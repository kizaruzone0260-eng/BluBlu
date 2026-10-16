/**
 * Часть A5 (2026-10-16): `scheduleFlush` был мёртвым кодом — pg-boss-очередь `notify-flush`
 * создавалась, воркер стоял, но заданий в неё не клал никто, и вся доставка держалась на
 * 30-секундном heartbeat. Тест проверяет ровно одно: ряд, который реально встал в очередь,
 * будит воркера на СВОЙ `send_at`, а дубликат (dedupe_key уже есть) — не будует вовсе.
 *
 * Модуль `notifyQueue` подменён целиком: здесь важен вызов, а не pg-boss (его воркер в юнит-
 *прогоне не запускается, и реальный `boss.send` требовал бы отдельной схемы `pgboss`).
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

vi.mock('../../src/services/notifyQueue.js', () => ({
  scheduleFlush: vi.fn(),
  classTitle: vi.fn(async () => 'Класс'),
  initNotifyWorker: vi.fn(),
  stopNotifyWorker: vi.fn(),
  schedulePostPublish: vi.fn(),
}));

import { scheduleFlush } from '../../src/services/notifyQueue.js';
import { enqueueNotification } from '../../src/services/notify.js';
import { TEST_DATABASE_URL, preparedDb, makeTeacher, type TestDB } from './util.js';
import {
  classes, classMembers, notificationPrefs, notifications, telegramLinks, users,
} from '../../src/db/schema.js';

const suite = TEST_DATABASE_URL ? describe : describe.skip;

suite('A5: постановка в очередь будит воркера (scheduleFlush подключён)', () => {
  let t: TestDB;
  let classId = '';
  let studentId = '';

  beforeAll(async () => {
    t = await preparedDb(TEST_DATABASE_URL);
    vi.mocked(scheduleFlush).mockClear();
    const teacher = await makeTeacher(t.sql, `flushT${Date.now()}@x.io`);
    const [cls] = await t.db.insert(classes).values({ teacherId: teacher.id, name: `Класс флаша ${Date.now()}` }).returning();
    classId = cls!.id;
    studentId = randomUUID();
    await t.db.insert(users).values({
      id: studentId, role: 'student', name: 'Флеш', email: `flushS${Date.now()}@x.io`,
      passwordHash: 'x', locale: 'ru', localeExplicit: true, tz: 'Asia/Tashkent',
    });
    await t.db.insert(classMembers).values({ classId, userId: studentId });
    await t.db.insert(telegramLinks).values({ userId: studentId, chatId: `9${String(Date.now()).slice(-9)}` });
    await t.db.insert(notificationPrefs).values({ userId: studentId, quietFrom: 8, quietTo: 8 });
  });
  afterAll(async () => { await t?.sql.end(); });

  it('один вставленный ряд ⇒ один вызов scheduleFlush именно на его send_at', async () => {
    const when = new Date(Date.now() + 3600_000);
    const base = `flush:${randomUUID()}`;
    expect(await enqueueNotification(t.db, {
      kind: 'materialNew', classId, when,
      params: { title: 'Домашка', class: 'Класс флаша' }, dedupeBase: base,
    })).toBe(1);
    const [row] = await t.db.select().from(notifications).where(sql`dedupe_key like ${base + '%'}`);
    const calls = vi.mocked(scheduleFlush).mock.calls.map((c) => c[0].getTime());
    expect(calls, 'воркер разбужен на время отправки этого ряда').toContain(row!.sendAt.getTime());
    expect(row!.sendAt.getTime()).toBe(when.getTime());
  });

  it('дубликат по dedupe_key ничего не вставляет и не будует воркера', async () => {
    const when = new Date(Date.now() + 7200_000);
    const base = `flush:${randomUUID()}`;
    const args = {
      kind: 'announcementNew' as const, classId, when,
      params: { title: 'Собрание', class: 'Класс флаша' }, dedupeBase: base,
    };
    expect(await enqueueNotification(t.db, args)).toBe(1);
    const before = vi.mocked(scheduleFlush).mock.calls.length;
    expect(await enqueueNotification(t.db, args)).toBe(0);
    expect(vi.mocked(scheduleFlush).mock.calls.length, 'повторной постановки ⇒ повторного пробуждения нет').toBe(before);
    const rows = await t.db.select({ id: notifications.id }).from(notifications)
      .where(eq(notifications.dedupeKey, `${base}|u:${studentId}`));
    expect(rows).toHaveLength(1);
  });
});
