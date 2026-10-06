import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DB } from '../db/index.js';
import { resolveClass } from '../services/classes.js';
import {
  startLesson, endLesson, getActiveSessionForClass, getActiveSessionForEvent,
  getSession, buildJoinToken, getRoomService, studentPermission, type LessonSession,
} from '../services/lessons.js';
import { wsJoin, wsBroadcast } from '../lib/wsHub.js';
import { env, livekitPublicWsUrl } from '../env.js';
import { eq, sql } from 'drizzle-orm';
import { users, events } from '../db/schema.js';
import { enqueueNotification, siteUrl } from '../services/notify.js';
import { classTitle } from '../services/notifyQueue.js';
import { createWsTicket, consumeWsTicket } from '../services/wsTicket.js';
import { wsOriginAllowed } from '../lib/wsOrigin.js';
import type { WebSocket as WsSocket } from 'ws';

const withRoom = (s: LessonSession) => ({
  id: s.id, classId: s.classId, eventId: s.eventId, roomName: s.roomName,
  startedAt: s.startedAt, endedAt: s.endedAt, lectureMode: s.lectureMode,
  muteAll: s.muteAll, // task 3: student banners survive reconnects
  layout: s.layoutState.layout,
  boardOpen: s.layoutState.boardOpen ?? false, // task B: the board as the main window
});

/** RoomService failures must not 500 the API (media server may be starting). */
async function media<T>(fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    return { ok: false, error };
  }
}

export async function lessonRoutes(app: FastifyInstance, opts: { db: DB }) {
  const { db } = opts;

  async function teacherSession(req: { user: { id: string } | null }, reply: import('fastify').FastifyReply, sessionId: string, { allowEnded = false } = {}) {
    const s = await getSession(db, sessionId);
    if (!s) { await reply.code(404).send({ error: 'notFound' }); return null; }
    const cls = await resolveClass(db, req.user!.id, 'teacher', s.classId);
    if (!cls) { await reply.code(404).send({ error: 'notFound' }); return null; }
    // AUDIT-H3: moderation of an ENDED session is meaningless — reject like missing
    if (s.endedAt && !allowEnded) { await reply.code(404).send({ error: 'notFound' }); return null; }
    return s;
  }

  // Teacher: start (idempotent per class) / end
  app.post('/api/lessons/start', { preHandler: app.authenticateTeacher }, async (req, reply) => {
    const p = z.object({ classId: z.string().uuid(), eventId: z.string().uuid().optional() }).safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: 'invalidInput' });
    const cls = await resolveClass(db, req.user!.id, 'teacher', p.data.classId);
    if (!cls) return reply.code(404).send({ error: 'notFound' });
    // AUDIT-H1: an event may only be bound to a session of its OWN class
    if (p.data.eventId) {
      const [ev] = await db.select({ classId: events.classId }).from(events).where(eq(events.id, p.data.eventId)).limit(1);
      if (!ev || ev.classId !== cls.id) return reply.code(400).send({ error: 'invalidInput' });
    }
    const s = await startLesson(db, req.user!.id, cls.id, p.data.eventId);
    wsBroadcast(s.id, { type: 'started', session: withRoom(s) });
    // §3.9 «урок начался» со ссылкой — через очередь уведомлений
    void (async () => {
      const name = await classTitle(db, cls.id);
      await enqueueNotification(db, {
        kind: 'lessonStarted', classId: cls.id, when: new Date(),
        params: { title: name, class: name, lessonUrl: `${siteUrl()}/lesson?classId=${cls.id}` },
        dedupeBase: `lesson:${s.id}`,
      });
    })().catch(() => undefined);
    return reply.code(201).send(withRoom(s));
  });

  app.post('/api/lessons/:id/end', { preHandler: app.authenticateTeacher }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const s = await teacherSession(req, reply, id);
    if (!s) return;
    const ended = await endLesson(db, id);
    if (!ended) return reply.code(404).send({ error: 'notFound' });
    // завершить урок для всех: kick every participant from the room (§3.6)
    const rs = await media(() => getRoomService().listParticipants(s.roomName));
    if (rs.ok) {
      for (const p of rs.value) {
        await media(() => getRoomService().removeParticipant(s.roomName, p.identity));
      }
    }
    wsBroadcast(id, { type: 'ended' });
    return withRoom(ended);
  });

  // Status (public within class): who may join + layout/lecture state
  app.get('/api/lessons/active', { preHandler: app.authenticate }, async (req, reply) => {
    const q = req.query as { classId?: string; eventId?: string };
    if (!q.classId && !q.eventId) return reply.code(400).send({ error: 'invalidInput' });
    let clsId = q.classId;
    if (q.eventId) {
      const s0 = await getActiveSessionForEvent(db, q.eventId);
      if (!s0) return { session: null };
      clsId = s0.classId;
    }
    if (!clsId) return { session: null };
    const cls = await resolveClass(db, req.user!.id, req.user!.role, clsId);
    if (!cls) return reply.code(404).send({ error: 'notFound' });
    const s = await getActiveSessionForClass(db, cls.id);
    if (!s) return { session: null };
    return { session: { ...withRoom(s), wsUrl: livekitPublicWsUrl() } };
  });

  // Join: issue short-lived LiveKit JWT (§5 поток входа)
  app.post('/api/lessons/:id/join', { preHandler: app.authenticate }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const s = await getSession(db, id);
    if (!s || s.endedAt) return reply.code(404).send({ error: 'notFound' });
    const cls = await resolveClass(db, req.user!.id, req.user!.role, s.classId);
    if (!cls) return reply.code(404).send({ error: 'notFound' });
    const [me] = await db.select({ name: sql<string>`concat_ws(' ', ${users.name}, nullif(${users.lastName}, ''))` }).from(users).where(eq(users.id, req.user!.id)).limit(1);
    const isTeacher = req.user!.role === 'teacher';
    const token = await buildJoinToken({
      room: s.roomName, identity: req.user!.id, name: me?.name ?? 'user',
      isTeacher, lectureMode: s.lectureMode,
    });
    return { token, wsUrl: livekitPublicWsUrl(), room: s.roomName, session: withRoom(s) };
  });

  // Layout for everyone (§3.6); boardOpen is preserved across layout changes
  app.patch('/api/lessons/:id/layout', { preHandler: app.authenticateTeacher }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const s = await teacherSession(req, reply, id);
    if (!s) return;
    const p = z.object({ layout: z.enum(['auto', 'gallery', 'stage', 'teacher']) }).safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: 'invalidInput' });
    const { lessonSessions } = await import('../db/schema.js');
    await db.update(lessonSessions).set({
      layoutState: { layout: p.data.layout, boardOpen: s.layoutState.boardOpen ?? false },
    }).where(eq(lessonSessions.id, id));
    wsBroadcast(id, { type: 'layout', layout: p.data.layout });
    return { ok: true };
  });

  // task B — «Доска»: the whiteboard becomes the main stage window for everyone
  // (cameras shrink to the strip); closing restores the previous arrangement.
  app.post('/api/lessons/:id/board', { preHandler: app.authenticateTeacher }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const s = await teacherSession(req, reply, id);
    if (!s) return;
    const p = z.object({ on: z.boolean() }).safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: 'invalidInput' });
    const { lessonSessions } = await import('../db/schema.js');
    await db.update(lessonSessions).set({
      layoutState: { layout: s.layoutState.layout, boardOpen: p.data.on },
    }).where(eq(lessonSessions.id, id));
    wsBroadcast(id, { type: 'board', on: p.data.on });
    return { ok: true, on: p.data.on };
  });

  async function setLecture(id: string, on: boolean) {
    const { lessonSessions } = await import('../db/schema.js');
    await db.update(lessonSessions).set({ lectureMode: on }).where(eq(lessonSessions.id, id));
  }

  // Lecture mode: forbid students from enabling mic (§3.6). New joiners get it from the token.
  app.post('/api/lessons/:id/lecture-mode', { preHandler: app.authenticateTeacher }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const s = await teacherSession(req, reply, id);
    if (!s) return;
    const on = !!(req.body as { on?: boolean }).on;
    await setLecture(id, on);
    const rs = await media(() => getRoomService().listParticipants(s.roomName));
    if (rs.ok) {
      for (const p of rs.value) {
        if (p.identity === s.createdBy) continue; // teacher identity
        await media(() => getRoomService().updateParticipant(s.roomName, p.identity, {
          permission: studentPermission(on) as never,
        }));
      }
    }
    wsBroadcast(id, { type: 'lectureMode', on });
    return { ok: true, liveParticipants: rs.ok ? rs.value.length : 0 };
  });

  // Mute/unmute one participant or everybody but the teacher (task 3:
  // «all» also persists the state on the session and broadcasts it, so a
  // reconnecting student still sees the banner and keeps the mic off).
  app.post('/api/lessons/:id/mute', { preHandler: app.authenticateTeacher }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const s = await teacherSession(req, reply, id);
    if (!s) return;
    const p = z.object({
      identity: z.string().min(1).optional(),
      all: z.boolean().default(false),
      kind: z.enum(['audio', 'video']).default('audio'),
      muted: z.boolean().default(true),
    }).safeParse(req.body ?? {});
    if (!p.success) return reply.code(400).send({ error: 'invalidInput' });
    const { TrackType } = await import('livekit-server-sdk');
    const want = p.data.kind === 'audio' ? TrackType.AUDIO : TrackType.VIDEO;
    const list = await media(() => getRoomService().listParticipants(s.roomName));
    if (!list.ok) return reply.code(502).send({ error: 'mediaServerUnavailable' });
    const rs = getRoomService();
    let n = 0;
    let students = 0;
    for (const part of list.value) {
      if (part.identity === s.createdBy) continue; // never mute the teacher
      students++;
      if (p.data.identity && part.identity !== p.data.identity) continue;
      const info = await media(() => rs.getParticipant(s.roomName, part.identity));
      if (!info.ok) continue;
      for (const track of info.value.tracks ?? []) {
        if (track.type !== want || !track.sid) continue;
        const r = await media(() => rs.mutePublishedTrack(s.roomName, part.identity, track.sid, p.data.muted));
        if (r.ok) n++;
      }
    }
    if (p.data.all && p.data.kind === 'audio') {
      const { lessonSessions } = await import('../db/schema.js');
      await db.update(lessonSessions).set({ muteAll: p.data.muted }).where(eq(lessonSessions.id, id));
      wsBroadcast(id, { type: 'muteAll', on: p.data.muted });
    }
    return { ok: true, muted: n, students };
  });

  // Temporarily grant a student the right to share screen
  app.post('/api/lessons/:id/grant-screen', { preHandler: app.authenticateTeacher }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const s = await teacherSession(req, reply, id);
    if (!s) return;
    const p = z.object({ identity: z.string().min(1), allow: z.boolean().default(true) }).safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: 'invalidInput' });
    const r = await media(() => getRoomService().updateParticipant(s.roomName, p.data.identity, {
      permission: studentPermission(s.lectureMode, p.data.allow) as never,
    }));
    if (!r.ok) return reply.code(502).send({ error: 'mediaServerUnavailable' });
    return { ok: true };
  });

  // Remove a participant
  app.post('/api/lessons/:id/kick', { preHandler: app.authenticateTeacher }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const s = await teacherSession(req, reply, id);
    if (!s) return;
    const p = z.object({ identity: z.string().min(1) }).safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: 'invalidInput' });
    if (p.data.identity === s.createdBy) return reply.code(400).send({ error: 'invalidInput' });
    const r = await media(() => getRoomService().removeParticipant(s.roomName, p.data.identity));
    if (!r.ok) return reply.code(502).send({ error: 'mediaServerUnavailable' });
    return { ok: true };
  });

  // One-time 30 s WS ticket (replaces access token in WS query strings, §logs audit).
  app.post('/api/ws/ticket', { preHandler: app.authenticate }, async (req, reply) => {
    const p = z.object({ sessionId: z.string().uuid() }).safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: 'invalidInput' });
    const s = await getSession(db, p.data.sessionId);
    if (!s || s.endedAt) return reply.code(404).send({ error: 'notFound' });
    const cls = await resolveClass(db, req.user!.id, req.user!.role, s.classId);
    if (!cls) return reply.code(404).send({ error: 'notFound' });
    const ticket = await createWsTicket(db, req.user!.id, s.id);
    return { ticket, ttlMs: 30_000 };
  });

  // ── lesson status WebSocket (§3.6 “статус по WebSocket”) ──
  // Browser WS can't set Authorization headers → ONE-TIME ticket in query, consumed here.
  app.get('/api/ws/lesson/:id', { websocket: true }, (socket: WsSocket, req) => {
    void (async () => {
      if (!wsOriginAllowed(req)) { socket.close(4403); return; }
      const url = new URL(req.url, 'http://local');
      const ticket = url.searchParams.get('ticket') ?? '';
      const q = url.searchParams.get('sessionId') ?? (url.pathname.split('/').pop() ?? '');
      const s = await getSession(db, q);
      if (!s) { socket.close(4404); return; }
      const consumed = await consumeWsTicket(db, ticket, s.id);
      if (!consumed) { socket.close(4401); return; }
      const cls = await resolveClass(db, consumed.userId, consumed.role, s.classId);
      if (!cls) { socket.close(4404); return; }
      wsJoin(q, socket);
      socket.send(JSON.stringify({
        type: s.endedAt ? 'ended' : 'started',
        session: { ...withRoom(s), wsUrl: livekitPublicWsUrl() },
      }));
    })().catch(() => socket.close(1011));
  });
}
