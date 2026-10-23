/**
 * Task 5 (2026-10-10) — what the access log ACTUALLY writes.
 *
 * The bug this file exists for: `logger.serializers.request` is not a key pino reads (pino reads
 * `serializers.req/res/err`), so the app's URL sanitizer never ran. A live stack logged 18 lines of
 * `/api/ws/lesson/<id>?ticket=<one-time ticket>` while `sanitizeRequestUrl` had a green unit test
 * next to it — the function was correct, the wiring was dead, and TypeScript did not object either.
 * A test on the function therefore cannot be the regression guard, so this one asserts on the
 * LINES: the same `accessLogOptions` object the server hands Fastify, a real app, real HTTP, a real
 * WebSocket upgrade, and then `expect(output).not.toContain(secret)`.
 *
 * The second half of the job is equally important: "no secrets in logs" is trivially satisfied by
 * deleting the log line. So every field an operator needs — status, method, path without query,
 * response time, request id — is pinned here too, on the output, not on the options.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { WebSocket } from 'ws';
import pino from 'pino';
import type { FastifyInstance } from 'fastify';
import { TEST_DATABASE_URL, preparedDb, makeTeacher, type TestDB } from './util.js';
import { accessLogOptions, buildApp } from '../../src/app.js';
import { REQUEST_ID_PATTERN } from '../../src/lib/requestId.js';

const suite = TEST_DATABASE_URL ? describe : describe.skip;
const NIL = '00000000-0000-4000-8000-000000000000';

suite('access log output (task 5)', () => {
  let t: TestDB;
  let app: FastifyInstance;
  let lines: string[] = [];
  let teacherTok = '';
  let classId = '';
  let sessionId = '';
  let icsToken = '';
  let inviteCode = '';
  let port = 0;

  const auth = (tok: string) => ({ authorization: `Bearer ${tok}` });
  const out = () => lines.join('');
  /** the JSON objects pino wrote, oldest first */
  const parsed = () => lines.map((l) => JSON.parse(l) as Record<string, never>);
  const msgLines = (msg: string) => parsed().filter((o) => o.msg === msg);

  beforeAll(async () => {
    t = await preparedDb(TEST_DATABASE_URL);
    lines = [];
    // The REAL options object from src/app.ts — this is the point of the file.
    const logger = pino(accessLogOptions, { write: (s: string) => { lines.push(String(s)); } });
    app = await buildApp(t.db, { logger });

    const teacher = await makeTeacher(t.sql, 'logt@x.io', 'Log Teacher');
    const login = await app.inject({ method: 'POST', url: '/api/auth/login',
      payload: { email: teacher.email, password: teacher.password } });
    expect(login.statusCode, login.body.slice(0, 200)).toBe(200);
    teacherTok = login.json().accessToken as string;

    const cls = await app.inject({ method: 'POST', url: '/api/classes', headers: auth(teacherTok),
      payload: { name: 'Log class', description: '', color: '#0ea5a5' } });
    classId = cls.json().id as string;
    const started = await app.inject({ method: 'POST', url: '/api/lessons/start',
      headers: auth(teacherTok), payload: { classId } });
    sessionId = started.json().id as string;

    const ical = await app.inject({ method: 'POST', url: '/api/me/ical-token', headers: auth(teacherTok) });
    icsToken = ical.json().token as string;
    expect(icsToken.length, 'a real ICS token, not a made-up one').toBeGreaterThan(10);

    const inv = await app.inject({ method: 'POST', url: `/api/classes/${classId}/invites`,
      headers: auth(teacherTok), payload: {} });
    inviteCode = inv.json().code as string;

    // a route that throws is registered inside buildApp's own lifecycle, which we do not own —
    // the 500 below is produced the way it happens in production: a dependency that stops working.

    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    port = typeof address === 'object' && address ? address.port : 0;
    lines = []; // fixtures above also logged; the assertions are about the requests below
  });

  afterAll(async () => {
    await app?.close();
    // the last test ends the pool on purpose; ending it twice must not decide the run
    await t?.sql.end().catch(() => undefined);
  });

  it('a query string never reaches the log — over HTTP and over a real WS upgrade', async () => {
    const q = await app.inject({ method: 'GET', url: '/api/health/live?ticket=QUERY-MARKER-123' });
    expect(q.statusCode).toBe(200);
    expect(out(), 'the query value').not.toContain('QUERY-MARKER-123');
    expect(out(), 'and not even the `?`').not.toContain('?ticket=QUERY');

    // the case that was broken: a one-time lesson ticket, over a socket, through Fastify's router
    const tr = await app.inject({ method: 'POST', url: '/api/ws/ticket',
      headers: auth(teacherTok), payload: { sessionId } });
    const ticket = tr.json().ticket as string;
    expect(typeof ticket).toBe('string');
    const ws = new WebSocket(
      `ws://127.0.0.1:${port}/api/ws/lesson/${sessionId}?ticket=${encodeURIComponent(ticket)}`);
    await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = (e) => rej(e); });
    await new Promise((r) => setTimeout(r, 200));
    ws.close();
    await new Promise((r) => setTimeout(r, 200));

    expect(out(), 'the upgrade line must not carry the ticket').not.toContain(ticket);
    expect(out(), '…but must still say which lesson was opened').toContain(`/api/ws/lesson/${sessionId}`);
    expect(out()).not.toContain('?ticket=');
  });

  it('the ICS token stays out of the log although it IS the path', async () => {
    const r = await app.inject({ method: 'GET', url: `/api/ical/${icsToken}` });
    expect(r.statusCode).toBe(200);
    expect(out(), 'the personal subscription token').not.toContain(icsToken);
    expect(out(), 'the route is still recognizable').toContain('/api/ical/[redacted]');
  });

  it('an invite code and a chat body are not logged either', async () => {
    expect(inviteCode.length).toBeGreaterThan(3);
    const said = await app.inject({ method: 'POST', url: `/api/classes/${classId}/chat/messages`,
      headers: auth(teacherTok), payload: { text: 'ЧАТ-ТЕЛО-МАРКЕР-не-в-лог' } });
    expect(said.statusCode, said.body.slice(0, 200)).toBeLessThan(300);
    expect(out(), 'request bodies are not logged').not.toContain('ЧАТ-ТЕЛО-МАРКЕР');
    expect(out(), 'and an issued invite code is not echoed either').not.toContain(inviteCode);
  });

  it('neither the bearer token nor a cookie appears in the output', async () => {
    const me = await app.inject({ method: 'GET', url: '/api/me',
      headers: { ...auth(teacherTok), cookie: 'klass_session=COOKIE-MARKER-9' } });
    expect(me.statusCode).toBe(200);
    expect(out(), 'the access token').not.toContain(teacherTok);
    expect(out(), 'the cookie value').not.toContain('COOKIE-MARKER-9');
    expect(out()).not.toContain('authorization');
  });

  it('the line still carries status, method, path without query, response time and req id', async () => {
    await app.inject({ method: 'GET', url: '/api/classes?probe=drop-me', headers: auth(teacherTok) });
    // paired by request id, which is exactly how an operator reads these lines
    const incoming = parsed()
      .map((o) => ({ id: o.reqId as string | undefined, q: o.req as unknown as Record<string, string> }))
      .find((x) => x.q?.url === '/api/classes');
    expect(incoming, 'our serializer ran (this is what `serializers.req` means)').toBeTruthy();
    expect(incoming?.q.type).toBe('request');
    expect(incoming?.q.method).toBe('GET');
    expect(String(incoming?.q.url)).not.toContain('?');
    expect(incoming?.q.remoteAddress, 'the client address the rate limiter keys on').toBeTruthy();
    const completed = parsed().find((o) => o.reqId === incoming?.id && o.msg === 'request completed');
    expect(completed, 'the matching response line').toBeTruthy();
    expect((completed?.res as { statusCode?: number })?.statusCode).toBe(200);
    expect(typeof completed?.responseTime).toBe('number');
    expect(typeof completed?.reqId).toBe('string');
  });

  it('an unknown uuid is answered and logged as a path, not as a probe of what exists', async () => {
    const r = await app.inject({ method: 'GET', url: `/api/lessons/${NIL}/hands`, headers: auth(teacherTok) });
    expect(r.statusCode).toBe(404);
    expect(out()).toContain(`/api/lessons/${NIL}/hands`);
  });

  /*
   * LAST: it kills the pool. A 500 has to appear in the log with the same request id (that is the
   * operator's half of the contract), the client must get the generic body, and the driver's own
   * error text must not carry the connection password of this test database — checked without
   * ever printing either.
   */
  it('a dependency failure is logged with its request id and answers generically', async () => {
    const pw = (() => { try { return decodeURIComponent(new URL(TEST_DATABASE_URL).password); } catch { return ''; } })();
    await t.sql.end();
    const r = await app.inject({ method: 'GET', url: '/api/classes', headers: auth(teacherTok) });
    expect(r.statusCode).toBe(500);
    // Task B (2026-10-23): the generic body keeps its shape and gains the request id, so the
    // client's «что пошло не так» and the operator's log line are the same number. The rule the
    // test exists for is unchanged: no driver text ever leaves the server.
    const body = r.json() as { error: string; reqId: string };
    expect(body.error, 'no driver text in the client response').toBe('serverError');
    expect(REQUEST_ID_PATTERN.test(String(body.reqId)), JSON.stringify(body)).toBe(true);
    // the same claim from the other side: the body is two fields, with no stack, no SQL and no
    // connection string anywhere in the bytes the client receives
    expect(r.body).not.toMatch(/at .*\(|Failed query|postgres:\/\/|params:/);
    const errLine = msgLines('unhandled error').at(-1);
    expect(errLine, 'the server does keep an internal record of a 500').toBeTruthy();
    expect(typeof errLine?.reqId).toBe('string');
    expect(body.reqId, 'the id the pupil reads out is the id in the log').toBe(errLine?.reqId);
    if (pw) expect(out(), 'a driver error must not echo the connection password').not.toContain(pw);
  });
});
