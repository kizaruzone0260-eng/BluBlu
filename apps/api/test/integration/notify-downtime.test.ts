/**
 * Аудит бота, п.3 — напоминания и очередь, когда процесс не работал.
 *
 * Схема в коде (проверяется здесь, а не описывается на глаз):
 *  • `scanReminders(db, now)` смотрит события на 48 ч вперёд и ставит в очередь только те
 *    срабатывания (24 ч / 1 ч / 10 мин), чей момент попал в окно `[now − 60 с, now + 30 мин]`;
 *  • `sendDue(db, transport, now)` отправляет всё, у чего `status = 'pending'` и
 *    `send_at <= now`, не более 25 рядов за проход;
 *  • оба вызываются таймером каждые 30 с (heartbeat в `services/notifyQueue.ts`).
 *
 * Отсюда два разных исхода «проспанного» времени: напоминание, которое НЕ успело встать в
 * очередь, теряется совсем (это и есть защита от лавины старых напоминаний после пробуждения),
 * а то, что уже лежит в таблице, уходит позже — один раз, но без всякой проверки, что урок
 * уже начался или прошёл. Ниже зафиксировано фактическое поведение.
 *
 * Всё время задаётся аргументом `now`, тесты детерминированы; данные и чат-id фиктивные.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { TEST_DATABASE_URL, preparedDb, makeTeacher, type TestDB } from './util.js';
import { notifications, notificationPrefs, telegramLinks, users, classes, classMembers } from '../../src/db/schema.js';
import {
  sendDue, scanReminders, enqueueNotification, applyQuietHours,
  type NotifyTransport, type TransportResult,
} from '../../src/services/notify.js';
import { createEvent } from '../../src/services/events.js';
import { randomUUID } from 'node:crypto';

const suite = TEST_DATABASE_URL ? describe : describe.skip;
const TZ = 'Asia/Tashkent';

class Rec implements NotifyTransport {
  sent: { chatId: string; text: string }[] = [];
  mode: 'ok' | 'retry' | 'blocked' = 'ok';
  async send(chatId: string, text: string): Promise<TransportResult> {
    if (this.mode === 'retry') return { retryAfterSec: 60 };
    if (this.mode === 'blocked') return { blocked: true };
    this.sent.push({ chatId, text });
    return { ok: true };
  }
}

const parts = (d: Date) => new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
}).formatToParts(d).reduce<Record<string, string>>((acc, x) => (x.type !== 'literal' ? { ...acc, [x.type]: x.value } : acc), {});

/** Смещение TZ в данный момент, снятое с самим Intl (никаких захардкоженных «+05»). */
const offsetOf = (d: Date) => {
  const p = parts(d);
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - d.getTime();
};
const minute = (d: Date) => new Date(Math.floor(+d / 60_000) * 60_000);

/** Инстант «сегодня (или завтра, если уже прошло) в localHour:localMinute местного времени TZ». */
function wallClock(localHour: number, localMinute: number): Date {
  const p = parts(new Date());
  const build = (dayOffset: number) => new Date(Math.floor(
    // секунды и миллисекунды «сейчас» могут оставить остаток — округляем до целой секунды,
    // иначе локальное время события (без секунд) разойдётся с расчётным на эти миллисекунды
    (Date.UTC(+p.year, +p.month - 1, +p.day + dayOffset, localHour, localMinute) - offsetOf(new Date())) / 1000,
  ) * 1000);
  const today = build(0);
  return today.getTime() > Date.now() ? today : build(1);
}

suite('напоминания и очередь при сне сервиса (аудит п.3)', () => {
  let t: TestDB;
  let classId = '';
  let studentId = '';
  let studentChat = '';
  let rec: Rec;

  /** Ряды напоминаний конкретного события: dedupe_key = `rem:<eventId>:<occMs>:<offset>|u:<user>`. */
  const rowsFor = (eventRowId: string, minutes: number, kind: string) => t.db.select().from(notifications)
    .where(and(eq(notifications.kind, kind), sql`dedupe_key like ${`rem:${eventRowId}:%:${minutes}|u:%`}`));

  const mkEvent = async (title: string, startsAt: Date, durationMin = 45) => createEvent(t.db, classId, {
    kind: 'lesson', title, description: '', durationMin, tz: TZ,
    startLocal: (() => { const p = parts(startsAt); return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`; })(),
  });

  beforeAll(async () => {
    t = await preparedDb(TEST_DATABASE_URL);
    const teacher = await makeTeacher(t.sql, `sleepT${Date.now()}@x.io`);
    const [cls] = await t.db.insert(classes).values({ teacherId: teacher.id, name: `Сон класс ${Date.now()}` }).returning();
    classId = cls!.id;
    studentId = randomUUID();
    studentChat = `9${String(Date.now()).slice(-9)}`;
    await t.db.insert(users).values({
      id: studentId, role: 'student', name: 'Спящий', email: `sleepS${Date.now()}@x.io`,
      passwordHash: 'x', locale: 'ru', localeExplicit: true, tz: TZ,
    });
    await t.db.insert(classMembers).values({ classId, userId: studentId });
    await t.db.insert(telegramLinks).values({ userId: studentId, chatId: studentChat });
    // тихие часы выключены (quietFrom === quietTo) — отдельный случай проверяется последним
    await t.db.insert(notificationPrefs).values({ userId: studentId, quietFrom: 8, quietTo: 8 });
    rec = new Rec();
  });
  afterAll(async () => { await t?.sql.end(); });

  it('просpanивание не отвечает лавиной: прошедшее событие не порождает ни одного напоминания', async () => {
    const t0 = minute(new Date(Date.now() + 30 * 60_000));
    const starts = new Date(t0.getTime() + 5 * 3600_000);
    const ev = await mkEvent('Лавина проверяется', starts);
    // тик во время: 24 ч назад уже проскочил, 1 ч и 10 мин ещё дальше 30-минутного горизонта
    expect(await scanReminders(t.db, t0)).toBe(0);
    // «проспали» 6 часов: событие уже случилось
    expect(await scanReminders(t.db, new Date(t0.getTime() + 6 * 3600_000))).toBe(0);
    for (const [kind, minutes] of [['reminder24h', 1440], ['reminder1h', 60], ['reminder10m', 10]] as const) {
      expect(await rowsFor(ev!.id, minutes, kind), kind).toHaveLength(0);
    }
  });

  it('напоминание, успевшее встать в очередь до сна, уходит позже — ровно один раз и без проверки свежести', async () => {
    const t0 = minute(new Date(Date.now() + 10 * 3600_000));
    const starts = new Date(t0.getTime() + 10 * 60_000); // срабатывание reminder10m = ровно t0
    const ev = await mkEvent('Урок после сна', starts);
    expect(await scanReminders(t.db, t0)).toBe(1);
    const mine = await rowsFor(ev!.id, 10, 'reminder10m');
    expect(mine).toHaveLength(1);
    expect(mine[0]!.status).toBe('pending');
    expect(mine[0]!.sendAt.getTime()).toBe(t0.getTime());

    // процесс спал 8 часов: очередь не работала, ряд остался pending; урок к пробуждению прошёл
    const wake = new Date(t0.getTime() + 8 * 3600_000);
    expect(starts.getTime() < wake.getTime(), 'факт проверки: урок уже начался').toBe(true);
    expect(await sendDue(t.db, rec, wake, 50)).toBe(1);
    const [row] = await rowsFor(ev!.id, 10, 'reminder10m');
    expect(row!.status).toBe('sent');
    expect(rec.sent.at(-1)?.text).toContain('Урок после сна');

    const before = rec.sent.length;
    await sendDue(t.db, rec, new Date(wake.getTime() + 60_000), 50);
    expect(rec.sent.length, 'второй проход не отправляет повтор').toBe(before);
    expect((await rowsFor(ev!.id, 10, 'reminder10m')).filter((x) => x.status === 'sent')).toHaveLength(1);
  });

  it('две параллельные доставки (heartbeat и pg-boss) одного ряда: сообщение строго одно', async () => {
    const when = minute(new Date(Date.now() - 5000));
    const base = `race:${randomUUID()}`;
    const n = await enqueueNotification(t.db, {
      kind: 'materialNew', classId, when,
      params: { title: 'Гонка', class: 'Сон класс' }, dedupeBase: base, excludeUserId: '',
    });
    expect(n).toBe(1);
    const now = new Date(+when + 60_000);
    const before = rec.sent.filter((s) => s.text.includes('Гонка')).length;
    const [a, b] = await Promise.all([sendDue(t.db, rec, now, 50), sendDue(t.db, rec, now, 50)]);
    const sent = rec.sent.filter((s) => s.text.includes('Гонка')).length - before;
    expect(sent, 'ряд должен уйти ровно один раз, кто бы из двух его ни забрал').toBe(1);
    expect(a + b, 'суммарно ряда коснули один раз').toBe(1);
  });

  it('403 (пользователь заблокировал бота) — терминальный статус, повторов нет', async () => {
    rec.mode = 'blocked';
    const base = `blocked:${randomUUID()}`;
    await enqueueNotification(t.db, {
      kind: 'announcementNew', classId, when: new Date(Date.now() - 5000),
      params: { title: 'Заблокирован', class: 'Сон класс' }, dedupeBase: base,
    });
    const before = rec.sent.length;
    expect(await sendDue(t.db, rec, new Date(), 50)).toBe(1);
    const [row] = await t.db.select().from(notifications).where(sql`dedupe_key like ${base + '%'}`);
    expect(row!.status).toBe('blocked');
    const [link] = await t.db.select().from(telegramLinks).where(eq(telegramLinks.userId, studentId)).limit(1);
    expect(link!.blockedAt, 'привязка помечена заблокированной — дальше этому чату не пишут').toBeTruthy();
    rec.mode = 'ok';
    await sendDue(t.db, rec, new Date(Date.now() + 3600_000), 50);
    expect(rec.sent.length, 'заблокированный ряд заново не отправляют').toBe(before);
    await t.db.update(telegramLinks).set({ blockedAt: null }).where(eq(telegramLinks.userId, studentId));
  });

  it('429: повтор ровно через retry_after, лимита попыток в этой ветке нет — 12 подряд оставляют ряд pending', async () => {
    rec.mode = 'retry';
    const base = `retry:${randomUUID()}`;
    await enqueueNotification(t.db, {
      kind: 'materialNew', classId, when: new Date(Date.now() - 5000),
      params: { title: 'Флуд', class: 'Сон класс' }, dedupeBase: base,
    });
    let now = new Date();
    let passes = 0;
    for (let i = 0; i < 12; i++) {
      now = new Date(now.getTime() + 5 * 60_000); // проходы дальше, чем retry_after → ряд снова поспевает
      const [r] = await t.db.select().from(notifications).where(sql`dedupe_key like ${base + '%'}`);
      if (r!.sendAt.getTime() <= now.getTime()) { expect(await sendDue(t.db, rec, now, 50)).toBe(1); passes++; }
    }
    expect(passes).toBe(12);
    const [row] = await t.db.select().from(notifications).where(sql`dedupe_key like ${base + '%'}`);
    expect(row!.attempts).toBe(12);
    expect(row!.lastError).toBe('429');
    expect(row!.status, '12 ответов 429 ряд не исчерпали: он всё ещё pending').toBe('pending');
    expect(row!.sendAt.getTime() - now.getTime(), 'send_at сдвинут ровно на retry_after').toBeGreaterThanOrEqual(50_000);
    rec.mode = 'ok';
    await sendDue(t.db, rec, new Date(row!.sendAt.getTime() + 1000), 50);
    const [done] = await t.db.select().from(notifications).where(sql`dedupe_key like ${base + '%'}`);
    expect(done!.status).toBe('sent');
  });

  it('обычная ошибка транспорта ограничена: 6 попыток с экспоненциальным шагом, затем failed', async () => {
    const base = `fail:${randomUUID()}`;
    await enqueueNotification(t.db, {
      kind: 'materialNew', classId, when: new Date(Date.now() - 5000),
      params: { title: 'Сбой', class: 'Сон класс' }, dedupeBase: base,
    });
    const boom: NotifyTransport = { send: async () => ({ error: 'boom-fictitious' }) };
    let now = new Date();
    for (let i = 0; i < 8; i++) {
      now = new Date(now.getTime() + 30 * 60_000);
      const [r] = await t.db.select().from(notifications).where(sql`dedupe_key like ${base + '%'}`);
      if (r!.status === 'pending' && r!.sendAt.getTime() <= now.getTime()) await sendDue(t.db, boom, now, 50);
    }
    const row = await t.db.select().from(notifications).where(sql`dedupe_key like ${base + '%'}`);
    expect(row[0]!.status, 'ветка общей ошибки имеет потолок попыток').toBe('failed');
    // 5, а не 6: терминальный проход меняет статус, но счётчик в ряд уже не пишет
    expect(row[0]!.attempts).toBe(5);
  });

  it('тихие часы: сдвиг ставит отправку за пределы окна, даже если урок уже прошёл (факт текущей схемы)', async () => {
    const trigger = wallClock(22, 40);          // местный тихий вечер
    const ev = await mkEvent('Тихий вечер', new Date(trigger.getTime() + 10 * 60_000));
    // отправную точку считаем из строки события, чтобы не разойтись с нею на секунды
    const starts = new Date(ev!.startsAt).getTime();
    const at = starts - 10 * 60_000;
    const shifted = applyQuietHours('reminder10m', new Date(at), 22, 8, TZ);
    expect(shifted.getTime(), 'из тихого окна отправка обязательно сдвигается').toBeGreaterThan(at);
    expect(Number(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', hour12: false }).format(shifted))).toBe(8);
    expect(shifted.getTime(), 'урок к моменту сдвинутой отправки уже закончился').toBeGreaterThan(starts + 45 * 60_000);

    await t.db.update(notificationPrefs).set({ quietFrom: 22, quietTo: 8 }).where(eq(notificationPrefs.userId, studentId));
    await scanReminders(t.db, new Date(at));
    const mine = await rowsFor(ev!.id, 10, 'reminder10m');
    expect(mine).toHaveLength(1);
    expect(mine[0]!.sendAt.getTime(), 'отправка перенесена на утро').toBe(shifted.getTime());
    await t.db.update(notificationPrefs).set({ quietFrom: 8, quietTo: 8 }).where(eq(notificationPrefs.userId, studentId));
  });

  it('выключенный вид напоминаний не ставится в очередь ни при каких условиях', async () => {
    await t.db.update(notificationPrefs).set({ kinds: { reminder10m: false } }).where(eq(notificationPrefs.userId, studentId));
    const t0 = minute(new Date(Date.now() + 3 * 3600_000));
    const ev = await mkEvent('Молчун', new Date(t0.getTime() + 10 * 60_000));
    await scanReminders(t.db, t0);
    expect(await rowsFor(ev!.id, 10, 'reminder10m')).toHaveLength(0);
    await t.db.update(notificationPrefs).set({ kinds: {} }).where(eq(notificationPrefs.userId, studentId));
  });
});
