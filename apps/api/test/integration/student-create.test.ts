/**
 * Аккаунт ученика, который создаёт учитель (2026-10-27).
 *
 * Зачем появился этот маршрут. Прежний экран учителя умел только найти УЖЕ существующий аккаунт
 * по почте, и на адрес новичка отвечал `studentNotFound`: «пусть сначала зарегистрируется сам».
 * Для школьника без ссылки и без терпения это тупик, а у учителя перед глазами уже лежат имя,
 * фамилия и почта. Теперь тем же экраном аккаунт заводится, ученик сразу попадает в список, и
 * дальше работают прежние сброс и обязательная смена пароля.
 *
 * Что здесь проверяется ГЛАВНЫМ образом — что это НЕ вторая система регистрации:
 *  • пароль хешется тем же `hashPassword` и проходит ту же `passwordPolicy` (временный пароль не
 *    имеет права быть слабым: его передают человеку словами, и слабый — самая удобная дыра);
 *  • обязательная смена поднимается СЕРВЕРНЫМ гейтом (`plugins/auth.ts`), а не экраном, и её
 *    нельзя обойти прямым URL — проверка обходит API с сессией временного пароля;
 *  • аккаунт и членство создаются ОДНОЙ транзакцией: ни «аккаунт без класса», ни «класс без
 *    аккаунта» не возможны, и занявший адрес запрос не создаёт ничего;
 *  • занятая почта — это 409 и НИКАКОГО изменения чужого пароля: именно этот пункт превращал
 *    «удобное создание» в тихий сброс чужого доступа;
 *  • роль не понижается и не повышается: учительский аккаунт не становится учеником;
 *  • пароля нет ни в ответе, ни в журнале; сессия учителя не входит чужим аккаунтом.
 *
 * Отдельным блоком — что выведенные маршруты приёма по коду класса (410) правда ничего не
 * создают: умерший способ не должен остаться запасной дверью.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { POLICY_VERSION } from '@klass/shared';
import { TEST_DATABASE_URL, preparedDb, makeTeacher, type TestDB } from './util.js';
import { buildApp } from '../../src/app.js';
import { env } from '../../src/env.js';
import { auditLog, classMembers, classes, users } from '../../src/db/schema.js';
import { hashPassword, verifyPassword } from '../../src/lib/password.js';
import type { FastifyInstance } from 'fastify';

const suite = TEST_DATABASE_URL ? describe : describe.skip;
const OLD = 'Passw0rd123';
const TEMP = 'TempPupil2026';
const OWN = 'ChosenByPupil2026';

suite('Учитель создаёт аккаунт ученика и добавляет его в класс', () => {
  let t: TestDB;
  let app: FastifyInstance;

  const bearer = (tok: string) => ({ authorization: `Bearer ${tok}` });
  const create = (tok: string | null, classId: string, payload: unknown) => app.inject({
    method: 'POST', url: `/api/classes/${classId}/students`,
    ...(tok ? { headers: bearer(tok) } : {}), payload,
  });
  const roster = (tok: string, classId: string) => app.inject({
    method: 'GET', url: `/api/classes/${classId}/members`, headers: bearer(tok),
  });
  const lookup = (tok: string, classId: string, email: string) => app.inject({
    method: 'POST', url: `/api/classes/${classId}/members/lookup`, headers: bearer(tok), payload: { email },
  });
  const addExisting = (tok: string, classId: string, email: string) => app.inject({
    method: 'POST', url: `/api/classes/${classId}/members`, headers: bearer(tok), payload: { email },
  });
  const login = (email: string, password: string) => app.inject({
    method: 'POST', url: '/api/auth/login', payload: { email, password },
  });
  const teacherToken = async (email: string) => {
    const r = await login(email, OLD);
    expect(r.statusCode, r.body).toBe(200);
    return r.json().accessToken as string;
  };
  const makeClass = async (teacherId: string, name: string) => {
    const [row] = await t.db.insert(classes).values({ teacherId, name }).returning();
    return row!.id;
  };
  /** ученик, существующий ДО запроса: ровно тот случай, когда создание обязан отклонить */
  const makePupil = async (email: string, opts: { password?: string; deleted?: boolean; classId?: string } = {}) => {
    const id = crypto.randomUUID();
    const lower = email.toLowerCase();
    const password = opts.password ?? OLD;
    await t.db.insert(users).values({
      id, role: 'student', name: 'Existing', lastName: 'Pupil', email: lower,
      passwordHash: await hashPassword(password), locale: 'ru', localeExplicit: true,
      profileCompletedAt: new Date(), ...(opts.deleted ? { deletedAt: new Date() } : {}),
    });
    if (opts.classId) await t.db.insert(classMembers).values({ classId: opts.classId, userId: id });
    return { id, email: lower, password };
  };
  const rows = (classId: string, userId: string) => t.db.select().from(classMembers)
    .where(and(eq(classMembers.classId, classId), eq(classMembers.userId, userId)));
  const settle = () => new Promise((r) => setTimeout(r, 80));
  const audits = (action: string, userId: string) => t.db.select().from(auditLog).where(eq(auditLog.action, action))
    .then((all) => all.filter((row) => (row.target as { userId?: string }).userId === userId));

  beforeAll(async () => {
    t = await preparedDb(TEST_DATABASE_URL);
    env.RATE_LOGIN_MAX = 500;
    env.RATE_IP_FAIL_MAX = 500;
    app = await buildApp(t.db);
  });
  afterAll(async () => { await app?.close(); await t?.sql.end(); });

  it('создаёт ученика: роль, membership, обязательная смена, формат хеша и журнал без пароля', async () => {
    const te = await makeTeacher(t.sql, `tc-ok-${Date.now()}@x.io`);
    const tok = await teacherToken(te.email);
    const cls = await makeClass(te.id, 'Создан учителем');
    const email = `tc-ok-${Date.now()}@x.io`;

    const r = await create(tok, cls, {
      firstName: 'Азиза', lastName: 'Каримова', email: `  ${email.toUpperCase()}  `, password: TEMP,
    });
    expect(r.statusCode, r.body).toBe(201);
    const body = r.json() as { ok: boolean; userId: string; name: string; email: string; mustChangePassword: boolean };
    expect(body.ok).toBe(true);
    expect(body.name, 'экран показывает то же имя, что в списке').toBe('Азиза Каримова');
    expect(body.email, 'почта нормализована, как при входе').toBe(email);
    expect(body.mustChangePassword, 'временный пароль обязан требовать смены').toBe(true);

    const [u] = await t.db.select().from(users).where(eq(users.id, body.userId));
    expect(u!.role).toBe('student');
    expect(u!.email).toBe(email);
    expect(u!.mustChangePassword, 'ф поднят в базе, а не только в ответе').toBe(true);
    expect(u!.profileCompletedAt, 'оба имени известны — гейт «Имя и фамилия» не нужен').toBeTruthy();
    expect(u!.localeExplicit, 'язык ещё никто не выбирал').toBe(false);
    /*
     * Тот же формат хеша, что у обычной регистрации: `hashPassword` один на весь продукт, и если
     * здесь однажды появится свой генератор — ученик не войдёт, а тест обязан это поймать.
     */
    expect(u!.passwordHash).toMatch(/^\$argon2(?:id|i|d)\$v=/);
    expect(await verifyPassword(u!.passwordHash, TEMP), 'пароль проверяется штатным верификатором').toBe(true);
    expect(await verifyPassword(u!.passwordHash, OLD), 'и это именно набранный учителем пароль, а не дефолт фикстур').toBe(false);

    expect(await rows(cls, body.userId), 'членство создано тем же ходом').toHaveLength(1);

    const list = await roster(tok, cls);
    expect(list.statusCode).toBe(200);
    expect((list.json() as { userId: string }[]).map((m) => m.userId)).toContain(body.userId);

    await settle();
    const events = await audits('student_create', body.userId);
    expect(events).toHaveLength(1);
    expect(events[0]!.target).toMatchObject({ classId: cls, userId: body.userId, source: 'teacher' });
    const text = JSON.stringify(events[0]!.target);
    expect(text).not.toContain(TEMP);
    expect(text, 'ни почты в журнале создания').not.toContain(email);
    expect(r.body).not.toContain(TEMP);
  });

  it('РЕГРЕССИЯ жизненного цикла: вход временным паролем, серверный гейт, смена, старый пароль мёртв', async () => {
    const te = await makeTeacher(t.sql, `tc-life-${Date.now()}@x.io`);
    const tok = await teacherToken(te.email);
    const cls = await makeClass(te.id, 'Жизненный цикл');
    const email = `tc-life-${Date.now()}@x.io`;

    const created = await create(tok, cls, { firstName: 'Бекзод', lastName: 'Рахимов', email, password: TEMP });
    expect(created.statusCode, created.body).toBe(201);
    const userId = (created.json() as { userId: string }).userId;

    const first = await login(email, TEMP);
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json().user.mustChangePassword, 'первый вход обязан требовать смену').toBe(true);
    const tempTok = first.json().accessToken as string;

    /*
     * Гейт держит СЕРВЕР, а не экран: прямые URL и curl с токеном временного пароля не должны
     * давать доступ к уроку, чужим заметкам или ленте класса. Разрешённый список короткий
     * (`TEMP_PW_ALLOWED` в plugins/auth.ts) — проверяем и запрет на рабочих маршрутах, и то, что
     * он не сломал саму смену пароля и выход.
     */
    const classesList = await app.inject({ method: 'GET', url: '/api/classes', headers: bearer(tempTok) });
    expect(classesList.statusCode, 'с временным паролем работать нельзя').toBe(403);
    expect(classesList.json().error).toBe('passwordChangeRequired');
    const blockedFeed = await app.inject({ method: 'GET', url: `/api/classes/${cls}/feed`, headers: bearer(tempTok) });
    expect(blockedFeed.statusCode).toBe(403);
    const blockedSheets = await app.inject({ method: 'GET', url: '/api/student-notes', headers: bearer(tempTok) });
    expect(blockedSheets.statusCode, 'и свои листки недоступны до смены').toBe(403);
    const me = await app.inject({ method: 'GET', url: '/api/me', headers: bearer(tempTok) });
    expect(me.statusCode, 'профиль доступен — экрану нужно показать, что происходит').toBe(200);

    /*
     * Тот же порядок, что проходит человек в браузере: у аккаунта от учителя НЕТ записи о
     * согласии, а калитка документов стоит ПЕРЕД сменой пароля. Если бы этот маршрут тоже
     * закрывался гейтом, первый вход был бы ловушкой (согласие требует смену, смена — согласия),
     * и поймано это оказалось браузерным тестом, а не здесь — поэтому проверяется и тут.
     */
    const consent = await app.inject({
      method: 'POST', url: '/api/me/accept-policy', headers: bearer(tempTok),
      payload: { version: POLICY_VERSION },
    });
    expect(consent.statusCode, `согласие обязано пройти до смены пароля: ${consent.body}`).toBe(200);

    const changed = await app.inject({
      method: 'POST', url: '/api/me/change-password', headers: bearer(tempTok),
      payload: { current: TEMP, next: OWN },
    });
    expect(changed.statusCode, changed.body).toBe(200);

    const after = await login(email, OWN);
    expect(after.statusCode).toBe(200);
    expect(after.json().user.mustChangePassword, 'свой пароль больше не требует смены').toBe(false);
    const stale = await login(email, TEMP);
    expect(stale.statusCode, 'временный пароль перестал пускать').toBe(401);
    const openNow = await app.inject({
      method: 'GET', url: '/api/classes', headers: bearer(after.json().accessToken as string),
    });
    expect(openNow.statusCode, 'после смены доступ вернулся').toBe(200);

    expect(await rows(cls, userId)).toHaveLength(1);
  });

  it('слабый, кривой и неполный ввод — 4xx с переводимым кодом, и в базе ничего не появляется', async () => {
    const te = await makeTeacher(t.sql, `tc-bad-${Date.now()}@x.io`);
    const tok = await teacherToken(te.email);
    const cls = await makeClass(te.id, 'Отказ по вводу');
    const stamp = Date.now();
    const before = await t.db.select({ id: users.id }).from(users);

    // ровно те же коды, что у регистрации по ссылке: одна политика на все входы
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ firstName: 'Азиза', lastName: 'Каримова', email: `bad1-${stamp}@x.io`, password: 'Short1' }, 'passwordTooShort'],
      [{ firstName: 'Азиза', lastName: 'Каримова', email: `bad2-${stamp}@x.io`, password: 'password123' }, 'passwordTooCommon'],
      [{ firstName: 'Азиза', lastName: 'Каримова', email: `bad3-${stamp}@x.io`, password: '12345678901' }, 'passwordTooSimple'],
      [{ firstName: 'А', lastName: 'Каримова', email: `bad4-${stamp}@x.io`, password: TEMP }, 'invalidInput'],
      [{ firstName: 'Азиза', lastName: 'К', email: `bad5-${stamp}@x.io`, password: TEMP }, 'invalidInput'],
      [{ firstName: 'Азиза', lastName: 'Каримова', email: 'not-an-email', password: TEMP }, 'invalidInput'],
      [{ firstName: 'Азиза', lastName: 'Каримова', password: TEMP }, 'invalidInput'],
    ];
    for (const [payload, code] of cases) {
      const r = await create(tok, cls, payload);
      expect(r.statusCode, JSON.stringify(payload)).toBe(400);
      expect(r.json().error, JSON.stringify(payload)).toBe(code);
      expect(r.json().reqId, 'у отказа есть id для разбора (в UI он не показывается)').toBeTruthy();
    }

    const after = await t.db.select({ id: users.id }).from(users);
    expect(after.length, 'ни один отказ не создал аккаунта').toBe(before.length);
    expect(await t.db.select().from(classMembers).where(eq(classMembers.classId, cls)))
      .toHaveLength(0);
    // журнал проверяется ПО КЛАССУ этого теста: файл один на несколько тестов, и чужие
    // состоявшиеся создания иначе выглядели бы как наши
    const own = (await t.db.select().from(auditLog).where(eq(auditLog.action, 'student_create')))
      .filter((row) => (row.target as { classId?: string }).classId === cls);
    expect(own).toHaveLength(0, 'несостоявшееся создание не пишется в журнал');

    /*
     * Лишнее поле в теле — не способ поднять привилегию: `studentCreateSchema` его отбрасывает,
     * и аккаунт всё равно рождается учеником. Стоит ПОСЛЕ счёта выше намеренно: это успешный
     * запрос, и он как раз обязан добавить себе строку. Различается здесь «схема игнорирует
     * неизвестное поле» и «маршрут спрашивает роль у клиента» — на глаз эти два кода одинаковы.
     */
    const escalated = await create(tok, cls, {
      firstName: 'Хочет', lastName: 'Быть', email: `bad-role-${Date.now()}@x.io`, password: TEMP, role: 'teacher',
    });
    expect(escalated.statusCode, 'роль не берётся из тела').toBe(201);
    const [createdRole] = await t.db.select({ role: users.role }).from(users)
      .where(eq(users.id, (escalated.json() as { userId: string }).userId));
    expect(createdRole!.role).toBe('student');
  });

  it('занятая почта: 409, чужой пароль не тронут, членство не создано; дальше — только поиск и подтверждение', async () => {
    const te = await makeTeacher(t.sql, `tc-taken-${Date.now()}@x.io`);
    const tok = await teacherToken(te.email);
    const cls = await makeClass(te.id, 'Почта занята');
    const clsOther = await makeClass(te.id, 'Второй класс того же учителя');
    const pupil = await makePupil(`tc-taken-p-${Date.now()}@x.io`, { password: OLD });

    const r = await create(tok, cls, {
      firstName: 'Подстава', lastName: 'Фамилия', email: pupil.email.toUpperCase(), password: TEMP,
    });
    expect(r.statusCode, r.body).toBe(409);
    expect(r.json().error).toBe('emailTaken');

    const [u] = await t.db.select().from(users).where(eq(users.id, pupil.id));
    expect(u!.name, 'чужое имя не перезаписано').toBe('Existing');
    expect(u!.mustChangePassword, 'чужой пароль не переведён в временный').toBe(false);
    expect(await login(pupil.email, OLD).then((x) => x.statusCode), 'старый пароль работает').toBe(200);
    expect(await rows(cls, pupil.id), '409 не создаёт членства').toHaveLength(0);

    /*
     * Дальше — ровно тот путь, который требует постановка: учитель видит личность и класс, и
     * добавляет аккаунт только после явного подтверждения. Отказ создания НЕ является скрытым
     * сбросом пароля: сравнение ниже и есть доказательство.
     */
    const found = await lookup(tok, cls, pupil.email);
    expect(found.statusCode, found.body).toBe(200);
    expect(found.json()).toMatchObject({ userId: pupil.id, name: 'Existing Pupil', alreadyMember: false });

    const added = await addExisting(tok, cls, pupil.email);
    expect(added.statusCode, added.body).toBe(200);
    expect(added.json()).toMatchObject({ ok: true, userId: pupil.id, alreadyMember: false });
    expect(await rows(cls, pupil.id)).toHaveLength(1);
    expect(await login(pupil.email, OLD).then((x) => x.statusCode), 'и после добавления пароль прежний').toBe(200);

    // повтор: уже состоит — и членство не заводится второй раз, и пароля снова никто не трогает
    const again = await create(tok, clsOther, {
      firstName: 'Ещё', lastName: 'Раз', email: pupil.email, password: TEMP,
    });
    expect(again.statusCode).toBe(409);
    const dup = await addExisting(tok, cls, pupil.email);
    expect(dup.json().alreadyMember, 'повтор — не авария, а «уже в классе»').toBe(true);
    expect(await rows(cls, pupil.id)).toHaveLength(1);
    const inOther = await lookup(tok, clsOther, pupil.email);
    expect(inOther.json().alreadyMember, 'в другом классе этого ученика ещё нет').toBe(false);

    await settle();
    expect(await audits('student_create', pupil.id), 'отказ по занятой почте в журнал создания не пишется')
      .toHaveLength(0);
  });

  it('учитель и удалённый аккаунт не становятся учениками; роль не понижается', async () => {
    const te = await makeTeacher(t.sql, `tc-role-${Date.now()}@x.io`);
    const tok = await teacherToken(te.email);
    const cls = await makeClass(te.id, 'Роли');

    const asTeacher = await create(tok, cls, {
      firstName: 'Another', lastName: 'Teacher', email: `tc-teach-${Date.now()}@x.io`, password: TEMP,
    });
    expect(asTeacher.statusCode, 'новый аккаунт создаётся только учеником').toBe(201);
    const created = await t.db.select({ role: users.role }).from(users)
      .where(eq(users.id, (asTeacher.json() as { userId: string }).userId));
    expect(created[0]!.role).toBe('student');

    const own = await create(tok, cls, {
      firstName: 'Твой', lastName: 'Учитель', email: te.email, password: TEMP,
    });
    expect(own.statusCode, 'почта учителя занята его же аккаунтом').toBe(409);
    expect(await rows(cls, te.id)).toHaveLength(0);
    const foundTeacher = await lookup(tok, cls, te.email);
    expect(foundTeacher.statusCode, 'учительский аккаунт в ученики не добавляется').toBe(400);
    expect(foundTeacher.json().error).toBe('notAStudent');

    const gone = await makePupil(`tc-del-${Date.now()}@x.io`, { deleted: true });
    const onDeleted = await create(tok, cls, {
      firstName: 'Удалён', lastName: 'Ранее', email: gone.email, password: TEMP,
    });
    expect(onDeleted.statusCode, 'почта стёртого аккаунта остаётся занятой').toBe(409);
    const foundDeleted = await lookup(tok, cls, gone.email);
    expect(foundDeleted.statusCode, 'и удалённый аккаунт не находится как живой').toBe(404);
    expect(foundDeleted.json().error).toBe('studentNotFound');
    expect(await t.db.select({ id: users.id }).from(users).where(eq(users.email, gone.email)))
      .toHaveLength(1, 'второго аккаунта на тот же адрес не появилось');
  });

  it('гонка двух одинаковых запросов создаёт РОВНО один аккаунт и одно членство', async () => {
    const te = await makeTeacher(t.sql, `tc-race-${Date.now()}@x.io`);
    const tok = await teacherToken(te.email);
    const cls = await makeClass(te.id, 'Гонка');
    const email = `tc-race-p-${Date.now()}@x.io`;

    const both = await Promise.all([
      create(tok, cls, { firstName: 'Гонка', lastName: 'Первый', email, password: TEMP }),
      create(tok, cls, { firstName: 'Гонка', lastName: 'Первый', email, password: TEMP }),
    ]);
    const codes = both.map((x) => x.statusCode).sort();
    expect(codes, 'один 201, второй 409 — не два аккаунта и не две пятисотки').toEqual([201, 409]);

    const found = await t.db.select({ id: users.id }).from(users).where(eq(users.email, email));
    expect(found, 'уникальный индекс держит почту').toHaveLength(1);
    expect(await rows(cls, found[0]!.id), 'ровно одна строка членства').toHaveLength(1);
  });

  it('права: аноним 401, ученик 403, чужой учитель 404 — и чужой класс не создаёт аккаунта', async () => {
    const owner = await makeTeacher(t.sql, `tc-own-${Date.now()}@x.io`);
    const ownerTok = await teacherToken(owner.email);
    const cls = await makeClass(owner.id, 'Чужой класс');
    const email = `tc-priv-p-${Date.now()}@x.io`;

    const anon = await create(null, cls, { firstName: 'Аноним', lastName: 'Зритель', email, password: TEMP });
    expect(anon.statusCode).toBe(401);

    const other = await makeTeacher(t.sql, `tc-oth-${Date.now()}@x.io`);
    const otherTok = await teacherToken(other.email);
    const foreign = await create(otherTok, cls, { firstName: 'Чужой', lastName: 'Учитель', email, password: TEMP });
    expect(foreign.statusCode, foreign.body).toBe(404);
    expect(foreign.json().error).toBe('notFound');

    // владение проверяется ДО разбора тела: кривое тело на чужом классе — всё равно 404, а не 400
    const foreignBad = await create(otherTok, cls, { firstName: 'Ч', lastName: '', email: 'x', password: 'z' });
    expect(foreignBad.statusCode, 'чужой класс не светит ответом на плохое тело').toBe(404);

    const pupilTok = await login(await (async () => {
      const p = await makePupil(`tc-pupil-${Date.now()}@x.io`);
      return p.email;
    })(), OLD);
    const asPupil = await create(pupilTok.json().accessToken as string, cls, {
      firstName: 'Ученик', lastName: 'Взрослый', email, password: TEMP,
    });
    expect(asPupil.statusCode, asPupil.body).toBe(403);

    expect(await t.db.select({ id: users.id }).from(users).where(eq(users.email, email)))
      .toHaveLength(0, 'ни одна отказавшая попытка не оставила аккаунта');
    expect(await t.db.select().from(classMembers).where(eq(classMembers.classId, cls))).toHaveLength(0);

    // и своим классом — работает: проверка прав не сломала маршрут
    const ok = await create(ownerTok, cls, { firstName: 'Свой', lastName: 'Ученик', email, password: TEMP });
    expect(ok.statusCode, ok.body).toBe(201);
  });

  it('выведенные маршруты приёма по коду отвечают 410 и ничего не создают', async () => {
    const te = await makeTeacher(t.sql, `tc-dead-${Date.now()}@x.io`);
    const tok = await teacherToken(te.email);
    const cls = await makeClass(te.id, 'Мёртвые маршруты');
    const email = `tc-dead-p-${Date.now()}@x.io`;
    const before = await t.db.select({ id: users.id }).from(users);

    const calls = [
      { method: 'POST' as const, url: '/api/auth/register', payload: {
        firstName: 'Призрак', lastName: 'Кода', email, password: TEMP, code: 'ABCD23EF',
      } },
      { method: 'POST' as const, url: '/api/auth/check-code', payload: { code: 'ABCD23EF' } },
      { method: 'POST' as const, url: '/api/join-by-code', headers: bearer(tok), payload: { code: 'ABCD23EF' } },
      { method: 'POST' as const, url: `/api/classes/${cls}/invites`, headers: bearer(tok), payload: {} },
      { method: 'GET' as const, url: `/api/classes/${cls}/invites`, headers: bearer(tok) },
    ];
    for (const c of calls) {
      const r = await app.inject(c);
      expect(r.statusCode, `${c.method} ${c.url}`).toBe(410);
      expect(r.json().error, 'переводимый код, а не текст фреймворка').toBe('enrollmentRetired');
      expect(r.json().reqId, 'id для разбора остаётся в ответе').toBeTruthy();
    }

    const after = await t.db.select({ id: users.id }).from(users);
    expect(after.length, 'мёртвый путь не заводит аккаунт').toBe(before.length);
    expect(await t.db.select().from(classMembers).where(eq(classMembers.classId, cls))).toHaveLength(0);
    expect(await t.db.select().from(auditLog).where(eq(auditLog.action, 'invite_create')))
      .toHaveLength(0, 'новый код больше не создаётся и не появляется в журнале');
  });
});
