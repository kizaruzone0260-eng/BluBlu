/**
 * Part 1(д) — stored-XSS per user field + no SSRF.
 *
 * 1) Every free-text user field is written with an XSS payload and read back
 *    VERBATIM as `application/json`. The server does NOT strip or re-emit it as
 *    HTML (escaping is the SPA's job — React escapes by construction, RichText/
 *    Tiptap render structured nodes), so nothing executes at the transport layer
 *    and no field is reflected with a text/html content-type.
 * 2) The server NEVER fetches a user-supplied URL. A material is created with an
 *    attachment link pointing at a local probe listener; we assert the listener
 *    receives no inbound request — there is no server-side URL fetch ⇒ no SSRF.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { TEST_DATABASE_URL, preparedDb, makeTeacher, type TestDB } from './util.js';
import { buildApp } from '../../src/app.js';
import { classes } from '../../src/db/schema.js';
import type { FastifyInstance } from 'fastify';

const suite = TEST_DATABASE_URL ? describe : describe.skip;
const XSS = '\"><img src=x onerror=alert(1)><script>bad()</script>';

suite('Part 1(д): stored XSS + SSRF', () => {
  let t: TestDB; let app: FastifyInstance; let teacherTok = '', teacherId = '';
  const bearer = () => ({ authorization: `Bearer ${teacherTok}` });
  beforeAll(async () => {
    t = await preparedDb(TEST_DATABASE_URL);
    app = await buildApp(t.db);
    const te = await makeTeacher(t.sql, `xss-t${Date.now()}@x.io`);
    teacherId = te.id;
    teacherTok = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: te.email, password: te.password } })).json().accessToken as string;
  });
  afterAll(async () => { await app?.close(); await t?.sql.end(); });

  const isJson = (h: Record<string, unknown>) => String(h['content-type'] ?? '').includes('application/json');

  it('profile name / lastName store the payload verbatim as JSON, never HTML', async () => {
    const patch = await app.inject({ method: 'PATCH', url: '/api/me/profile', headers: bearer(), payload: { name: XSS, lastName: XSS, locale: 'ru' } });
    expect(patch.statusCode).toBe(200);
    expect(isJson(patch.headers)).toBe(true);
    expect(patch.json().name).toBe(XSS);
    const me = await app.inject({ method: 'GET', url: '/api/me', headers: bearer() });
    expect(me.json().name).toBe(XSS);
    expect(me.json().lastName).toBe(XSS);
    expect(String(me.headers['content-type'])).not.toContain('text/html');
  });

  it('class name + announcement body + note title/body survive verbatim (JSON only)', async () => {
    const [cls] = await t.db.insert(classes).values({ teacherId, name: 'base' }).returning();
    const rc = await app.inject({ method: 'PATCH', url: `/api/classes/${cls!.id}`, headers: bearer(), payload: { name: XSS } });
    expect(rc.statusCode).toBe(200); expect(rc.json().name).toBe(XSS);

    const ann = await app.inject({ method: 'POST', url: `/api/classes/${cls!.id}/announcements`, headers: bearer(), payload: { title: XSS, body: XSS } });
    expect(ann.statusCode).toBe(201);
    const feed = await app.inject({ method: 'GET', url: `/api/classes/${cls!.id}/feed`, headers: bearer() });
    expect(isJson(feed.headers)).toBe(true);
    const seen = (feed.json() as { title: string; body: string }[]).find((p) => p.body === XSS);
    expect(seen, 'announcement payload returned verbatim').toBeTruthy();

    const note = await app.inject({ method: 'POST', url: '/api/notes', headers: bearer(), payload: { classId: cls!.id, title: XSS, body: XSS } });
    expect(note.statusCode).toBe(201);
    const notes = await app.inject({ method: 'GET', url: '/api/notes', headers: bearer() });
    const n = (notes.json() as { title: string; body: string }[]).find((x) => x.body === XSS);
    expect(n, 'note body returned verbatim').toBeTruthy();
    // the stored text is never re-served as HTML — it is inert until the SPA escapes it
    for (const r of [rc, ann, feed, note, notes]) expect(String(r.headers['content-type'] ?? '')).not.toContain('text/html');
  });

  it('no SSRF: the server never fetches a user-supplied attachment URL', async () => {
    let hits = 0;
    const probe = createServer((req, res) => { hits++; res.end('nope'); });
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
    const port = (probe.address() as AddressInfo).port;
    const [cls] = await t.db.insert(classes).values({ teacherId, name: 'ssrf' }).returning();
    // an internal numeric host passes the format-only validator; the point is nothing fetches it
    const up = await app.inject({
      method: 'POST', url: `/api/classes/${cls!.id}/announcements`, headers: bearer(),
      payload: { title: 'link', body: 'x', links: [{ url: `http://127.0.0.1:${port}/ssrf-probe`, title: 'p' }] },
    });
    // whether the link is accepted (stored, never fetched) or rejected, the probe must stay silent
    await new Promise((r) => setTimeout(r, 400));
    expect(hits, `server must not request ${port}`).toBe(0);
    await new Promise<void>((r) => probe.close(() => r()));
    void up;
  });

  it('the URL validator rejects non-http(s)/hostless URLs; internal IPs pass format — no-fetch is the SSRF defence', async () => {
    const { safeExternalUrl } = await import('../../src/services/posts.js');
    expect(safeExternalUrl('http://localhost:9/admin')).toBeNull(); // bare host, no dot
    expect(safeExternalUrl('javascript:alert(1)')).toBeNull();
    expect(safeExternalUrl('data:text/html,<script>')).toBeNull();
    expect(safeExternalUrl('file:///etc/passwd')).toBeNull();
    // numeric internal hosts PASS the format-only check — which is exactly why the
    // "server never fetches a user URL" probe above is the real SSRF defence.
    expect(typeof safeExternalUrl('http://169.254.169.254/latest/meta-data')).toBe('string');
    expect(typeof safeExternalUrl('http://127.0.0.1:80/')).toBe('string');
  });
});
