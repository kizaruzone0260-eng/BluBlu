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
import { makeHomeworkAi } from '../services/homework/ai.js';
import { claimUpdate, processUpdate, type BotDeps, type TgUpdate } from '../services/bot.js';
import { applyMenu, CapturingApi, grammyApi, removeMenu, type BotApi } from '../services/botApi.js';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { redactSecrets } from '../lib/redact.js';
import { hashToken } from '../services/notify.js';

/**
 * Потолок числа ключей в словаре настроек уведомлений (задача 2026-10-27, часть A).
 *
 * Сегодня продукт знает пять видов уведомлений (`KIND_KEYS` в services/bot.ts), а `kinds` — это jsonb,
 * который пишется ЦЕЛИКОМ из тела запроса. Без потолка один аутентифицированный вызов может
 * положить в базу словарь из сотен тысяч ключей, и каждая последующая отправка уведомления
 * будет его перечитывать. 16 — это «все сегодняшние виды плюс запас на новые», а не произвольное
 * маленькое число: легитимный запрос никогда в него не упрётся.
 */
export const MAX_NOTIFY_KIND_KEYS = 16;

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
    homeworkAi: makeHomeworkAi(),
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

/**
 * A4 (2026-10-16): фон-обработка одного обновления после того, как маршрут уже ответил
 * Telegram. Счётчик нужен не для статистики: `pendingBotUpdates()` показывает, что работа
 * ещё идёт, а `drainBotUpdates()` даёт тестам дождаться побочных эффектов — иначе проверка
 * «что ушло в Telegram» читала бы пустоту сразу после ответа 200.
 * Ошибка наружу не уходит никогда: она идёт в `warn` уже очищенной от секретов, а строка
 * журнала остаётся без `processed_at` и добирается при следующем старте.
 */
let inFlight = 0;
export function queueBotUpdate(deps: BotDeps, update: TgUpdate, warn: (line: string) => void): void {
  inFlight++;
  void processUpdate(deps, update)
    .catch((e: Error) => warn(`telegram update failed: ${redactSecrets(e?.message ?? String(e))}`))
    .finally(() => { inFlight--; });
}
export function pendingBotUpdates(): number { return inFlight; }
export async function drainBotUpdates(timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (inFlight > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
}

export async function telegramRoutes(app: FastifyInstance, opts: { db: DB }) {
  const { db } = opts;
  const bot = createBot();

  const deps: BotDeps = botDeps(db, bot);

  // Webhook from Telegram (§6: answer fast, never throw, redeliveries are
  // deduped by the bot_updates ledger).
  app.post('/webhook/telegram', { config: { rateLimit: { max: 300, timeWindow: '1 minute' } } }, async (req, reply) => {
    const secret = req.headers['x-telegram-bot-api-secret-token'];
    // Hardening (Phase 1и): constant-time compare of the webhook shared secret,
    // and a missing configured secret still rejects every request (no bypass).
    const given = typeof secret === 'string' ? secret : '';
    const expected = env.TELEGRAM_WEBHOOK_SECRET;
    const a = Buffer.from(given, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    if (!expected || a.length !== b.length || !timingSafeEqual(a, b)) {
      return reply.code(403).send({ error: 'forbidden' });
    }
    const update = req.body as TgUpdate;
    if (typeof update?.update_id === 'number') {
      /*
       * Аудит бота, п.2 мерил, что ответ Telegram приходит ПОСЛЕ всей обработки: на холодном
       * Render это десятки секунд, а Telegram отрывает соединение и доставляет update заново.
       * Часть A4 (2026-10-16): в этом запросе остаётся только запись в журнал (её уникальный
       * ключ и есть защита от двойной доставки), действие уходит в фон. Фоновая задача не
       * должна унести процесс: ошибка пишется в лог, `processed_at` не ставится, и строку
       * добирает `reprocessUnfinished` при следующем старте.
       */
      const fresh = await claimUpdate(db, update).catch((e: Error) => {
        req.log.warn(`telegram ledger failed: ${redactSecrets(e?.message ?? String(e))}`);
        return false;
      });
      if (fresh) queueBotUpdate(deps, update, (m) => req.log.warn(m));
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
      // Zod 4 требует схему КЛЮЧА у `z.record` (в Zod 3 один аргумент означал «ключ — строка»).
      // Одновременно это потолок на число настроек: словарь уведомлений конечен (сегодня пять
      // ключей, см. `KIND_KEYS` в services/bot.ts), а словарь без ограничения ключей — готовый
      // способ прислать мегабайты мусора в jsonb и в разбор схемы (GHSA-mrhx-c7xc-m3w5).
      // Словарь не сужен до известных имён намеренно: прежний клиент мог прислать свой ключ,
      // и это не должно стать отказом — отказ здесь только про РАЗМЕР.
      kinds: z.record(z.string(), z.boolean())
        .refine((v) => Object.keys(v).length <= MAX_NOTIFY_KIND_KEYS, 'tooManyKeys')
        .default({}),
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
