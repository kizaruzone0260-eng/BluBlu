/**
 * C2 (2026-10-16): принудительная смена временного пароля держится СЕРВЕРОМ.
 *
 * До этой правки флаг `must_change_password` только возвращался в профиле, а барьер был
 * клиентским (`apps/web/src/App.tsx`): человек с временным паролем и знанием URL API получал
 * полноценный bearer и работал с классами, чужими заметками и доской, не сменив пароль.
 * Здесь проверяется ровно то, что раньше не проверялось: что сервер сам отказывает такому
 * bearer'у на всех маршрутах, кроме смены пароля, чтения своего профиля, принятия документов и
 * выхода. Три первых теста — про запрет; четвёртый появился 2026-10-27 и держит ровно обратное:
 * согласие с документами от этого списка не исчезнет, иначе аккаунт от учителя не может сделать
 * первый шаг.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { POLICY_VERSION } from '@klass/shared';
import { TEST_DATABASE_URL, preparedDb, makeTeacher, type TestDB } from './util.js';
import { buildApp } from '../../src/app.js';
import { env } from '../../src/env.js';
import { users } from '../../src/db/schema.js';
import type { FastifyInstance } from 'fastify';

const suite = TEST_DATABASE_URL ? describe : describe.skip;
const PW = 'Passw0rd123';
const NEW_PW = 'Another-Correct-Horse-42';

suite('C2: временный пароль без смены не даёт работать с API', () => {
  let t: TestDB; let app: FastifyInstance; let email = '';

  async function login() {
    const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: PW } });
    expect(r.statusCode, `вход временным паролем должен удасться, а не быть 401`).toBe(200);
    return { accessToken: String(r.json().accessToken), user: r.json().user as { mustChangePassword: boolean } };
  }
  const bearer = (tok: string) => ({ authorization: `Bearer ${tok}` });

  beforeAll(async () => {
    t = await preparedDb(TEST_DATABASE_URL);
    env.RATE_LOGIN_MAX = 500;
    app = await buildApp(t.db);
  });
  afterAll(async () => { await app?.close(); await t?.sql.end(); });

  it('заложивает предусловие: у учителя стоит флаг принудительной смены', async () => {
    const te = await makeTeacher(t.sql, `gate${Date.now()}@x.io`);
    email = te.email;
    await t.db.update(users).set({ mustChangePassword: true }).where(eq(users.id, te.id));
    const l = await login();
    expect(l.user.mustChangePassword).toBe(true);
  });

  it('любой рабочий маршрут — 403 с внятным кодом, а не 200', async () => {
    const { accessToken } = await login();
    for (const url of ['/api/classes', '/api/notes', '/api/chat/summary', '/api/events']) {
      const r = await app.inject({ method: 'GET', url, headers: bearer(accessToken) });
      expect(r.statusCode, `«${url}» с временным паролем обязан быть закрыт`).toBe(403);
      expect(r.json().error).toBe('passwordChangeRequired');
    }
  });

  it('записывающий маршрут тоже закрыт: пароль нельзя «обойти» полезным действием', async () => {
    const { accessToken } = await login();
    const r = await app.inject({
      method: 'POST', url: '/api/classes', headers: bearer(accessToken),
      payload: { name: 'Обход гейта', description: '', color: '#0ea5a5' },
    });
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toBe('passwordChangeRequired');
  });

  /*
   * 2026-10-27: аккаунт, который создал учитель, arrives with BOTH flags — no policy acceptance
   * and a temporary password. `App.tsx` shows the legal gate first, so refusing
   * `POST /api/me/accept-policy` here made such an account unusable: the screen asked for consent,
   * consent asked for a password change, and the password change screen only opens after consent.
   * Caught by the browser spec `zz32-teacher-create`, not by review. Standing BEFORE the test that
   * changes the password, because from that point this precondition no longer holds.
   */
  it('принять документы с временным паролем можно — иначе первый вход в ловушке', async () => {
    const { accessToken } = await login();
    const ok = await app.inject({
      method: 'POST', url: '/api/me/accept-policy', headers: bearer(accessToken),
      payload: { version: POLICY_VERSION },
    });
    expect(ok.statusCode, `согласие не должно упираться в гейт: ${ok.body}`).toBe(200);

    // это НЕ лазейка в списке разрешённых: чужую и устаревшую версию маршрута по-прежнему 409
    const stale = await app.inject({
      method: 'POST', url: '/api/me/accept-policy', headers: bearer(accessToken),
      payload: { version: '2000-01-01' },
    });
    expect(stale.statusCode, 'устаревшая версия не проходит даже сюда').toBe(409);
    expect(stale.json().error).toBe('policyVersionStale');

    // и рабочий маршрут остаётся закрытым ПОСЛЕ согласия: список не превратился в пропуск
    const blocked = await app.inject({ method: 'GET', url: '/api/classes', headers: bearer(accessToken) });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error).toBe('passwordChangeRequired');
  });

  it('сменить пароль, прочитать свой профиль и выйти всё ещё можно', async () => {
    const { accessToken } = await login();
    expect((await app.inject({ method: 'GET', url: '/api/me', headers: bearer(accessToken) })).statusCode).toBe(200);
    const weak = await app.inject({
      method: 'POST', url: '/api/me/change-password', headers: bearer(accessToken),
      payload: { current: PW, next: 'short' },
    });
    expect(weak.statusCode, 'слабый новый пароль отсекается политикой, а не гейтом').toBe(400);
    const ok = await app.inject({
      method: 'POST', url: '/api/me/change-password', headers: bearer(accessToken),
      payload: { current: PW, next: NEW_PW },
    });
    expect(ok.statusCode, `смена пароля обязана пройти: ${JSON.stringify(ok.json())}`).toBe(200);
  });

  it('после смены флаг снят, и API снова открыт', async () => {
    const l = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: NEW_PW } });
    expect(l.statusCode).toBe(200);
    expect((l.json().user as { mustChangePassword: boolean }).mustChangePassword).toBe(false);
    const r = await app.inject({ method: 'GET', url: '/api/classes', headers: bearer(String(l.json().accessToken)) });
    expect(r.statusCode, 'свой пароль = обычный доступ').toBe(200);
  });

  it('отрицательный контроль: обычный аккаунт гейт не трогает', async () => {
    const te = await makeTeacher(t.sql, `plain${Date.now()}@x.io`);
    const l = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: te.email, password: PW } });
    const r = await app.inject({ method: 'GET', url: '/api/classes', headers: bearer(String(l.json().accessToken)) });
    expect(r.statusCode).toBe(200);
  });
});
