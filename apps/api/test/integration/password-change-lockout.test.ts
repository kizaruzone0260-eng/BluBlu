/**
 * Часть B1/B2 (2026-10-16) — смена пароля стоит в том же счётчике перебора, что и вход.
 *
 * Модель до правки: `/api/auth/login` ведёт `login_attempts` по email (5 провалов → задержка
 * 30 с, 60 с, … до потолка 15 мин), а `/api/me/change-password` проверял текущий пароль и
 * ничего не записывал в этот счётчик. То есть подбор текущего пароля можно было вести через
 * смену — там, где локаут не мешал вовсе. Теперь один счётчик на оба случая: тот же ключ
 * (нормализованный email), та же задержка, тот же ровный ответ, а успех сбрасывает счётчик.
 *
 * B2 закрывает обратную сторону того же счётчика: строка без блокировки, которую не
 * трогали сутки, уже ничего не защищает и убирается фоновой уборкой.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { TEST_DATABASE_URL, preparedDb, makeTeacher, type TestDB } from './util.js';
import { buildApp } from '../../src/app.js';
import { env } from '../../src/env.js';
import { loginAttempts } from '../../src/db/schema.js';
import { sweepLoginAttempts, LOGIN_ATTEMPT_TTL_MS } from '../../src/services/auth.js';
import type { FastifyInstance } from 'fastify';

const suite = TEST_DATABASE_URL ? describe : describe.skip;
const PW = 'Passw0rd123';
const NEXT = 'FreshPassword9';

suite('B1/B2: смена пароля и счётчик перебора', () => {
  let t: TestDB;
  let app: FastifyInstance;

  const bearer = (tok: string) => ({ authorization: `Bearer ${tok}` });
  async function token(email: string, password = PW) {
    const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } });
    return (r.json().accessToken as string) ?? '';
  }
  const counter = async (email: string) =>
    (await t.db.select().from(loginAttempts).where(eq(loginAttempts.email, email)).limit(1))[0] ?? null;
  const attempt = async (tok: string, current: string) => app.inject({
    method: 'POST', url: '/api/me/change-password', headers: bearer(tok),
    payload: { current, next: NEXT },
  });

  beforeAll(async () => {
    t = await preparedDb(TEST_DATABASE_URL);
    env.RATE_LOGIN_MAX = 500; // в файле намеренных провалов больше, чем лимит на IP
    app = await buildApp(t.db);
  });
  afterAll(async () => { await app?.close(); await t?.sql.end(); });

  it('провал текущих 5 попыток в смене пароля закрывает вход тем же локаутом', async () => {
    const te = await makeTeacher(t.sql, `b1a${Date.now()}@x.io`);
    const tok = await token(te.email);
    for (let i = 1; i <= 5; i++) {
      const r = await attempt(tok, `wrong-current-${i}`);
      expect(r.statusCode, `проход ${i}`).toBe(403);
      expect(r.json().error).toBe('wrongPassword');
    }
    const row = await counter(te.email);
    expect(row, 'строка счётчика заведена сменой пароля, а не входом').not.toBeNull();
    expect(row!.failCount).toBe(5);
    expect(row!.lockedUntil, 'порог 5 ⇒ наступила задержка').toBeTruthy();

    // и вход теперь отдаёт РОВНО тот же ответ, что и неудачная смена: nothing reveals
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: te.email, password: PW } });
    expect(login.statusCode).toBe(401);
    expect(login.json().error).toBe('invalidCredentials');
    // верный пароль тоже не пускает, пока держится окно: это именно задержка, а не «не угадали»
    const right = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: te.email, password: PW } });
    expect(right.statusCode).toBe(401);
    const after = await counter(te.email);
    expect(after!.failCount, 'продолжение стука растит счётчик').toBeGreaterThan(5);
  });

  it('пока окно держится, смена пароля отвечает тем же «wrongPassword» и тоже растит окно', async () => {
    const te = await makeTeacher(t.sql, `b1b${Date.now()}@x.io`);
    const tok = await token(te.email);
    for (let i = 0; i < 5; i++) await attempt(tok, `nope-${i}`);
    const before = (await counter(te.email))!;
    expect(before.lockedUntil).toBeTruthy();
    // верный текущий пароль во время блокировки НЕ меняет пароль: окно — не подсказка, а отказ
    const ok = await attempt(tok, PW);
    expect(ok.statusCode).toBe(403);
    expect(ok.json().error).toBe('wrongPassword');
    const mid = (await counter(te.email))!;
    expect(mid.failCount).toBe(before.failCount + 1);
    expect(mid.lockedUntil!.getTime(), 'окно отсчитывается заново и не уменьшается').toBeGreaterThanOrEqual(before.lockedUntil!.getTime());
  });

  it('успешная смена сбрасывает счётчик, и вход после окна работает', async () => {
    const te = await makeTeacher(t.sql, `b1c${Date.now()}@x.io`);
    const tok = await token(te.email);
    await attempt(tok, 'wrong-1');
    await attempt(tok, 'wrong-2');
    expect((await counter(te.email))!.failCount).toBe(2);
    const ok = await attempt(tok, PW);
    expect(ok.statusCode).toBe(200);
    expect(await counter(te.email), 'успех снимает строку — как на входе').toBeNull();
    // старый пароль больше не годится, новый — да
    expect(await token(te.email), 'старый пароль не работает').toBe('');
    expect((await token(te.email, NEXT)).length).toBeGreaterThan(20);
  });

  it('B2: уборка снимает строки старше суток без блокировки и не трогает блокировки и свежие', async () => {
    expect(LOGIN_ATTEMPT_TTL_MS).toBe(24 * 3600_000);
    const now = new Date();
    const oldPlain = `b2-old-${Date.now()}@x.io`;
    const oldLocked = `b2-lock-${Date.now()}@x.io`;
    const fresh = `b2-fresh-${Date.now()}@x.io`;
    await t.db.insert(loginAttempts).values([
      { email: oldPlain, failCount: 1, lockedUntil: null, updatedAt: new Date(now.getTime() - 30 * 3600_000) },
      { email: oldLocked, failCount: 7, lockedUntil: new Date(now.getTime() + 60_000), updatedAt: new Date(now.getTime() - 30 * 3600_000) },
      { email: fresh, failCount: 2, lockedUntil: null, updatedAt: new Date(now.getTime() - 60_000) },
    ]);
    expect(await sweepLoginAttempts(t.db, now)).toBe(1);
    expect(await counter(oldPlain)).toBeNull();
    expect((await counter(oldLocked))!.failCount, 'идущая блокировка не снимается').toBe(7);
    expect((await counter(fresh))!.failCount, 'свежий счётчик на месте').toBe(2);
    // идемпотентно
    expect(await sweepLoginAttempts(t.db, now)).toBe(0);
    await t.db.delete(loginAttempts).where(eq(loginAttempts.email, oldLocked));
    await t.db.delete(loginAttempts).where(eq(loginAttempts.email, fresh));
  });
});
