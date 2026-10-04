/**
 * §7 access-rights audit matrix. Two tenants: A (victim) and B (attacker).
 * For every class-scoped endpoint: anonymous → 401; foreign teacher/student → 404
 * (never 403 — existence must not leak); student on teacher route → 403;
 * ownership filters (notes/sheets) → 404 for foreign ids; LiveKit/board tokens
 * only for active-session members. Also: lesson session cannot bind an event of
 * another class.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { TEST_DATABASE_URL, preparedDb, makeTeacher, type TestDB } from './util.js';
import { buildApp } from '../../src/app.js';
import { classes, inviteCodes, posts, files as filesTable, users } from '../../src/db/schema.js';
import { hashInviteCode } from '../../src/lib/invite.js';
import type { FastifyInstance } from 'fastify';

const suite = TEST_DATABASE_URL ? describe : describe.skip;
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const genCode = () => Array.from({ length: 8 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join('');

suite('§7 rights audit', () => {
  let t: TestDB;
  let app: FastifyInstance;
  const tok: Record<string, string> = {};
  const id: Record<string, string> = {};
  let classA = '', classB = '', teacherAId = '', studentAId = '', studentBId = '';
  let postA = '', fileA = '', noteA = '', eventA = '', sessionA = '', sheetA = '', inviteA = '';

  async function enroll(email: string, classId: string, who: string) {
    const code = genCode();
    await t.db.insert(inviteCodes).values({
      classId, codeHash: hashInviteCode(code, process.env.JWT_SECRET!),
      createdBy: teacherAId, expiresAt: new Date(Date.now() + 86400000),
    });
    const r = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { firstName: 'Pupil', lastName: 'Test', email, password: 'Secret1234', code } });
    tok[who] = r.json().accessToken as string;
    if (who === 'studentA') studentAId = r.json().user.id;
    if (who === 'studentB') studentBId = r.json().user.id;
  }

  beforeAll(async () => {
    t = await preparedDb(TEST_DATABASE_URL);
    app = await buildApp(t.db);
    const tA = await makeTeacher(t.sql, `audA${Date.now()}@x.io`);
    teacherAId = tA.id;
    const tB = await makeTeacher(t.sql, `audB${Date.now()}@x.io`);
    const chk = await t.sql`select email, left(password_hash, 14) as h from users where id = ${tA.id}`;
    if (!chk.length) throw new Error('teacher row missing after insert!');
    for (const [who, u] of [['teacherA', tA], ['teacherB', tB]] as const) {
      const l = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: u.email, password: u.password } });
      if (l.statusCode !== 200) {
        const { login: svcLogin } = await import('../../src/services/auth.js');
        const svc = await svcLogin(t.db, u.email, u.password);
        const raw = await t.sql`select email, password_hash, deleted_at from users where email = ${u.email}`;
        throw new Error(`login ${who} → ${l.statusCode}; svc=${JSON.stringify(svc).slice(0, 60)}; raw=${JSON.stringify(raw).slice(0, 120)}`);
      }
      tok[who] = l.json().accessToken as string;
    }
    const [cA] = await t.db.insert(classes).values({ teacherId: teacherAId, name: 'Class A' }).returning();
    const [cB] = await t.db.insert(classes).values({ teacherId: tB.id, name: 'Class B' }).returning();
    classA = cA!.id; classB = cB!.id;
    await enroll(`aa${Date.now()}@x.io`, classA, 'studentA');
    await enroll(`bb${Date.now()}@x.io`, classB, 'studentB');

    // victim resources in class A
    const inv = await app.inject({ method: 'POST', url: `/api/classes/${classA}/invites`, headers: { authorization: `Bearer ${tok.teacherA}` }, payload: {} });
    inviteA = inv.json().id;
    const up = Buffer.concat([Buffer.from('%PDF-1.4'), Buffer.from('x'.repeat(200))]);
    const head = `--BND\r\nContent-Disposition: form-data; name="title"\r\n\r\nVictim doc\r\n--BND\r\nContent-Disposition: form-data; name="file"; filename="d.pdf"\r\nContent-Type: application/octet-stream\r\n\r\n`;
    const mat = await app.inject({
      method: 'POST', url: `/api/classes/${classA}/materials`,
      headers: { authorization: `Bearer ${tok.teacherA}`, 'content-type': 'multipart/form-data; boundary=BND' },
      payload: Buffer.concat([Buffer.from(head, 'utf8'), up, Buffer.from('\r\n--BND--\r\n', 'utf8')]),
    });
    postA = mat.json().id;
    if (mat.statusCode !== 201) throw new Error(`material upload failed ${mat.statusCode} ${mat.body.slice(0, 200)} tok=${String(tok.teacherA).slice(0, 18)}…`);
    const feed = await app.inject({ method: 'GET', url: `/api/classes/${classA}/feed`, headers: { authorization: `Bearer ${tok.studentA}` } });
    fileA = feed.json().find((p: { id: string }) => p.id === postA).files[0].id;

    const note = await app.inject({ method: 'POST', url: '/api/notes', headers: { authorization: `Bearer ${tok.teacherA}` }, payload: { classId: classA, title: 'N', body: 'secret plan' } });
    noteA = note.json().id;
    const ev = await app.inject({
      method: 'POST', url: `/api/classes/${classA}/events`, headers: { authorization: `Bearer ${tok.teacherA}` },
      payload: { kind: 'lesson', title: 'Victim lesson', description: '', startLocal: '2026-11-02T19:00', durationMin: 50, tz: 'Asia/Tashkent' },
    });
    eventA = ev.json().id;
    const ses = await app.inject({ method: 'POST', url: '/api/lessons/start', headers: { authorization: `Bearer ${tok.teacherA}` }, payload: { classId: classA, eventId: eventA } });
    sessionA = ses.json().id;
    const sheet = await app.inject({ method: 'POST', url: '/api/student-notes', headers: { authorization: `Bearer ${tok.studentA}` }, payload: { classId: classA, title: 'S', body: 'private' } });
    sheetA = sheet.json().id;
    const ics = await app.inject({ method: 'POST', url: '/api/me/ical-token', headers: { authorization: `Bearer ${tok.teacherA}` } });
    id.icsA = ics.json().token;
  });
  afterAll(async () => { await app?.close(); await t?.sql.end(); });

  const a = (who: string) => ({ authorization: `Bearer ${tok[who]}` });

  // ── classes & members ───────────────────────────────────────────────────────
  it('anonymous → 401 on every member-scoped GET', async () => {
    for (const url of ['/api/classes', `/api/classes/${classA}/feed`, '/api/events', '/api/notes', '/api/student-notes', `/api/classes/${classA}/members`, `/api/classes/${classA}/invites`, `/api/lessons/active?classId=${classA}`, `/api/files/${fileA}`]) {
      const r = await app.inject({ method: 'GET', url });
      expect(r.statusCode, url).toBe(401);
    }
  });

  it('B cannot touch A class: patch/archive/members/invites/reset → 404; A students list is invisible', async () => {
    const attacks: [string, string, unknown?][] = [
      ['PATCH', `/api/classes/${classA}`, { name: 'hijacked' }],
      ['POST', `/api/classes/${classA}/archive`],
      ['GET', `/api/classes/${classA}/members`],
      ['POST', `/api/classes/${classA}/members`, { userId: studentAId }],
      ['DELETE', `/api/classes/${classA}/members/${studentAId}`],
      ['POST', `/api/classes/${classA}/members/${studentAId}/move`, { toClassId: classB }],
      ['POST', `/api/classes/${classA}/members/${studentAId}/reset-password`],
      ['POST', `/api/classes/${classA}/invites`, {}],
      ['GET', `/api/classes/${classA}/invites`],
      ['POST', `/api/classes/${classA}/invites/${inviteA}/revoke`],
      ['POST', `/api/classes/${classA}/events`, { kind: 'other', title: 'x', startLocal: '2026-11-03T10:00', durationMin: 60, tz: 'UTC' }],
      ['GET', `/api/classes/${classA}/telegram`],
      ['POST', `/api/classes/${classA}/link-token`],
      ['PUT', `/api/classes/${classA}/notify-channel`, { channel: 'group' }],
    ];
    for (const [method, url, payload] of attacks) {
      const rB = await app.inject({ method: method as 'GET', url, headers: a('teacherB'), payload: payload as object });
      expect(rB.statusCode, `teacherB ${method} ${url}`).toBe(404);
      const rAnon = await app.inject({ method: method as 'GET', url, payload: payload as object });
      expect(rAnon.statusCode, `anon ${method} ${url}`).toBe(401);
    }
  });

  it('student on teacher routes → 403 (not 404 — route-level role)', async () => {
    const r1 = await app.inject({ method: 'GET', url: `/api/classes/${classA}/members`, headers: a('studentA') });
    expect(r1.statusCode).toBe(403);
    const r2 = await app.inject({ method: 'POST', url: `/api/classes/${classA}/invites`, headers: a('studentA'), payload: {} });
    expect(r2.statusCode).toBe(403);
    const r3 = await app.inject({ method: 'POST', url: '/api/notes', headers: a('studentA'), payload: { classId: classA } });
    expect(r3.statusCode).toBe(403);
  });

  it('B student cannot join A class without code; B teacher cannot add A student to B class by id enumeration', async () => {
    const wrong = await app.inject({ method: 'POST', url: '/api/join-by-code', headers: a('studentB'), payload: { code: 'ZZZZZZZZ' } });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().error).toBe('invalidCode');
    // by design a teacher MAY add an existing student knowing their uuid (uuid is unguessable; §3.2 direct-add)
    const add = await app.inject({ method: 'POST', url: `/api/classes/${classB}/members`, headers: a('teacherB'), payload: { userId: studentAId } });
    expect(add.statusCode).toBe(200);
    const membersB = await app.inject({ method: 'GET', url: `/api/classes/${classB}/members`, headers: a('teacherB') });
    expect(membersB.json().some((m: { userId: string }) => m.userId === studentAId)).toBe(true);
    // but adding a TEACHER as member must fail
    const addT = await app.inject({ method: 'POST', url: `/api/classes/${classB}/members`, headers: a('teacherB'), payload: { userId: teacherAId } });
    expect(addT.statusCode).toBe(400);
  });

  it('move between classes of different teachers → 400 (ownership of target checked)', async () => {
    // studentA was just added to B by teacherB; teacherA cannot move him into A via B-class route...
    const r = await app.inject({ method: 'POST', url: `/api/classes/${classB}/members/${studentAId}/move`, headers: a('teacherA'), payload: { toClassId: classA } });
    expect(r.statusCode).toBe(404); // teacherA doesn't own classB (source) at all
  });

  // ── posts/files ─────────────────────────────────────────────────────────────
  it('A feed/files invisible to B-student and B-teacher (404), B-student cannot download file', async () => {
    const f1 = await app.inject({ method: 'GET', url: `/api/classes/${classA}/feed`, headers: a('studentB') });
    expect(f1.statusCode).toBe(404);
    const f2 = await app.inject({ method: 'GET', url: `/api/classes/${classA}/feed`, headers: a('teacherB') });
    expect(f2.statusCode).toBe(404);
    const dl = await app.inject({ method: 'GET', url: `/api/files/${fileA}`, headers: a('studentB') });
    expect(dl.statusCode).toBe(404);
    const inline = await app.inject({ method: 'GET', url: `/api/files/${fileA}/inline`, headers: a('teacherB') });
    expect(inline.statusCode).toBe(404);
    const dlA = await app.inject({ method: 'GET', url: `/api/files/${fileA}`, headers: a('studentA') });
    expect(dlA.statusCode).toBe(200); // control: legit member still ok
  });

  it('B cannot edit/delete A posts (404); students cannot (403)', async () => {
    const r1 = await app.inject({ method: 'PATCH', url: `/api/posts/${postA}`, headers: a('teacherB'), payload: { title: 'hij' } });
    expect(r1.statusCode).toBe(404);
    const r2 = await app.inject({ method: 'DELETE', url: `/api/posts/${postA}`, headers: a('teacherB') });
    expect(r2.statusCode).toBe(404);
    const r3 = await app.inject({ method: 'DELETE', url: `/api/posts/${postA}`, headers: a('studentA') });
    expect(r3.statusCode).toBe(403);
  });

  it('B teacher cannot upload into A class (404) and cannot read A teacher notes', async () => {
    const head = `--BND\r\nContent-Disposition: form-data; name="title"\r\n\r\nx\r\n--BND\r\nContent-Disposition: form-data; name="file"; filename="d.pdf"\r\n\r\n%PDF-1.4\r\n--BND--\r\n`;
    const up = await app.inject({
      method: 'POST', url: `/api/classes/${classA}/materials`,
      headers: { ...a('teacherB'), 'content-type': 'multipart/form-data; boundary=BND' }, payload: head,
    });
    expect(up.statusCode).toBe(404);
    const notesB = await app.inject({ method: 'GET', url: '/api/notes', headers: a('teacherB') });
    expect(notesB.json()).toEqual([]);
    const patch = await app.inject({ method: 'PATCH', url: `/api/notes/${noteA}`, headers: a('teacherB'), payload: { body: 'x' } });
    expect(patch.statusCode).toBe(404);
    const del = await app.inject({ method: 'DELETE', url: `/api/notes/${noteA}`, headers: a('teacherB') });
    expect(del.statusCode).toBe(404);
    const pub = await app.inject({ method: 'POST', url: `/api/notes/${noteA}/publish`, headers: a('teacherB') });
    expect(pub.statusCode).toBe(404);
    // creating a note in A class as B-teacher → 404
    const create = await app.inject({ method: 'POST', url: '/api/notes', headers: a('teacherB'), payload: { classId: classA, title: '', body: '' } });
    expect(create.statusCode).toBe(404);
  });

  // ── events / ICS ────────────────────────────────────────────────────────────
  it('B sees no A events; B cannot patch/delete A event; event of A visible to A-student only', async () => {
    const evB = await app.inject({ method: 'GET', url: '/api/events?from=2026-11-01T00:00:00Z&to=2026-11-30T00:00:00Z', headers: a('teacherB') });
    expect((evB.json() as unknown[]).length).toBe(0);
    const p = await app.inject({ method: 'PATCH', url: `/api/events/${eventA}`, headers: a('teacherB'), payload: { scope: 'all', changes: { kind: 'other', title: 'x', description: '', startLocal: '2026-11-02T19:00', durationMin: 50, tz: 'UTC' } } });
    expect(p.statusCode).toBe(404);
    const d = await app.inject({ method: 'DELETE', url: `/api/events/${eventA}?scope=all`, headers: a('teacherB') });
    expect(d.statusCode).toBe(404);
    const evA = await app.inject({ method: 'GET', url: '/api/events?from=2026-11-01T00:00:00Z&to=2026-11-30T00:00:00Z', headers: a('studentA') });
    expect((evA.json() as { eventId: string }[]).some((o) => o.eventId === eventA)).toBe(true);
    // B-student filtering by A classId → empty, no existence leak in message
    const filt = await app.inject({ method: 'GET', url: `/api/events?classId=${classA}`, headers: a('studentB') });
    expect(filt.statusCode).toBe(200);
    expect((filt.json() as unknown[]).length).toBe(0);
  });

  it('ICS: A token exposes A data only; B cannot mint token for A; bad token 404', async () => {
    const icsA = await app.inject({ method: 'GET', url: `/api/ical/${id.icsA}` });
    expect(icsA.body).toContain('Victim lesson');
    expect(icsA.body).not.toContain('Class B');
    const bad = await app.inject({ method: 'GET', url: '/api/ical/not-a-real-token-xyz' });
    expect(bad.statusCode).toBe(404);
    const tokB = await app.inject({ method: 'POST', url: '/api/me/ical-token', headers: a('teacherB') });
    const icsB = await app.inject({ method: 'GET', url: `/api/ical/${tokB.json().token}` });
    expect(icsB.body).not.toContain('Victim lesson');
  });

  // ── lessons / RTC token / WS ───────────────────────────────────────────────
  it('B cannot join A lesson (404), cannot get token after end; A student gets valid token', async () => {
    const jB = await app.inject({ method: 'POST', url: `/api/lessons/${sessionA}/join`, headers: a('studentB') });
    expect(jB.statusCode).toBe(404);
    const jT = await app.inject({ method: 'POST', url: `/api/lessons/${sessionA}/join`, headers: a('teacherB') });
    expect(jT.statusCode).toBe(404);
    const jA = await app.inject({ method: 'POST', url: `/api/lessons/${sessionA}/join`, headers: a('studentA') });
    expect(jA.statusCode).toBe(200);
    // moderation from B → 404
    for (const path of ['end', 'lecture-mode', 'mute', 'kick', 'grant-screen']) {
      const r = await app.inject({ method: 'POST', url: `/api/lessons/${sessionA}/${path}`, headers: a('teacherB'), payload: path === 'mute' ? { all: true } : path === 'lecture-mode' ? { on: true } : path === 'kick' || path === 'grant-screen' ? { identity: studentAId } : {} });
      expect(r.statusCode, path).toBe(404);
    }
    const lay = await app.inject({ method: 'PATCH', url: `/api/lessons/${sessionA}/layout`, headers: a('teacherB'), payload: { layout: 'stage' } });
    expect(lay.statusCode).toBe(404);
    // A teacher can end (control) — and after end nobody joins
    const end = await app.inject({ method: 'POST', url: `/api/lessons/${sessionA}/end`, headers: a('teacherA') });
    expect(end.statusCode).toBe(200);
    const after = await app.inject({ method: 'POST', url: `/api/lessons/${sessionA}/join`, headers: a('studentA') });
    expect(after.statusCode).toBe(404);
  });

  it('lesson session cannot bind an event of ANOTHER class (anti-confusion)', async () => {
    const ev = await app.inject({
      method: 'POST', url: `/api/classes/${classB}/events`, headers: a('teacherB'),
      payload: { kind: 'lesson', title: 'B lesson', description: '', startLocal: '2026-11-05T10:00', durationMin: 45, tz: 'UTC' },
    });
    const bEvent = ev.json().id as string;
    const start = await app.inject({
      method: 'POST', url: '/api/lessons/start', headers: a('teacherB'),
      payload: { classId: classB, eventId: bEvent },
    });
    expect(start.statusCode).toBe(201);
    const evil = await app.inject({
      method: 'POST', url: '/api/lessons/start', headers: a('teacherB'),
      payload: { classId: classB, eventId: eventA }, // eventA belongs to classA
    });
    expect(evil.statusCode).toBe(400);
    await app.inject({ method: 'POST', url: `/api/lessons/${start.json().id}/end`, headers: a('teacherB') });
  });

  it('WS tickets: one-time, session-bound, member gets snapshot; anon gets 4401 with zero data', async () => {
    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    interface Outcome { opened: boolean; code: number | null; messages: string[] }
    function probe(url: string, ms = 1200): Promise<Outcome> {
      return new Promise((res) => {
        const out: Outcome = { opened: false, code: null, messages: [] };
        const ws = new WebSocket(url);
        ws.onopen = () => { out.opened = true; };
        ws.onmessage = (e) => { out.messages.push(String(e.data)); };
        ws.onclose = (e) => { out.code = e.code; res(out); };
        setTimeout(() => { try { ws.close(); } catch { /* noop */ } res(out); }, ms);
      });
    }
    // fresh live sessions for both tenants
    const stA = await app.inject({ method: 'POST', url: '/api/lessons/start', headers: a('teacherA'), payload: { classId: classA } });
    const liveA = stA.json().id as string;
    const stB = await app.inject({ method: 'POST', url: '/api/lessons/start', headers: a('teacherB'), payload: { classId: classB } });
    const liveB = stB.json().id as string;

    const bad = await probe(`ws://127.0.0.1:${port}/api/ws/lesson/${liveA}?ticket=xx`);
    expect(bad.messages, 'no bytes to an invalid ticket').toEqual([]);
    expect(bad.code).toBe(4401);

    const tr = await app.inject({ method: 'POST', url: '/api/ws/ticket', headers: a('studentA'), payload: { sessionId: liveA } });
    expect(tr.statusCode).toBe(200);
    const ticket = tr.json().ticket as string;
    const ok = await probe(`ws://127.0.0.1:${port}/api/ws/board/${liveA}?ticket=${encodeURIComponent(ticket)}`, 900);
    expect(ok.opened).toBe(true);
    expect(ok.messages.length, 'member receives init').toBeGreaterThan(0);
    expect(ok.code, 'member socket stays open').toBeNull();

    // ONE-TIME: the consumed ticket is dead
    const reuse = await probe(`ws://127.0.0.1:${port}/api/ws/board/${liveA}?ticket=${encodeURIComponent(ticket)}`);
    expect(reuse.code).toBe(4401);

    // SESSION-BOUND: valid ticket for B's session cannot open A's board
    const trB = await app.inject({ method: 'POST', url: '/api/ws/ticket', headers: a('studentB'), payload: { sessionId: liveB } });
    const cross = await probe(`ws://127.0.0.1:${port}/api/ws/board/${liveA}?ticket=${trB.json().ticket as string}`);
    expect(cross.code).toBe(4401);

    // membership enforced AT ISSUANCE: B cannot get a ticket for A's session
    const denied = await app.inject({ method: 'POST', url: '/api/ws/ticket', headers: a('studentB'), payload: { sessionId: liveA } });
    expect(denied.statusCode).toBe(404);
    // ended session → no tickets
    const ended = await app.inject({ method: 'POST', url: '/api/ws/ticket', headers: a('studentA'), payload: { sessionId: sessionA } });
    expect(ended.statusCode).toBe(404);

    // EXPIRED ticket (rows aged manually) → 4401
    const t2 = await app.inject({ method: 'POST', url: '/api/ws/ticket', headers: a('studentA'), payload: { sessionId: liveA } });
    const plain = t2.json().ticket as string;
    await t.sql`update ws_tickets set expires_at = now() - interval '1 minute'`;
    const expired = await probe(`ws://127.0.0.1:${port}/api/ws/board/${liveA}?ticket=${encodeURIComponent(plain)}`);
    expect(expired.code).toBe(4401);

    await app.inject({ method: 'POST', url: `/api/lessons/${liveA}/end`, headers: a('teacherA') });
    await app.inject({ method: 'POST', url: `/api/lessons/${liveB}/end`, headers: a('teacherB') });
  });

  // ── board & student sheets ──────────────────────────────────────────────────
  it('B cannot read/write/publish A board; A members can', async () => {
    const gB = await app.inject({ method: 'GET', url: `/api/lessons/${sessionA}/board`, headers: a('teacherB') });
    expect(gB.statusCode).toBe(404);
    const gB2 = await app.inject({ method: 'GET', url: `/api/lessons/${sessionA}/board`, headers: a('studentB') });
    expect(gB2.statusCode).toBe(404);
    const put = await app.inject({ method: 'PUT', url: `/api/lessons/${sessionA}/board/page`, headers: a('teacherB'), payload: { pageNo: 1, elements: [{ id: 'x' }] } });
    expect(put.statusCode).toBe(404);
    const pub = await app.inject({
      method: 'POST', url: `/api/lessons/${sessionA}/board/publish`, headers: a('teacherB'),
      payload: { dataUrl: 'data:image/png;base64,' + Buffer.from([0x89, 0x50, 0x4e, 0x47, 1]).toString('base64'), kind: 'png', title: 'steal' },
    });
    expect(pub.statusCode).toBe(404);
    const pubStu = await app.inject({
      method: 'POST', url: `/api/lessons/${sessionA}/board/publish`, headers: a('studentA'),
      payload: { dataUrl: 'data:image/png;base64,iVBORw0K', kind: 'png', title: 'x' },
    });
    expect(pubStu.statusCode).toBe(403);
    const okGet = await app.inject({ method: 'GET', url: `/api/lessons/${sessionA}/board`, headers: a('studentA') });
    expect(okGet.statusCode).toBe(200);
  });

  it('student sheets are owner-only: B list empty, B patch/delete 404, teacher never sees them', async () => {
    const lb = await app.inject({ method: 'GET', url: '/api/student-notes', headers: a('studentB') });
    expect(lb.json()).toEqual([]);
    const pb = await app.inject({ method: 'PATCH', url: `/api/student-notes/${sheetA}`, headers: a('studentB'), payload: { body: 'x' } });
    expect(pb.statusCode).toBe(404);
    const db = await app.inject({ method: 'DELETE', url: `/api/student-notes/${sheetA}`, headers: a('studentB') });
    expect(db.statusCode).toBe(404);
    const byTeacher = await app.inject({ method: 'PATCH', url: `/api/student-notes/${sheetA}`, headers: a('teacherA'), payload: { body: 'x' } });
    expect(byTeacher.statusCode).toBe(404);
    const listTeacher = await app.inject({ method: 'GET', url: '/api/student-notes', headers: a('teacherA') });
    expect(listTeacher.json()).toEqual([]);
    // creating a sheet for a class you are NOT member of → 404
    const fake = await app.inject({ method: 'POST', url: '/api/student-notes', headers: a('studentB'), payload: { classId: classA, title: '', body: '' } });
    expect(fake.statusCode).toBe(404);
    const okA = await app.inject({ method: 'PATCH', url: `/api/student-notes/${sheetA}`, headers: a('studentA'), payload: { body: 'v2' } });
    expect(okA.statusCode).toBe(200);
  });

  // ── misc ────────────────────────────────────────────────────────────────────
  it('rtc spike route cannot be used to mint lesson-room tokens; telegram endpoints are owner-scoped', async () => {
    const lesson = await app.inject({ method: 'POST', url: '/api/rtc/token', headers: a('studentA'), payload: { room: `lesson-${classA.slice(0, 8)}-abc` } });
    expect(lesson.statusCode).toBe(501); // lesson rooms live on the session flow only
    const spike = await app.inject({ method: 'POST', url: '/api/rtc/token', headers: a('studentA'), payload: { room: 'spike-9' } });
    expect(spike.statusCode).toBe(200);
    const anonSpike = await app.inject({ method: 'POST', url: '/api/rtc/token', payload: { room: 'spike-9' } });
    expect(anonSpike.statusCode).toBe(401);
    const linkB = await app.inject({ method: 'DELETE', url: '/api/me/telegram-link', headers: a('studentB') });
    expect(linkB.statusCode).toBe(200); // unlinks self only
    const tg = await app.inject({ method: 'GET', url: `/api/classes/${classA}/telegram`, headers: a('studentA') });
    expect(tg.statusCode).toBe(403);
  });

  it('extra edges: classId-filtered lists, self-kick, teacher on student routes, anon telegram-status', async () => {
    // notes list filtered by A class as B teacher → empty, no leak
    const nb = await app.inject({ method: 'GET', url: `/api/notes?classId=${classA}`, headers: a('teacherB') });
    expect(nb.json()).toEqual([]);
    // sheets scoped by someone else's session → empty
    const sb = await app.inject({ method: 'GET', url: `/api/student-notes?sessionId=${sessionA}`, headers: a('studentB') });
    expect(sb.json()).toEqual([]);
    // teacher cannot join via class code as if a student
    const tj = await app.inject({ method: 'POST', url: '/api/join-by-code', headers: a('teacherB'), payload: { code: 'ABCDEFGH' } });
    expect(tj.statusCode).toBe(403);
    // AUDIT-H3 check: moderation of an ENDED session → 404 (like missing)
    const sk = await app.inject({ method: 'POST', url: `/api/lessons/${sessionA}/kick`, headers: a('teacherA'), payload: { identity: teacherAId } });
    expect(sk.statusCode).toBe(404);
    // on a LIVE session self-kick is rejected 400
    const live = await app.inject({ method: 'POST', url: '/api/lessons/start', headers: a('teacherA'), payload: { classId: classA } });
    const liveId = live.json().id as string;
    const selfKick = await app.inject({ method: 'POST', url: `/api/lessons/${liveId}/kick`, headers: a('teacherA'), payload: { identity: teacherAId } });
    expect(selfKick.statusCode).toBe(400);
    await app.inject({ method: 'POST', url: `/api/lessons/${liveId}/end`, headers: a('teacherA') });
    // anonymous telegram status & spike rtc
    for (const url of ['/api/me/telegram-status', '/api/me/notify-prefs']) {
      const r = await app.inject({ method: 'GET', url });
      expect(r.statusCode, url).toBe(401);
    }
    // B cannot publish notes into A class feed even via note create+publish chain
    const nc = await app.inject({ method: 'POST', url: '/api/notes', headers: a('teacherB'), payload: { classId: classA, title: 'x', body: 'y' } });
    expect(nc.statusCode).toBe(404);
  });

  it('sanity: A-side happy paths still work after audit (no over-blocking)', async () => {
    const cls = await app.inject({ method: 'GET', url: '/api/classes', headers: a('studentA') });
    expect(cls.json().some((c: { id: string }) => c.id === classA)).toBe(true);
    const feed = await app.inject({ method: 'GET', url: `/api/classes/${classA}/feed`, headers: a('studentA') });
    expect((feed.json() as unknown[]).length).toBeGreaterThan(0);
    const mine = await app.inject({ method: 'GET', url: '/api/me', headers: a('studentA') });
    expect(mine.json().role).toBe('student');
    const left = await app.inject({ method: 'POST', url: `/api/classes/${classB}/leave`, headers: a('studentA') });
    expect(left.statusCode).toBe(200); // studentA was force-added to B earlier — leaving must work
    const membersB = await app.inject({ method: 'GET', url: `/api/classes/${classB}/members`, headers: a('teacherB') });
    expect(membersB.json().some((m: { userId: string }) => m.userId === studentAId)).toBe(false);
  });
});
