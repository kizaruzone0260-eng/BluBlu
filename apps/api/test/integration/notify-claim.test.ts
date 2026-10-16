/**
 * Часть A (2026-10-16) — очередь уведомлений бота: атомарный захват ряда, срок годности,
 * тихие часы группового канала и уборка истории.
 *
 * Почему это отдельный файл, а не правки в `notify-downtime.test.ts`: тот набор закрепляет
 * поведение очереди при сне сервиса (что ушло, что не ушло), а здесь проверяются МЕХАНИКИ
 * захвата и уборки, у которых есть время и параллельность. Оба набора гоняют по одной
 * таблице и одному truncate-состоянию, поэтому каждый тест съедает свои ряды до конца.
 *
 * Всё время задаётся аргументом `now` там, где его читает код; данные и чат-id фиктивные.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { TEST_DATABASE_URL, preparedDb, makeTeacher, type TestDB } from './util.js';
import {
  classTelegramChats, classNotifyPrefs, classes, classMembers,
  notifications, notificationPrefs, telegramLinks, users,
} from '../../src/db/schema.js';
import {
  sendDue, reclaimStuck, sweepNotifications, enqueueNotification,
  MAX_ATTEMPTS_429, NOTIFY_HISTORY_MS, STALE_MS, STUCK_MS,
  type NotifyKind, type NotifyTransport, type TransportResult,
} from '../../src/services/notify.js';

const suite = TEST_DATABASE_URL ? describe : describe.skip;
const TZ = 'Asia/Tashkent';

/** Пишет ряд очереди с фиктивным чатом; всё остальное — дефолты схемы. */
type Row = {
  kind: NotifyKind; chatId?: string; sendAt: Date; status?: 'pending' | 'sending';
  lockedAt?: Date | null; startsAt?: Date | null; text?: string; key?: string; attempts?: number;
};

class Rec implements NotifyTransport {
  sent: { chatId: string; text: string }[] = [];
  async send(chatId: string, text: string): Promise<TransportResult> {
    this.sent.push({ chatId, text });
    return { ok: true };
  }
}

/** Транспорт, который зависает внутри `send` и ждёт, пока его отпустят. */
class Hang implements NotifyTransport {
  sent: { chatId: string; text: string }[] = [];
  private release: () => void = () => undefined;
  private gate = new Promise<void>((r) => { this.release = r; });
  async send(chatId: string, text: string): Promise<TransportResult> {
    this.sent.push({ chatId, text });
    await this.gate;
    return { ok: true };
  }
  unblock() { this.release(); }
}

async function waitFor(cond: () => Promise<boolean> | boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await cond()) return;
    if (Date.now() > deadline) throw new Error('waitFor: условие не выполнилось');
    await new Promise((r) => setTimeout(r, 5));
  }
}

suite('очередь уведомлений: захват, свежесть, уборка (часть A)', () => {
  let t: TestDB;
  let classId = '';
  let teacherId = '';
  let studentId = '';
  let studentChat = '';
  let rec: Rec;

  const row = async (r: Row) => {
    const [ins] = await t.db.insert(notifications).values({
      kind: r.kind, classId, userId: studentId,
      chatId: r.chatId ?? studentChat,
      payload: { text: r.text ?? `фиктивный текст ${r.kind}` },
      dedupeKey: r.key ?? `t:${randomUUID()}`,
      sendAt: r.sendAt, status: r.status ?? 'pending',
      lockedAt: r.lockedAt ?? null, startsAt: r.startsAt ?? null,
      attempts: r.attempts ?? 0,
    }).returning({ id: notifications.id });
    return ins!.id;
  };
  const get = async (id: string) =>
    (await t.db.select().from(notifications).where(eq(notifications.id, id)).limit(1))[0]!;
  /** только те отправки, что относятся к данному тексту — остальные ряды файла не мешают */
  const sentOf = (transport: { sent: { text: string }[] }, needle: string) =>
    transport.sent.filter((s) => s.text.includes(needle)).length;

  beforeAll(async () => {
    t = await preparedDb(TEST_DATABASE_URL);
    const teacher = await makeTeacher(t.sql, `claimT${Date.now()}@x.io`);
    teacherId = teacher.id;
    const [cls] = await t.db.insert(classes).values({ teacherId, name: `Класс захвата ${Date.now()}` }).returning();
    classId = cls!.id;
    studentId = randomUUID();
    studentChat = `9${String(Date.now()).slice(-9)}`;
    await t.db.insert(users).values({
      id: studentId, role: 'student', name: 'Очередь', email: `claimS${Date.now()}@x.io`,
      passwordHash: 'x', locale: 'ru', localeExplicit: true, tz: TZ,
    });
    await t.db.insert(classMembers).values({ classId, userId: studentId });
    await t.db.insert(telegramLinks).values({ userId: studentId, chatId: studentChat });
    // тихие часы выключены: общая постановка в очередь не должна сдвигать send_at
    await t.db.insert(notificationPrefs).values([
      { userId: studentId, quietFrom: 8, quietTo: 8 },
      { userId: teacherId, quietFrom: 8, quietTo: 8 },
    ]);
    rec = new Rec();
  });
  afterAll(async () => { await t?.sql.end(); });

  it('A1: захват ряда атомарен — зависший транспорт и второй параллельный проход дают ровно одну отправку', async () => {
    // один-единственный pending-ряд на момент теста: счётчики проходов сравнимы напрямую
    const tag = `атомарный-${randomUUID().slice(0, 8)}`;
    const id = await row({ kind: 'materialNew', sendAt: new Date(Date.now() - 1000), text: tag });
    const hang = new Hang();
    const now = new Date();

    const first = sendDue(t.db, hang, now, 50);            // не ждём: он застрял в транспорте
    await waitFor(() => hang.sent.length === 1);
    const during = await get(id);
    expect(during.status, 'ряд в работе помечен sending и не виден второму проходу').toBe('sending');
    expect(during.lockedAt, 'захват датирован').toBeTruthy();

    const second = await sendDue(t.db, rec, now, 50);      // второй проход идёт ВО ВРЕМЯ зависшего
    expect(second, 'второй проход не забирает ни одного ряда').toBe(0);
    expect(sentOf(rec, tag), 'второй проход ничего не отправил').toBe(0);

    hang.unblock();
    expect(await first).toBe(1);
    expect((await get(id)).status).toBe('sent');
    expect(sentOf(hang, tag)).toBe(1);
    // и после завершения — повторной отправки нет
    expect(await sendDue(t.db, rec, new Date(+now + 60_000), 50)).toBe(0);
    expect(sentOf(hang, tag) + sentOf(rec, tag)).toBe(1);
  }, 30_000);

  it('A1: зависший sending старше пяти минут возвращается в pending, более свежий — нет', async () => {
    expect(STUCK_MS).toBe(5 * 60_000);
    const old = await row({
      kind: 'materialNew', status: 'sending', text: 'зависший-старый',
      lockedAt: new Date(Date.now() - 6 * 60_000), sendAt: new Date(Date.now() - 7 * 60_000),
      startsAt: new Date(Date.now() + 3600_000),
    });
    const young = await row({
      kind: 'materialNew', status: 'sending', text: 'зависший-молодой',
      lockedAt: new Date(Date.now() - 60_000), sendAt: new Date(Date.now() - 60_000),
      startsAt: new Date(Date.now() + 3600_000),
    });
    expect(await reclaimStuck(t.db, new Date())).toBe(1);
    expect((await get(old)).status, 'ряд висит 6 минут ⇒ снова в очереди').toBe('pending');
    expect((await get(old)).lockedAt).toBeNull();
    expect((await get(young)).status, 'ряд висит минуту ⇒ его ещё обрабатывают').toBe('sending');

    // и возврат действительно работает: освободившийся ряд уходит
    const sent = await sendDue(t.db, rec, new Date(), 50);
    expect(sent).toBeGreaterThanOrEqual(1);
    expect((await get(old)).status).toBe('sent');
    expect((await get(young)).status, 'чужой незавершённый захват не растраивается').toBe('sending');
    // доводим молодого до конца, чтобы не оставлять pending-рядов следующим тестам
    await t.db.update(notifications).set({ status: 'sent', lockedAt: null })
      .where(eq(notifications.id, young));
  }, 30_000);

  it('A2: напоминание, у которого событие уже началось, не отправляется; «урок начался» — отправляется', async () => {
    expect(STALE_MS).toBe(2 * 3600_000);
    const now = new Date();
    const started = new Date(+now - 20 * 60_000);            // событие уже идёт
    // ряд младше двух часов, так что срабатывает именно проверка начала события
    const rem = await row({
      kind: 'reminder10m', sendAt: new Date(+now - 30 * 60_000), startsAt: started, text: 'опоздавшее напоминание',
    });
    const les = await row({
      kind: 'lessonStarted', sendAt: new Date(+now - 30 * 60_000), startsAt: started, text: 'урок начался',
    });
    expect(await sendDue(t.db, rec, now, 50)).toBe(2);
    const r = await get(rem);
    expect(r.status).toBe('expired');
    expect(r.lastError).toBe('already started');
    expect(sentOf(rec, 'опоздавшее напоминание'), 'напоминание про идущий урок не уходит').toBe(0);
    expect((await get(les)).status, 'исключение — «урок начался»: он и есть про начавшееся').toBe('sent');
    expect(sentOf(rec, 'урок начался')).toBe(1);
  });

  it('A2: ряд старше двух часов после send_at становится expired и не трогает транспорт', async () => {
    const id = await row({ kind: 'materialNew', sendAt: new Date(Date.now() - 3 * 3600_000), text: 'трёхчасовой хвост' });
    const before = rec.sent.length;
    expect(await sendDue(t.db, rec, new Date(), 50)).toBe(1);
    expect((await get(id)).status).toBe('expired');
    expect((await get(id)).lastError).toBe('stale');
    expect(rec.sent.length, 'просроченный ряд не должен был попасть в транспорт').toBe(before);
  });

  it('A3: потолок попыток стоит и в ветке 429', async () => {
    expect(MAX_ATTEMPTS_429).toBe(12);
    const flaky: NotifyTransport = { send: async () => ({ retryAfterSec: 1 }) };
    const tag = `сорокдва-${randomUUID().slice(0, 8)}`;
    const id = await row({ kind: 'materialNew', sendAt: new Date(Date.now() - 1000), text: tag });
    let now = new Date();
    for (let i = 0; i < MAX_ATTEMPTS_429; i++) {
      now = new Date(+now + 5 * 60_000); // задержка retry_after=1 с — ряд снова поспевает
      await sendDue(t.db, flaky, now, 50);
    }
    const r = await get(id);
    expect(r.status, 'двенадцать ответов 429 исчерпывают ряд').toBe('failed');
    expect(r.attempts).toBe(MAX_ATTEMPTS_429 - 1);
    expect(r.lastError).toBe('429');
  }, 30_000);

  it('A5: групповой канал уважает тихие часа так же, как личный', async () => {
    // 00:30 по Ташкенту (+5) — внутри ночного окна 22→08
    const when = new Date('2026-10-05T19:30:00Z');
    await t.db.update(notificationPrefs).set({ quietFrom: 22, quietTo: 8 }).where(eq(notificationPrefs.userId, teacherId));
    await t.db.insert(classTelegramChats).values({ classId, chatId: '-100999', linkedBy: teacherId });
    await t.db.insert(classNotifyPrefs).values({ classId, channel: 'group' });
    const base = `group:${randomUUID()}`;
    const n = await enqueueNotification(t.db, {
      kind: 'eventNew', classId, when, params: { title: 'Контрольная', class: 'Класс захвата' },
      dedupeBase: base, excludeUserId: '',
    });
    expect(n).toBe(1);
    const [r] = await t.db.select().from(notifications).where(sql`dedupe_key like ${base + '%'} limit 1`);
    expect(r!.chatId).toBe('-100999');
    const localHour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', hour12: false }).format(r!.sendAt));
    expect(r!.sendAt.getTime(), 'ночью в чат класса не пишем — отправка переносится').toBeGreaterThan(when.getTime());
    expect([8, 9], `перенос на утро, получился час ${localHour}`).toContain(localHour);
    expect(r!.startsAt?.getTime(), `starts_at хранит время события, а не сдвинутую отправку`).toBe(when.getTime());

    // и «урок начался» в группе остаётся мгновенным — для него тихие часа не действуют
    const base2 = `group-start:${randomUUID()}`;
    await enqueueNotification(t.db, {
      kind: 'lessonStarted', classId, when, params: { title: 'Открытый урок', class: 'Класс захвата', lessonUrl: 'https://example.invalid/lesson' },
      dedupeBase: base2,
    });
    const [r2] = await t.db.select().from(notifications).where(sql`dedupe_key like ${base2 + '%'} limit 1`);
    expect(r2!.sendAt.getTime()).toBe(when.getTime());

    await t.db.delete(classNotifyPrefs);
    await t.db.delete(classTelegramChats);
    await t.db.update(notificationPrefs).set({ quietFrom: 8, quietTo: 8 }).where(eq(notificationPrefs.userId, teacherId));
    // ряды этого теста остались pending — убираем их из очереди, чтобы не мешать следующим
    await t.db.delete(notifications).where(sql`dedupe_key like 'group:%' or dedupe_key like 'group-start:%'`);
  });

  it('A5: фоновая уборка снимает терминальные ряды старше 30 дней и не трогает живые', async () => {
    expect(NOTIFY_HISTORY_MS).toBe(30 * 24 * 3600_000);
    const old = new Date(Date.now() - 40 * 24 * 3600_000);
    const recent = new Date(Date.now() - 10 * 24 * 3600_000);
    const mk = async (status: 'sent' | 'failed' | 'expired' | 'blocked' | 'pending', createdAt: Date) => {
      const [ins] = await t.db.insert(notifications).values({
        kind: 'materialNew', classId, userId: studentId, chatId: studentChat,
        payload: { text: 'архивный ряд' }, dedupeKey: `sweep:${randomUUID()}`,
        sendAt: createdAt, status, createdAt,
      }).returning({ id: notifications.id });
      return ins!.id;
    };
    const doomed = [
      await mk('sent', old), await mk('failed', old), await mk('expired', old), await mk('blocked', old),
    ];
    const kept = [await mk('sent', recent), await mk('pending', old)];

    expect(await sweepNotifications(t.db, new Date())).toBe(4);
    for (const id of doomed) expect(await get(id), 'уже не существует').toBeUndefined();
    for (const id of kept) expect((await get(id)).status, 'свежий или живой ряд не убирается').toBeTruthy();
    // идемпотентно: второй проход не находит ничего
    expect(await sweepNotifications(t.db, new Date())).toBe(0);
  });
});
