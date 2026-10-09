import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sql, eq } from 'drizzle-orm';
import type { DB } from '../db/index.js';
import { users } from '../db/schema.js';
import { audit } from '../services/audit.js';
import { wsBroadcast } from '../lib/wsHub.js';
import {
  COMMENT_MAX_LEN, clearCommentMute, commentAccess, deleteComment, isCommentMuted,
  lessonCommentRateCheck, listCommentMutes, markCommentsRead,
  pinnedComments, postComment, recentComments, setAnswered, setCommentsMode, setCommentMute,
  setPinned, unreadCount,
} from '../services/lessonComments.js';

/**
 * Task 2 (2026-10-09) — comments during a lesson.
 *
 * Realtime rides the lesson socket that already exists (`/api/ws/lesson/:id`, one-time ticket,
 * class membership checked at connect) — a second socket would mean a second ticket path and a
 * second place to get the rights wrong. Writes are REST; every accepted change is broadcast to
 * the room, and a client that reconnects simply GETs the last 50 again.
 *
 * Rights, in the order the route checks them:
 *  1. not in the class of this session, or no such session  → 404 (identical, so ids don't probe)
 *  2. the lesson has ended                                  → teacher reads, nobody writes (404)
 *  3. mode off / student muted                              → 403 with a specific error key
 *  4. size and rate limits                                   → 400 / 429 with retry-after
 * A student is never allowed to touch another student's comment; the author id is part of the
 * DELETE's WHERE, so "not yours" and "not here" are both a 404 rather than a 403 that leaks.
 */

const bodySchema = z.object({ text: z.string().min(1, 'empty').max(COMMENT_MAX_LEN) });
const pinSchema = z.object({ on: z.boolean() });
const modeSchema = z.object({ mode: z.enum(['on', 'off', 'slow']) });
const muteSchema = z.object({ userId: z.string().uuid() });
const params = z.object({ id: z.string().uuid(), commentId: z.string().uuid().optional(), userId: z.string().uuid().optional() });

export async function lessonCommentRoutes(app: FastifyInstance, opts: { db: DB }) {
  const { db } = opts;

  const who = async (userId: string): Promise<string> => {
    const [u] = await db.select({
      name: sql<string>`concat_ws(' ', ${users.name}, nullif(${users.lastName}, ''))`,
    }).from(users).where(eq(users.id, userId)).limit(1);
    return u?.name ?? '';
  };

  /** the shared gate: access + "is this lesson still running" */
  async function gate(req: { user: { id: string; role: 'teacher' | 'student' } | null }, reply: import('fastify').FastifyReply, sessionId: string, write: boolean) {
    const a = await commentAccess(db, req.user!.id, req.user!.role, sessionId);
    if (!a) { await reply.code(404).send({ error: 'notFound' }); return null; }
    // A finished lesson is a transcript the teacher may re-read. Students get the same 404 the
    // moderation endpoints of an ended session already answer (AUDIT-H3), so "over" and "never
    // existed" are not distinguishable to them either.
    if (a.endedAt && (write || !a.isTeacher)) { await reply.code(404).send({ error: 'notFound' }); return null; }
    return a;
  }

  app.get('/api/lessons/:id/comments', { preHandler: app.authenticate }, async (req, reply) => {
    const p = params.safeParse(req.params);
    if (!p.success) return reply.code(404).send({ error: 'notFound' });
    const a = await gate(req, reply, p.data.id, false);
    if (!a) return;
    const comments = await recentComments(db, a.sessionId);
    const unread = await unreadCount(db, req.user!.id, a.sessionId);
    void markCommentsRead(db, req.user!.id, a.sessionId).catch(() => undefined);
    return {
      comments, unread, mode: a.mode, ended: Boolean(a.endedAt),
      pinned: comments.filter((c) => c.pinned).map((c) => c.id),
      mutes: a.isTeacher ? await listCommentMutes(db, a.sessionId) : undefined,
    };
  });

  app.post('/api/lessons/:id/comments', { preHandler: app.authenticate }, async (req, reply) => {
    const p = params.safeParse(req.params);
    if (!p.success) return reply.code(404).send({ error: 'notFound' });
    const a = await gate(req, reply, p.data.id, true);
    if (!a) return;
    const isTeacher = a.isTeacher;
    if (a.mode === 'off') return reply.code(403).send({ error: 'commentsDisabled' });
    if (!isTeacher && await isCommentMuted(db, a.sessionId, req.user!.id)) return reply.code(403).send({ error: 'commentMuted' });
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.code === 'too_small' ? 'chatEmpty' : 'invalidInput' });
    const text = parsed.data.text.trim();
    if (!text) return reply.code(400).send({ error: 'chatEmpty' });
    const rate = lessonCommentRateCheck(req.user!.id, a.mode === 'slow', isTeacher);
    if (!rate.allowed) return reply.code(429).header('retry-after', String(rate.retryAfterSec)).send({ error: 'commentRateLimited' });
    const comment = await postComment(db, a.sessionId, req.user!.id, await who(req.user!.id), text);
    await markCommentsRead(db, req.user!.id, a.sessionId).catch(() => undefined);
    wsBroadcast(a.sessionId, { type: 'comment', comment });
    return reply.code(201).send(comment);
  });

  app.delete('/api/lessons/:id/comments/:commentId', { preHandler: app.authenticate }, async (req, reply) => {
    const p = params.safeParse(req.params);
    if (!p.success || !p.data.commentId) return reply.code(404).send({ error: 'notFound' });
    const a = await gate(req, reply, p.data.id, true);
    if (!a) return;
    const gone = await deleteComment(db, a.sessionId, p.data.commentId, a.isTeacher ? null : req.user!.id);
    if (!gone) return reply.code(404).send({ error: 'notFound' });
    audit(db, req.user!.id, a.isTeacher ? 'lesson_comment_delete_teacher' : 'lesson_comment_delete_own', {
      sessionId: a.sessionId, classId: a.classId, commentId: p.data.commentId,
    });
    wsBroadcast(a.sessionId, { type: 'commentDeleted', commentId: p.data.commentId });
    return { ok: true };
  });

  app.post('/api/lessons/:id/comments/:commentId/pin', { preHandler: app.authenticateTeacher }, async (req, reply) => {
    const p = params.safeParse(req.params);
    if (!p.success || !p.data.commentId) return reply.code(404).send({ error: 'notFound' });
    const a = await gate(req, reply, p.data.id, true);
    if (!a) return;
    const parsed = pinSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalidInput' });
    const r = await setPinned(db, a.sessionId, p.data.commentId, parsed.data.on);
    if (r === 'not-found') return reply.code(404).send({ error: 'notFound' });
    if (r === 'too-many') return reply.code(409).send({ error: 'commentPinLimit' });
    wsBroadcast(a.sessionId, { type: 'commentPinned', commentId: p.data.commentId, on: parsed.data.on });
    return { ok: true, pinned: await pinnedComments(db, a.sessionId) };
  });

  app.post('/api/lessons/:id/comments/:commentId/answered', { preHandler: app.authenticateTeacher }, async (req, reply) => {
    const p = params.safeParse(req.params);
    if (!p.success || !p.data.commentId) return reply.code(404).send({ error: 'notFound' });
    const a = await gate(req, reply, p.data.id, true);
    if (!a) return;
    const parsed = pinSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalidInput' });
    const ok = await setAnswered(db, a.sessionId, p.data.commentId, parsed.data.on);
    if (!ok) return reply.code(404).send({ error: 'notFound' });
    wsBroadcast(a.sessionId, { type: 'commentAnswered', commentId: p.data.commentId, on: parsed.data.on });
    return { ok: true };
  });

  app.post('/api/lessons/:id/comments/mutes', { preHandler: app.authenticateTeacher }, async (req, reply) => {
    const p = params.safeParse(req.params);
    if (!p.success) return reply.code(404).send({ error: 'notFound' });
    const a = await gate(req, reply, p.data.id, true);
    if (!a) return;
    const parsed = muteSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalidInput' });
    if (parsed.data.userId === req.user!.id) return reply.code(400).send({ error: 'invalidInput' });
    await setCommentMute(db, a.sessionId, parsed.data.userId, req.user!.id);
    audit(db, req.user!.id, 'lesson_comment_mute', { sessionId: a.sessionId, classId: a.classId, userId: parsed.data.userId });
    wsBroadcast(a.sessionId, { type: 'commentMuted', userId: parsed.data.userId, on: true });
    return { ok: true };
  });

  app.delete('/api/lessons/:id/comments/mutes/:userId', { preHandler: app.authenticateTeacher }, async (req, reply) => {
    const p = params.safeParse(req.params);
    if (!p.success || !p.data.userId) return reply.code(404).send({ error: 'notFound' });
    const a = await gate(req, reply, p.data.id, true);
    if (!a) return;
    await clearCommentMute(db, a.sessionId, p.data.userId);
    audit(db, req.user!.id, 'lesson_comment_unmute', { sessionId: a.sessionId, classId: a.classId, userId: p.data.userId });
    wsBroadcast(a.sessionId, { type: 'commentMuted', userId: p.data.userId, on: false });
    return { ok: true };
  });

  app.put('/api/lessons/:id/comments/mode', { preHandler: app.authenticateTeacher }, async (req, reply) => {
    const p = params.safeParse(req.params);
    if (!p.success) return reply.code(404).send({ error: 'notFound' });
    const a = await gate(req, reply, p.data.id, true);
    if (!a) return;
    const parsed = modeSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalidInput' });
    await setCommentsMode(db, a.sessionId, parsed.data.mode);
    audit(db, req.user!.id, 'lesson_comment_mode', { sessionId: a.sessionId, classId: a.classId, mode: parsed.data.mode });
    wsBroadcast(a.sessionId, { type: 'commentsMode', mode: parsed.data.mode });
    return { ok: true, mode: parsed.data.mode };
  });

  app.post('/api/lessons/:id/comments/read', { preHandler: app.authenticate }, async (req, reply) => {
    const p = params.safeParse(req.params);
    if (!p.success) return reply.code(404).send({ error: 'notFound' });
    const a = await gate(req, reply, p.data.id, false);
    if (!a) return;
    await markCommentsRead(db, req.user!.id, a.sessionId);
    return { ok: true };
  });
}
