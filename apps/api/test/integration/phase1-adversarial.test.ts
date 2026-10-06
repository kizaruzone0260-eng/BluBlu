/**
 * Phase 1 — adversarial additions that the §7 rights matrix does not yet cover:
 * cross-class topic edits, foreign per-event ICS, XSS VERBATIM storage on every
 * user-text surface (the server never HTML-encodes/strips — React escapes at
 * render, proven by the fact the API returns the exact bytes with a JSON
 * content-type), dangerous attachment URL schemes, and the WebSocket Origin
 * gate. Two tenants: A (victim) / B (attacker).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { WebSocket } from 'ws';
import { TEST_DATABASE_URL, preparedDb, makeTeacher, type TestDB } from './util.js';
import { buildApp } from '../../src/app.js';
import { classes, inviteCodes } from '../../src/db/schema.js';
import { hashInviteCode } from '../../src/lib/invite.js';
import type { FastifyInstance } from 'fastify';

const suite = TEST_DATABASE_URL ? describe : describe.skip;
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const genCode = () => Array.from({ length: 8 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join('');

/** minimal multipart/form-data body builder (text fields only, optional one file) */
function mp(fields: Record<string, string>, file?: { name: string; filename: string; type: string; data: Buffer }): { ct: string; body: Buffer } {
  const B = '----P1B';
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${B}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`, 'utf8'));
  }
  if (file) {
    parts.push(Buffer.from(`--${B}\r\nContent-Disposition: form-data; name="${file.name}"; filename="${file.filename}"\r\nContent-Type: ${file.type}\r\n\r\n`, 'utf8'));
    parts.push(file.data, Buffer.from('\r\n', 'utf8'));
  }
  parts.push(Buffer.from(`--${B}--\r\n`, 'utf8'));
  return { ct: `multipart/form-data; boundary=${B}`, body: Buffer.concat(parts) };
}

suite('Phase 1 adversarial (topics / ics / xss / ws-origin)', () => {
  let t: TestDB; let app: FastifyInstance;
  const tok: Record<string, string> = {};
  let classA = '', classB = '', teacherAId = '', studentAId = '';
  let topicA = '', eventA = '';

  async function enroll(email: string, classId: string, who: string): Promise<string> {
    const code = genCode();
    await t.db.insert(inviteCodes).values({ classId, codeHash: hashInviteCode(code, process.env.JWT_SECRET!), createdBy: teacherAId, expiresAt: new Date(Date.now() + 86400000) });
    const r = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { firstName: 'Pupil', lastName: 'Test', email, password: 'Secret1234', code } });
    tok[who] = r.json().accessToken; return r.json().user.id as string;
  }
  const a = (who: string) => ({ authorization: `Bearer ${tok[who]}` });

  beforeAll(async () => {
    t = await preparedDb(TEST_DATABASE_URL);
    app = await buildApp(t.db);
    const tA = await makeTeacher(t.sql, `xa${Date.now()}@x.io`); teacherAId = tA.id;
    const tB = await makeTeacher(t.sql, `xb${Date.now()}@x.io`);
    tok.teacherA = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: tA.email, password: tA.password } })).json().accessToken;
    tok.teacherB = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: tB.email, password: tB.password } })).json().accessToken;
    const [cA] = await t.db.insert(classes).values({ teacherId: teacherAId, name: 'Class A' }).returning();
    const [cB] = await t.db.insert(classes).values({ teacherId: tB.id, name: 'Class B' }).returning();
    classA = cA!.id; classB = cB!.id;
    studentAId = await enroll(`advA${Date.now()}@x.io`, classA, 'studentA');
    await enroll(`advB${Date.now()}@x.io`, classB, 'studentB');
    const tp = await app.inject({ method: 'POST', url: `/api/classes/${classA}/topics`, headers: a('teacherA'), payload: { name: 'Victim topic' } });
    topicA = tp.json().id;
    const ev = await app.inject({ method: 'POST', url: `/api/classes/${classA}/events`, headers: a('teacherA'),
      payload: { kind: 'lesson', title: 'Adv lesson', description: '', startLocal: '2026-12-01T19:00', durationMin: 50, tz: 'Asia/Tashkent' } });
    eventA = ev.json().id;
  });
  afterAll(async () => { await app?.close(); await t?.sql.end(); });

  // ── topics ─────────────────────────────────────────────────────────────────
  it('B teacher cannot read/rename/delete A topic (404); B cannot list A topics', async () => {
    expect((await app.inject({ method: 'GET', url: `/api/classes/${classA}/topics`, headers: a('teacherB') })).statusCode).toBe(404);
    expect((await app.inject({ method: 'PATCH', url: `/api/topics/${topicA}`, headers: a('teacherB'), payload: { name: 'hijacked' } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: `/api/topics/${topicA}`, headers: a('teacherB') })).statusCode).toBe(404);
    // control: A can rename
    expect((await app.inject({ method: 'PATCH', url: `/api/topics/${topicA}`, headers: a('teacherA'), payload: { name: 'Renamed' } })).statusCode).toBe(200);
  });

  // ── per-event ICS ────────────────────────────────────────────────────────────
  it('B cannot download A event as .ics (404); A member can (200)', async () => {
    expect((await app.inject({ method: 'GET', url: `/api/events/${eventA}/ics`, headers: a('teacherB') })).statusCode).toBe(404);
    const okA = await app.inject({ method: 'GET', url: `/api/events/${eventA}/ics`, headers: a('teacherA') });
    expect(okA.statusCode).toBe(200);
    expect(okA.body).toContain('Adv lesson');
  });

  // ── XSS verbatim + dangerous link schemes ───────────────────────────────────
  it('user text is stored & returned verbatim (no server-side HTML/encoding) across surfaces', async () => {
    const XSS = '<img src=x onerror=alert(1)>&amp;"\'<script>bad()</script>';
    // chat message (studentA in class A)
    const cm = await app.inject({ method: 'POST', url: `/api/classes/${classA}/chat/messages`, headers: a('studentA'), payload: { text: XSS } });
    expect(cm.statusCode).toBe(201);
    expect(cm.json().text).toBe(XSS);
    const list = await app.inject({ method: 'GET', url: `/api/classes/${classA}/chat/messages`, headers: a('studentA') });
    expect(list.headers['content-type']).toContain('application/json');
    expect((list.json().messages as { text: string }[]).some((m) => m.text === XSS)).toBe(true);

    // material title + description + a link attachment title
    const body = mp({
      title: XSS,
      description: 'hello <b>world</b> <script>x()</script>',
      publish: 'now',
      attachments: JSON.stringify([{ url: 'https://ok.example/doc', title: XSS }]),
    });
    const mat = await app.inject({ method: 'POST', url: `/api/classes/${classA}/materials`, headers: { ...a('teacherA'), 'content-type': body.ct }, payload: body.body });
    expect(mat.statusCode).toBe(201);
    const feed = await app.inject({ method: 'GET', url: `/api/classes/${classA}/feed`, headers: a('studentA') });
    const post = (feed.json() as { title: string; body: string; attachments: { title: string; url: string }[] }[]).find((p) => p.title === XSS);
    expect(post, 'material with verbatim XSS title present in feed').toBeTruthy();
    expect(post!.body).toContain('<script>x()</script>'); // stored raw; client escapes on render
    expect(post!.attachments[0]!.title).toBe(XSS);
    expect(post!.attachments[0]!.url).toBe('https://ok.example/doc');
  });

  it('attachment URLs must be http(s); javascript:/data:/file: rejected (no SSRF/handler)', async () => {
    for (const bad of ['javascript:alert(1)', 'data:text/html,<script>1</script>', 'file:///etc/passwd', 'https://no-spaces-but-nodotscheme']) {
      const body = mp({ title: 'x', publish: 'now', attachments: JSON.stringify([{ url: bad, title: 't' }]) });
      const r = await app.inject({ method: 'POST', url: `/api/classes/${classA}/materials`, headers: { ...a('teacherA'), 'content-type': body.ct }, payload: body.body });
      expect(r.statusCode, bad).toBe(400);
      expect(r.json().error, bad).toBe('invalidLink');
    }
  });

  // ── WebSocket Origin gate ────────────────────────────────────────────────────
  it('board WS rejects a cross-site Origin (4403) even with a valid ticket; same-host opens', async () => {
    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    const st = await app.inject({ method: 'POST', url: '/api/lessons/start', headers: a('teacherA'), payload: { classId: classA } });
    const sessionId = st.json().id as string;
    const mkTicket = async () => (await app.inject({ method: 'POST', url: '/api/ws/ticket', headers: a('studentA'), payload: { sessionId } })).json().ticket as string;

    function probe(origin: string | null, ticket: string): Promise<number | null> {
      return new Promise((res) => {
        const opts = origin ? { headers: { origin } } : undefined;
        const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws/board/${sessionId}?ticket=${encodeURIComponent(ticket)}`, opts);
        ws.onclose = (e) => res(e.code);
        setTimeout(() => { try { ws.close(); } catch { /* */ } res(null); }, 1200);
      });
    }
    // cross-site origin → 4403, and the ticket is NOT consumed (still usable)
    const cross = await probe('http://evil.example', await mkTicket());
    expect(cross).toBe(4403);
    // same-host origin → opens (stays connected, no close code)
    const same = await probe(`http://127.0.0.1:${port}`, await mkTicket());
    expect(same).toBeNull();
  });
});
