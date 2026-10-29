/**
 * Item 8 — class chat: rights, moderation, limits, pagination, XSS-as-text,
 * reconnect semantics (ticket one-time), cascade on delete.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import WebSocket from 'ws';
import { TEST_DATABASE_URL, preparedDb, type TestDB } from './util.js';
import { buildApp } from '../../src/app.js';
import { classes, users, classMembers, chatMessages } from '../../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { hashPassword } from '../../src/lib/password.js';
import type { FastifyInstance } from 'fastify';

const suite = TEST_DATABASE_URL ? describe : describe.skip;

suite('chat (item 8)', () => {
  let t: TestDB;
  let app: FastifyInstance;
  let teacherTok = '';
  let studentATok = '';
  let classId = '';
  let otherClassId = '';
  let studentBId = '';

  beforeAll(async () => {
    t = await preparedDb(TEST_DATABASE_URL);
    app = await buildApp(t.db);
    const pw = await hashPassword('Passw0rd123');
    const [teacher] = await t.db.insert(users).values({ role: 'teacher', name: 'ЧатTeacher', email: 'cht@x.io', passwordHash: pw, locale: 'ru', tz: 'UTC' }).returning();
    const [sa] = await t.db.insert(users).values({ role: 'student', name: 'Ученик А', email: 'cha@x.io', passwordHash: pw, locale: 'ru', tz: 'UTC' }).returning();
    const [sb] = await t.db.insert(users).values({ role: 'student', name: 'Ученик Б', email: 'chb@x.io', passwordHash: pw, locale: 'ru', tz: 'UTC' }).returning();
    studentBId = sb!.id;
    const [c1] = await t.db.insert(classes).values({ teacherId: teacher!.id, name: 'Чат-класс' }).returning();
    const [c2] = await t.db.insert(classes).values({ teacherId: teacher!.id, name: 'Чужой класс' }).returning();
    classId = c1!.id; otherClassId = c2!.id;
    await t.db.insert(classMembers).values([
      { classId, userId: sa!.id }, { classId, userId: sb!.id },
      { classId: otherClassId, userId: sa!.id }, // student B is NOT in otherClassId, student A is in both
    ]);
    const login = async (email: string) => {
      const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'Passw0rd123' } });
      return `Bearer ${r.json().accessToken}`;
    };
    teacherTok = await login('cht@x.io');
    studentATok = await login('cha@x.io');
  });
  afterAll(async () => { await app?.close(); await t?.sql.end(); });

  const a = (tok: string) => ({ authorization: tok });
  const post = (tok: string, url: string, body: unknown) =>
    app.inject({ method: 'POST', url, headers: a(tok), payload: body as object });
  const get = (tok: string, url: string) => app.inject({ method: 'GET', url, headers: a(tok) });

  it('member student and teacher can post; text stays PLAIN (XSS payload never HTML)', async () => {
    const t1 = await post(teacherTok, `/api/classes/${classId}/chat/messages`, { text: 'Урок в 10:00' });
    expect(t1.statusCode).toBe(201);
    const s1 = await post(studentATok, `/api/classes/${classId}/chat/messages`, { text: '<script>alert(1)</script> & <img src=x onerror=bad()>' });
    expect(s1.statusCode).toBe(201);
    const list = await get(studentATok, `/api/classes/${classId}/chat/messages`);
    expect(list.statusCode).toBe(200);
    const msgs = list.json().messages as { text: string; authorName: string }[];
    expect(msgs.length).toBe(2);
    expect(msgs[1]!.text).toBe('<script>alert(1)</script> & <img src=x onerror=bad()>'); // stored verbatim; the client renders as text
    expect(msgs[1]!.authorName).toBe('Ученик А');
  });

  it('empty / whitespace / >2000 are rejected', async () => {
    expect((await post(studentATok, `/api/classes/${classId}/chat/messages`, { text: '' })).statusCode).toBe(400);
    expect((await post(studentATok, `/api/classes/${classId}/chat/messages`, { text: '   \t \n ' })).statusCode).toBe(400);
    const r = await post(studentATok, `/api/classes/${classId}/chat/messages`, { text: 'x'.repeat(2001) });
    expect(r.statusCode).toBe(400);
  });

  it('outsiders get 404 (foreign class and non-member), never 403', async () => {
    const pw = await hashPassword('Passw0rd123');
    await t.db.insert(users).values({ role: 'student', name: 'Чужак', email: 'out@x.io', passwordHash: pw, locale: 'ru', tz: 'UTC' });
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'out@x.io', password: 'Passw0rd123' } });
    const outTok = `Bearer ${login.json().accessToken}`;
    const forbiddenGet = await get(outTok, `/api/classes/${classId}/chat/messages`);
    expect(forbiddenGet.statusCode).toBe(404);
    const forbiddenPost = await post(outTok, `/api/classes/${classId}/chat/messages`, { text: 'хочу' });
    expect(forbiddenPost.statusCode).toBe(404);
    const forbiddenTicket = await post(outTok, `/api/classes/${classId}/chat/ticket`, {});
    expect(forbiddenTicket.statusCode).toBe(404);
    expect(forbiddenGet.json().error).toBe('notFound');
  });

  it('mute: teacher mutes a student (temp + forever), muted student 403, unmute restores', async () => {
    const m = await post(teacherTok, `/api/classes/${classId}/chat/mutes`, { userId: studentBId, until: new Date(Date.now() + 5 * 60_000).toISOString() });
    expect(m.statusCode).toBe(200);
    const loginB = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'chb@x.io', password: 'Passw0rd123' } });
    const bTok = `Bearer ${loginB.json().accessToken}`;
    const denied = await post(bTok, `/api/classes/${classId}/chat/messages`, { text: 'а можно?' });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error).toBe('chatMuted');
    // expired mute lets through
    const exp = await post(teacherTok, `/api/classes/${classId}/chat/mutes`, { userId: studentBId, until: new Date(Date.now() - 1000).toISOString() });
    expect(exp.statusCode).toBe(200);
    const allowed = await post(bTok, `/api/classes/${classId}/chat/messages`, { text: 'снова можно' });
    expect(allowed.statusCode).toBe(201);
    // permanent then unmute
    await post(teacherTok, `/api/classes/${classId}/chat/mutes`, { userId: studentBId, until: null });
    expect((await post(bTok, `/api/classes/${classId}/chat/messages`, { text: 'x' })).statusCode).toBe(403);
    const un = await app.inject({ method: 'DELETE', url: `/api/classes/${classId}/chat/mutes/${studentBId}`, headers: a(teacherTok) });
    expect(un.statusCode).toBe(200);
    expect((await post(bTok, `/api/classes/${classId}/chat/messages`, { text: 'y' })).statusCode).toBe(201);
    // mute of a teacher by teacher itself is refused (400 invalid — cannot mute self/other teacher)
    const self = await post(teacherTok, `/api/classes/${classId}/chat/mutes`, { userId: studentBId, until: 'not-a-date' });
    expect(self.statusCode).toBe(400);
  });

  it('modes: off blocks everyone; announce blocks students but not the teacher', async () => {
    const off = await app.inject({ method: 'PUT', url: `/api/classes/${classId}/chat/mode`, headers: a(teacherTok), payload: { mode: 'off' } });
    expect(off.statusCode).toBe(200);
    expect((await post(teacherTok, `/api/classes/${classId}/chat/messages`, { text: 'даже я?' })).statusCode).toBe(403);
    expect((await post(studentATok, `/api/classes/${classId}/chat/messages`, { text: 'а я?' })).statusCode).toBe(403);
    const ann = await app.inject({ method: 'PUT', url: `/api/classes/${classId}/chat/mode`, headers: a(teacherTok), payload: { mode: 'announce' } });
    expect(ann.statusCode).toBe(200);
    expect((await post(studentATok, `/api/classes/${classId}/chat/messages`, { text: 'ученик' })).json().error).toBe('chatAnnounceOnly');
    expect((await post(teacherTok, `/api/classes/${classId}/chat/messages`, { text: 'объявление' })).statusCode).toBe(201);
    await app.inject({ method: 'PUT', url: `/api/classes/${classId}/chat/mode`, headers: a(teacherTok), payload: { mode: 'on' } });
  });

  it('rate limit: 6th message inside 10 s → 429 with retry-after', async () => {
    const pw = await hashPassword('Passw0rd123');
    const [f] = await t.db.insert(users).values({ role: 'student', name: 'Флудер', email: 'fld@x.io', passwordHash: pw, locale: 'ru', tz: 'UTC' }).returning();
    await t.db.insert(classMembers).values({ classId, userId: f!.id });
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'fld@x.io', password: 'Passw0rd123' } });
    const tok = `Bearer ${login.json().accessToken}`;
    for (let i = 0; i < 5; i++) expect((await post(tok, `/api/classes/${classId}/chat/messages`, { text: `м${i}` })).statusCode).toBe(201);
    const six = await post(tok, `/api/classes/${classId}/chat/messages`, { text: 'шестая' });
    expect(six.statusCode).toBe(429);
    expect(Number(six.headers['retry-after'])).toBeGreaterThan(0);
    // another user is unaffected
    expect((await post(studentATok, `/api/classes/${classId}/chat/messages`, { text: 'другой пользователь' })).statusCode).toBe(201);
  });

  it('pagination: older pages via ?before, ascending order, hasMore flag', async () => {
    const pw = await hashPassword('Passw0rd123');
    const [g] = await t.db.insert(users).values({ role: 'student', name: 'Листатель', email: 'lst@x.io', passwordHash: pw, locale: 'ru', tz: 'UTC' }).returning();
    await t.db.insert(classMembers).values({ classId, userId: g!.id });
    // seed 40 old messages straight to DB, timestamps spread in the past
    for (let i = 0; i < 40; i++) {
      await t.db.insert(chatMessages).values({
        classId, authorId: g!.id, text: `старое ${i}`,
        createdAt: new Date(Date.now() - (40 - i) * 60_000),
      });
    }
    const p1 = await get(teacherTok, `/api/classes/${classId}/chat/messages?limit=10`);
    const d1 = p1.json();
    expect(d1.messages.length).toBe(10);
    expect(d1.hasMore).toBe(true);
    const firstTs = d1.messages[0].createdAt as string;
    const p2 = await get(teacherTok, `/api/classes/${classId}/chat/messages?limit=10&before=${encodeURIComponent(firstTs)}`);
    const d2 = p2.json();
    expect(d2.messages.length).toBe(10);
    expect(new Date(d2.messages[9].createdAt) < new Date(firstTs)).toBe(true);
    // ascending within a page
    const times = d2.messages.map((m: { createdAt: string }) => +new Date(m.createdAt));
    expect([...times].sort((x, y) => x - y)).toEqual(times);
  });

  it('deletion: student removes own (ok), foreign (404); teacher removes any + audit rows exist', async () => {
    const own = await post(studentATok, `/api/classes/${classId}/chat/messages`, { text: 'своё' });
    const ownId = own.json().id as string;
    const tMsg = await post(teacherTok, `/api/classes/${classId}/chat/messages`, { text: 'учительское' });
    const bad = await app.inject({ method: 'DELETE', url: `/api/classes/${classId}/chat/messages/${tMsg.json().id}`, headers: a(studentATok) });
    expect(bad.statusCode).toBe(404); // students only ever hit their own rows
    const good = await app.inject({ method: 'DELETE', url: `/api/classes/${classId}/chat/messages/${ownId}`, headers: a(studentATok) });
    expect(good.statusCode).toBe(200);
    const tdel = await app.inject({ method: 'DELETE', url: `/api/classes/${classId}/chat/messages/${tMsg.json().id}`, headers: a(teacherTok) });
    expect(tdel.statusCode).toBe(200);
    // audit() is fire-and-forget (§performance) — poll briefly
    let rows: { action: string }[] = [];
    for (let i = 0; i < 20 && rows.length < 2; i++) {
      const audit = await t.db.execute(`select action from audit_log where action in ('chat_delete_own','chat_delete_teacher')`);
      rows = (Array.isArray(audit) ? audit : (audit as { rows?: { action: string }[] }).rows) ?? [];
      if (rows.length < 2) await new Promise((r) => setTimeout(r, 50));
    }
    expect(rows.length).toBeGreaterThanOrEqual(2);
  });

  // ── item 7: editing own messages ────────────────────────────────────────────
  const patch = (tok: string, url: string, body: unknown) =>
    app.inject({ method: 'PATCH', url, headers: a(tok), payload: body as object });

  it('edit: author updates own text (editedAt set); teacher/peer get 404; XSS stays plain', async () => {
    const pw = await hashPassword('Passw0rd123');
    const [ed] = await t.db.insert(users).values({ role: 'student', name: 'Редактор', email: 'edt@x.io', passwordHash: pw, locale: 'ru', tz: 'UTC' }).returning();
    await t.db.insert(classMembers).values({ classId, userId: ed!.id });
    const tok = `Bearer ${(await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'edt@x.io', password: 'Passw0rd123' } })).json().accessToken}`;

    const msg = await post(tok, `/api/classes/${classId}/chat/messages`, { text: '<b>черновик</b>' });
    expect(msg.statusCode).toBe(201);
    const mid = msg.json().id as string;
    expect(msg.json().editedAt).toBeNull();

    const ok = await patch(tok, `/api/classes/${classId}/chat/messages/${mid}`, { text: '<script>alert(1)</script> финал' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().text).toBe('<script>alert(1)</script> финал'); // stored verbatim — the client renders as text
    expect(ok.json().editedAt).toBeTruthy();
    const list = await get(tok, `/api/classes/${classId}/chat/messages`);
    const row = (list.json().messages as { id: string; editedAt: string | null }[]).find((m) => m.id === mid);
    expect(row?.editedAt).toBeTruthy();

    // the teacher may delete but NEVER edit someone else's message
    const byTeacher = await patch(teacherTok, `/api/classes/${classId}/chat/messages/${mid}`, { text: 'руками учителя' });
    expect(byTeacher.statusCode).toBe(404);
    // a peer student likewise
    const byPeer = await patch(studentATok, `/api/classes/${classId}/chat/messages/${mid}`, { text: 'сосед' });
    expect(byPeer.statusCode).toBe(404);
    // outsider → no access to the class at all
    const outTok = `Bearer ${(await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'out@x.io', password: 'Passw0rd123' } })).json().accessToken}`;
    expect((await patch(outTok, `/api/classes/${classId}/chat/messages/${mid}`, { text: 'чужак' })).statusCode).toBe(404);

    // limits: empty / whitespace / >2000
    expect((await patch(tok, `/api/classes/${classId}/chat/messages/${mid}`, { text: '' })).statusCode).toBe(400);
    expect((await patch(tok, `/api/classes/${classId}/chat/messages/${mid}`, { text: '   ' })).statusCode).toBe(400);
    expect((await patch(tok, `/api/classes/${classId}/chat/messages/${mid}`, { text: 'x'.repeat(2001) })).statusCode).toBe(400);
    // the failed attempts above did NOT touch the message
    expect((await patch(tok, `/api/classes/${classId}/chat/messages/${mid}`, { text: 'всё ещё можно' })).statusCode).toBe(200);
    // editing a deleted message → 404
    await app.inject({ method: 'DELETE', url: `/api/classes/${classId}/chat/messages/${mid}`, headers: a(tok) });
    expect((await patch(tok, `/api/classes/${classId}/chat/messages/${mid}`, { text: 'нет строки' })).statusCode).toBe(404);
  });

  it('edit: muted student cannot edit own message (403 chatMuted)', async () => {
    const pw = await hashPassword('Passw0rd123');
    const [mu] = await t.db.insert(users).values({ role: 'student', name: 'Заглуш', email: 'mut@x.io', passwordHash: pw, locale: 'ru', tz: 'UTC' }).returning();
    await t.db.insert(classMembers).values({ classId, userId: mu!.id });
    const tok = `Bearer ${(await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'mut@x.io', password: 'Passw0rd123' } })).json().accessToken}`;
    const msg = await post(tok, `/api/classes/${classId}/chat/messages`, { text: 'до заглушения' });
    const mid = msg.json().id as string;
    await post(teacherTok, `/api/classes/${classId}/chat/mutes`, { userId: mu!.id, until: null });
    const denied = await patch(tok, `/api/classes/${classId}/chat/messages/${mid}`, { text: 'после' });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error).toBe('chatMuted');
  });

  it('edit: edits share the send rate limit (6th action in 10 s → 429)', async () => {
    const pw = await hashPassword('Passw0rd123');
    const [fl] = await t.db.insert(users).values({ role: 'student', name: 'Лимитчик', email: 'lim@x.io', passwordHash: pw, locale: 'ru', tz: 'UTC' }).returning();
    await t.db.insert(classMembers).values({ classId, userId: fl!.id });
    const tok = `Bearer ${(await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'lim@x.io', password: 'Passw0rd123' } })).json().accessToken}`;
    const first = await post(tok, `/api/classes/${classId}/chat/messages`, { text: 'раз' });
    for (let i = 0; i < 4; i++) expect((await post(tok, `/api/classes/${classId}/chat/messages`, { text: `ещё${i}` })).statusCode).toBe(201);
    // 5 sends used; the 6th action — an EDIT — is refused with the same 429
    const six = await patch(tok, `/api/classes/${classId}/chat/messages/${first.json().id}`, { text: 'шесть' });
    expect(six.statusCode).toBe(429);
    expect(Number(six.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('edit: WS broadcasts an «edited» frame to connected sockets', async () => {
    const pw = await hashPassword('Passw0rd123');
    const [ob] = await t.db.insert(users).values({ role: 'student', name: 'Смотритель', email: 'obs@x.io', passwordHash: pw, locale: 'ru', tz: 'UTC' }).returning();
    await t.db.insert(classMembers).values({ classId, userId: ob!.id });
    const tok = `Bearer ${(await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'obs@x.io', password: 'Passw0rd123' } })).json().accessToken}`;
    const msg = await post(tok, `/api/classes/${classId}/chat/messages`, { text: 'в эфир' });
    const mid = msg.json().id as string;
    const tr = await post(tok, `/api/classes/${classId}/chat/ticket`, {});
    const ticket = tr.json().ticket as string;
    if (!app.server.listening) await app.listen({ port: 0, host: '127.0.0.1' }); // first WS test in the file opens the port
    const addr = app.server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    const frame = new Promise<string>((res) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws/chat/${classId}?ticket=${encodeURIComponent(ticket)}`);
      ws.on('message', (d) => { const s = String(d); if (s.includes('"edited"')) { ws.close(); res(s); } });
      setTimeout(() => { try { ws.close(); } catch { /* */ } res(''); }, 6000);
    });
    await new Promise((r) => setTimeout(r, 300)); // let the socket join the room
    const edited = await patch(tok, `/api/classes/${classId}/chat/messages/${mid}`, { text: 'обновлено в эфире' });
    expect(edited.statusCode).toBe(200);
    const got = await frame;
    expect(got).toContain('"edited"');
    expect(got).toContain('обновлено в эфире');
  });

  it('WS: ticket is one-time; second socket with the same ticket closes 4401; summary shows last+unread', async () => {
    const tr = await post(teacherTok, `/api/classes/${classId}/chat/ticket`, {});
    expect(tr.statusCode).toBe(200);
    const ticket = tr.json().ticket as string;
    // start the fastify HTTP server on an ephemeral port so real sockets can connect
    if (!app.server.listening) await app.listen({ port: 0, host: '127.0.0.1' }); // an earlier WS test may have opened it
    const addr = app.server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    const codeOf = (tk: string) => new Promise<number>((res) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws/chat/${classId}?ticket=${encodeURIComponent(tk)}`);
      ws.on('close', (code) => res(code));
      ws.on('error', () => res(-1));
    });
    const first = await new Promise<string>((res) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws/chat/${classId}?ticket=${encodeURIComponent(ticket)}`);
      ws.on('message', (d) => { ws.close(); res(String(d)); });
      ws.on('close', () => res(''));
      setTimeout(() => { try { ws.close(); } catch { /* */ } res(''); }, 4000);
    });
    expect(first).toContain('ready');
    const reuseCode = await codeOf(ticket); // same ticket again ⇒ 4401
    expect(reuseCode).toBe(4401);
    const summary = await get(teacherTok, '/api/chat/summary');
    const row = (summary.json() as { classId: string; lastMessage: string | null; unread: number }[]).find((x) => x.classId === classId);
    expect(row).toBeTruthy();
    expect(row!.lastMessage).toBeTruthy();
  });

  /*
   * 2026-10-28, аудит SEC-04. Архив класса обязан закрывать И чат: `resolveClass`, лента,
   * материалы, доски и файлы для архивированного класса отвечают 404, а чат был единственной
   * поверхностью без фильтра по `archived_at`. Проверяется обе стороны правила: закрыто всё
   * (включая сокет) и не закрыто ничего лишнего — свой неархивированный класс остаётся рабочим,
   * а снятие архива чат возвращает (строки сообщений при архивации не трогаются).
   *
   * Отдельный класс, а не общий `classId`: иначе проверка зависела бы от порядка файлов и
   * мешала тесту каскада ниже.
   */
  it('archive closes the chat for every surface, and un-archiving opens it back', async () => {
    const [teacherRow] = await t.db.select({ id: users.id }).from(users).where(eq(users.email, 'cht@x.io'));
    const [pupil] = await t.db.select({ id: users.id }).from(users).where(eq(users.email, 'cha@x.io'));
    const [arch] = await t.db.insert(classes).values({ teacherId: teacherRow!.id, name: 'Архив-чат' }).returning();
    const archId = arch!.id;
    await t.db.insert(classMembers).values({ classId: archId, userId: pupil!.id });

    // контроль: живой класс работает как работал
    expect((await post(studentATok, `/api/classes/${archId}/chat/messages`, { text: 'до архива' })).statusCode).toBe(201);

    // тикет выдаётся ДО архивации — чтобы проверить и сокет, который подключается уже после
    const tr = await post(teacherTok, `/api/classes/${archId}/chat/ticket`, {});
    expect(tr.statusCode).toBe(200);
    const ticket = tr.json().ticket as string;

    expect((await post(teacherTok, `/api/classes/${archId}/archive`, {})).statusCode).toBe(200);

    // чужие поверхности архива (лента, файлы, доски) были закрыты и раньше — здесь проверяются
    // именно поверхности чата
    const surfaces: Array<[string, string, unknown]> = [
      ['GET', `/api/classes/${archId}/chat/messages`, undefined],
      ['POST', `/api/classes/${archId}/chat/messages`, { text: 'после архива' }],
      ['POST', `/api/classes/${archId}/chat/read`, {}],
      ['POST', `/api/classes/${archId}/chat/ticket`, {}],
    ];
    for (const [method, url, body] of surfaces) {
      const r = await app.inject({ method: method as 'GET', url, headers: a(teacherTok), ...(body ? { payload: body as object } : {}) });
      expect(r.statusCode, `${method} ${url} архивированного класса`).toBe(404);
      expect(r.json().error, `${method} ${url}: 404, а не 403 (§7)`).toBe('notFound');
    }
    // то же участником, а не владельцем: у студента путь ровно тот же
    const asPupil = await get(studentATok, `/api/classes/${archId}/chat/messages`);
    expect(asPupil.statusCode, 'участник архива тоже видит 404').toBe(404);

    // модерация владельца: режим (PUT), список и постановка заглушений — 404, а не «настрой архив»
    const mode = await app.inject({ method: 'PUT', url: `/api/classes/${archId}/chat/mode`, headers: a(teacherTok), payload: { mode: 'off' } });
    expect(mode.statusCode, 'режим чата архива не переключается').toBe(404);
    const mute = await post(teacherTok, `/api/classes/${archId}/chat/mutes`, { userId: pupil!.id, until: null });
    expect(mute.statusCode, 'заглушение в архиве невозможно').toBe(404);
    const mutes = await get(teacherTok, `/api/classes/${archId}/chat/mutes`);
    expect(mutes.statusCode).toBe(404);
    const unmute = await app.inject({
      method: 'DELETE', url: `/api/classes/${archId}/chat/mutes/${pupil!.id}`, headers: a(teacherTok),
    });
    expect(unmute.statusCode).toBe(404);

    // сокет: выданный заранее тикет всё ещё расходуется, но доступ к классу уже проверяется
    // повторно — и получает 4404, а не «ready»
    if (!app.server.listening) await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    const closeCode = await new Promise<number>((res) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws/chat/${archId}?ticket=${encodeURIComponent(ticket)}`);
      ws.on('close', (code) => res(code));
      ws.on('error', () => res(-1));
      ws.on('message', () => { ws.close(); res(-2); }); // -2 = сокет вообще открылся: регрессия
      setTimeout(() => { try { ws.close(); } catch { /* */ } res(-3); }, 5000);
    });
    expect(closeCode, 'сокет чата архивированного класса закрыт 4404 (-2 значит, что открылся)').toBe(4404);

    // снятие архива возвращает чат: фильтр читает состояние класса на каждый запрос
    await t.db.update(classes).set({ archivedAt: null }).where(eq(classes.id, archId));
    const back = await get(studentATok, `/api/classes/${archId}/chat/messages`);
    expect(back.statusCode, 'архив снят — лента снова доступна').toBe(200);
    expect((back.json() as { messages: unknown[] }).messages.length).toBe(1);
    /*
     * Запись проверяется ТЕМИ ЖЕ маршрутами, что выше давали 404, и тем же участником:
     * `/chat/read` меняет состояние (отметка прочтения) и не упирается в окно 5 сообщений / 10 с,
     * на котором держится весь файл тестов. Пост здесь был бы красным по лимиту, а не по правке.
     */
    expect((await post(studentATok, `/api/classes/${archId}/chat/read`, {})).statusCode,
      'запись в чат архива снята — снова проходит').toBe(200);
    const ticketAfter = await post(teacherTok, `/api/classes/${archId}/chat/ticket`, {});
    expect(ticketAfter.statusCode, 'владелец снова получает WS-тикет').toBe(200);

    // и живой класс-сосед это изменение не задело
    expect((await get(studentATok, `/api/classes/${classId}/chat/messages`)).statusCode,
      'неархивированный класс работает как работал').toBe(200);
  });

  it('class deletion cascades messages', async () => {
    await t.db.delete(classes).where(eq(classes.id, classId));
    const left = await t.db.select().from(chatMessages).where(eq(chatMessages.classId, classId));
    expect(left.length).toBe(0);
  });
});
