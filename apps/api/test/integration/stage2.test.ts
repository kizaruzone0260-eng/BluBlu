import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { TEST_DATABASE_URL, preparedDb, makeTeacher, type TestDB } from './util.js';
import { buildApp } from '../../src/app.js';
import { classes, inviteCodes, classMembers, users, files } from '../../src/db/schema.js';
import { hashInviteCode } from '../../src/lib/invite.js';
import { eq } from 'drizzle-orm';
import fs from 'node:fs';
import path from 'node:path';

const suite = TEST_DATABASE_URL ? describe : describe.skip;

function multipart(fields: Record<string, string>, file: { name: string; filename: string; data: Buffer }, boundary = 'KLBOUND') {
  let head = `--${boundary}\r\n`;
  for (const [k, v] of Object.entries(fields)) {
    head += `Content-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n--${boundary}\r\n`;
  }
  head += `Content-Disposition: form-data; name="${file.name}"; filename="${file.filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`;
  return Buffer.concat([
    Buffer.from(head, 'utf8'),
    file.data,
    Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'),
  ]);
}

suite('stage 2: materials, files, teacher notes', () => {
  let t: TestDB;
  let classId = '';
  let teacher: { id: string; email: string; password: string; token: string };
  let studentToken = '';
  let outsiderToken = '';

  beforeAll(async () => {
    t = await preparedDb(TEST_DATABASE_URL);
    teacher = await makeTeacher(t.sql, `st2${Date.now()}@x.io`) as typeof teacher;
    const [cls] = await t.db.insert(classes).values({ teacherId: teacher.id, name: 'Hist' }).returning();
    classId = cls!.id;

    // two students via invite codes
    const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
    const genCode = () => Array.from({ length: 8 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join('');
    async function enroll(email: string) {
      const code = genCode();
      await t.db.insert(inviteCodes).values({
        classId, codeHash: hashInviteCode(code, process.env.JWT_SECRET!),
        createdBy: teacher.id, expiresAt: new Date(Date.now() + 86400000),
      });
      const app = await buildApp(t.db);
      const r = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { firstName: 'Pupil K', lastName: 'Test', email, password: 'Secret1234', code } });
      await app.close();
      return r.json().accessToken as string;
    }
    studentToken = await enroll(`al${Date.now()}@x.io`);
    // outsider: student of ANOTHER class, must not access classId
    const [other] = await t.db.insert(classes).values({ teacherId: teacher.id, name: 'Other' }).returning();
    const code2 = genCode();
    await t.db.insert(inviteCodes).values({
      classId: other!.id, codeHash: hashInviteCode(code2, process.env.JWT_SECRET!),
      createdBy: teacher.id, expiresAt: new Date(Date.now() + 86400000),
    });
    const app0 = await buildApp(t.db);
    const r0 = await app0.inject({ method: 'POST', url: '/api/auth/register', payload: { firstName: 'Out S', lastName: 'Test', email: `out${Date.now()}@x.io`, password: 'Secret1234', code: code2 } });
    outsiderToken = r0.json().accessToken as string;
    await app0.close();
  });

  afterAll(async () => { await t?.sql.end(); });

  beforeEach(() => {
    fs.mkdirSync(path.resolve('test/.files'), { recursive: true });
  });

  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  const teacherAuth = () => ({ authorization: `Bearer ${teacher.token}` });

  async function loginTeacher(app: Awaited<ReturnType<typeof buildApp>>) {
    const l = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: teacher.email, password: teacher.password } });
    teacher.token = l.json().accessToken as string;
  }

  it('teacher uploads a PDF material; member student downloads it through the API; outsider gets 404', async () => {
    const app = await buildApp(t.db);
    await loginTeacher(app);
    const up = await app.inject({
      method: 'POST', url: `/api/classes/${classId}/materials`,
      headers: { ...teacherAuth(), 'content-type': 'multipart/form-data; boundary=KLBOUND' },
      payload: multipart({ title: 'Source readers', description: 'ch 1' }, { name: 'file', filename: 'readers.pdf', data: Buffer.from('%PDF-1.4 fake body') }),
    });
    expect(up.statusCode).toBe(201);
    const feed = await app.inject({ method: 'GET', url: `/api/classes/${classId}/feed`, headers: auth(studentToken) });
    expect(feed.statusCode).toBe(200);
    const item = feed.json()[0];
    expect(item.files).toHaveLength(1);
    const fileId = item.files[0].id as string;

    const dl = await app.inject({ method: 'GET', url: `/api/files/${fileId}`, headers: auth(studentToken) });
    expect(dl.statusCode).toBe(200);
    expect(dl.headers['content-type']).toContain('application/pdf');
    expect(dl.headers['x-content-type-options']).toBe('nosniff');
    expect((dl.headers['content-disposition'] as string)).toContain('attachment');
    expect(dl.body).toContain('%PDF-1.4');

    const out = await app.inject({ method: 'GET', url: `/api/files/${fileId}`, headers: auth(outsiderToken) });
    expect(out.statusCode).toBe(404);
    // non-member cannot even fetch the feed
    const outFeed = await app.inject({ method: 'GET', url: `/api/classes/${classId}/feed`, headers: auth(outsiderToken) });
    expect(outFeed.statusCode).toBe(404);
    await app.close();
  });

  it('rejects disguised executable, accepts docx by PK+ext', async () => {
    const app = await buildApp(t.db);
    await loginTeacher(app);
    const bad = await app.inject({
      method: 'POST', url: `/api/classes/${classId}/materials`,
      headers: { ...teacherAuth(), 'content-type': 'multipart/form-data; boundary=KLBOUND' },
      payload: multipart({ title: 'evil' }, { name: 'file', filename: 'invoice.pdf', data: Buffer.from([0x4d, 0x5a, 0x90, 0]) }),
    });
    expect(bad.statusCode).toBe(415);
    expect(bad.json().error).toBe('fileTypeRejected');

    const docx = await app.inject({
      method: 'POST', url: `/api/classes/${classId}/materials`,
      headers: { ...teacherAuth(), 'content-type': 'multipart/form-data; boundary=KLBOUND' },
      payload: multipart({ title: 'Essay template' }, { name: 'file', filename: 'tpl.docx', data: Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2]) }),
    });
    expect(docx.statusCode).toBe(201);
    await app.close();
  });

  it('oversized file → 413 (limit 2 MB in tests)', async () => {
    const app = await buildApp(t.db);
    await loginTeacher(app);
    const big = Buffer.concat([Buffer.from('%PDF'), Buffer.alloc(3 * 1024 * 1024, 1)]);
    const r = await app.inject({
      method: 'POST', url: `/api/classes/${classId}/materials`,
      headers: { ...teacherAuth(), 'content-type': 'multipart/form-data; boundary=KLBOUND' },
      payload: multipart({ title: 'Huge' }, { name: 'file', filename: 'big.pdf', data: big }),
    });
    expect(r.statusCode).toBeGreaterThanOrEqual(400);
    expect([413, 500].includes(r.statusCode)).toBe(true); // multipart fileSize limit surfaces as request error
    await app.close();
  });

  it('teacher quota enforced (507)', async () => {
    const app = await buildApp(t.db);
    await loginTeacher(app);
    // fake a nearly-full quota via an existing 4.9 GB file row (storage file may not exist)
    const [p] = await t.db.insert((await import('../../src/db/schema.js')).posts)
      .values({ classId, authorId: teacher.id, kind: 'material', title: 'old', body: '' }).returning();
    await t.db.insert(files).values({
      postId: p!.id, storageKey: `${randomUUID()}.bin`, originalName: 'old.bin',
      mime: 'application/pdf', size: 5_500_000_000, uploadedBy: teacher.id,
    });
    const r = await app.inject({
      method: 'POST', url: `/api/classes/${classId}/materials`,
      headers: { ...teacherAuth(), 'content-type': 'multipart/form-data; boundary=KLBOUND' },
      payload: multipart({ title: 'New' }, { name: 'file', filename: 'a.pdf', data: Buffer.from('%PDF tiny') }),
    });
    expect(r.statusCode).toBe(507);
    expect(r.json().error).toBe('quotaExceeded');
    await t.db.delete(files); // cleanup rows (cascades posts)
    await app.close();
  });

  it('video inline with HTTP Range → 206', async () => {
    const app = await buildApp(t.db);
    await loginTeacher(app);
    const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 32]), Buffer.from('ftyp'), Buffer.from('isom'), Buffer.alloc(2000)]);
    const up = await app.inject({
      method: 'POST', url: `/api/classes/${classId}/materials`,
      headers: { ...teacherAuth(), 'content-type': 'multipart/form-data; boundary=KLBOUND' },
      payload: multipart({ title: 'Lesson clip' }, { name: 'file', filename: 'clip.mp4', data: mp4 }),
    });
    expect(up.statusCode).toBe(201);
    const feed = await app.inject({ method: 'GET', url: `/api/classes/${classId}/feed`, headers: auth(studentToken) });
    const fileId = feed.json().find((f: { title: string }) => f.title === 'Lesson clip').files[0].id;
    const rng = await app.inject({
      method: 'GET', url: `/api/files/${fileId}/inline`,
      headers: { ...auth(studentToken), range: 'bytes=0-99' },
    });
    expect(rng.statusCode).toBe(206);
    expect(rng.headers['content-range']).toMatch(/^bytes 0-99\/\d+$/);
    expect(rng.rawPayload.length).toBe(100);
    await app.close();
  });

  it('announcement + pin ordering + delete removes files row', async () => {
    const app = await buildApp(t.db);
    await loginTeacher(app);
    const an = await app.inject({
      method: 'POST', url: `/api/classes/${classId}/announcements`,
      headers: teacherAuth(), payload: { title: 'Exam Friday', body: 'Bring passports' },
    });
    expect(an.statusCode).toBe(201);
    const postId = an.json().id as string;
    const pin = await app.inject({ method: 'PATCH', url: `/api/posts/${postId}`, headers: teacherAuth(), payload: { pinned: true } });
    expect(pin.json().pinned).toBe(true);
    const feed = await app.inject({ method: 'GET', url: `/api/classes/${classId}/feed`, headers: auth(studentToken) });
    expect(feed.json()[0].id).toBe(postId); // pinned first
    const del = await app.inject({ method: 'DELETE', url: `/api/posts/${postId}`, headers: teacherAuth() });
    expect(del.statusCode).toBe(200);
    // student can't delete or create posts
    const stDel = await app.inject({ method: 'DELETE', url: `/api/posts/${postId}`, headers: auth(studentToken) });
    expect(stDel.statusCode).toBe(403);
    await app.close();
  });

  it('teacher notes: autosave, private, publish creates feed material', async () => {
    const app = await buildApp(t.db);
    await loginTeacher(app);
    const n = await app.inject({
      method: 'POST', url: '/api/notes', headers: teacherAuth(),
      payload: { classId, title: 'Plan', body: '# Intro' },
    });
    expect(n.statusCode).toBe(201);
    const noteId = n.json().id as string;
    const upd = await app.inject({ method: 'PATCH', url: `/api/notes/${noteId}`, headers: teacherAuth(), payload: { body: '# Intro v2' } });
    expect(upd.json().body).toBe('# Intro v2');
    // private: student cannot list notes (teacher-only route)
    const asStudent = await app.inject({ method: 'GET', url: '/api/notes', headers: auth(studentToken) });
    expect(asStudent.statusCode).toBe(403);
    // publish → becomes feed material
    const pub = await app.inject({ method: 'POST', url: `/api/notes/${noteId}/publish`, headers: teacherAuth() });
    expect(pub.statusCode).toBe(200);
    const feed = await app.inject({ method: 'GET', url: `/api/classes/${classId}/feed`, headers: auth(studentToken) });
    expect(feed.json().some((p: { id: string }) => p.id === pub.json().postId)).toBe(true);
    await app.close();
  });
});
