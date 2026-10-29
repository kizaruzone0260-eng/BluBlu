/**
 * Bot task §7 — dispatcher tests with a MOCKED Telegram API (CapturingApi):
 * no token, no network. Roles, callback signing/forgery, class isolation,
 * public-schedule switch, /announce (pick→text→confirm→send / cancel / expiry /
 * double-press / foreign class), /contact (3 steps, cancel, limits, block,
 * teacher reply, HTML escaping), dialog survival across app instances,
 * update_id idempotency, group silence, command menus on link/unlink.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import { TEST_DATABASE_URL, preparedDb, makeTeacher, acceptPolicy, type TestDB } from './util.js';
import { buildApp } from '../../src/app.js';
import {
  auditLog, botSessions, classes, classMembers, contactBlocklist, contactReports,
  notifications, posts, telegramLinks, telegramTokens, users,
} from '../../src/db/schema.js';
import { handleUpdate, T, type BotDeps } from '../../src/services/bot.js';
import { CapturingApi, signCb } from '../../src/services/botApi.js';
import { hashPassword } from '../../src/lib/password.js';
import { hashToken, newOpaqueToken } from '../../src/services/notify.js';
import { createEvent } from '../../src/services/events.js';
import { env } from '../../src/env.js';
import type { FastifyInstance } from 'fastify';

const suite = TEST_DATABASE_URL ? describe : describe.skip;

suite('telegram bot (mocked api)', () => {
  let t: TestDB;
  let app: FastifyInstance;
  let teacherId = '';
  let classId = '';
  let studentId = '';
  let api: CapturingApi;
  let deps: BotDeps;
  let uid = 1_000_000; // unique update_id base → idempotency ledger is per-test-safe

  const T_CHAT = 501; const S_CHAT = 601;
  const msg = (chatId: number, text: string, type = 'private') => ({
    update_id: ++uid,
    message: { message_id: 1, chat: { id: chatId, type }, from: { id: chatId }, text },
  });
  const cbq = (chatId: number, payload: Record<string, string>) => ({
    update_id: ++uid,
    callback_query: {
      id: `q${uid}`, from: { id: chatId },
      message: { message_id: 5, chat: { id: chatId, type: 'private' } },
      data: signCb(payload),
    },
  });
  const rawCb = (chatId: number, data: string) => ({
    update_id: ++uid,
    callback_query: { id: `q${uid}`, from: { id: chatId }, message: { message_id: 5, chat: { id: chatId, type: 'private' } }, data },
  });
  const go = async (u: Parameters<typeof handleUpdate>[1]) => { await handleUpdate(deps, u); };
  const texts = () => api.calls.filter((c) => c.text !== undefined).map((c) => c.text as string);
  const lastText = () => { const l = texts(); return l[l.length - 1] ?? ''; };
  const clear = () => { api.calls.length = 0; };

  beforeAll(async () => {
    t = await preparedDb(TEST_DATABASE_URL);
    app = await buildApp(t.db);
    const teacher = await makeTeacher(t.sql, `botT${Date.now()}@x.io`);
    teacherId = teacher.id;
    await t.db.insert(telegramLinks).values({ userId: teacherId, chatId: String(T_CHAT) });
    const [cls] = await t.db.insert(classes).values({ teacherId, name: `7Q ${Date.now()}` }).returning();
    classId = cls!.id;
    const [stu] = await t.db.insert(users).values({
      role: 'student', name: 'Сидор', lastName: 'Сидоров', email: `bots${Date.now()}@x.io`,
      passwordHash: await hashPassword('Secret1234'), profileCompletedAt: new Date(),
      // the assertions below read Russian bot texts, so this account chose Russian (task 1)
      locale: 'ru', localeExplicit: true,
    }).returning().then((r) => [r[0]]);
    studentId = stu!.id;
    await acceptPolicy(t.sql, studentId);
    await t.db.insert(classMembers).values({ classId, userId: studentId });
    await t.db.insert(telegramLinks).values({ userId: studentId, chatId: String(S_CHAT) });
    api = new CapturingApi();
    deps = { db: t.db, api, isGroupAdmin: async () => false };
    const d = new Date();
    const p = (n: number) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    await createEvent(t.db, classId, {
      kind: 'lesson', title: 'Дроби', description: 'секретное описание',
      startLocal: `${p(0)}T16:30`, durationMin: 45, tz: 'Asia/Tashkent',
    });
  });
  afterAll(async () => { await app?.close(); await t?.sql.end(); });

  it('idempotency: the same update_id is processed exactly once', async () => {
    clear();
    const u = msg(910, '/help');
    await go(u);
    const n1 = api.calls.length;
    expect(n1).toBeGreaterThan(0);
    await go(u); // redelivery (webhook retry after a sleeping boot)
    expect(api.calls.length).toBe(n1);
  });

  it('groups: the bot answers nothing except /link', async () => {
    clear();
    await go({ update_id: ++uid, message: { message_id: 1, chat: { id: -100, type: 'group' }, from: { id: 5 }, text: '/schedule' } });
    await go({ update_id: ++uid, message: { message_id: 1, chat: { id: -100, type: 'supergroup' }, from: { id: 5 }, text: '/announce' } });
    expect(api.calls.length).toBe(0);
  });

  it('student cannot run teacher commands (nor by callback forgery)', async () => {
    clear();
    await go(msg(S_CHAT, '/announce'));
    expect(lastText()).toContain('только учителю');
    clear();
    await go(msg(S_CHAT, '/classes'));
    expect(lastText()).toContain('только учителю');
    clear();
    await go(msg(S_CHAT, '/settings'));
    expect(lastText()).toContain('только учителю');
    // a student sending a callback signed for the TEACHER is refused (bound to user)
    clear();
    await go(cbq(S_CHAT, { u: teacherId, a: 'ansend', c: classId }));
    expect(lastText()).toContain('устарела или не для вас');
    // unsigned/garbage callback
    clear();
    await go(rawCb(S_CHAT, 'c1.bogus.sig'));
    expect(lastText()).toContain('устарела или не для вас');
  });

  it('class isolation: a student cannot pull another class through callbacks', async () => {
    const [other] = await t.db.insert(classes).values({ teacherId, name: `9Z ${Date.now()}` }).returning();
    clear();
    await go(cbq(S_CHAT, { u: studentId, a: 'sch', c: other!.id, r: 'today' }));
    expect(lastText()).toContain('не найден');
    clear();
    await go(cbq(S_CHAT, { u: studentId, a: 'mat', c: other!.id }));
    expect(lastText()).toContain('только учителю');
    // teacher-only materials of a class the teacher does own works via picker
    clear();
    await go(msg(T_CHAT, '/materials'));
    expect(lastText()).toContain('Выберите класс');
  });

  it('schedule by name: hidden when the switch is off, time+title only when on', async () => {
    const [pub] = await t.db.insert(classes).values({ teacherId, name: `PUB${Date.now()}`, botPublicSchedule: false }).returning();
    const name = pub!.name;
    clear();
    await go(msg(920, '/schedule')); // unbound chat
    // an unbound chat has no profile, so the bot answers in the product default — English
    // since task 1 (it used to be Russian for everybody). The assertion itself is unchanged.
    expect(lastText()).toContain('exact class name');
    clear();
    await go(msg(920, name));
    expect(lastText()).toContain('Class not found');;  // unbound chat → default language (task 1)
    await t.db.update(classes).set({ botPublicSchedule: true }).where(eq(classes.id, pub!.id));
    await t.db.insert(classMembers).values({ classId: pub!.id, userId: studentId });
    const d = new Date();
    await createEvent(t.db, pub!.id, {
      kind: 'lesson', title: 'Открытый урок', description: 'не показывать',
      startLocal: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate() + 1).padStart(2, '0')}T15:00`,
      durationMin: 45, tz: 'Asia/Tashkent',
    });
    clear();
    await go(msg(921, '/schedule'));
    clear();
    await go(msg(921, name));
    const out = lastText();
    expect(out).toContain('Открытый урок');
    expect(out).not.toContain('http'); // no lesson links / URLs for unbound lookups
    expect(out).not.toContain('не показывать');
    // wrong name and closed class answer identically
    clear();
    await go(msg(922, '/schedule'));
    clear();
    await go(msg(922, 'нет-такого-класса'));
    expect(lastText()).toContain('Class not found');;  // unbound chat → default language (task 1)
  });

  it('/announce: pick → text → preview → send (post + notify + audit), double-press deduped', async () => {
    clear();
    await go(msg(T_CHAT, '/announce'));
    const pick = api.last('send');
    expect(JSON.stringify(pick?.opts?.buttons ?? '')).toContain('c2.');
    clear();
    await go(cbq(T_CHAT, { u: teacherId, a: 'an', c: classId }));
    expect(lastText()).toContain('Текст объявления');
    clear();
    await go(msg(T_CHAT, 'Завтра контрольная <b>тест</b>'));
    const preview = api.last('send');
    expect(preview?.text).toContain('Класс');
    expect(preview?.text).toContain('1 ученик');
    expect(preview?.text).toContain('&lt;b&gt;'); // user markup is escaped, never raw
    expect(preview?.opts?.html).toBe(true);
    // cancel first: nothing must be posted
    clear();
    await go(cbq(T_CHAT, { u: teacherId, a: 'ancancel', c: classId }));
    expect(lastText()).toContain('Отменено');
    expect(await t.db.select().from(posts)).toHaveLength(0);
    // redo and SEND
    clear();
    await go(cbq(T_CHAT, { u: teacherId, a: 'an', c: classId }));
    await go(msg(T_CHAT, 'Завтра контрольная <b>тест</b>'));
    clear();
    await go(cbq(T_CHAT, { u: teacherId, a: 'ansend', c: classId }));
    expect(lastText()).toContain('Отправлено');
    const [post] = await t.db.select().from(posts).where(and(eq(posts.classId, classId)));
    expect(post?.kind).toBe('announcement');
    const notes = await t.db.select().from(notifications).where(eq(notifications.dedupeKey, `post:${post!.id}|u:${studentId}`));
    expect(notes.length).toBe(1);
    const aud = await t.db.select().from(auditLog).where(eq(auditLog.action, 'bot_announce'));
    expect(aud.length).toBe(1);
    // double press → alreadySent, no duplicate post
    clear();
    await go(cbq(T_CHAT, { u: teacherId, a: 'ansend', c: classId }));
    expect(lastText()).toContain('уже отправлено');
    const all = await t.db.select().from(posts);
    expect(all.length).toBe(1);
  });

  it('/announce: confirmation expires after 10 minutes', async () => {
    clear();
    await go(cbq(T_CHAT, { u: teacherId, a: 'an', c: classId }));
    await go(msg(T_CHAT, 'Истечение проверки'));
    await t.db.update(botSessions).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(botSessions.chatId, String(T_CHAT)));
    clear();
    await go(cbq(T_CHAT, { u: teacherId, a: 'ansend', c: classId }));
    expect(lastText()).toContain('уже отправлено'); // the expired session cannot be claimed
    const before = await t.db.select().from(posts);
    expect(before.length).toBe(1); // still only the one earlier post
  });

  it('/announce: quick form + ambiguity → class buttons', async () => {
    clear();
    const clsRow = (await t.db.select({ name: classes.name }).from(classes).where(eq(classes.id, classId)).limit(1))[0]!;
    await go(msg(T_CHAT, `/announce ${clsRow.name} срочно перенос урока`));
    const prev = api.last('send');
    expect(prev?.text).toContain('Класс');
    expect(prev?.text).toContain('срочно перенос урока');
    clear();
    await go(msg(T_CHAT, '/announce НетТакогоКласса текст'));
    expect(lastText()).toContain('Выберите или отправьте');
    // cancel the pending dialog so later tests start clean
    await go(cbq(T_CHAT, { u: teacherId, a: 'ancancel', c: classId }));
  });

  it('/contact: three steps, escaped HTML report to the owner teacher, reply + block', async () => {
    const sender = 930; // unbound user → the bot speaks the product default (English) since task 1
    clear();
    await go(msg(sender, '/contact'));
    expect(lastText()).toContain('Step 1/3');
    clear();
    await go(msg(sender, 'Аноним Вопросов'));
    expect(lastText()).toContain('Step 2/3');
    clear();
    await go(msg(sender, '7Q')); // class hint as typed
    expect(lastText()).toContain('Step 3/3');
    clear();
    await go(msg(sender, 'Здравствуйте! <script>alert(1)</script>'));
    const report = api.calls.find((c) => c.kind === 'send' && c.chatId === String(T_CHAT));
    expect(report).toBeTruthy(); // owner teacher (linked)
    expect(report?.text).toContain('&lt;script&gt;');
    expect(report?.text).toContain('Аноним Вопросов');
    expect(report?.text).toContain('7Q');
    expect(report?.opts?.html).toBe(true);
    const [rep] = await t.db.select().from(contactReports).where(eq(contactReports.senderChatId, String(sender))).limit(1);
    expect(rep?.delivered).toBe(true);
    expect(rep?.expiresAt.getTime() > Date.now() + 29 * 86400_000).toBe(true); // 30-day link
    // teacher replies
    clear();
    await go(cbq(T_CHAT, { u: teacherId, a: 'creply', r: rep!.id }));
    expect(lastText()).toContain('Ответ ученику');
    clear();
    await go(msg(T_CHAT, 'Урок в четверг, всё будет.'));
    const forwarded = api.calls.find((c) => c.kind === 'send' && c.chatId === String(sender));
    expect(forwarded?.text).toContain('Ответ учителя:');
    // teacher blocks the sender
    clear();
    await go(cbq(T_CHAT, { u: teacherId, a: 'cblock', r: rep!.id }));
    expect(lastText()).toContain('заблокирован');
    const [bl] = await t.db.select().from(contactBlocklist).where(eq(contactBlocklist.senderChatId, String(sender))).limit(1);
    expect(bl?.blockedBy).toBe(teacherId);
    clear();
    await go(msg(sender, '/contact'));
    expect(lastText()).toContain('blocked');   // anonymous (unbound) sender → default language (task 1)
    // unblock through /settings button
    clear();
    await go(msg(T_CHAT, '/settings'));
    const st = api.last('send');
    expect(JSON.stringify(st?.opts?.buttons ?? '')).toContain('Разблокировать');
    await go(cbq(T_CHAT, { u: teacherId, a: 'unblock', c: String(sender) }));
    const left = await t.db.select().from(contactBlocklist);
    expect(left.length).toBe(0);
  });

  it('/contact: /cancel, expiry, 3-per-hour limit, teacher refused', async () => {
    const sender = 940;
    clear();
    await go(msg(sender, '/contact'));
    await go(msg(sender, 'Бросил Диалог'));
    clear();
    await go(msg(sender, '/cancel'));
    expect(lastText()).toContain('Cancelled');   // unbound sender → default language (task 1)
    clear();
    await go(msg(sender, 'это уже не диалог')); // plain text outside a dialog → ignored
    expect(api.calls.length).toBe(0);
    // expiry: start, force-expire the session, the next text is NOT a dialog answer
    await go(msg(sender, '/contact'));
    await go(msg(sender, 'Истёк Истёков'));
    await t.db.update(botSessions).set({ expiresAt: new Date(Date.now() - 1) }).where(eq(botSessions.chatId, String(sender)));
    clear();
    await go(msg(sender, 'после истечения'));
    expect(api.calls.length).toBe(0);
    // limit 3/hour (sender 940 already used 2 fresh starts above)
    let lastReply = '';
    for (let i = 0; i < 3; i++) {
      clear();
      await go(msg(sender, '/contact'));
      lastReply = lastText();
    }
    expect(lastReply).toContain('At most 3 messages per hour');   // unbound sender → default language (task 1)
    // a teacher may not use /contact
    clear();
    await go(msg(T_CHAT, '/contact'));
    expect(lastText()).toContain('только ученикам');
  });

  it('/contact from a LINKED student carries the confirmed account line + class buttons', async () => {
    clear();
    await go(msg(S_CHAT, '/contact'));
    await go(msg(S_CHAT, 'Сидор Сидоров'));
    const ask = api.last('send');
    expect(JSON.stringify(ask?.opts?.buttons ?? '')).toContain('7Q'); // his classes as buttons
    const clsRow = (await t.db.select({ name: classes.name }).from(classes).where(eq(classes.id, classId)).limit(1))[0]!;
    await go(cbq(S_CHAT, { u: studentId, a: 'ccls', c: classId }));
    expect(lastText()).toContain('Шаг 3/3');
    clear();
    await go(msg(S_CHAT, 'Не понимаю дроби'));
    const report = api.calls.find((c) => c.kind === 'send' && c.chatId === String(T_CHAT));
    expect(report?.text).toContain('Аккаунт: Сидор Сидоров');
    expect(report?.text).toContain('подтверждено');
    expect(report?.text).toContain(clsRow.name);
    const [rep] = await t.db.select().from(contactReports).where(eq(contactReports.senderChatId, String(S_CHAT))).limit(1);
    expect(rep?.classId).toBe(classId);
    expect(rep?.senderUserId).toBe(studentId);
  });

  it('dialog state survives an app restart (Postgres-backed)', async () => {
    const sender = 950;
    clear();
    await go(msg(sender, '/contact'));
    await go(msg(sender, 'Пережил Рестарт'));
    const [sess] = await t.db.select().from(botSessions).where(eq(botSessions.chatId, String(sender))).limit(1);
    expect(sess?.state).toBe('contact:class');
    // a brand-new app instance (fresh module deps, same DB) continues the dialog
    const api2 = new CapturingApi();
    const deps2: BotDeps = { db: t.db, api: api2, isGroupAdmin: async () => false };
    await handleUpdate(deps2, {
      update_id: ++uid,
      message: { message_id: 9, chat: { id: sender, type: 'private' }, from: { id: sender }, text: '7Q' },
    });
    expect((api2.calls[api2.calls.length - 1]?.text ?? '')).toContain('Step 3/3'); // unbound sender → default language (task 1)
    clear();
    await t.db.delete(botSessions).where(eq(botSessions.chatId, String(sender)));
  });

  it('link applies the role menu (chat scope); an English account gets English under every language', async () => {
    const [stu2] = await t.db.insert(users).values({
      role: 'student', name: 'Меню', lastName: 'Тест', email: `botm${Date.now()}@x.io`,
      passwordHash: await hashPassword('Secret1234'), profileCompletedAt: new Date(),
    }).returning();
    await acceptPolicy(t.sql, stu2!.id);
    const token = newOpaqueToken();
    await t.db.insert(telegramTokens).values({ tokenHash: hashToken(token), userId: stu2!.id, expiresAt: new Date(Date.now() + 60_000) });
    clear();
    await go(msg(960, `/start ${token}`));
    const cmds = api.calls.filter((c) => c.kind === 'cmds');
    // This account has no chosen locale, so it is the English default — and the menu of THIS
    // chat is installed under ru, uz, en and the language-less fallback (4 slots). Telegram
    // picks the menu by the CLIENT language: leaving a Russian slot here would show Russian
    // labels beside English answers, which is exactly what the live test reported.
    expect(cmds.length).toBe(4);
    expect(cmds.every((c) => c.chatId === '960')).toBe(true);
    expect(cmds.map((c) => c.lang).sort()).toEqual(['', 'en', 'ru', 'uz']);
    expect(JSON.stringify(cmds.find((c) => c.lang === 'en')?.commands)).toContain('stop');
    for (const c of cmds) {
      expect(JSON.stringify(c.commands)).not.toMatch(/[А-Яа-яЁё]/);
    }
    // unlink via the API route → deleteMyCommands + basic menu
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: (await t.db.select().from(users).where(eq(users.id, stu2!.id)).limit(1))[0]!.email, password: 'Secret1234' } });
    const tok = login.json().accessToken as string;
    const del = await app.inject({ method: 'DELETE', url: '/api/me/telegram-link', headers: { authorization: `Bearer ${tok}` } });
    expect(del.statusCode).toBe(200);
    // the webhook route's singleton api is a DIFFERENT CapturingApi than `api`;
    // assert at the DB level that the link is gone instead
    const [gone] = await t.db.select().from(telegramLinks).where(eq(telegramLinks.userId, stu2!.id)).limit(1);
    expect(gone).toBeUndefined();
    void isNull;
  });

  it('the bot speaks the profile language, and English when nobody chose one (task 1)', async () => {
    // a dedicated account: the shared student is deliberately Russian for the tests above
    const chat = 707;
    const [fresh] = await t.db.insert(users).values({
      role: 'student', name: 'Дефолт', lastName: 'Тил', email: `botdef${Date.now()}@x.io`,
      passwordHash: await hashPassword('Secret1234'), profileCompletedAt: new Date(),
    }).returning();
    await acceptPolicy(t.sql, fresh!.id, 'en');
    await t.db.insert(telegramLinks).values({ userId: fresh!.id, chatId: String(chat) });

    clear();
    await go(msg(chat, '/help'));
    expect(lastText(), 'an account that never chose gets the English default').toBe(T.helpStudent.en);

    clear();
    await t.db.update(users).set({ locale: 'uz', localeExplicit: true }).where(eq(users.id, fresh!.id));
    await go(msg(chat, '/help'));
    expect(lastText(), 'a chosen profile language is what the bot answers in').toBe(T.helpStudent.uz);

    // /language is a choice too: it must leave the account explicit, not just answer once
    clear();
    await go(cbq(chat, { u: fresh!.id, a: 'lang', l: 'ru' }));
    const [after] = await t.db.select({ locale: users.locale, explicit: users.localeExplicit })
      .from(users).where(eq(users.id, fresh!.id)).limit(1);
    expect(after).toMatchObject({ locale: 'ru', explicit: true });
  });

  it('command budget: >20 commands/min per user is politely refused', async () => {
    const sender = 970;
    clear();
    let limited = 0;
    for (let i = 0; i < 24; i++) {
      await go(msg(sender, '/help'));
      if ((api.calls[api.calls.length - 1]?.text ?? '').includes('Too many commands')) limited++;  // unbound sender → default language (task 1)
    }
    expect(limited).toBeGreaterThanOrEqual(1);
  });

  it('webhook endpoint: 403 without the secret, 200 + ledger with it', async () => {
    const prev = env.TELEGRAM_WEBHOOK_SECRET;
    env.TELEGRAM_WEBHOOK_SECRET = 'test-hook-secret';
    try {
      const upd = (id: number) => ({ update_id: id, message: { message_id: 1, chat: { id: 980, type: 'private' }, from: { id: 980 }, text: '/help' } });
      const bad = await app.inject({ method: 'POST', url: '/webhook/telegram', headers: { 'x-telegram-bot-api-secret-token': 'nope' }, payload: upd(++uid) });
      expect(bad.statusCode).toBe(403);
      const id = ++uid;
      const good = await app.inject({ method: 'POST', url: '/webhook/telegram', headers: { 'x-telegram-bot-api-secret-token': 'test-hook-secret' }, payload: upd(id) });
      expect(good.statusCode).toBe(200);
      // redelivery of the same update_id: still a fast 200, no second processing
      const dup = await app.inject({ method: 'POST', url: '/webhook/telegram', headers: { 'x-telegram-bot-api-secret-token': 'test-hook-secret' }, payload: upd(id) });
      expect(dup.statusCode).toBe(200);
    } finally { env.TELEGRAM_WEBHOOK_SECRET = prev; }
  });
});
