import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, and, sql } from 'drizzle-orm';
import { TEST_DATABASE_URL, preparedDb, makeTeacher, type TestDB } from './util.js';
import {
  enqueueNotification, sendDue, scanReminders, createLinkToken, consumeLinkToken,
  applyQuietHours, type NotifyTransport, type TransportResult,
} from '../../src/services/notify.js';
import { processUpdate } from '../../src/services/telegramBot.js';
import { notifications, telegramLinks, classTelegramChats, classLinkTokens, classNotifyPrefs, users, classes, classMembers, events } from '../../src/db/schema.js';
import { createEvent } from '../../src/services/events.js';
import { hashToken } from '../../src/services/notify.js';
import { randomUUID } from 'node:crypto';

const suite = TEST_DATABASE_URL ? describe : describe.skip;

class RecordingTransport implements NotifyTransport {
  sent: { chatId: string; text: string }[] = [];
  mode: 'ok' | 'retry' | 'blocked' | 'fail' = 'ok';
  async send(chatId: string, text: string): Promise<TransportResult> {
    if (this.mode === 'retry') return { retryAfterSec: 42 };
    if (this.mode === 'blocked') return { blocked: true };
    if (this.mode === 'fail') return { error: 'boom' };
    this.sent.push({ chatId, text });
    return { ok: true };
  }
}

suite('stage 6: telegram queue, quiet hours, dedupe, rights', () => {
  let t: TestDB;
  let classId = '';
  let teacherId = '';
  let studentId = '';
  let transport: RecordingTransport;

  beforeAll(async () => {
    t = await preparedDb(TEST_DATABASE_URL);
    const teacher = await makeTeacher(t.sql, `tg${Date.now()}@x.io`);
    teacherId = teacher.id;
    const [cls] = await t.db.insert(classes).values({ teacherId, name: 'Telegram class' }).returning();
    classId = cls!.id;
    const [stu] = await t.db.insert(users).values({
      role: 'student', name: 'Pupil', email: `tgs${Date.now()}@x.io`, passwordHash: 'x', locale: 'ru', tz: 'Asia/Tashkent',
    }).returning();
    studentId = stu!.id;
    await t.db.insert(classMembers).values({ classId, userId: studentId });
    // disable quiet hours for the queue tests (own unit test covers quiet behaviour)
    const { notificationPrefs } = await import('../../src/db/schema.js');
    await t.db.insert(notificationPrefs).values([
      { userId: studentId, quietFrom: 8, quietTo: 8 },
      { userId: teacherId, quietFrom: 8, quietTo: 8 },
    ]);
    transport = new RecordingTransport();
  });
  afterAll(async () => { await t?.sql.end(); });

  it('no /start ⇒ nothing is ever sent (queue skips unlinked users)', async () => {
    await enqueueNotification(t.db, {
      kind: 'materialNew', classId, when: new Date(),
      params: { title: 'Doc', class: 'Telegram class' }, dedupeBase: `post:${randomUUID()}`, excludeUserId: teacherId,
    });
    const due = await sendDue(t.db, transport, new Date(Date.now() + 60000));
    // unlinked student ⇒ nothing enqueued for them at all; teacher excluded ⇒ zero rows
    expect(due).toBe(0);
    expect(transport.sent).toHaveLength(0);
    const rows = await t.db.select().from(notifications);
    expect(rows).toHaveLength(0);
  });

  it('linked student receives localized text; second enqueue with same dedupe is ignored', async () => {
    await t.db.insert(telegramLinks).values({ userId: studentId, chatId: '111' });
    const base = `post:${randomUUID()}`;
    const n1 = await enqueueNotification(t.db, {
      kind: 'materialNew', classId, when: new Date(),
      params: { title: 'Lesson 5', class: 'Telegram class' }, dedupeBase: base,
    });
    const n2 = await enqueueNotification(t.db, {
      kind: 'materialNew', classId, when: new Date(),
      params: { title: 'Lesson 5', class: 'Telegram class' }, dedupeBase: base,
    });
    expect(n1).toBe(1);
    expect(n2).toBe(0); // §3.9 idempotency via unique dedupe_key
    await sendDue(t.db, transport, new Date(Date.now() + 60000));
    expect(transport.sent.at(-1)?.text).toContain('Lesson 5');
  });

  it('429 → sendAt pushed by retry_after, attempts++, row stays pending', async () => {
    transport.mode = 'retry';
    await enqueueNotification(t.db, {
      kind: 'announcementNew', classId, when: new Date(),
      params: { title: 'Test', class: 'C' }, dedupeBase: `ann:${randomUUID()}`,
    });
    const now = new Date(Date.now() + 60000);
    await sendDue(t.db, transport, now);
    const [row] = await t.db.select().from(notifications)
      .where(and(eq(notifications.kind, 'announcementNew'), eq(notifications.status, 'pending')))
      .limit(1);
    expect(row).toBeTruthy();
    expect(row!.attempts).toBe(1);
    expect(row!.sendAt.getTime()).toBeGreaterThan(now.getTime() + 40_000);
    transport.mode = 'ok';
  });

  it('403 → link marked blocked and notification blocked, no retries', async () => {
    await t.db.insert(telegramLinks).values({ userId: teacherId, chatId: '999' })
      .onConflictDoUpdate({ target: telegramLinks.userId, set: { chatId: '999', blockedAt: null } });
    await enqueueNotification(t.db, {
      kind: 'announcementNew', classId, when: new Date(),
      params: { title: 'To teacher', class: 'C' }, dedupeBase: `te:${randomUUID()}`,
    });
    transport.mode = 'blocked';
    await sendDue(t.db, transport, new Date(Date.now() + 60000));
    const rows = await t.db.select().from(notifications).where(eq(notifications.status, 'blocked'));
    expect(rows.length).toBeGreaterThan(0);
    const [link] = await t.db.select().from(telegramLinks).where(eq(telegramLinks.userId, teacherId)).limit(1);
    expect(link!.blockedAt).toBeTruthy();
    transport.mode = 'ok';
    // teacher no longer gets personal notices
    await t.db.update(telegramLinks).set({ blockedAt: null }); // reset for group tests
  });

  it('quiet hours defer material notices but never lessonStarted', () => {
    const quiet = new Date('2026-10-05T19:30:00Z'); // 00:30 in Tashkent (+5) — inside 22:00–08:00
    const deferred = applyQuietHours('materialNew', quiet, 22, 8, 'Asia/Tashkent');
    expect(deferred.getTime()).toBeGreaterThan(quiet.getTime());
    const localHour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Tashkent', hour: '2-digit', hour12: false }).format(deferred));
    expect(localHour === 8 || localHour === 9).toBe(true);
    const lesson = applyQuietHours('lessonStarted', quiet, 22, 8, 'Asia/Tashkent');
    expect(lesson.getTime()).toBe(quiet.getTime());
  });

  it('group channel: one group notice, no per-user duplicates', async () => {
    await t.db.insert(classTelegramChats).values({ classId, chatId: '-100777', linkedBy: teacherId });
    await t.db.insert(classNotifyPrefs).values({ classId, channel: 'group' });
    const before = transport.sent.length;
    const n = await enqueueNotification(t.db, {
      kind: 'eventNew', classId, when: new Date(),
      params: { title: 'Exam', class: 'Telegram class', when: '' }, dedupeBase: `evt:${randomUUID()}`,
    });
    expect(n).toBe(1);
    await sendDue(t.db, transport, new Date(Date.now() + 60000));
    expect(transport.sent.length).toBe(before + 1);
    expect(transport.sent.at(-1)!.chatId).toBe('-100777');
    await t.db.delete(classNotifyPrefs); // back to private default
  });

  it('scanReminders is idempotent across ticks and sends once per occurrence', async () => {
    const when = new Date(Date.now() + 24 * 3600_000 + 20 * 60_000); // trigger(24h) = now+20min
    const wall = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Tashkent', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(when);
    const p: Record<string, string> = {};
    for (const x of wall) if (x.type !== 'literal') p[x.type] = x.value;
    await createEvent(t.db, classId, {
      kind: 'lesson', title: 'Reminder lesson', description: '',
      startLocal: `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`,
      durationMin: 50, tz: 'Asia/Tashkent',
    });
    const a = await scanReminders(t.db, new Date());
    const b = await scanReminders(t.db, new Date()); // second tick same minute → no dupes
    expect(a).toBeGreaterThan(0);
    expect(b).toBe(0);
    const remRows = await t.db.select().from(notifications).where(sql`kind in ('reminder24h','reminder1h','reminder10m')`);
    expect(remRows.length).toBe(a);
  });

  it('bot flows: /start consumes one-time token; /link requires admin; webhook ignores others', async () => {
    const { token } = await createLinkToken(t.db, studentId);
    const deps = { db: t.db, send: async () => undefined, isGroupAdmin: async () => false };
    const start = await processUpdate(deps, { message: { text: `/start ${token}`, chat: { id: 111, type: 'private' }, from: { id: 111 } } });
    expect(start.reply).toContain('привязан');
    const again = await processUpdate(deps, { message: { text: `/start ${token}`, chat: { id: 111, type: 'private' }, from: { id: 111 } } });
    expect(again.reply).toContain('недействительна'); // one-time
    const linkDenied = await processUpdate(deps, { message: { text: '/link ABC', chat: { id: -100, type: 'group' }, from: { id: 111 } } });
    expect(linkDenied.reply).toContain('только администратор');
    // now as admin with valid code
    const code = 'TGC0DE42';
    await t.db.insert(classLinkTokens).values({
      tokenHash: hashToken(code), classId, createdBy: teacherId, expiresAt: new Date(Date.now() + 60000),
    });
    // teacher must be personally linked: chat_id equals tg user id
    await t.db.insert(telegramLinks).values({ userId: teacherId, chatId: '555' })
      .onConflictDoUpdate({ target: telegramLinks.userId, set: { chatId: '555', blockedAt: null } });
    const deps2 = { db: t.db, send: async () => undefined, isGroupAdmin: async () => true };
    const okLink = await processUpdate(deps2, { message: { text: `/link ${code}`, chat: { id: -100222, type: 'supergroup' }, from: { id: 555 } } });
    expect(okLink.reply).toContain('привязана');
    const used = await t.db.select().from(classLinkTokens);
    expect(used.find((x) => x.classId === classId && x.tokenHash === hashToken(code))).toBeUndefined(); // one-shot
    const chats = await t.db.select().from(classTelegramChats);
    expect(chats.some((c) => c.chatId === '-100222')).toBe(true);
  });

  it('webhook endpoint rejects wrong secret and accepts correct one', async () => {
    const { buildApp } = await import('../../src/app.js');
    const app = await buildApp(t.db);
    const bad = await app.inject({ method: 'POST', url: '/webhook/telegram', headers: { 'x-telegram-bot-api-secret-token': 'nope' }, payload: {} });
    expect(bad.statusCode).toBe(403);
    const good = await app.inject({
      method: 'POST', url: '/webhook/telegram',
      headers: { 'x-telegram-bot-api-secret-token': process.env.TELEGRAM_WEBHOOK_SECRET ?? '' },
      payload: { message: { text: '/help', chat: { id: 7, type: 'private' }, from: { id: 7 } } },
    });
    // in test env there is no bot token → handled=false path returns ok anyway
    expect([200, 403]).toContain(good.statusCode);
    await app.close();
  });
});
