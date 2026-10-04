import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { WebSocket } from 'ws';
import { eq } from 'drizzle-orm';
import type { DB } from '../db/index.js';
import { users } from '../db/schema.js';
import { audit } from '../services/audit.js';
import {
  chatAccess, clearMute, consumeChatTicket, createChatTicket, deleteMessage, deleteMessageAny,
  isMuted, listMessages, markRead, postMessage, setMute, chatSummary, type ChatMessageRow,
} from '../services/chat.js';

/**
 * Item 8 — class chat routes. Realtime: /api/ws/chat/:classId with a one-time
 * 30 s ticket (same semantics as lesson/board sockets). REST covers history,
 * posting, moderation and read markers.
 */

const CHAT_MAX_LEN = 2000;
const bodySchema = z.object({ text: z.string().min(1, 'empty').max(CHAT_MAX_LEN) });
const muteSchema = z.object({ userId: z.string().uuid(), until: z.string().datetime().nullable().optional() });
const modeSchema = z.object({ mode: z.enum(['on', 'off', 'announce']) });
const uuidP = z.object({ id: z.string().uuid(), messageId: z.string().uuid().optional(), userId: z.string().uuid().optional() });

// ── per-user sliding window: ≤5 messages / 10 s (item 8) ─────────────────────
const RATE_MAX = 5;
const RATE_WINDOW_MS = 10_000;
const sendTimes = new Map<string, number[]>();
export function chatRateCheck(userId: string, now = Date.now()): { allowed: boolean; retryAfterSec: number } {
  const arr = (sendTimes.get(userId) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  if (arr.length >= RATE_MAX) {
    sendTimes.set(userId, arr);
    return { allowed: false, retryAfterSec: Math.ceil((RATE_WINDOW_MS - (now - arr[0]!)) / 1000) };
  }
  arr.push(now);
  sendTimes.set(userId, arr);
  return { allowed: true, retryAfterSec: 0 };
}
export function chatRateReset(userId: string): void { sendTimes.delete(userId); }

// ── WS hub ────────────────────────────────────────────────────────────────────
const rooms = new Map<string, Set<WebSocket>>();

function broadcast(classId: string, msg: unknown, except?: WebSocket): void {
  const raw = JSON.stringify(msg);
  for (const s of rooms.get(classId) ?? []) {
    if (s !== except && s.readyState === s.OPEN) { try { s.send(raw); } catch { /* drop */ } }
  }
}

export async function chatRoutes(app: FastifyInstance, opts: { db: DB }) {
  const { db } = opts;

  const who = async (userId: string): Promise<{ name: string; role: 'teacher' | 'student' }> => {
    const [u] = await db.select({ name: users.name, role: users.role }).from(users).where(eq(users.id, userId)).limit(1);
    return { name: u?.name ?? '', role: (u?.role as 'teacher' | 'student') ?? 'student' };
  };

  // ── REST ───────────────────────────────────────────────────────────────────

  app.get('/api/chat/summary', { preHandler: app.authenticate }, async (req) =>
    chatSummary(db, req.user!.id, req.user!.role));

  app.get('/api/classes/:id/chat/messages', { preHandler: app.authenticate }, async (req, reply) => {
    const p = uuidP.safeParse(req.params);
    if (!p.success) return reply.code(404).send({ error: 'notFound' });
    if (!(await chatAccess(db, req.user!.id, req.user!.role, p.data.id))) return reply.code(404).send({ error: 'notFound' });
    const q = req.query as { before?: string; limit?: string };
    const limit = Math.min(Math.max(Number(q.limit ?? 30) || 30, 1), 50);
    const before = q.before ? new Date(q.before) : null;
    if (before && Number.isNaN(before.getTime())) return reply.code(400).send({ error: 'invalidInput' });
    const page = await listMessages(db, p.data.id, before, limit + 1); // one extra ⇒ hasMore probe
    const hasMore = page.length > limit;
    const messages = page.slice(0, limit).reverse();
    void markRead(db, req.user!.id, p.data.id).catch(() => undefined);
    return { messages, hasMore };
  });

  app.post('/api/classes/:id/chat/messages', { preHandler: app.authenticate }, async (req, reply) => {
    const p = uuidP.safeParse(req.params);
    if (!p.success) return reply.code(404).send({ error: 'notFound' });
    const access = await chatAccess(db, req.user!.id, req.user!.role, p.data.id);
    if (!access) return reply.code(404).send({ error: 'notFound' });
    const isTeacher = req.user!.role === 'teacher';
    if (access.chatMode === 'off') return reply.code(403).send({ error: 'chatDisabled' });
    if (access.chatMode === 'announce' && !isTeacher) return reply.code(403).send({ error: 'chatAnnounceOnly' });
    if (!isTeacher && await isMuted(db, p.data.id, req.user!.id)) return reply.code(403).send({ error: 'chatMuted' });
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.code === 'too_small' ? 'chatEmpty' : 'invalidInput' });
    const text = parsed.data.text.trim();
    if (!text) return reply.code(400).send({ error: 'chatEmpty' });
    const rate = chatRateCheck(req.user!.id);
    if (!rate.allowed) return reply.code(429).header('retry-after', String(rate.retryAfterSec)).send({ error: 'chatRateLimited' });
    const w = await who(req.user!.id);
    const msg = await postMessage(db, p.data.id, req.user!.id, w.name, text);
    broadcast(p.data.id, { type: 'message', message: msg });
    return reply.code(201).send(msg);
  });

  app.delete('/api/classes/:id/chat/messages/:messageId', { preHandler: app.authenticate }, async (req, reply) => {
    const p = uuidP.safeParse(req.params);
    if (!p.success || !p.data.messageId) return reply.code(404).send({ error: 'notFound' });
    const access = await chatAccess(db, req.user!.id, req.user!.role, p.data.id);
    if (!access) return reply.code(404).send({ error: 'notFound' });
    const isTeacher = req.user!.role === 'teacher';
    const gone = isTeacher
      ? await deleteMessageAny(db, p.data.id, p.data.messageId)
      : await deleteMessage(db, p.data.id, p.data.messageId, req.user!.id); // students: own only
    if (!gone) return reply.code(404).send({ error: 'notFound' });
    audit(db, req.user!.id, isTeacher ? 'chat_delete_teacher' : 'chat_delete_own', { classId: p.data.id, messageId: p.data.messageId });
    broadcast(p.data.id, { type: 'deleted', messageId: p.data.messageId, classId: p.data.id });
    return { ok: true };
  });

  app.post('/api/classes/:id/chat/mutes', { preHandler: app.authenticateTeacher }, async (req, reply) => {
    const p = uuidP.safeParse(req.params);
    if (!p.success) return reply.code(404).send({ error: 'notFound' });
    const parsed = muteSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalidInput' });
    const access = await chatAccess(db, req.user!.id, 'teacher', p.data.id);
    if (!access) return reply.code(404).send({ error: 'notFound' });
    if (parsed.data.userId === req.user!.id) return reply.code(400).send({ error: 'invalidInput' });
    await setMute(db, p.data.id, parsed.data.userId, req.user!.id, parsed.data.until ? new Date(parsed.data.until) : null);
    audit(db, req.user!.id, 'chat_mute', { classId: p.data.id, userId: parsed.data.userId, until: parsed.data.until ?? 'forever' });
    return { ok: true };
  });

  app.delete('/api/classes/:id/chat/mutes/:userId', { preHandler: app.authenticateTeacher }, async (req, reply) => {
    const p = uuidP.safeParse(req.params);
    if (!p.success || !p.data.userId) return reply.code(404).send({ error: 'notFound' });
    const access = await chatAccess(db, req.user!.id, 'teacher', p.data.id);
    if (!access) return reply.code(404).send({ error: 'notFound' });
    await clearMute(db, p.data.id, p.data.userId);
    audit(db, req.user!.id, 'chat_unmute', { classId: p.data.id, userId: p.data.userId });
    return { ok: true };
  });

  app.get('/api/classes/:id/chat/mutes', { preHandler: app.authenticateTeacher }, async (req, reply) => {
    const p = uuidP.safeParse(req.params);
    if (!p.success) return reply.code(404).send({ error: 'notFound' });
    const access = await chatAccess(db, req.user!.id, 'teacher', p.data.id);
    if (!access) return reply.code(404).send({ error: 'notFound' });
    const { listMutes } = await import('../services/chat.js');
    return { mutes: await listMutes(db, p.data.id) };
  });

  app.put('/api/classes/:id/chat/mode', { preHandler: app.authenticateTeacher }, async (req, reply) => {
    const p = uuidP.safeParse(req.params);
    if (!p.success) return reply.code(404).send({ error: 'notFound' });
    const access = await chatAccess(db, req.user!.id, 'teacher', p.data.id);
    if (!access) return reply.code(404).send({ error: 'notFound' });
    const parsed = modeSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalidInput' });
    const { setChatMode } = await import('../services/chat.js');
    await setChatMode(db, p.data.id, parsed.data.mode);
    audit(db, req.user!.id, 'chat_mode', { classId: p.data.id, mode: parsed.data.mode });
    return { ok: true, mode: parsed.data.mode };
  });

  // one-time WS ticket for the chat socket
  app.post('/api/classes/:id/chat/ticket', { preHandler: app.authenticate }, async (req, reply) => {
    const p = uuidP.safeParse(req.params);
    if (!p.success) return reply.code(404).send({ error: 'notFound' });
    if (!(await chatAccess(db, req.user!.id, req.user!.role, p.data.id))) return reply.code(404).send({ error: 'notFound' });
    const ticket = await createChatTicket(db, req.user!.id, p.data.id);
    return { ticket };
  });

  app.post('/api/classes/:id/chat/read', { preHandler: app.authenticate }, async (req, reply) => {
    const p = uuidP.safeParse(req.params);
    if (!p.success) return reply.code(404).send({ error: 'notFound' });
    if (!(await chatAccess(db, req.user!.id, req.user!.role, p.data.id))) return reply.code(404).send({ error: 'notFound' });
    await markRead(db, req.user!.id, p.data.id);
    return { ok: true };
  });

  // ── WebSocket (4401 bad/expired/reused ticket, 4404 no access) ─────────────
  app.get('/api/ws/chat/:id', { websocket: true }, (socket: WebSocket, req) => {
    void (async () => {
      const classId = (req.params as { id: string }).id;
      const url = new URL(req.url ?? '/', 'http://local');
      const ticket = url.searchParams.get('ticket') ?? '';
      const consumed = z.string().uuid().safeParse(classId).success
        ? await consumeChatTicket(db, ticket, classId)
        : null;
      if (!consumed) { socket.close(4401); return; }
      const access = await chatAccess(db, consumed.userId, consumed.role, classId);
      if (!access) { socket.close(4404); return; }
      let set = rooms.get(classId);
      if (!set) { set = new Set(); rooms.set(classId, set); }
      set.add(socket);
      void markRead(db, consumed.userId, classId).catch(() => undefined);
      socket.on('close', () => {
        set!.delete(socket);
        if (set!.size === 0) rooms.delete(classId);
      });
      socket.on('error', () => { /* close follows */ });
      socket.send(JSON.stringify({ type: 'ready', classId, mode: access.chatMode }));
    })().catch(() => socket.close(1011));
  });
}
