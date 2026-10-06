/**
 * Part 1(г) — upload & delivery safety. Drives the real multipart materials
 * endpoint and the file delivery routes to prove:
 *  • type is decided by MAGIC BYTES, not the extension (a PDF-named HTML is
 *    rejected; a real PDF/PNG is accepted);
 *  • HTML is rejected outright; SVG is allowed but FORCED download-only (inline
 *    preview refused) and served with `nosniff` + `attachment`;
 *  • the download sets Content-Disposition (RFC 5987, URL-encoded) + X-Content-
 *    Type-Options: nosniff + no-store;
 *  • the on-disk key is a UUID, never derived from the (possibly hostile)
 *    filename, so no path traversal.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { TEST_DATABASE_URL, preparedDb, makeTeacher, type TestDB } from './util.js';
import { buildApp } from '../../src/app.js';
import { classes, files as filesTable } from '../../src/db/schema.js';
import type { FastifyInstance } from 'fastify';

const suite = TEST_DATABASE_URL ? describe : describe.skip;

function multipart(fields: Record<string, string>, file: { filename: string; bytes: Buffer }) {
  const b = '----part1boundary';
  const head = Object.entries(fields)
    .map(([k, v]) => `--${b}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`).join('');
  const fileHead = `--${b}\r\nContent-Disposition: form-data; name="file"; filename="${file.filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`;
  const payload = Buffer.concat([
    Buffer.from(head + fileHead, 'utf8'), file.bytes, Buffer.from(`\r\n--${b}--\r\n`, 'utf8'),
  ]);
  return { headers: { 'content-type': `multipart/form-data; boundary=${b}` }, payload };
}

const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from('%'.repeat(200))]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('idat')]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', 'utf8');
const HTML = Buffer.from('<!DOCTYPE html><html><body>hi</body></html>', 'utf8');

suite('Part 1(г): uploads & delivery', () => {
  let t: TestDB; let app: FastifyInstance; let teacherTok = '', teacherId = '';
  const bearer = () => ({ authorization: `Bearer ${teacherTok}` });

  async function newClass() {
    const [c] = await t.db.insert(classes).values({ teacherId, name: `Up ${Date.now()}` }).returning();
    return c!.id;
  }
  async function upload(classId: string, filename: string, bytes: Buffer, title = 'doc') {
    const mp = multipart({ title }, { filename, bytes });
    return app.inject({ method: 'POST', url: `/api/classes/${classId}/materials`, headers: { ...bearer(), ...mp.headers }, payload: mp.payload });
  }
  async function fileIdOf(postId: string) {
    const [f] = await t.db.select().from(filesTable).where(eq(filesTable.postId, postId)).limit(1);
    return f?.id ?? '';
  }

  beforeAll(async () => {
    t = await preparedDb(TEST_DATABASE_URL);
    app = await buildApp(t.db);
    const te = await makeTeacher(t.sql, `up-t${Date.now()}@x.io`);
    teacherId = te.id;
    const l = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: te.email, password: te.password } });
    teacherTok = l.json().accessToken as string;
  });
  afterAll(async () => { await app?.close(); await t?.sql.end(); });

  it('accepts a real PDF and serves it download-only with nosniff + attachment + no-store', async () => {
    const cls = await newClass();
    const up = await upload(cls, 'notes.pdf', PDF);
    expect(up.statusCode).toBe(201);
    const dl = await app.inject({ method: 'GET', url: `/api/files/${await fileIdOf(up.json().id)}`, headers: bearer() });
    expect(dl.statusCode).toBe(200);
    expect(String(dl.headers['x-content-type-options'])).toBe('nosniff');
    expect(String(dl.headers['content-disposition'])).toMatch(/^attachment; filename\*=UTF-8''/);
    expect(String(dl.headers['content-type'])).toBe('application/pdf');
    expect(String(dl.headers['cache-control'])).toContain('no-store');
  });

  it('decides by MAGIC BYTES, not the extension: a PDF-named HTML is rejected', async () => {
    const cls = await newClass();
    const up = await upload(cls, 'invoice.pdf', HTML);
    expect(up.statusCode).toBe(415);
    expect(up.json().error).toBe('fileTypeRejected');
  });

  it('rejects HTML upload entirely (never an allowed group)', async () => {
    const cls = await newClass();
    expect((await upload(cls, 'page.html', HTML)).statusCode).toBe(415);
  });

  it('SVG is allowed as a file but FORCED download-only (inline preview refused)', async () => {
    const cls = await newClass();
    const up = await upload(cls, 'board.svg', SVG);
    expect(up.statusCode).toBe(201);
    const fileId = await fileIdOf(up.json().id);
    const inline = await app.inject({ method: 'GET', url: `/api/files/${fileId}/inline`, headers: bearer() });
    expect(inline.statusCode).toBe(400);
    expect(inline.json().error).toBe('notPreviewable');
    const dl = await app.inject({ method: 'GET', url: `/api/files/${fileId}`, headers: bearer() });
    expect(dl.statusCode).toBe(200);
    expect(String(dl.headers['content-disposition'])).toMatch(/^attachment;/);
    expect(String(dl.headers['x-content-type-options'])).toBe('nosniff');
  });

  it('the storage key is a UUID — a hostile filename never reaches the disk path', async () => {
    const cls = await newClass();
    const up = await upload(cls, '../../../../etc/passwd.png', PNG);
    expect(up.statusCode).toBe(201);
    const [row] = await t.db.select().from(filesTable).where(eq(filesTable.postId, up.json().id));
    expect(row!.storageKey).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.png$/i);
    const dl = await app.inject({ method: 'GET', url: `/api/files/${row!.id}`, headers: bearer() });
    expect(String(dl.headers['content-disposition'])).toContain("filename*=UTF-8''");
    expect(String(dl.headers['content-disposition'])).not.toContain('../');
  });

  it('accepts a genuine PNG (magic 89 50 4E 47)', async () => {
    const cls = await newClass();
    const up = await upload(cls, 'photo.png', PNG);
    expect(up.statusCode).toBe(201);
    const [row] = await t.db.select().from(filesTable).where(eq(filesTable.postId, up.json().id));
    expect(row!.mime).toBe('image/png');
  });

  it('a junk/unknown-content .exe is rejected (magic, not extension)', async () => {
    const cls = await newClass();
    const up = await upload(cls, 'installer.exe', Buffer.from('MZ\x90\x00binarynotallowed\x00\x01', 'binary'));
    expect(up.statusCode).toBe(415);
  });

  it('anonymous download of a file is 401 and no-store (never cached/leaked)', async () => {
    const cls = await newClass();
    const up = await upload(cls, 'a.pdf', PDF);
    const anon = await app.inject({ method: 'GET', url: `/api/files/${await fileIdOf(up.json().id)}` });
    expect(anon.statusCode).toBe(401);
    expect(String(anon.headers['cache-control'])).toContain('no-store');
  });
});
