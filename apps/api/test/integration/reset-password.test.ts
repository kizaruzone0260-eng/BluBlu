/**
 * Часть C (задача 2026-10-23) — сброс пароля ученика учителем.
 *
 * Прогон до правки: ученик пять раз вводит неверный пароль, учитель «сбрасывает» его в списке
 * класса, ученик вводит новый пароль — и получает тот же 401. Причина в коде, а не в интерфейсе:
 * `login()` первым делом смотрит `login_attempts.lockedUntil` и под блокировкой не проверяет
 * пароль вообще (ровный ответ + рост окна), а `setTempPassword()` менял `users.password_hash` и
 * снимал сессии, но строку счётчика не трогал. То есть сброс не возвращал доступ ровно в том
 * случае, для которого он и нужен: человек уже не может войти.
 *
 * Второй дефект того же участка: маршрут не принимал пароль вообще, а экран показывал
 * сгенерированный пароль в строке таблицы и молчал при любой ошибке запроса.
 *
 * Третий: пароль, который задал учитель, обязан пройти ту же проверку, что и при регистрации.
 * Разрешить здесь «12345678» означало бы ослабить политику ради удобства — этого не делаем.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { TEST_DATABASE_URL, preparedDb, makeTeacher, type TestDB } from './util.js';
import { buildApp } from '../../src/app.js';
import { env } from '../../src/env.js';
import { classMembers, users, loginAttempts } from '../../src/db/schema.js';
import { hashPassword } from '../../src/lib/password.js';
import type { FastifyInstance } from 'fastify';

const suite = TEST_DATABASE_URL ? describe : describe.skip;

const OLD = 'Passw0rd123';        // пароль фикстуры `makeTeacher`
const TEMP = 'PupilTemp2026';     // то, что задаёт учитель
const WEAK = '12345678';          // запрещённая политиками классика

suite('C: сброс пароля ученика учителем', () => {
  let t: TestDB;
  let app: FastifyInstance;

  const bearer = (tok: string) => ({ authorization: `Bearer ${tok}` });

  /** Ученик класса `classId` с известным паролем — без лишнего HTTP-круга, чтобы тест был про сброс. */
  async function makePupil(classId: string, email: string, password = OLD) {
    const id = crypto.randomUUID();
    const lower = email.toLowerCase();
    await t.db.insert(users).values({
      id, role: 'student', name: 'Test', lastName: 'Pupil', email: lower,
      passwordHash: await hashPassword(password), locale: 'ru', localeExplicit: true,
      profileCompletedAt: new Date(),
    });
    await t.db.insert(classMembers).values({ classId, userId: id });
    return { id, email: lower };
  }

  async function teacherToken(email: string, password = OLD) {
    const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } });
    return (r.json().accessToken as string) ?? '';
  }

  /** Класс существующего учителя: `/api/classes` создаёт его одним ходом с проверкой прав. */
  async function createClass(tok: string, name: string) {
    const r = await app.inject({
      method: 'POST', url: '/api/classes', headers: bearer(tok), payload: { name },
    });
    return r.json().id as string;
  }

  const reset = (tok: string, classId: string, userId: string, payload?: unknown) => app.inject({
    method: 'POST', url: `/api/classes/${classId}/members/${userId}/reset-password`,
    headers: bearer(tok), ...(payload !== undefined ? { payload } : {}),
  });

  const counter = async (email: string) =>
    (await t.db.select().from(loginAttempts).where(eq(loginAttempts.email, email)).limit(1))[0] ?? null;

  /** Пять неудачных входов: ровно тот порог, после которого включается задержка. */
  async function lockOut(email: string) {
    for (let i = 1; i <= 5; i++) {
      const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: `wrong-${i}` } });
      expect(r.statusCode, `провал ${i}`).toBe(401);
    }
    const row = await counter(email);
    expect(row?.lockedUntil, 'окно наступило').toBeTruthy();
  }

  beforeAll(async () => {
    t = await preparedDb(TEST_DATABASE_URL);
    env.RATE_LOGIN_MAX = 500;   // в файле намеренных провалов больше, чем лимит на адрес
    env.RATE_IP_FAIL_MAX = 500; // и анти-переборный счётчик на адрес тоже не должен мешать тесту
    app = await buildApp(t.db);
  });
  afterAll(async () => { await app?.close(); await t?.sql.end(); });

  it('РЕГРЕССИЯ: сброс возвращает доступ заблокированному аккаунту', async () => {
    const te = await makeTeacher(t.sql, `c-lock-${Date.now()}@x.io`);
    const tok = await teacherToken(te.email);
    const cls = await createClass(tok, 'C lockout');
    const pupil = await makePupil(cls, `c-lock-p${Date.now()}@x.io`);

    await lockOut(pupil.email);
    // до сброса вход невозможен даже с ВЕРНЫМ паролем: это и есть смысл локаута
    const before = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: pupil.email, password: OLD } });
    expect(before.statusCode, 'пока окно держится, верный пароль не пускает').toBe(401);

    const r = await reset(tok, cls, pupil.id, { password: TEMP });
    expect(r.statusCode, `сброс принят: ${r.body}`).toBe(200);

    const after = await counter(pupil.email);
    expect(after, 'сброс снимает строку счётчика — доступ возвращается сразу').toBeNull();

    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: pupil.email, password: TEMP } });
    expect(login.statusCode, `вход с новым паролем: ${login.body}`).toBe(200);
    expect(login.json().user.mustChangePassword, 'временный пароль обязан быть сменён').toBe(true);
    const old = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: pupil.email, password: OLD } });
    expect(old.statusCode, 'старый пароль больше не годится').toBe(401);
  });

  it('пароль учителя принимается и НИКОГДА не возвращается обратно', async () => {
    const te = await makeTeacher(t.sql, `c-set-${Date.now()}@x.io`);
    const tok = await teacherToken(te.email);
    const cls = await createClass(tok, 'C set');
    const pupil = await makePupil(cls, `c-set-p${Date.now()}@x.io`);

    const r = await reset(tok, cls, pupil.id, { password: TEMP });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.body, 'тело ответа не содержит ни заданного пароля, ни сгенерированного').not.toContain(TEMP);
    expect(r.json().tempPassword, 'раз учитель задал пароль сам, выдавать нечего').toBeUndefined();
    // и в базе лежит хеш, а не строка
    const [row] = await t.db.select({ hash: users.passwordHash }).from(users).where(eq(users.id, pupil.id)).limit(1);
    expect(row!.hash).not.toBe(TEMP);
    expect(row!.hash.startsWith('$argon2')).toBe(true);
  });

  it('старые сессии ученика отзываются, а новые не заводятся', async () => {
    const te = await makeTeacher(t.sql, `c-sess-${Date.now()}@x.io`);
    const tok = await teacherToken(te.email);
    const cls = await createClass(tok, 'C sessions');
    const pupil = await makePupil(cls, `c-sess-p${Date.now()}@x.io`);

    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: pupil.email, password: OLD } });
    expect(login.statusCode).toBe(200);
    const cookie = login.headers['set-cookie'];
    const raw = Array.isArray(cookie) ? cookie.join('\n') : String(cookie ?? '');
    const refresh = /(?:^|\s)klass_rt=([^;]+)/.exec(raw)?.[1] ?? '';
    expect(refresh.length, 'после входа есть refresh-кука').toBeGreaterThan(10);

    expect((await reset(tok, cls, pupil.id, { password: TEMP })).statusCode).toBe(200);

    const rot = await app.inject({ method: 'POST', url: '/api/auth/refresh', headers: { cookie: `klass_rt=${refresh}` } });
    expect(rot.statusCode, 'сброс снимает существующую сессию').toBe(401);
  });

  it('слабый пароль учителя отвергается политикой, и пароль ученика НЕ меняется', async () => {
    const te = await makeTeacher(t.sql, `c-weak-${Date.now()}@x.io`);
    const tok = await teacherToken(te.email);
    const cls = await createClass(tok, 'C weak');
    const pupil = await makePupil(cls, `c-weak-p${Date.now()}@x.io`);

    const tooCommon = await reset(tok, cls, pupil.id, { password: WEAK });
    expect(tooCommon.statusCode, tooCommon.body).toBe(400);
    expect(['passwordTooShort', 'passwordTooSimple', 'passwordTooCommon']).toContain(tooCommon.json().error);

    const tooShort = await reset(tok, cls, pupil.id, { password: 'Ab1' });
    expect(tooShort.statusCode).toBe(400);

    // отказ — это отказ: старый пароль по-прежнему работает
    const still = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: pupil.email, password: OLD } });
    expect(still.statusCode, 'отказ сброса не трогает аккаунт').toBe(200);
    await t.db.update(users).set({ mustChangePassword: false }).where(eq(users.id, pupil.id));
  });

  it('чужой учитель и чужой класс получают 404, а не подсказку', async () => {
    const owner = await makeTeacher(t.sql, `c-own-${Date.now()}@x.io`);
    const ownerTok = await teacherToken(owner.email);
    const cls = await createClass(ownerTok, 'C own');
    const pupil = await makePupil(cls, `c-own-p${Date.now()}@x.io`);

    const other = await makeTeacher(t.sql, `c-oth-${Date.now()}@x.io`);
    const otherTok = await teacherToken(other.email);
    const otherClass = await createClass(otherTok, 'C other class');

    // учитель не своего класса
    expect((await reset(otherTok, cls, pupil.id, { password: TEMP })).statusCode).toBe(404);
    // и свой класс, но ученик из чужого
    expect((await reset(otherTok, otherClass, pupil.id, { password: TEMP })).statusCode).toBe(404);
    // пароль ученика не тронут
    const ok = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: pupil.email, password: OLD } });
    expect(ok.statusCode).toBe(200);
    await t.db.update(users).set({ mustChangePassword: false }).where(eq(users.id, pupil.id));
  });

  it('временный пароль держит серверный гейт: работать с классом нельзя, сменить пароль — можно', async () => {
    const te = await makeTeacher(t.sql, `c-gate-${Date.now()}@x.io`);
    const tok = await teacherToken(te.email);
    const cls = await createClass(tok, 'C gate');
    const pupil = await makePupil(cls, `c-gate-p${Date.now()}@x.io`);
    expect((await reset(tok, cls, pupil.id, { password: TEMP })).statusCode).toBe(200);

    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: pupil.email, password: TEMP } });
    expect(login.statusCode).toBe(200);
    const pTok = login.json().accessToken as string;

    // список своих классов — обычный путь ученика; под временным паролем сервер его не отдаёт
    const classesList = await app.inject({ method: 'GET', url: '/api/classes', headers: bearer(pTok) });
    expect(classesList.statusCode, 'гейт держит сервер, а не экран').toBe(403);

    const changed = await app.inject({
      method: 'POST', url: '/api/me/change-password', headers: bearer(pTok),
      payload: { current: TEMP, next: 'PupilFresh2026' },
    });
    expect(changed.statusCode, changed.body).toBe(200);
    const after = await app.inject({ method: 'GET', url: '/api/classes', headers: bearer(pTok) });
    expect(after.statusCode, 'после смены пароль становится обычным').toBe(200);
  });

  it('прежний способ (без пароля) продолжает работать: генерация остаётся на сервере', async () => {
    const te = await makeTeacher(t.sql, `c-gen-${Date.now()}@x.io`);
    const tok = await teacherToken(te.email);
    const cls = await createClass(tok, 'C gen');
    const pupil = await makePupil(cls, `c-gen-p${Date.now()}@x.io`);

    const r = await reset(tok, cls, pupil.id);
    expect(r.statusCode, r.body).toBe(200);
    const generated = r.json().tempPassword as string;
    expect(generated.length, 'сгенерированный пароль показан ровно один раз').toBeGreaterThan(9);
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: pupil.email, password: generated } });
    expect(login.statusCode).toBe(200);
    expect(login.json().user.mustChangePassword).toBe(true);
  });
});
