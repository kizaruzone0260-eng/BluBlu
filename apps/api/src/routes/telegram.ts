import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import type { Bot } from 'grammy';
import type { DB } from '../db/index.js';
import { env } from '../env.js';
import {
  createLinkToken, unlinkUser, getPrefs, telegramReady,
} from '../services/notify.js';
import { notificationPrefs, classNotifyPrefs, classTelegramChats, classLinkTokens, users, telegramLinks } from '../db/schema.js';
import { resolveClass } from '../services/classes.js';
import { createBot } from '../services/telegramBot.js';
import { handleUpdate, type BotDeps, type TgUpdate } from '../services/bot.js';
import { applyMenu, CapturingApi, grammyApi, removeMenu, type BotApi } from '../services/botApi.js';
import { randomBytes } from 'node:crypto';
import { hashToken } from '../services/notify.js';

/**
 * The bot API in use. With a real token + TELEGRAM_TRANSPORT=telegram it is
 * grammY; in tests/demo (TELEGRAM_TRANSPORT=log) it is a capturing fake so the
 * whole dispatcher runs without any Telegram network or token (§7).
 */
let botApi: BotApi | null = null;
export function getBotApi(db: DB, bot: Bot | null): BotApi {
  botApi ??= bot && env.TELEGRAM_TRANSPORT === 'telegram' ? grammyApi(bot) : new CapturingApi();
  return botApi;
}
/** test helper: the capturing api used by the app under test */
export function capturingApi(db: DB, bot: Bot | null): CapturingApi {
  const a = getBotApi(db, bot);
  if (!(a instanceof CapturingApi)) throw new Error('not in capture mode');
  return a;
}

/** Bot dependencies shared by the webhook route and the demo long-polling loop (server.ts). */
export function botDeps(db: DB, bot: Bot | null): BotDeps {
  const api = getBotApi(db, bot);
  return {
    db,
    api,
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

  // Webhook from Telegram (§6: answer fast, never throw, redeliveries are
  // deduped by the bot_updates ledger inside handleUpdate).
  app.post('/webhook/telegram', { config: { rateLimit: { max: 300, timeWindow: '1 minute' } } }, async (req, reply) => {
    const secret = req.headers['x-telegram-bot-api-secret-token'];
    if (!env.TELEGRAM_WEBHOOK_SECRET || secret !== env.TELEGRAM_WEBHOOK_SECRET) {
      return reply.code(403).send({ error: 'forbidden' });
    }
    const update = req.body as TgUpdate;
    if (typeof update?.update_id === 'number') {
      // cold start / handler bugs must not 500 back into Telegram's face
      await Promise.resolve(handleUpdate(deps, update)).catch((e: Error) =>
        req.log.warn(`telegram update failed: ${e?.message ?? String(e)}`));
    }
    return reply.send({ ok: true });
  });

  // Profile: link/unlink personal Telegram, notification prefs
  app.post('/api/me/telegram-link', { preHandler: app.authenticate }, async (req, reply) => {
    const res = await createLinkToken(db, req.user!.id);
    if (!res) return reply.code(400).send({ error: 'telegramNotConfigured' }); // item 5: no invented bot names
    return res;
  });

  app.delete('/api/me/telegram-link', { preHandler: app.authenticate }, async (req) => {
    const [link] = await db.select({ chatId: telegramLinks.chatId }).from(telegramLinks)
      .where(eq(telegramLinks.userId, req.user!.id)).limit(1);
    await unlinkUser(db, req.user!.id);
    if (link) {
      // §1: the role menu is revoked with the link
      await removeMenu(deps.api, link.chatId).catch(() => undefined);
      await applyMenu(deps.api, 'basic', link.chatId).catch(() => undefined);
    }
    return { ok: true };
  });

  app.get('/api/me/telegram-status', { preHandler: app.authenticate }, async (req) => {
    const [link] = await db.select({ linkedAt: telegramLinks.linkedAt, blockedAt: telegramLinks.blockedAt })
      .from(telegramLinks).where(eq(telegramLinks.userId, req.user!.id)).limit(1);
    return { linked: Boolean(link), blocked: Boolean(link?.blockedAt), configured: telegramReady() };
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
