import { and, eq, inArray, isNull, lte, sql, or } from 'drizzle-orm';
import { randomBytes, createHash } from 'node:crypto';
import {
  notifications, notificationPrefs, telegramLinks, telegramTokens,
  classTelegramChats, classNotifyPrefs, users, classMembers,
} from '../db/schema.js';
import type { DB } from '../db/index.js';
import { env } from '../env.js';
import { listEventsInRange } from './events.js';

export type NotifyKind =
  | 'eventNew' | 'eventChanged' | 'eventCancelled'
  | 'reminder24h' | 'reminder1h' | 'reminder10m'
  | 'lessonStarted' | 'materialNew' | 'announcementNew';

export interface TransportResult {
  ok?: boolean; retryAfterSec?: number; blocked?: boolean; error?: string;
}
export interface NotifyTransport {
  send(chatId: string, text: string): Promise<TransportResult>;
}

/** Capture transport for tests/dev (TELEGRAM_TRANSPORT=log). */
export class LogTransport implements NotifyTransport {
  sent: { chatId: string; text: string }[] = [];
  async send(chatId: string, text: string): Promise<TransportResult> {
    this.sent.push({ chatId, text });
    if (process.env.TEST_TRANSPORT_FAIL === '429') return { retryAfterSec: 5 };
    if (process.env.TEST_TRANSPORT_FAIL === '403') return { blocked: true };
    return { ok: true };
  }
}
export class TelegramTransport implements NotifyTransport {
  constructor(private bot: { api: { sendMessage: (chatId: string, text: string) => Promise<unknown> } }) {}
  async send(chatId: string, text: string): Promise<TransportResult> {
    try {
      await this.bot.api.sendMessage(chatId, text);
      return { ok: true };
    } catch (e) {
      const err = e as { error_code?: number; description?: string; parameters?: { retry_after?: number } };
      if (err.error_code === 429) return { retryAfterSec: err.parameters?.retry_after ?? 3 };
      if (err.error_code === 403) return { blocked: true };
      return { error: err.description ?? 'send failed' };
    }
  }
}

// ─── texts ru/uz (§3.9: короткие, со ссылкой, без вложений) ───────────────────

const T: Record<NotifyKind, { ru: (p: Record<string, string>) => string; uz: (p: Record<string, string>) => string }> = {
  eventNew: {
    ru: (p) => `Новое событие: ${p.title} — ${p.when} (${p.class}).\n${p.url}`,
    uz: (p) => `Yangi tadbir: ${p.title} — ${p.when} (${p.class}).\n${p.url}`,
  },
  eventChanged: {
    ru: (p) => `Событие изменено: ${p.title} — ${p.when} (${p.class}).\n${p.url}`,
    uz: (p) => `Tadbir o'zgardi: ${p.title} — ${p.when} (${p.class}).\n${p.url}`,
  },
  eventCancelled: {
    ru: (p) => `Событие отменено: ${p.title} (${p.class}).`,
    uz: (p) => `Tadbir bekor qilindi: ${p.title} (${p.class}).`,
  },
  reminder24h: {
    ru: (p) => `Напоминание: завтра ${p.time} — ${p.title} (${p.class}).\n${p.url}`,
    uz: (p) => `Eslatma: ertaga ${p.time} — ${p.title} (${p.class}).\n${p.url}`,
  },
  reminder1h: {
    ru: (p) => `Через час — ${p.title} (${p.class}) в ${p.time}.\n${p.url}`,
    uz: (p) => `Bir soatdan — ${p.title} (${p.class}) ${p.time}.\n${p.url}`,
  },
  reminder10m: {
    ru: (p) => `Через 10 минут — ${p.title} (${p.class}).\n${p.url}`,
    uz: (p) => `10 daqiqadan so'ng — ${p.title} (${p.class}).\n${p.url}`,
  },
  lessonStarted: {
    ru: (p) => `Урок начался: ${p.title} (${p.class}). Вход: ${p.lessonUrl}`,
    uz: (p) => `Dars boshlandi: ${p.title} (${p.class}). Kirish: ${p.lessonUrl}`,
  },
  materialNew: {
    ru: (p) => `Новый материал: ${p.title} (${p.class}).\n${p.url}`,
    uz: (p) => `Yangi material: ${p.title} (${p.class}).\n${p.url}`,
  },
  announcementNew: {
    ru: (p) => `Объявление: ${p.title} (${p.class}).\n${p.url}`,
    uz: (p) => `E'lon: ${p.title} (${p.class}).\n${p.url}`,
  },
};

export function siteUrl(): string {
  // demo (Cloudflare Tunnel / any public origin override) wins over the
  // production DOMAIN logic.
  if (env.PUBLIC_URL) return env.PUBLIC_URL.replace(/\/+$/, '');
  return env.DOMAIN ? `https://${env.DOMAIN}` : env.PUBLIC_WEB_ORIGIN;
}

const hash = (s: string) => createHash('sha256').update(s).digest('hex');
export const newOpaqueToken = () => randomBytes(16).toString('base64url');
export const hashToken = hash;

// ─── prefs & quiet hours ──────────────────────────────────────────────────────

export async function getPrefs(db: DB, userId: string) {
  const [p] = await db.select().from(notificationPrefs).where(eq(notificationPrefs.userId, userId)).limit(1);
  return p ?? { userId, kinds: {}, quietFrom: 22, quietTo: 8, channel: 'private' as const };
}

const REMINDER_OFFSETS: { kind: NotifyKind; minutes: number }[] = [
  { kind: 'reminder24h', minutes: 24 * 60 },
  { kind: 'reminder1h', minutes: 60 },
  { kind: 'reminder10m', minutes: 10 },
];
export { REMINDER_OFFSETS };

/** Shift `when` out of the user's quiet window (except lessonStarted). */
export function applyQuietHours(
  kind: NotifyKind, when: Date, quietFrom: number, quietTo: number, tz: string,
): Date {
  if (kind === 'lessonStarted') return when;
  if (quietFrom === quietTo) return when;
  const fmt = (d: Date) => Number(new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hour: '2-digit', hour12: false,
  }).format(d));
  const inQuiet = (d: Date) => {
    const h = fmt(d);
    return quietFrom < quietTo ? h >= quietFrom && h < quietTo : h >= quietFrom || h < quietTo;
  };
  let t = new Date(when);
  let guard = 0;
  while (inQuiet(t) && guard < 3) {
    // move to next quietTo boundary (local)
    const add = 60 * 60_000; // walk hourly then fine-grain by minute
    while (inQuiet(t)) t = new Date(t.getTime() + add);
    guard++;
  }
  return t;
}

// ─── enqueue ──────────────────────────────────────────────────────────────────

export interface EnqueueArgs {
  kind: NotifyKind;
  classId: string;
  /** occurrence time for reminders, event/lesson time otherwise */
  when: Date;
  params: Record<string, string>;
  /** stable base for dedupe, e.g. `evt:<id>:<occStart>` or `post:<id>` */
  dedupeBase: string;
  /** exclude the actor from personal notices (teacher made the post) */
  excludeUserId?: string;
}

/**
 * §3.9 fan-out: per-class channel decides group/private/both; personal notices
 * go only to linked, unblocked users with the kind enabled; duplicates are
 * impossible thanks to the unique dedupe_key.
 */
export async function enqueueNotification(db: DB, a: EnqueueArgs): Promise<number> {
  const channelRow = await db.select().from(classNotifyPrefs).where(eq(classNotifyPrefs.classId, a.classId)).limit(1);
  const channel = channelRow[0]?.channel ?? 'private';
  const members = await db.select({ userId: classMembers.userId }).from(classMembers)
    .where(eq(classMembers.classId, a.classId));
  const teacherRows = await db.execute(sql`select teacher_id from classes where id = ${a.classId}`);
  const teacherId = String((teacherRows as unknown as { teacher_id: string }[])[0]?.teacher_id ?? '');
  const allUserIds = [...new Set([...members.map((m) => m.userId), teacherId])].filter((id) => id && id !== a.excludeUserId);
  const locales = allUserIds.length
    ? await db.select({ id: users.id, locale: users.locale, tz: users.tz })
        .from(users).where(inArray(users.id, allUserIds))
    : [];
  const inserted: string[] = [];

  if (channel === 'group' || channel === 'both') {
    const chats = await db.select().from(classTelegramChats).where(eq(classTelegramChats.classId, a.classId));
    for (const chat of chats) {
      const key = `${a.dedupeBase}|g:${chat.chatId}`;
      const did = await tryInsert(db, a, key, null, chat.chatId, 'ru', a.when);
      if (did) inserted.push(did);
    }
  }
  if (channel === 'private' || channel === 'both') {
    for (const u of locales) {
      const prefs = await getPrefs(db, u.id);
      if (prefs.kinds[a.kind] === false) continue;
      const link = await db.select().from(telegramLinks)
        .where(and(eq(telegramLinks.userId, u.id), isNull(telegramLinks.blockedAt))).limit(1);
      if (!link[0]) continue; // no /start — never write first (§3.9 acceptance)
      const key = `${a.dedupeBase}|u:${u.id}`;
      const sendAt = applyQuietHours(a.kind, a.when, prefs.quietFrom, prefs.quietTo, u.tz);
      const did = await tryInsert(db, { ...a, when: sendAt }, key, u.id, link[0].chatId, u.locale, sendAt);
      if (did) inserted.push(did);
    }
  }
  return inserted.length;
}

async function tryInsert(
  db: DB, a: EnqueueArgs, key: string, userId: string | null, chatId: string,
  locale: 'ru' | 'uz', sendAt: Date,
): Promise<string | null> {
  const text = T[a.kind][locale]({ ...a.params, url: siteUrl(), lessonUrl: a.params.lessonUrl ?? siteUrl(), when: '' });
  const [row] = await db.insert(notifications).values({
    kind: a.kind, classId: a.classId, userId, chatId,
    payload: { text, params: a.params },
    dedupeKey: key, sendAt,
  }).onConflictDoNothing().returning({ id: notifications.id });
  return row?.id ?? null;
}

// ─── sender ───────────────────────────────────────────────────────────────────

/** One pass over due notifications. Returns number processed. */
export async function sendDue(db: DB, transport: NotifyTransport, now = new Date(), limit = 25): Promise<number> {
  const rows = await db.execute(sql`
    SELECT id, chat_id, user_id AS "userId", kind, attempts FROM notifications
     WHERE status = 'pending' AND send_at <= ${now.toISOString()}::timestamptz
     ORDER BY send_at LIMIT ${limit}
     FOR UPDATE SKIP LOCKED`);
  const list = (Array.isArray(rows) ? rows : (rows as { rows?: unknown[] }).rows ?? []) as
    { id: string; chat_id: string | null; userId: string | null; kind: string; attempts: number }[];
  for (const r of list) {
    if (!r.chat_id) { await finish(db, r.id, 'skipped', 'no chat'); continue; }
    const [full] = await db.select().from(notifications).where(eq(notifications.id, r.id)).limit(1);
    if (!full || full.status !== 'pending') continue;
    const text = String((full.payload as { text?: string }).text ?? '');
    const res = await transport.send(r.chat_id, text);
    if (res.ok) { await finish(db, r.id, 'sent'); continue; }
    if (res.blocked) {
      await db.update(telegramLinks).set({ blockedAt: now }).where(eq(telegramLinks.chatId, r.chat_id));
      await finish(db, r.id, 'blocked', '403');
      continue;
    }
    if (res.retryAfterSec !== undefined) {
      // 429: exponential-ish backoff driven by Telegram's own hint
      await db.update(notifications).set({
        status: 'pending',
        sendAt: new Date(now.getTime() + res.retryAfterSec * 1000),
        attempts: full.attempts + 1,
        lastError: '429',
      }).where(eq(notifications.id, r.id));
      continue;
    }
    const attempts = full.attempts + 1;
    if (attempts >= 6) { await finish(db, r.id, 'failed', res.error ?? 'error'); continue; }
    await db.update(notifications).set({
      sendAt: new Date(now.getTime() + Math.min(2 ** attempts, 600) * 1000),
      attempts, lastError: res.error ?? 'error',
    }).where(eq(notifications.id, r.id));
  }
  return list.length;
}

async function finish(db: DB, id: string, status: 'sent' | 'failed' | 'blocked' | 'skipped', error?: string) {
  await db.update(notifications).set({ status, lastError: error ?? null }).where(eq(notifications.id, id));
}

// ─── reminder scheduler tick (§3.5 reminders 24h/1h/10m) ─────────────────────

/**
 * Scans occurrences in the next 24 h and enqueues reminders whose trigger time
 * has arrived. Safe to run every minute: dedupe_key makes it idempotent.
 */
export async function scanReminders(db: DB, now = new Date()): Promise<number> {
  const horizon = new Date(now.getTime() + 30 * 60_000); // triggers only in the next 30 min
  const scanUntil = new Date(now.getTime() + 48 * 3600_000 + 60_000); // occurrences up to 48 h ahead
  const allUsers = await db.select({ id: users.id }).from(users).where(isNull(users.deletedAt));
  let count = 0;
  for (const u of allUsers) {
    const [link] = await db.select().from(telegramLinks)
      .where(and(eq(telegramLinks.userId, u.id), isNull(telegramLinks.blockedAt))).limit(1);
    if (!link) continue;
    const prefs = await getPrefs(db, u.id);
    for (const role of ['student', 'teacher'] as const) {
      if (role === 'teacher') {
        const [isT] = await db.select({ id: users.id }).from(users)
          .where(and(eq(users.id, u.id), eq(users.role, 'teacher'))).limit(1);
        if (!isT) continue;
      }
      const occ = await listEventsInRange(db, u.id, role, now, scanUntil);
      for (const o of occ) {
        const startMs = +new Date(o.startsAt);
        for (const r of REMINDER_OFFSETS) {
          if (prefs.kinds[r.kind] === false) continue;
          const trigger = startMs - r.minutes * 60_000;
          if (trigger < now.getTime() - 60_000 || trigger > horizon.getTime()) continue;
          // only enqueue if the window for THIS tick would have fired (avoid stale backlog)
          const local = new Intl.DateTimeFormat('en-GB', { timeZone: o.tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(startMs));
          const id = await tryInsertForUser(db, u.id, link.chatId, r.kind, o.classId, {
            title: o.title, class: o.className, time: local, url: `${siteUrl()}/calendar`,
          }, `rem:${o.uid}:${r.minutes}`, new Date(trigger));
          if (id) count++;
        }
      }
    }
  }
  return count;
}

async function tryInsertForUser(
  db: DB, userId: string, chatId: string, kind: NotifyKind, classId: string,
  params: Record<string, string>, key: string, sendAtRaw: Date,
): Promise<string | null> {
  const [u] = await db.select({ locale: users.locale, tz: users.tz }).from(users).where(eq(users.id, userId)).limit(1);
  if (!u) return null;
  const prefs = await getPrefs(db, userId);
  const sendAt = applyQuietHours(kind, sendAtRaw, prefs.quietFrom, prefs.quietTo, u.tz);
  const text = T[kind][u.locale]({ ...params, url: siteUrl(), lessonUrl: siteUrl() });
  const [row] = await db.insert(notifications).values({
    kind, classId, userId, chatId, payload: { text, params },
    dedupeKey: `${key}|u:${userId}`, sendAt,
  }).onConflictDoNothing().returning({ id: notifications.id });
  return row?.id ?? null;
}

// ─── link tokens (§3.9) ───────────────────────────────────────────────────────

export async function createLinkToken(db: DB, userId: string): Promise<{ token: string; url: string }> {
  const token = newOpaqueToken();
  await db.insert(telegramTokens).values({
    tokenHash: hash(token), userId,
    expiresAt: new Date(Date.now() + 15 * 60_000), // TTL 15 min
  });
  const botName = env.TELEGRAM_BOT_NAME;
  return { token, url: `https://t.me/${botName}?start=${token}` };
}

export async function consumeLinkToken(db: DB, token: string, chatId: string): Promise<boolean> {
  const rows = await db.execute(sql`
    DELETE FROM telegram_tokens
     WHERE token_hash = ${hash(token)} AND expires_at > now()
    RETURNING user_id`);
  const list = (Array.isArray(rows) ? rows : (rows as { rows?: unknown[] }).rows ?? []) as { user_id: string }[];
  const userId = list[0]?.user_id;
  if (!userId) return false;
  await db.insert(telegramLinks).values({ userId, chatId })
    .onConflictDoUpdate({ target: telegramLinks.userId, set: { chatId, linkedAt: new Date(), blockedAt: null } });
  return true;
}

export async function unlinkUser(db: DB, userId: string) {
  await db.delete(telegramLinks).where(eq(telegramLinks.userId, userId));
}
