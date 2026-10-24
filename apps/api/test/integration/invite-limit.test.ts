/**
 * Потолок на адрес для публичных маршрутов приглашений (задача 2026-10-23, §4).
 *
 * Требование постановки: не меньше 60 проверок предпросмотра с одного адреса за 10 минут плюс
 * нарастающая задержка для повторных обращений с заведомо неверным токеном. Реализация делит
 * это на два слоя, и оба проверяются здесь:
 *  • общий «против потопа» потолок маршрута (`effectiveIpWindowMax`, в продакшене 120 / 10 мин) —
 *    он же доказывает, что 60 человек со школы поместятся с запасом;
 *  • счётчик НЕВЕРНЫХ токенов на адрес (`ivj:<ip>` в `lib/throttle.ts`), который в продакшене
 *    держит 20 в минуту и после превывления закрывает адрес на 15 минут — ровно та «нарастающая
 *    задержка», только без penalty на тех, кто ввёл всё правильно.
 *
 * Второй слой в тестовой среде недостижим (там потолок 500/мин — см. NON_PROD_IP_FAILURE_MAX_PER_MIN,
 * чтобы весь класс мог регистрироваться), поэтому он проверяется дважды: юнитом на примитив
 * счётчика и этим файлом на то, что маршрут зовёт счётчик именно с `effectiveIpFailMax`, а не с
 * захардкоженным числом.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { TEST_DATABASE_URL, preparedDb, makeTeacher, type TestDB } from './util.js';
import { buildApp } from '../../src/app.js';
import { env } from '../../src/env.js';
import { PROD_IP_FAILURE_MAX_PER_MIN, PROD_IP_WINDOW_MAX, effectiveIpFailMax, effectiveIpWindowMs } from '../../src/lib/prodConfig.js';
import { throttleCheck, throttleRecordAttempt, throttleReset } from '../../src/lib/throttle.js';
import { CODE_BLOCK_MINUTES } from '@klass/shared';
import type { FastifyInstance } from 'fastify';

const suite = TEST_DATABASE_URL ? describe : describe.skip;
const PREVIEW = '/api/invitations/preview';
const JUNK = 'a'.repeat(32);

suite('A: лимиты публичных маршрутов приглашений', () => {
  let t: TestDB;
  let app: FastifyInstance;
  let teacherTok = '';
  let classId = '';
  let link = '';

  let ipSeq = 0;
  const freshIp = () => `10.88.${Math.floor(++ipSeq / 254) % 254}.${ipSeq % 254}`;
  const previewFrom = (token: string, ip: string) => app.inject({
    method: 'POST', url: PREVIEW, remoteAddress: ip, payload: { token },
  });

  beforeAll(async () => {
    t = await preparedDb(TEST_DATABASE_URL);
    env.PUBLIC_URL = 'https://blublu.example';
    app = await buildApp(t.db);
    const te = await makeTeacher(t.sql, `lim-t-${Date.now()}@x.io`);
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: te.email, password: 'Passw0rd123' } });
    teacherTok = login.json().accessToken as string;
    const cls = await app.inject({
      method: 'POST', url: '/api/classes', headers: { authorization: `Bearer ${teacherTok}` }, payload: { name: 'Limit class' },
    });
    classId = cls.json().id as string;
    const l = await app.inject({
      method: 'POST', url: `/api/classes/${classId}/invites/link`,
      headers: { authorization: `Bearer ${teacherTok}` }, payload: { ttlDays: 7 },
    });
    link = (l.json().url as string).split('#')[1] ?? '';
  });
  afterAll(async () => {
    env.PUBLIC_URL = '';
    await app?.close();
    await t?.sql.end();
  });

  /**
   * 120 / 10 мин на продакшене — это больше требованных 60 ровно вдвое, и проверка идёт на
   * НОВОМ адресе, чтобы окно не разделять с другими тестами файла.
   */
  it('60 проверок подряд с одного адреса проходят, не упёршись в потолок', async () => {
    const ip = freshIp();
    const codes: number[] = [];
    for (let i = 0; i < 60; i++) codes.push((await previewFrom(link, ip)).statusCode);
    expect(codes.every((s) => s === 200), `заблокированы: ${codes.filter((s) => s !== 200).length} из 60`).toBe(true);
  });

  it('за ceiling адрес получает 429 с кодом и reqId, а не 500', async () => {
    const ip = freshIp();
    let last = 0;
    const seen: number[] = [];
    // потолок на маршрут = 120 / 10 мин (в тестовой среде он не ниже продакшенового)
    for (let i = 0; i < PROD_IP_WINDOW_MAX + 2; i++) {
      last = (await previewFrom(link, ip)).statusCode;
      seen.push(last);
    }
    expect(seen.slice(0, PROD_IP_WINDOW_MAX).every((s) => s === 200), 'первые 120 — нормальные').toBe(true);
    expect(last).toBe(429);
    const r = await previewFrom(link, ip);
    expect(r.statusCode).toBe(429);
    expect(r.json().error).toBe('tooManyRequests');
    expect(r.json().reqId, 'и в лимите человек может назвать id').toMatch(/^[0-9a-z]{10}$/);
    expect(Number(r.headers['retry-after']) > 0).toBe(true);
  });

  it('счётчик неверных токенов на адрес считает только промахи и закрывает адрес на 15 минут', () => {
    // примитив в тех же числах, что продакшенов: 20 промахов за минуту → блок на CODE_BLOCK_MINUTES
    const key = `ivj-test-${Date.now()}`;
    const max = effectiveIpFailMax('production', env.RATE_IP_FAIL_MAX);
    expect(max, 'в продакшене потолок — ровно PROD_IP_FAILURE_MAX_PER_MIN').toBe(PROD_IP_FAILURE_MAX_PER_MIN);
    const t0 = Date.now();
    for (let i = 0; i < max - 1; i++) throttleRecordAttempt(key, t0 + i, max);
    expect(throttleCheck(key, t0 + max - 1).allowed, 'до порога адрес свободен').toBe(true);
    throttleRecordAttempt(key, t0 + max - 1, max);
    const blocked = throttleCheck(key, t0 + max);
    expect(blocked.allowed, 'порог взят — адрес закрыт').toBe(false);
    expect(blocked.retryAfterSec).toBeCloseTo(CODE_BLOCK_MINUTES * 60, -1);
    throttleReset(key);
    expect(throttleCheck(key, t0 + max).allowed, 'успешная проверка сбрасывает счётчик').toBe(true);
  });

  /**
   * Guard-тест структуры (правка 2026-10-24). Раньше он проверял, что маршрут зовёт
   * `throttleRecordAttempt(...)` с `effectiveIpFailMax`, — и этого оказалось мало: счётчик стоял
   * в одном маршруте из трёх, а проверка «тот же учёт везде» нечем не проверялась. Теперь
   * проверяется именно инвариант: примитивы троттлинга живут в ОДНОМ модуле, а все три
   * публичных маршрута проходят через него. Ослаблением это не является: assert-ов стало больше,
   * и они строже (прямой вызов примитива из маршрута теперь сам по себе красный).
   */
  it('все три маршрута ведут промахи через один общий счётчик', () => {
    const throttle = readFileSync(path.resolve(__dirname, '../../src/lib/inviteThrottle.ts'), 'utf8');
    const src = readFileSync(path.resolve(__dirname, '../../src/routes/invitations.ts'), 'utf8');

    // потолок — из общей функции, а не цифра в коде
    expect(throttle).toMatch(/effectiveIpFailMax\(env\.NODE_ENV, env\.RATE_IP_FAIL_MAX\)/);
    expect(throttle, 'ключ один на все маршруты').toMatch(/INVITE_JUNK_PREFIX = 'ivj:'/);

    // маршрут обязан СПРАШИВАТЬ привратника, а не читать примитивы напрямую
    for (const helper of ['inviteJunkGate', 'noteInviteTokenMiss', 'noteInviteTokenHit']) {
      expect(src, `маршрут использует ${helper}`).toContain(helper);
    }
    expect(src, 'примитивы троттлинга в маршрутах больше не дублируются').not.toMatch(/throttleCheck|throttleRecordAttempt|throttleReset/);
    const gates = src.match(/inviteJunkGate\(req\.ip\)/g) ?? [];
    expect(gates.length, 'по одной проверке на preview, register и join').toBe(3);
    const hits = src.match(/noteInviteTokenHit\(req\.ip\)/g) ?? [];
    expect(hits.length, 'успех обнуляет счётчик тоже во всех трёх').toBeGreaterThanOrEqual(3);
    const misses = src.match(/refusedToken\(req\.ip/g) ?? [];
    expect(misses.length, 'каждый отказ по токену идёт через один засчитывающий хелпер').toBeGreaterThanOrEqual(4);

    // и сам потолок окна — тот же, что у входа по коду (см. app.ts)
    expect(effectiveIpWindowMs()).toBe(10 * 60_000);
  });

  it('верный токен не пополняет счётчик промахов', async () => {
    const ip = freshIp();
    const before = await previewFrom(link, ip);
    expect(before.statusCode).toBe(200);
    for (let i = 0; i < 10; i++) expect((await previewFrom(link, ip)).statusCode).toBe(200);
    // после десяти ВЕРНЫХ проверок один промах всё ещё даёт обычный inviteInvalid, а не 429
    const miss = await previewFrom(JUNK, ip);
    expect(miss.statusCode).toBe(400);
    expect(miss.json().error).toBe('inviteInvalid');
  });
});
