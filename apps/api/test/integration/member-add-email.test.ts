/**
 * Добавление существующего ученика в класс по почте (задача 2026-10-26).
 *
 * Зачем это вообще нужно. Учитель видел «ученик уже существует, войдите или попросите сбросить
 * пароль», но сброс требует членства: в списке класса ученика нет — значит, и кнопки сброса нет,
 * и пароль восстановить нечем. Публичная ссылка не должна давать доступ к чужому аккаунту,
 * поэтому единственный корректный путь — учитель СВОЕГО класса добавляет уже существующий
 * ученический аккаунт по почте; после этого работает обычный сброс.
 *
 * Проверяется ровно граница:
 *  • почта нормализуется так же, как при регистрации/входе (регистр, пробелы);
 *  • добавляется только существующий, не удалённый аккаунт с ролью `student`;
 *  • чужой класс для учителя — 404, аноним — 401, ученик — 403; почты и пароля в журнале нет;
 *  • повторное добавление идемпотентно и не плодит ни членства, ни событий аудита;
 *  • прежний путь по `userId` остаётся рабочим;
 *  • полный сценарий «забыл пароль»: до добавления сброс невозможен, после — временный пароль,
 *    отзыв старой сессии и обязательная смена пароля.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { TEST_DATABASE_URL, preparedDb, makeTeacher, type TestDB } from './util.js';
import { buildApp } from '../../src/app.js';
import { env } from '../../src/env.js';
import { auditLog, classMembers, classes, users } from '../../src/db/schema.js';
import { hashPassword } from '../../src/lib/password.js';
import type { FastifyInstance } from 'fastify';

const suite = TEST_DATABASE_URL ? describe : describe.skip;
const OLD = 'Passw0rd123';
const NEW = 'BrandNew2026';

suite('Учитель добавляет существующего ученика по почте', () => {
  let t: TestDB;
  let app: FastifyInstance;

  const bearer = (tok: string) => ({ authorization: `Bearer ${tok}` });
  const addEmail = (tok: string, classId: string, payload: unknown) => app.inject({
    method: 'POST', url: `/api/classes/${classId}/members`, headers: bearer(tok), payload,
  });
  const members = (tok: string, classId: string) => app.inject({
    method: 'GET', url: `/api/classes/${classId}/members`, headers: bearer(tok),
  });
  const reset = (tok: string, classId: string, userId: string) => app.inject({
    method: 'POST', url: `/api/classes/${classId}/members/${userId}/reset-password`,
    headers: bearer(tok), payload: {},
  });
  const login = (email: string, password: string) => app.inject({
    method: 'POST', url: '/api/auth/login', payload: { email, password },
  });
  const cookieOf = (r: Awaited<ReturnType<typeof login>>) => {
    const raw = r.headers['set-cookie'];
    const all = Array.isArray(raw) ? raw.join('\n') : String(raw ?? '');
    const value = /(?:^|\s)klass_rt=([^;]+)/.exec(all)?.[1] ?? '';
    return `klass_rt=${value}`;
  };
  /** аудит пишется без ожидания — перед проверкой даём вставке завершиться */
  const settle = () => new Promise((r) => setTimeout(r, 80));

  async function teacherToken(email: string) {
    const r = await login(email, OLD);
    expect(r.statusCode, r.body).toBe(200);
    return r.json().accessToken as string;
  }

  async function makeClass(teacherId: string, name: string) {
    const [row] = await t.db.insert(classes).values({ teacherId, name }).returning();
    return row!.id;
  }

  /** Ученик без членства в классе — именно тот, кого учитель не видит в списке. */
  async function makePupil(email: string, opts: { deleted?: boolean } = {}) {
    const id = crypto.randomUUID();
    const lower = email.toLowerCase();
    await t.db.insert(users).values({
      id, role: 'student', name: 'Sam', lastName: 'Pupil', email: lower,
      passwordHash: await hashPassword(OLD), locale: 'ru', localeExplicit: true,
      profileCompletedAt: new Date(),
      ...(opts.deleted ? { deletedAt: new Date() } : {}),
    });
    return { id, email: lower };
  }

  const memberRows = (classId: string, userId: string) => t.db.select().from(classMembers)
    .where(and(eq(classMembers.classId, classId), eq(classMembers.userId, userId)));

  beforeAll(async () => {
    t = await preparedDb(TEST_DATABASE_URL);
    env.RATE_LOGIN_MAX = 500;
    env.RATE_IP_FAIL_MAX = 500;
    app = await buildApp(t.db);
  });
  afterAll(async () => { await app?.close(); await t?.sql.end(); });

  it('добавляет по нормализованной почте; повтор идемпотентен, аудит без почты и пароля', async () => {
    const te = await makeTeacher(t.sql, `ma-ok-${Date.now()}@x.io`);
    const tok = await teacherToken(te.email);
    const cls = await makeClass(te.id, 'Add by email');
    const pupil = await makePupil(`ma-ok-p-${Date.now()}@x.io`);

    // Регистр и пробелы — тот же адрес: ровно так его введёт человек, скопировав из письма.
    const r = await addEmail(tok, cls, { email: `  ${pupil.email.toUpperCase()}  ` });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ ok: true, userId: pupil.id, name: 'Sam Pupil', alreadyMember: false });

    const roster = await members(tok, cls);
    expect(roster.statusCode).toBe(200);
    expect((roster.json() as { userId: string }[]).map((m) => m.userId)).toContain(pupil.id);
    expect(await memberRows(cls, pupil.id)).toHaveLength(1);

    await settle();
    const addEvents = (await t.db.select().from(auditLog).where(eq(auditLog.action, 'member_add')))
      .filter((row) => (row.target as { userId?: string }).userId === pupil.id);
    expect(addEvents).toHaveLength(1);
    expect(addEvents[0]!.target).toMatchObject({ classId: cls, userId: pupil.id, source: 'email' });
    const targetText = JSON.stringify(addEvents[0]!.target);
    expect(targetText).not.toContain(pupil.email);
    expect(targetText).not.toContain(OLD);

    // Повторный клик: тот же ответ «уже в классе», но без второго членства и второго события.
    const again = await addEmail(tok, cls, { email: pupil.email });
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json()).toMatchObject({ ok: true, userId: pupil.id, alreadyMember: true });
    expect(await memberRows(cls, pupil.id)).toHaveLength(1);
    await settle();
    const stillOne = (await t.db.select().from(auditLog).where(eq(auditLog.action, 'member_add')))
      .filter((row) => (row.target as { userId?: string }).userId === pupil.id);
    expect(stillOne, 'несостоявшееся добавление не пишется как событие').toHaveLength(1);
  });

  it('отличает «не найден», «не ученик», удалённый и кривой ввод — и ничего не добавляет', async () => {
    const te = await makeTeacher(t.sql, `ma-no-${Date.now()}@x.io`);
    const tok = await teacherToken(te.email);
    const cls = await makeClass(te.id, 'Add negative');
    const stamp = Date.now();

    const missing = await addEmail(tok, cls, { email: `ma-ghost-${stamp}@x.io` });
    expect(missing.statusCode, missing.body).toBe(404);
    expect(missing.json().error).toBe('studentNotFound');
    expect(missing.json().reqId, 'у ошибки есть идентификатор для разбора').toBeTruthy();

    const teacher = await addEmail(tok, cls, { email: te.email });
    expect(teacher.statusCode, teacher.body).toBe(400);
    expect(teacher.json().error).toBe('notAStudent');
    expect(teacher.json().reqId).toBeTruthy();

    const deleted = await makePupil(`ma-del-${stamp}@x.io`, { deleted: true });
    const gone = await addEmail(tok, cls, { email: deleted.email });
    expect(gone.statusCode, 'удалённый аккаунт не добавляется и не отличается от отсутствующего').toBe(404);
    expect(gone.json().error).toBe('studentNotFound');

    for (const body of [{}, { userId: crypto.randomUUID(), email: `x-${stamp}@x.io` }, { email: 'not-an-email' }]) {
      const bad = await addEmail(tok, cls, body);
      expect(bad.statusCode, JSON.stringify(body)).toBe(400);
      expect(bad.json().error).toBe('invalidInput');
      expect(bad.json().reqId).toBeTruthy();
    }

    expect(await t.db.select().from(classMembers).where(eq(classMembers.classId, cls)),
      'ни один отказ не создал членства').toHaveLength(0);
  });

  it('чужой учитель — 404, ученик — 403, аноним — 401; членства не появляется', async () => {
    const owner = await makeTeacher(t.sql, `ma-own-${Date.now()}@x.io`);
    const ownerTok = await teacherToken(owner.email);
    const cls = await makeClass(owner.id, 'Add private');
    const pupil = await makePupil(`ma-priv-p-${Date.now()}@x.io`);

    const other = await makeTeacher(t.sql, `ma-oth-${Date.now()}@x.io`);
    const otherTok = await teacherToken(other.email);
    const foreign = await addEmail(otherTok, cls, { email: pupil.email });
    expect(foreign.statusCode, foreign.body).toBe(404);
    expect(foreign.json().error).toBe('notFound');

    const foreignById = await app.inject({
      method: 'POST', url: `/api/classes/${cls}/members`, headers: bearer(otherTok),
      payload: { userId: pupil.id },
    });
    expect(foreignById.statusCode).toBe(404);

    const pupilTok = (await login(pupil.email, OLD)).json().accessToken as string;
    const asPupil = await addEmail(pupilTok, cls, { email: pupil.email });
    expect(asPupil.statusCode, asPupil.body).toBe(403);

    const anon = await app.inject({
      method: 'POST', url: `/api/classes/${cls}/members`, payload: { email: pupil.email },
    });
    expect(anon.statusCode).toBe(401);

    expect(await memberRows(cls, pupil.id)).toHaveLength(0);
  });

  it('прежний путь по userId не сломан, но учителя в ученики не добавляет', async () => {
    const te = await makeTeacher(t.sql, `ma-id-${Date.now()}@x.io`);
    const tok = await teacherToken(te.email);
    const cls = await makeClass(te.id, 'Add by id');
    const pupil = await makePupil(`ma-id-p-${Date.now()}@x.io`);

    const byId = await app.inject({
      method: 'POST', url: `/api/classes/${cls}/members`, headers: bearer(tok), payload: { userId: pupil.id },
    });
    expect(byId.statusCode, byId.body).toBe(200);
    expect(byId.json()).toEqual({ ok: true });
    expect(await memberRows(cls, pupil.id)).toHaveLength(1);

    const asTeacherMember = await app.inject({
      method: 'POST', url: `/api/classes/${cls}/members`, headers: bearer(tok), payload: { userId: te.id },
    });
    expect(asTeacherMember.statusCode, asTeacherMember.body).toBe(400);
    expect(asTeacherMember.json().error).toBe('invalidInput');
    expect(await memberRows(cls, te.id)).toHaveLength(0);
  });

  it('РЕГРЕССИЯ «забыл пароль»: без членства сброса нет; после добавления — временный пароль, отзыв сессии, смена', async () => {
    const te = await makeTeacher(t.sql, `ma-pw-${Date.now()}@x.io`);
    const tok = await teacherToken(te.email);
    const cls = await makeClass(te.id, 'Forgot password');
    const pupil = await makePupil(`ma-pw-p-${Date.now()}@x.io`);

    // Так выглядела исходная жалоба: ученик в классе не числится, кнопки сброса у учителя нет.
    const tooEarly = await reset(tok, cls, pupil.id);
    expect(tooEarly.statusCode, tooEarly.body).toBe(404);

    // Старая сессия ученика — её обязан отозвать сброс.
    const before = await login(pupil.email, OLD);
    expect(before.statusCode).toBe(200);
    const oldCookie = cookieOf(before);
    expect(oldCookie).toContain('klass_rt=');

    const added = await addEmail(tok, cls, { email: pupil.email });
    expect(added.statusCode, added.body).toBe(200);
    expect(added.json().alreadyMember).toBe(false);

    const r = await reset(tok, cls, pupil.id);
    expect(r.statusCode, r.body).toBe(200);
    const temp = r.json().tempPassword as string;
    expect(typeof temp).toBe('string');
    expect(temp.length, 'временный пароль не короткий').toBeGreaterThanOrEqual(10);

    const oldLogin = await login(pupil.email, OLD);
    expect(oldLogin.statusCode, 'старый пароль перестал действовать').toBe(401);

    const tempLogin = await login(pupil.email, temp);
    expect(tempLogin.statusCode, tempLogin.body).toBe(200);
    expect(tempLogin.json().user.mustChangePassword, 'временный пароль требует смены').toBe(true);
    const tempTok = tempLogin.json().accessToken as string;

    const oldRefresh = await app.inject({
      method: 'POST', url: '/api/auth/refresh', headers: { cookie: oldCookie },
    });
    expect(oldRefresh.statusCode, 'сброс снимает прежнюю сессию').toBe(401);

    const changed = await app.inject({
      method: 'POST', url: '/api/me/change-password', headers: bearer(tempTok),
      payload: { current: temp, next: NEW },
    });
    expect(changed.statusCode, changed.body).toBe(200);

    const fresh = await login(pupil.email, NEW);
    expect(fresh.statusCode, fresh.body).toBe(200);
    expect(fresh.json().user.mustChangePassword).toBe(false);

    // Роспись не задвоилась за весь сценарий, а в журнале сброса нет самого пароля.
    expect(await memberRows(cls, pupil.id)).toHaveLength(1);
    await settle();
    const resetEvents = (await t.db.select().from(auditLog).where(eq(auditLog.action, 'reset_password')))
      .filter((row) => (row.target as { userId?: string }).userId === pupil.id);
    expect(resetEvents).toHaveLength(1);
    expect(JSON.stringify(resetEvents)).not.toContain(temp);
    expect(JSON.stringify(resetEvents)).not.toContain(NEW);
  });
});
