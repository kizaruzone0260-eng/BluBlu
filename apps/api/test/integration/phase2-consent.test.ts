/**
 * Phase 2 — consent capture. A freshly created account has NOT accepted the
 * current bundle; acceptance is recorded with the version + timestamp and is
 * reflected by /api/me. A stale version or a malformed body is refused, and an
 * anonymous caller cannot record consent.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { TEST_DATABASE_URL, preparedDb, makeTeacher, makeStudent, loginToken, type TestDB } from './util.js';
import { buildApp } from '../../src/app.js';
import { classes, policyAcceptances } from '../../src/db/schema.js';
import { POLICY_VERSION } from '@klass/shared';
import type { FastifyInstance } from 'fastify';

const suite = TEST_DATABASE_URL ? describe : describe.skip;

suite('Phase 2 consent', () => {
  let t: TestDB; let app: FastifyInstance;
  let teacherId = ''; let classId = '';

  /*
   * Ученик фикстуры — `makeStudent` + `loginToken` (2026-10-27), после вывода приёма по
   * восьмизначному коду класса. Выбор осознанный, и его надо беречь: `/api/me` считает
   * `policyAccepted` по строке в `policy_acceptances`, а её у вставленного аккаунта нет — значит
   * согласие ещё НЕ дано, ровно то и проверяет первый тест. При этом `makeStudent` проставляет
   * `profile_completed_at`, и здесь это тоже правильно: экран согласия не про имя, тесту нужен
   * свежий аккаунт без принятой политики, а не аккаунт, у которого профиль ещё не собран.
   */
  async function newStudent(email: string): Promise<string> {
    const stu = await makeStudent(t.sql, { classId, email });
    return loginToken(app, stu.email, stu.password);
  }
  const bearer = (tok: string) => ({ authorization: `Bearer ${tok}` });

  beforeAll(async () => {
    t = await preparedDb(TEST_DATABASE_URL);
    app = await buildApp(t.db);
    const te = await makeTeacher(t.sql, `cons${Date.now()}@x.io`);
    teacherId = te.id;
    const [c] = await t.db.insert(classes).values({ teacherId, name: 'C' }).returning();
    classId = c!.id;
  });
  afterAll(async () => { await app?.close(); await t?.sql.end(); });

  it('a new account has policyAccepted=false and no acceptance row', async () => {
    const tok = await newStudent(`c1${Date.now()}@x.io`);
    const me = await app.inject({ method: 'GET', url: '/api/me', headers: bearer(tok) });
    expect(me.json().policyAccepted).toBe(false);
  });

  it('accept-policy stores the current version + time and flips /api/me', async () => {
    const tok = await newStudent(`c2${Date.now()}@x.io`);
    const userId = (await app.inject({ method: 'GET', url: '/api/me', headers: bearer(tok) })).json().id as string;
    const ok = await app.inject({ method: 'POST', url: '/api/me/accept-policy', headers: bearer(tok), payload: { version: POLICY_VERSION } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().version).toBe(POLICY_VERSION);
    expect((await app.inject({ method: 'GET', url: '/api/me', headers: bearer(tok) })).json().policyAccepted).toBe(true);
    const rows = await t.db.select().from(policyAcceptances).where(eq(policyAcceptances.userId, userId));
    expect(rows[0]?.version).toBe(POLICY_VERSION);
    expect(rows[0]?.acceptedAt).toBeInstanceOf(Date);
    // idempotent: a second accept keeps exactly one row
    await app.inject({ method: 'POST', url: '/api/me/accept-policy', headers: bearer(tok), payload: { version: POLICY_VERSION } });
    expect((await t.db.select().from(policyAcceptances).where(eq(policyAcceptances.userId, userId))).length).toBe(1);
  });

  it('a stale version is refused with 409', async () => {
    const tok = await newStudent(`c3${Date.now()}@x.io`);
    const r = await app.inject({ method: 'POST', url: '/api/me/accept-policy', headers: bearer(tok), payload: { version: '1999-01-01' } });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe('policyVersionStale');
    expect((await app.inject({ method: 'GET', url: '/api/me', headers: bearer(tok) })).json().policyAccepted).toBe(false);
  });

  /*
   * Аудит SEC-01/02/09 (2026-10-28): текст политики изменился, поэтому `POLICY_VERSION` поднят.
   * Повторное согласие — не новая механика, а СЛЕДСТВИЕ версии: строка, принятая под прежней
   * версией, остаётся в базе (это история), но `/api/me` больше не считает её действующей.
   * Дальше ровно одно принятие текущей версии перезаписывает строку, а не плодит вторую.
   *
   * `2000-01-01` — намеренно «давняя» версия, а не конкретный прошлый релиз: тест обязан
   * пережить следующее повышение `POLICY_VERSION` и не зависит от даты в тексте.
   */
  it('an acceptance of an older version no longer counts and is replaced on re-consent', async () => {
    const tok = await newStudent(`c5${Date.now()}@x.io`);
    const userId = (await app.inject({ method: 'GET', url: '/api/me', headers: bearer(tok) })).json().id as string;
    await t.db.insert(policyAcceptances)
      .values({ userId, version: '2000-01-01', acceptedAt: new Date() });

    expect((await app.inject({ method: 'GET', url: '/api/me', headers: bearer(tok) })).json().policyAccepted).toBe(false);

    const again = await app.inject({ method: 'POST', url: '/api/me/accept-policy', headers: bearer(tok), payload: { version: POLICY_VERSION } });
    expect(again.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/me', headers: bearer(tok) })).json().policyAccepted).toBe(true);

    const rows = await t.db.select().from(policyAcceptances).where(eq(policyAcceptances.userId, userId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.version).toBe(POLICY_VERSION);
  });

  it('a malformed version is 400; anonymous cannot record consent', async () => {
    const tok = await newStudent(`c4${Date.now()}@x.io`);
    const bad = await app.inject({ method: 'POST', url: '/api/me/accept-policy', headers: bearer(tok), payload: { version: 'v1' } });
    expect(bad.statusCode).toBe(400);
    const anon = await app.inject({ method: 'POST', url: '/api/me/accept-policy', payload: { version: POLICY_VERSION } });
    expect(anon.statusCode).toBe(401);
  });
});
