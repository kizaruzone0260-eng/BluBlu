import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DB } from '../db/index.js';
import { audit } from '../services/audit.js';
import { wsBroadcast } from '../lib/wsHub.js';
import { floorPermission, getRoomService } from '../services/lessons.js';
import {
  handAccess, listHands, lowerAll, lowerHand, raiseHand, setFloor,
} from '../services/lessonHands.js';

/**
 * «Поднять руку» (task 2Б, 2026-10-10).
 *
 * Rights, in the order the routes check them — the same shape as the lesson comments, so nobody
 * has to learn a second rulebook:
 *  1. not in the class of this session, or no such session → 404 (identical; ids do not probe);
 *  2. the lesson has ended                                 → 404 (a hand is live-lesson state);
 *  3. «дать слово», «забрать» and «опустить все руки»      → teacher only (403);
 *  4. a student acting on a hand                           → only their own, and that is a DELETE
 *     whose WHERE carries the user id, so reaching for somebody else's row is a 404.
 *
 * What «give the floor» does to LiveKit, and why it cannot do more:
 * `mutePublishedTrack(muted: false)` is answered by LiveKit with 412 "remote unmute not enabled"
 * (measured in the CI run of 2026-10-10), so the server can mute a student but can never turn
 * their microphone on. The floor is therefore a PERMISSION change for that one participant
 * (`floorPermission`, composed with whatever else they hold so an existing screen-share survives)
 * plus a socket frame; the student's own client is the one that unmutes. Because of that:
 *  - granting tries LiveKit FIRST and records nothing if the media server is unreachable (502) —
 *    the API never claims a floor it could not give;
 *  - revoking clears the fact first and then restores the baseline permission, so a media-server
 *    outage can leave a student able to publish but never unable to be told to stop.
 */

const params = z.object({ id: z.string().uuid(), userId: z.string().uuid().optional() });

export async function lessonHandRoutes(app: FastifyInstance, opts: { db: DB }) {
  const { db } = opts;

  async function gate(req: { user: { id: string; role: 'teacher' | 'student' } | null }, reply: import('fastify').FastifyReply, sessionId: string) {
    const a = await handAccess(db, req.user!.id, req.user!.role, sessionId);
    if (!a) { await reply.code(404).send({ error: 'notFound' }); return null; }
    if (a.endedAt) { await reply.code(404).send({ error: 'notFound' }); return null; }
    return a;
  }

  /**
   * The one LiveKit round-trip both grant and revoke need; never throws (the `media()` pattern of
   * routes/lessons.ts). Reading the participant first is what lets a grant COMPOSE with an
   * existing screen-share instead of replacing it. When that read fails we fall back to the lesson
   * baseline and still try the write: if the person is not in the room, or the media server is
   * down, the write fails too and the caller answers 502 — one error path, and never a recorded
   * floor that nobody can use.
   *
   * Taking the floor back also MUTES the audio they are already publishing. A permission change
   * alone would not: LiveKit keeps a published track running, and it refuses to turn a microphone
   * ON remotely (412) while the mute direction works — which is exactly the asymmetry this feature
   * is built around.
   */
  async function applyFloor(roomName: string, userId: string, lectureMode: boolean, on: boolean) {
    let current: import('../services/lessons.js').CurrentPermission | undefined;
    try {
      current = (await getRoomService().getParticipant(roomName, userId)).permission ?? undefined;
    } catch { current = undefined; }
    try {
      await getRoomService().updateParticipant(roomName, userId, {
        permission: floorPermission(current, lectureMode, on) as never,
      });
      if (!on) await silenceAudio(roomName, userId);
      return { applied: true as const };
    } catch {
      return { applied: false as const };
    }
  }

  /** mute every published audio track of one participant; failures are reported, never thrown */
  async function silenceAudio(roomName: string, userId: string): Promise<boolean> {
    const { TrackType } = await import('livekit-server-sdk');
    const rs = getRoomService();
    try {
      const info = await rs.getParticipant(roomName, userId);
      let any = false;
      for (const track of info.tracks ?? []) {
        if (track.type !== TrackType.AUDIO || !track.sid) continue;
        try { await rs.mutePublishedTrack(roomName, userId, track.sid, true); any = true; } catch { /* one track already gone */ }
      }
      return any;
    } catch { return false; }
  }

  app.get('/api/lessons/:id/hands', { preHandler: app.authenticate }, async (req, reply) => {
    const p = params.safeParse(req.params);
    if (!p.success) return reply.code(404).send({ error: 'notFound' });
    const a = await gate(req, reply, p.data.id);
    if (!a) return;
    const hands = await listHands(db, a.sessionId);
    return {
      hands,
      lectureMode: a.lectureMode,
      // every client asks «is it me» so the button state survives a reload
      mine: hands.find((h) => h.userId === req.user!.id) ?? null,
    };
  });

  app.post('/api/lessons/:id/hand', { preHandler: app.authenticate }, async (req, reply) => {
    const p = params.safeParse(req.params);
    if (!p.success) return reply.code(404).send({ error: 'notFound' });
    const a = await gate(req, reply, p.data.id);
    if (!a) return;
    if (a.isTeacher) return reply.code(403).send({ error: 'teacherHasTheFloor' });
    const hand = await raiseHand(db, a.sessionId, req.user!.id);
    if (!hand) return reply.code(500).send({ error: 'internal' });
    wsBroadcast(a.sessionId, { type: 'handRaised', hand });
    return { ok: true, hand };
  });

  /** A student lowers THEIR OWN hand. Losing the floor with it is not a punishment — the row is
   *  gone, so the permission goes back with it. */
  app.delete('/api/lessons/:id/hand', { preHandler: app.authenticate }, async (req, reply) => {
    const p = params.safeParse(req.params);
    if (!p.success) return reply.code(404).send({ error: 'notFound' });
    const a = await gate(req, reply, p.data.id);
    if (!a) return;
    const mine = (await listHands(db, a.sessionId)).find((h) => h.userId === req.user!.id);
    if (!mine) return reply.code(404).send({ error: 'notFound' });
    const deleted = await lowerHand(db, a.sessionId, req.user!.id);
    if (!deleted) return reply.code(404).send({ error: 'notFound' });
    if (mine.grantedAt) await applyFloor(a.roomName, req.user!.id, a.lectureMode, false);
    wsBroadcast(a.sessionId, { type: 'handLowered', userId: req.user!.id, wasFloor: Boolean(mine.grantedAt) });
    return { ok: true };
  });

  app.post('/api/lessons/:id/hands/:userId/grant', { preHandler: app.authenticateTeacher }, async (req, reply) => {
    const p = params.safeParse(req.params);
    if (!p.success) return reply.code(404).send({ error: 'notFound' });
    const a = await gate(req, reply, p.data.id);
    if (!a) return;
    const userId = p.data.userId!;
    // the queue decides who is grantable: a permission is never written for an id that did not ask
    const hand = (await listHands(db, a.sessionId)).find((h) => h.userId === userId);
    if (!hand) return reply.code(404).send({ error: 'notFound' });
    const media = await applyFloor(a.roomName, userId, a.lectureMode, true);
    if (!media.applied) {
      // either the media server is down or this person is not in the room — from here the two are
      // the same answer, and neither may be recorded as a floor
      return reply.code(502).send({ error: 'mediaServerUnavailable' });
    }
    await setFloor(db, a.sessionId, userId, true);
    audit(db, req.user!.id, 'lesson_hand_grant', { sessionId: a.sessionId, userId });
    wsBroadcast(a.sessionId, { type: 'handGranted', userId });
    return { ok: true };
  });

  app.post('/api/lessons/:id/hands/:userId/revoke', { preHandler: app.authenticateTeacher }, async (req, reply) => {
    const p = params.safeParse(req.params);
    if (!p.success) return reply.code(404).send({ error: 'notFound' });
    const a = await gate(req, reply, p.data.id);
    if (!a) return;
    const userId = p.data.userId!;
    const marked = await setFloor(db, a.sessionId, userId, false);
    if (!marked) return reply.code(404).send({ error: 'notFound' });
    const media = await applyFloor(a.roomName, userId, a.lectureMode, false);
    audit(db, req.user!.id, 'lesson_hand_revoke', {
      sessionId: a.sessionId, userId, mediaApplied: media.applied,
    });
    wsBroadcast(a.sessionId, { type: 'handRevoked', userId });
    return { ok: true, mediaApplied: media.applied };
  });

  app.post('/api/lessons/:id/hands/lower-all', { preHandler: app.authenticateTeacher }, async (req, reply) => {
    const p = params.safeParse(req.params);
    if (!p.success) return reply.code(404).send({ error: 'notFound' });
    const a = await gate(req, reply, p.data.id);
    if (!a) return;
    const { cleared, hadFloor } = await lowerAll(db, a.sessionId);
    // whoever held the floor gets the baseline permission back; one failure must not stop the rest
    const restored: string[] = [];
    for (const userId of hadFloor) {
      const media = await applyFloor(a.roomName, userId, a.lectureMode, false);
      if (media.applied) restored.push(userId);
    }
    audit(db, req.user!.id, 'lesson_hand_lower_all', {
      sessionId: a.sessionId, cleared, restored: restored.length,
    });
    wsBroadcast(a.sessionId, { type: 'handsCleared', cleared });
    return { ok: true, cleared, restored: restored.length };
  });
}
