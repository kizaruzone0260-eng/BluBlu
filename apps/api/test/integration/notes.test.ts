/**
 * D — teacher notes: class-less notes, lesson (event) binding, pinning,
 * publish guard, ownership. Uses its own fixtures (no demo seed anywhere).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { preparedDb, makeTeacher, type TestDB } from './util.js';
import { buildApp } from '../../src/app.js';
import { classes, events } from '../../src/db/schema.js';
import type { FastifyInstance } from 'fastify';

const suite = process.env.DATABASE_URL_TEST ? describe : describe.skip;

suite('notes (D): optional class, lesson link, pin, publish', () => {
  let t: TestDB;
  let app: FastifyInstance;
  let tok = '';
  let classId = '';
  let otherClassId = '';
  let eventId = '';

  beforeAll(async () => {
    t = await preparedDb(process.env.DATABASE_URL_TEST!);
    app = await buildApp(t.db);
    const teacher = await makeTeacher(t.sql, `notes${Date.now()}@x.io`);
    const l = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: teacher.email, password: teacher.password } });
    tok = `Bearer ${l.json().accessToken}`;
    const a = l.json().user.id as string;
    const [c] = await t.db.insert(classes).values({ teacherId: a, name: 'Notes class' }).returning();
    classId = c!.id;
    const teacher2 = await makeTeacher(t.sql, `notes2${Date.now()}@x.io`);
    const [c2] = await t.db.insert(classes).values({ teacherId: teacher2.id, name: 'Foreign' }).returning();
    otherClassId = c2!.id;
    const [e] = await t.db.insert(events).values({
      classId, kind: 'lesson', title: 'Урок', startsAt: new Date(), endsAt: new Date(Date.now() + 36e5),
    }).returning();
    eventId = e!.id;
  });
  afterAll(async () => { await app?.close(); await t?.sql.end(); });

  const a = () => ({ authorization: tok });
  const post = (payload: unknown) => app.inject({ method: 'POST', url: '/api/notes', headers: a(), payload: payload as object });

  it('rejects a note that is empty in BOTH title and body (§2)', async () => {
    const r1 = await post({ title: '', body: '', classId: null });
    expect(r1.statusCode).toBe(400);
    expect(r1.json().error).toBe('noteEmpty');
    // whitespace-only title + tag-only body is still empty
    const r2 = await post({ title: '   ', body: '<p>  </p><p>&nbsp;</p>' });
    expect(r2.statusCode).toBe(400);
    expect(r2.json().error).toBe('noteEmpty');
    // a drawing payload counts as content
    const r3 = await post({
      title: '', classId: null,
      body: `<p></p><div class="note-drawing" data-note-drawing="${encodeURIComponent(JSON.stringify({ strokes: [{ c: '#000', w: 3, pts: [[1, 2], [3, 4]] }] }))}"></div>`,
    });
    expect(r3.statusCode).toBe(201);
    await app.inject({ method: 'DELETE', url: `/api/notes/${r3.json().id}`, headers: a() });
  });

  it('PATCH cannot empty an existing note (§2)', async () => {
    const n = (await post({ title: 'есть текст', body: '<p>раз</p>' })).json();
    const r = await app.inject({ method: 'PATCH', url: `/api/notes/${n.id}`, headers: a(), payload: { title: '', body: '<p> </p>' } });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe('noteEmpty');
    // pin-only patch of the same note stays legal
    const p = await app.inject({ method: 'PATCH', url: `/api/notes/${n.id}`, headers: a(), payload: { pinned: true } });
    expect(p.statusCode).toBe(200);
    await app.inject({ method: 'DELETE', url: `/api/notes/${n.id}`, headers: a() });
  });

  it('title-only and text-only notes are both valid (§2)', async () => {
    const t1 = await post({ title: 'только заголовок', body: '' });
    const t2 = await post({ title: '', body: '<p>только текст</p>' });
    expect([t1.statusCode, t2.statusCode]).toEqual([201, 201]);
    for (const r of [t1, t2]) await app.inject({ method: 'DELETE', url: `/api/notes/${r.json().id}`, headers: a() });
  });

  it('creates a note without any class (за заметкой вне урока)', async () => {
    const r = await post({ title: 'Идея', body: '<p>просто</p>' });
    expect(r.statusCode).toBe(201);
    const n = r.json();
    expect(n.classId).toBeNull();
    const get = await app.inject({ method: 'GET', url: '/api/notes', headers: a() });
    expect(get.json().some((x: { id: string }) => x.id === n.id)).toBe(true);
  });

  it('binds a note to own lesson; rejects foreign/mismatched events', async () => {
    const ok = await post({ title: 'К уроку', body: '', classId, eventId });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().eventId).toBe(eventId);
    const bad = await post({ title: 'x', body: '', eventId: '11111111-1111-1111-1111-111111111111' });
    expect(bad.statusCode).toBe(400);
    const mismatch = await post({ title: 'x', body: '', classId: otherClassId, eventId });
    expect(mismatch.statusCode).toBe(404); // foreign class resolved → 404 (§7)
  });

  it('event-only note inherits its class', async () => {
    const r = await post({ title: 'только событие', body: '', eventId });
    expect(r.statusCode).toBe(201);
    expect(r.json().classId).toBe(classId);
  });

  it('pins/unpins; pinned sort first', async () => {
    const n1 = (await post({ title: 'обычная', body: '', classId })).json();
    const n2 = (await post({ title: 'важная', body: '', classId })).json();
    const p = await app.inject({ method: 'PATCH', url: `/api/notes/${n2.id}`, headers: a(), payload: { pinned: true } });
    expect(p.statusCode).toBe(200);
    expect(p.json().pinned).toBe(true);
    const list = await app.inject({ method: 'GET', url: '/api/notes', headers: a() });
    const rows = list.json() as { id: string; pinned: boolean }[];
    const firstPinned = rows.findIndex((x) => x.pinned);
    const lastUnpinned = rows.map((x) => x.pinned).lastIndexOf(false);
    expect(firstPinned).toBeLessThan(lastUnpinned + 1);
    expect(rows.some((x) => x.id === n1.id)).toBe(true);
  });

  it('publish requires a class; then works', async () => {
    const noClass = (await post({ title: 'вне класса', body: '<p>текст</p>' })).json();
    const r0 = await app.inject({ method: 'POST', url: `/api/notes/${noClass.id}/publish`, headers: a() });
    expect(r0.statusCode).toBe(400);
    const withClass = (await post({ title: 'к публикации', body: '<p>да</p>', classId })).json();
    const r1 = await app.inject({ method: 'POST', url: `/api/notes/${withClass.id}/publish`, headers: a() });
    expect(r1.statusCode).toBe(200);
    expect(r1.json().postId).toBeTruthy();
  });

  it('classId=null unlinks a note; deleting removes it', async () => {
    const n = (await post({ title: 'temp', body: '', classId })).json();
    const u = await app.inject({ method: 'PATCH', url: `/api/notes/${n.id}`, headers: a(), payload: { classId: null } });
    expect(u.json().classId).toBeNull();
    const d = await app.inject({ method: 'DELETE', url: `/api/notes/${n.id}`, headers: a() });
    expect(d.statusCode).toBe(200);
    const list = await app.inject({ method: 'GET', url: '/api/notes', headers: a() });
    expect((list.json() as { id: string }[]).some((x) => x.id === n.id)).toBe(false);
  });
});
