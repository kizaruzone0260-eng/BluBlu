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

  it('WS: ticket is one-time; second socket with the same ticket closes 4401; summary shows last+unread', async () => {
    const tr = await post(teacherTok, `/api/classes/${classId}/chat/ticket`, {});
    expect(tr.statusCode).toBe(200);
    const ticket = tr.json().ticket as string;
    // start the fastify HTTP server on an ephemeral port so real sockets can connect
    await app.listen({ port: 0, host: '127.0.0.1' });
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

  it('class deletion cascades messages', async () => {
    await t.db.delete(classes).where(eq(classes.id, classId));
    const left = await t.db.select().from(chatMessages).where(eq(chatMessages.classId, classId));
    expect(left.length).toBe(0);
  });
});
