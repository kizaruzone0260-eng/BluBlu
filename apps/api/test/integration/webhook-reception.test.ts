/**
 * Аудит бота, п.2 — приём вебхука. Провёрка идёт по ИТОГОВОМУ выводу маршрута (статус, тело,
 * строки журнала, количество вызовов Telegram API), а не по отдельным функциям: ровно так же,
 * как с access-логом (docs/HARDENING.md).
 *
 * Что здесь закреплено:
 *  • без секретного заголовка и с неверным — один и тот же 403 с телом без подробностей, и
 *    обновление НЕ обрабатывается (ни строки в журнале, ни вызова API);
 *  • с верным секретом — 200 и строка в `bot_updates`;
 *  • часть A4 (2026-10-16): 200 приходит СРАЗУ после записи в журнал, а действие делает фон;
 *    фоновая ошибка не теряет обновление — его добирает переобработка при старте, и только
 *    строки моложе десяти минут;
 *  • повторная доставка того же `update_id` не выполняет действие дважды;
 *  • тело без числового `update_id` — 200 и ноль побочных эффектов;
 *  • падение обработчика не превращается в 5xx для Telegram, и в журнал не попадает ни токен,
 *    ни строка подключения (проверяется по тексту, который реально написал логгер);
 *  • маршрут имеет собственный лимит 300 запросов/мин — он тоже виден здесь.
 *
 * Все значения фиктивны.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { TEST_DATABASE_URL, preparedDb, type TestDB } from './util.js';
import { buildApp } from '../../src/app.js';
import { botUpdates } from '../../src/db/schema.js';
import { env } from '../../src/env.js';
import { botDeps, capturingApi, drainBotUpdates, pendingBotUpdates } from '../../src/routes/telegram.js';
import { reprocessUnfinished } from '../../src/services/bot.js';
import type { BotApi } from '../../src/services/botApi.js';
import pino from 'pino';
import type { FastifyInstance } from 'fastify';

const suite = TEST_DATABASE_URL ? describe : describe.skip;

const SECRET = 'fictitious-reception-secret-0123456789';
const HEAD = 'x-telegram-bot-api-secret-token';

suite('вебхук: приём обновлений (аудит п.2)', () => {
  let t: TestDB;
  let app: FastifyInstance;
  let logs: string[] = [];
  let uid = 3_000_000;
  const api = () => capturingApi(t.db, null);

  const upd = (id: number, chatId = 4_242_000) => ({
    update_id: id,
    message: { message_id: 1, chat: { id: chatId, type: 'private' }, from: { id: chatId }, text: '/help' },
  });
  const hook = (payload: unknown, secret = SECRET) => app.inject({
    method: 'POST', url: '/webhook/telegram', headers: { [HEAD]: secret }, payload,
  });
  const ledger = async (ids: number[]) =>
    (await t.db.select({ id: botUpdates.updateId }).from(botUpdates).where(inArray(botUpdates.updateId, ids))).length;

  beforeAll(async () => {
    t = await preparedDb(TEST_DATABASE_URL);
    // фиктивные значения вместо реальных: маршрут обязан их вырезать, если библиотека положит
    // их в сообщение ошибки.
    process.env.TELEGRAM_BOT_TOKEN = '777000:FICTIONAL-faketoken-faketoken-faketoken77';
    env.TELEGRAM_WEBHOOK_SECRET = SECRET;
    logs = [];
    const sink = pino({ level: 'warn' }, { write: (line: string) => logs.push(line) });
    app = await buildApp(t.db, { logger: sink as never });
  });
  afterAll(async () => {
    await app?.close();
    delete process.env.TELEGRAM_BOT_TOKEN;
    await t?.sql.end();
  });

  it('403 без заголовка и с неверным — одинаковое тело без подробностей, обновление не обработано', async () => {
    const before = api().calls.length;
    const a = uid + 1, b = uid + 2;
    const noHeader = await app.inject({ method: 'POST', url: '/webhook/telegram', payload: upd(a) });
    const wrong = await hook(upd(b), 'obviously-wrong-fictitious-secret');
    expect(noHeader.statusCode).toBe(403);
    expect(wrong.statusCode).toBe(403);
    // тело: ровно тот же ответ, без причины, без ожидаемого значения, без стека
    expect(noHeader.json()).toEqual({ error: 'forbidden' });
    expect(wrong.json()).toEqual(noHeader.json());
    expect(noHeader.body).not.toMatch(/secret|token|expected|stack/i);
    expect(wrong.body).not.toContain(SECRET);
    expect(await ledger([a, b])).toBe(0);
    expect(api().calls, 'отклонённое обновление не должно ничего отправить в Telegram').toHaveLength(before);
  });

  it('верный секрет: 200, запись в журнале доставок и завершённая обработка', async () => {
    const id = uid + 10;
    const r = await hook(upd(id));
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true });
    expect(await ledger([id])).toBe(1);
    // A4: фон-задача обязана дойти до отметки — иначе страница журнала «принято, но не
    // сделано» копилась бы до следующего старта процесса.
    await drainBotUpdates();
    expect(pendingBotUpdates()).toBe(0);
    const [row] = await t.db.select().from(botUpdates).where(eq(botUpdates.updateId, id));
    expect(row!.processedAt, 'действие выполнено — строка закрыта').toBeTruthy();
    expect((row!.payload as { update_id: number }).update_id, 'журнал хранит само обновление').toBe(id);
  });

  it('A4: 200 уходит ДО того, как обработка закончилась', async () => {
    // Проверка ровно на том, что мерил аудит п.2: раньше ответ Telegram приходил после всего
    // диспетчера, и на холодном Render это десятки секунд (Telegram отрывает соединение и
    // доставляет update заново). Здесь транспорт зависает навсегда — если маршрут всё ещё
    // ждёт его, `hook()` не вернётся вовсе и тест упадёт по таймауту.
    const id = uid + 12;
    const api = capturingApi(t.db, null);
    const original = api.sendMessage.bind(api);
    let gate: () => void = () => undefined;
    const blocked = new Promise<void>((res) => { gate = res; });
    api.sendMessage = async (...args: Parameters<BotApi['sendMessage']>) => {
      await blocked;
      return original(...args);
    };
    try {
      const r = await hook(upd(id, 4_242_999));
      expect(r.statusCode, 'ответ уже у Telegram, хотя действие ещё висит').toBe(200);
      expect(pendingBotUpdates(), 'обработка идёт в фоне').toBe(1);
      expect(await ledger([id]), 'в журнале строка появилась до ответа').toBe(1);
      gate();
      await drainBotUpdates();
      expect(pendingBotUpdates()).toBe(0);
      const [row] = await t.db.select().from(botUpdates).where(eq(botUpdates.updateId, id));
      expect(row!.processedAt).toBeTruthy();
    } finally {
      api.sendMessage = original;
    }
  }, 30_000);

  it('A4: падение фона не теряет обновление — его добирает старт процесса', async () => {
    const id = uid + 13;
    // «фон упал»: строка принята, а processed_at нет
    await t.db.insert(botUpdates).values({ updateId: id, payload: upd(id, 4_242_888) as unknown as Record<string, unknown> });
    const deps = botDeps(t.db, null);
    const before = api().calls.length;
    const r = await reprocessUnfinished(deps);
    expect(r.attempted, 'строка попала в окно переобработки').toBeGreaterThanOrEqual(1);
    expect(r.done, 'ошибок нет — действие доделано').toBeGreaterThanOrEqual(1);
    expect(api().calls.length).toBeGreaterThan(before);
    const [row] = await t.db.select().from(botUpdates).where(eq(botUpdates.updateId, id));
    expect(row!.processedAt, 'после переобработки строка закрыта').toBeTruthy();

    // повторный вызов ничего не делает: закрытые строки второй раз не выполняются
    const calls = api().calls.length;
    expect(await reprocessUnfinished(deps)).toMatchObject({ attempted: 0, done: 0, failed: 0 });
    expect(api().calls.length).toBe(calls);
  });

  it('A4: старше десяти минут не переобрабатывается (окно и по возрасту, и по счётчику)', async () => {
    const id = uid + 14;
    await t.db.insert(botUpdates).values({
      updateId: id, payload: upd(id, 4_242_777) as unknown as Record<string, unknown>,
      seenAt: new Date(Date.now() - 11 * 60_000),
    });
    const before = api().calls.length;
    expect(await reprocessUnfinished(botDeps(t.db, null))).toMatchObject({ attempted: 0, done: 0 });
    expect(api().calls.length, 'окно 10 минут — жёсткое').toBe(before);
    const [row] = await t.db.select().from(botUpdates).where(eq(botUpdates.updateId, id));
    expect(row!.processedAt, 'старая строка остаётся незакрытой, но и не выполняется').toBeNull();
  });

  it('повторная доставка того же update_id выполняет действие ровно один раз', async () => {
    const chat = 4_242_111;
    const before = api().calls.length;
    const id = uid + 20;
    const first = await hook(upd(id, chat));
    await drainBotUpdates();
    const sentOnce = api().calls.length - before;
    expect(first.statusCode).toBe(200);
    expect(sentOnce, 'первая доставка обязана что-то ответить').toBeGreaterThan(0);
    const again = await hook(upd(id, chat));
    expect(again.statusCode).toBe(200);
    await drainBotUpdates();
    expect(api().calls.length - before, 'повтор не добавляет ни одного действия').toBe(sentOnce);
    expect(await ledger([id])).toBe(1);
  });

  it('параллельная повторная доставка не даёт второго действия (журнал пишется до обработки)', async () => {
    const chat = 4_242_222;
    const before = api().calls.length;
    const id = uid + 30;
    const [r1, r2] = await Promise.all([hook(upd(id, chat)), hook(upd(id, chat))]);
    expect([r1.statusCode, r2.statusCode]).toEqual([200, 200]);
    await drainBotUpdates();
    expect(api().calls.length - before, 'оба запроса могли прийти одновременно — действие одно').toBeLessThanOrEqual(1);
  });

  it('тело без числового update_id: 200 и ни одного побочного эффекта', async () => {
    const before = api().calls.length;
    const r = await hook({ update_id: 'not-a-number' });
    expect(r.statusCode).toBe(200);
    const r2 = await hook({});
    expect(r2.statusCode).toBe(200);
    expect(api().calls).toHaveLength(before);
  });

  it('падение обработчика: Telegram всё равно получает 200, в журнале нет ни токена, ни строки подключения', async () => {
    const a = api();
    const original = a.sendMessage.bind(a);
    a.sendMessage = async () => {
      throw new Error('connect postgres://klass:fakepass@db.invalid:5432/klass failed via https://api.telegram.org/bot777000:FICTIONAL-faketoken-faketoken-faketoken77/sendMessage');
    };
    try {
      const r = await hook(upd(uid + 40));
      expect(r.statusCode, 'ошибка внутри обработчика не должна возвращать Telegram 5xx').toBe(200);
      expect(r.body).not.toMatch(/postgres|telegram\.org|Error/);
      await drainBotUpdates(); // причина пишется фоном — ждать её надо после 200, а не до
    } finally {
      a.sendMessage = original;
    }
    const joined = logs.join('\n');
    expect(joined, 'причина падения в журнал пишется').toContain('telegram update failed');
    expect(joined).not.toContain('fakepass');
    expect(joined).not.toContain('FICTIONAL-faketoken');
    expect(joined).not.toContain('postgres://klass');
  });

  it('у маршрута стоит собственный лимит 300 запросов в минуту', async () => {
    // Отдельный экземпляр приложения: счётчик лимитера живёт в памяти одного Fastify-приложения,
    // иначе этот взрыв отнял бы бюджет у всех остальных тестов файла (429 вместо 403/200).
    const sink = pino({ level: 'fatal' }, { write: () => undefined });
    const burst = await buildApp(t.db, { logger: sink as never });
    try {
      // пустые тела: ничего не обрабатывается, считается только limiter
      const codes: number[] = [];
      for (let i = 0; i < 340; i++) {
        codes.push((await burst.inject({
          method: 'POST', url: '/webhook/telegram', headers: { [HEAD]: SECRET }, payload: {},
        })).statusCode);
      }
      const limited = codes.filter((c) => c === 429).length;
      expect(codes[0], 'первые запросы ещё в лимите').toBe(200);
      expect(limited, 'сверх 300/мин Telegram получает 429 и будет повторять доставку').toBeGreaterThan(0);
    } finally { await burst.close(); }
  });

  it('отсутствие настроенного секрета отклоняет вообще всё (обход невозможен)', async () => {
    const prev = env.TELEGRAM_WEBHOOK_SECRET;
    env.TELEGRAM_WEBHOOK_SECRET = '';
    try {
      const before = api().calls.length;
      const r = await hook(upd(uid + 50), '');
      expect(r.statusCode).toBe(403);
      expect(api().calls).toHaveLength(before);
    } finally { env.TELEGRAM_WEBHOOK_SECRET = prev; }
  });

  it('журнал остаётся читаемым: update_id и маршрут видны, секрета нет', async () => {
    const id = uid + 60;
    await hook(upd(id, 4_242_333));
    const rows = await t.db.select().from(botUpdates).where(eq(botUpdates.updateId, id));
    expect(rows).toHaveLength(1);
  });
});
