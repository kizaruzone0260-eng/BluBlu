/**
 * Task 2 — the name screen flag (users.profile_completed_at):
 * /api/me answers with it, registration sets it, the profile PATCH flips it
 * exactly once (both names non-empty) and never takes it back. Access rights
 * of every other endpoint are untouched.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TEST_DATABASE_URL, preparedDb, makeTeacher, makeInviteLink, loginToken, type TestDB } from './util.js';
import { buildApp } from '../../src/app.js';
import { env } from '../../src/env.js';
import { classes } from '../../src/db/schema.js';
import type { FastifyInstance } from 'fastify';

const suite = TEST_DATABASE_URL ? describe : describe.skip;

suite('profile completed flag (name screen, task 2)', () => {
  let t: TestDB;
  let app: FastifyInstance;
  let teacherId = '';
  let teacherTok = '';
  let classId = '';

  beforeAll(async () => {
    t = await preparedDb(TEST_DATABASE_URL);
    app = await buildApp(t.db);
    const teacher = await makeTeacher(t.sql, `gateT${Date.now()}@x.io`);
    teacherId = teacher.id;
    teacherTok = await loginToken(app, teacher.email, teacher.password);
    const [c] = await t.db.insert(classes).values({ teacherId, name: 'Gate' }).returning();
    classId = c!.id;
    // маршрут ссылки не собирает URL без публичного адреса и отвечает 503 — это его контракт
    env.PUBLIC_URL = 'http://127.0.0.1:3123';
  });
  afterAll(async () => { await app?.close(); await t?.sql.end(); });
  const me = (token: string) => app.inject({ method: 'GET', url: '/api/me', headers: { authorization: `Bearer ${token}` } });
  const patch = (token: string, body: Record<string, unknown>) =>
    app.inject({ method: 'PATCH', url: '/api/me/profile', headers: { authorization: `Bearer ${token}` }, payload: body });

  it('a teacher account without a family name is NOT complete (seed-teacher rule)', async () => {
    const teacher = await makeTeacher(t.sql, `gateT2${Date.now()}@x.io`); // last_name default ''
    const l = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: teacher.email, password: teacher.password } });
    const m = await me(l.json().accessToken);
    expect(m.json().profileCompleted).toBe(false);
  });

  it('finishing the name pair completes the profile exactly once and irreversibly', async () => {
    const teacher = await makeTeacher(t.sql, `gateT3${Date.now()}@x.io`);
    const l = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: teacher.email, password: teacher.password } });
    const tk = l.json().accessToken;
    const r1 = await patch(tk, { name: 'Иван', lastName: 'Петров', locale: 'ru', tz: 'Asia/Tashkent' });
    expect(r1.statusCode).toBe(200);
    expect(r1.json().profileCompleted).toBe(true);
    expect((await me(tk)).json().profileCompleted).toBe(true);
    // a later PATCH that empties the family name must NOT re-open the gate
    await patch(tk, { name: 'Иван', lastName: '', locale: 'ru', tz: 'Asia/Tashkent' });
    expect((await me(tk)).json().profileCompleted).toBe(true);
  });

  it('a PATCH with only one name filled keeps the profile incomplete', async () => {
    const teacher = await makeTeacher(t.sql, `gateT4${Date.now()}@x.io`);
    const l = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: teacher.email, password: teacher.password } });
    const tk = l.json().accessToken;
    await patch(tk, { name: 'ТолькоИмя', locale: 'ru', tz: 'Asia/Tashkent' });
    expect((await me(tk)).json().profileCompleted).toBe(false);
  });

  /*
   * 2026-10-27: раньше имя и фамилия собирали на двух шагах регистрации по коду класса. Шаг
   * выведен вместе со способом, но свойство осталось ровно то же: аккаунт, у которого оба имени
   * известны с момента создания, не должен показывать экран «Имя и фамилия». Проверяется на живом
   * пути — регистрация по одноразовой ссылке, где форма тоже спрашивает оба имени заодно.
   */
  it('registration collects both names → the student is complete at once', async () => {
    const link = await makeInviteLink(app, teacherTok, classId);
    const r = await app.inject({
      method: 'POST', url: '/api/invitations/register',
      payload: {
        token: link.token, firstName: 'Гретхен', lastName: 'Мюллер',
        email: `gateS${Date.now()}@x.io`, password: 'Secret1234',
      },
    });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().user.profileCompleted).toBe(true);
    expect((await me(r.json().accessToken)).json().profileCompleted).toBe(true);
  });

  /*
   * И обратная сторона того же контракта: аккаунт, который СОЗДАЛ УЧИТЕЛЬ (у него имя и фамилия
   * спрашивал не ученик, а учитель), тоже считается собранным — иначе ребёнок с временным паролем
   * попал бы сначала на экран имени, хотя оба поля уже введены.
   */
  it('a teacher-created account is complete at once too', async () => {
    const created = await app.inject({
      method: 'POST', url: `/api/classes/${classId}/students`, headers: { authorization: `Bearer ${teacherTok}` },
      payload: { firstName: 'Азиз', lastName: 'Карим', email: `gateC${Date.now()}@x.io`, password: 'Secret1234' },
    });
    expect(created.statusCode, created.body).toBe(201);
    const pupilTok = await loginToken(app, (created.json() as { email: string }).email, 'Secret1234');
    expect((await me(pupilTok)).json().profileCompleted).toBe(true);
  });
});
