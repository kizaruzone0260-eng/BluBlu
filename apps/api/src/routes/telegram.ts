import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import type { Bot } from 'grammy';
import type { DB } from '../db/index.js';
import { env } from '../env.js';
import {
  createLinkToken, unlinkUser, getPrefs,
} from '../services/notify.js';
import { notificationPrefs, classNotifyPrefs, classTelegramChats, classLinkTokens, users, telegramLinks } from '../db/schema.js';
import { resolveClass } from '../services/classes.js';
import { processUpdate, createBot, type BotDeps } from '../services/telegramBot.js';
import { randomBytes } from 'node:crypto';
import { hashToken } from '../services/notify.js';

/** Bot dependencies shared by the webhook route and the demo long-polling loop (server.ts). */
export function botDeps(db: DB, bot: Bot | null): BotDeps {
  return {
    db,
    isGroupAdmin: async (chatId, tgUserId) => {
      if (!bot) return false;
      try {
        const member = await bot.api.getChatMember(chatId, tgUserId);
        return member.status === 'administrator' || member.status === 'creator';
      } catch {
        return false;
      }
    },
  };
}

export async function telegramRoutes(app: FastifyInstance, opts: { db: DB }) {
  const { db } = opts;
  const bot = createBot();

  const deps: BotDeps = botDeps(db, bot);

  // Webhook from Telegram (behind Caddy). Secret header check per §3.9.
  app.post('/webhook/telegram', async (req, reply) => {
    const secret = req.headers['x-telegram-bot-api-secret-token'];
    if (!env.TELEGRAM_WEBHOOK_SECRET || secret !== env.TELEGRAM_WEBHOOK_SECRET) {
      return reply.code(403).send({ error: 'forbidden' });
    }
    const update = req.body as Parameters<typeof processUpdate>[1];
    const res = await processUpdate(deps, update);
    if (res.handled && res.reply && bot) {
      const chatId = update.message?.chat?.id;
      if (chatId !== undefined) {
        try { await bot.api.sendMessage(chatId, res.reply); } catch { /* log-only */ }
      }
    }
    return reply.send({ ok: true });
  });

  // Profile: link/unlink personal Telegram, notification prefs
  app.post('/api/me/telegram-link', { preHandler: app.authenticate }, async (req) => {
    return createLinkToken(db, req.user!.id);
  });

  app.delete('/api/me/telegram-link', { preHandler: app.authenticate }, async (req) => {
    await unlinkUser(db, req.user!.id);
    return { ok: true };
  });

  app.get('/api/me/telegram-status', { preHandler: app.authenticate }, async (req) => {
    const [link] = await db.select({ linkedAt: telegramLinks.linkedAt, blockedAt: telegramLinks.blockedAt })
      .from(telegramLinks).where(eq(telegramLinks.userId, req.user!.id)).limit(1);
    return { linked: Boolean(link), blocked: Boolean(link?.blockedAt) };
  });

  app.get('/api/me/notify-prefs', { preHandler: app.authenticate }, async (req) => getPrefs(db, req.user!.id));

  app.put('/api/me/notify-prefs', { preHandler: app.authenticate }, async (req, reply) => {
    const p = z.object({
      kinds: z.record(z.boolean()).default({}),
      quietFrom: z.number().int().min(0).max(23).default(22),
      quietTo: z.number().int().min(0).max(23).default(8),
      channel: z.enum(['private', 'group', 'both']).default('private'),
    }).safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: 'invalidInput' });
    await db.insert(notificationPrefs).values({ userId: req.user!.id, ...p.data })
      .onConflictDoUpdate({ target: notificationPrefs.userId, set: p.data });
    return p.data;
  });

  // Class: bind-code for /link in a group, channel override, current chat
  app.post('/api/classes/:id/link-token', { preHandler: app.authenticateTeacher }, async (req, reply) => {
    const p = z.object({ id: z.string().uuid() }).safeParse(req.params);
    if (!p.success) return reply.code(404).send({ error: 'notFound' });
    const cls = await resolveClass(db, req.user!.id, 'teacher', p.data.id);
    if (!cls) return reply.code(404).send({ error: 'notFound' });
    const code = randomBytes(6).toString('base64url').toUpperCase().replace(/[^A-Z2-9]/g, 'K');
    await db.insert(classLinkTokens).values({
      tokenHash: hashToken(code), classId: cls.id, createdBy: req.user!.id,
      expiresAt: new Date(Date.now() + 15 * 60_000),
    });
    return reply.code(201).send({ code });
  });

  app.get('/api/classes/:id/telegram', { preHandler: app.authenticateTeacher }, async (req, reply) => {
    const p = z.object({ id: z.string().uuid() }).safeParse(req.params);
    if (!p.success) return reply.code(404).send({ error: 'notFound' });
    const cls = await resolveClass(db, req.user!.id, 'teacher', p.data.id);
    if (!cls) return reply.code(404).send({ error: 'notFound' });
    const chats = await db.select({ chatId: classTelegramChats.chatId }).from(classTelegramChats)
      .where(eq(classTelegramChats.classId, cls.id));
    const pref = await db.select().from(classNotifyPrefs).where(eq(classNotifyPrefs.classId, cls.id)).limit(1);
    return { chats: chats.map((c) => c.chatId), channel: pref[0]?.channel ?? 'private' };
  });

  app.put('/api/classes/:id/notify-channel', { preHandler: app.authenticateTeacher }, async (req, reply) => {
    const p = z.object({ id: z.string().uuid() }).safeParse(req.params);
    const b = z.object({ channel: z.enum(['private', 'group', 'both']) }).safeParse(req.body);
    if (!p.success || !b.success) return reply.code(400).send({ error: 'invalidInput' });
    const cls = await resolveClass(db, req.user!.id, 'teacher', p.data.id);
    if (!cls) return reply.code(404).send({ error: 'notFound' });
    await db.insert(classNotifyPrefs).values({ classId: cls.id, channel: b.data.channel })
      .onConflictDoUpdate({ target: classNotifyPrefs.classId, set: { channel: b.data.channel } });
    return { ok: true };
  });

  app.delete('/api/classes/:id/telegram/:chatId', { preHandler: app.authenticateTeacher }, async (req, reply) => {
    const p = z.object({ id: z.string().uuid(), chatId: z.string().min(1) }).safeParse(req.params);
    if (!p.success) return reply.code(400).send({ error: 'invalidInput' });
    const cls = await resolveClass(db, req.user!.id, 'teacher', p.data.id);
    if (!cls) return reply.code(404).send({ error: 'notFound' });
    await db.delete(classTelegramChats).where(and(
      eq(classTelegramChats.classId, cls.id),
      eq(classTelegramChats.chatId, p.data.chatId),
    ));
    return { ok: true };
  });
}
