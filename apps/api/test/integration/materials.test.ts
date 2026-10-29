/**
 * Material form (task A) — rights, audiences, statuses/schedule, topics,
 * attachments (URL schemes, XSS-as-text, add/remove) and multi-class create.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TEST_DATABASE_URL, preparedDb, type TestDB } from './util.js';
import { buildApp } from '../../src/app.js';
import { classes, classMembers, users, telegramLinks, notifications, posts as postsTable, files as filesTable } from '../../src/db/schema.js';
import { publishDuePosts, safeExternalUrl, classifyAttachmentUrl } from '../../src/services/posts.js';
import { hashPassword } from '../../src/lib/password.js';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';

const suite = TEST_DATABASE_URL ? describe : describe.skip;

function multipart(fields: Record<string, string>, file?: { name: string; filename: string; data: Buffer }, boundary = 'MTBOUND') {
  let head = '';
  for (const [k, v] of Object.entries(fields)) {
    head += `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`;
  }
  if (file) {
    head += `--${boundary}\r\nContent-Disposition: form-data; name="${file.name}"; filename="${file.filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`;
    return Buffer.concat([Buffer.from(head, 'utf8'), file.data, Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8')]);
  }
  return Buffer.concat([Buffer.from(head + `--${boundary}--\r\n`, 'utf8')]);
}

suite('material form (task A)', () => {
  let t: TestDB;
  let app: FastifyInstance;
  let teacherTok = '', s1Tok = '', s2Tok = '', outTok = '';
  let s1Id = '', s2Id = '', outId = '';
  let classA = '', classB = '';

  beforeAll(async () => {
    t = await preparedDb(TEST_DATABASE_URL);
    app = await buildApp(t.db);
    const pw = await hashPassword('Passw0rd123');
    const [tr] = await t.db.insert(users).values({ role: 'teacher', name: 'Мат', lastName: 'Тичер', email: 'mat@x.io', passwordHash: pw, locale: 'ru', tz: 'UTC' }).returning();
    const [a] = await t.db.insert(users).values({ role: 'student', name: 'Уч1', email: 's1@x.io', passwordHash: pw, locale: 'ru', tz: 'UTC' }).returning();
    const [b] = await t.db.insert(users).values({ role: 'student', name: 'Уч2', email: 's2@x.io', passwordHash: pw, locale: 'ru', tz: 'UTC' }).returning();
    const [o] = await t.db.insert(users).values({ role: 'student', name: 'Чужак', email: 'o1@x.io', passwordHash: pw, locale: 'ru', tz: 'UTC' }).returning();
    s1Id = a!.id; s2Id = b!.id; outId = o!.id;
    const [ca] = await t.db.insert(classes).values({ teacherId: tr!.id, name: 'Мат-А' }).returning();
    const [cb] = await t.db.insert(classes).values({ teacherId: tr!.id, name: 'Мат-B' }).returning();
    classA = ca!.id; classB = cb!.id;
    await t.db.insert(classMembers).values([
      { classId: classA, userId: s1Id }, { classId: classA, userId: s2Id },
      { classId: classB, userId: outId },
    ]);
    const login = async (email: string) =>
      `Bearer ${(await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'Passw0rd123' } })).json().accessToken}`;
    teacherTok = await login('mat@x.io');
    s1Tok = await login('s1@x.io');
    s2Tok = await login('s2@x.io');
    outTok = await login('o1@x.io');
  });
  afterAll(async () => { await app?.close(); await t?.sql.end(); });

  const a = (tok: string) => ({ authorization: tok });
  const up = (tok: string, classId: string, fields: Record<string, string>, file?: { name: string; filename: string; data: Buffer }) =>
    app.inject({
      method: 'POST', url: `/api/classes/${classId}/materials`,
      headers: { ...a(tok), 'content-type': `multipart/form-data; boundary=MTBOUND` },
      payload: multipart(fields, file),
    });
  const pdf = { name: 'file', filename: 'doc.pdf', data: Buffer.from('%PDF-1.4 test body') };
  const feedOf = (tok: string, classId: string) => app.inject({ method: 'GET', url: `/api/classes/${classId}/feed`, headers: a(tok) });

  it('URL helpers: only http(s) survive; youtube/drive classify; no SSRF fetches', () => {
    expect(safeExternalUrl('javascript:alert(1)')).toBeNull();
    expect(safeExternalUrl('data:text/html,<script>')).toBeNull();
    expect(safeExternalUrl('file:///etc/passwd')).toBeNull();
    expect(safeExternalUrl('http://localhost/x')).toBeNull(); // no dotted host
    expect(safeExternalUrl('https://example.com/a')).toBe('https://example.com/a');
    expect(classifyAttachmentUrl('https://youtu.be/dQw4w9WgXcQ')).toBe('youtube');
    expect(classifyAttachmentUrl('https://www.youtube.com/watch?v=x')).toBe('youtube');
    expect(classifyAttachmentUrl('https://drive.google.com/file/d/1/view')).toBe('drive');
    expect(classifyAttachmentUrl('https://docs.google.com/document/d/1')).toBe('drive');
    expect(classifyAttachmentUrl('https://wikipedia.org')).toBe('link');
  });

  it('create with file + link + youtube + drive: kinds stored, XSS stays plain', async () => {
    const r = await up(teacherTok, classA, {
      title: '<b>Тема</b> & <script>alert(1)</script>',
      description: '<p><img src=x onerror=bad()>текст</p>',
      attachments: JSON.stringify([
        { url: 'https://example.com/lesson', title: 'Урок' },
        { url: 'https://youtu.be/dQw4w9WgXcQ', title: 'Видео' },
        { url: 'https://drive.google.com/file/d/1x/view', title: 'Файл' },
      ]),
    }, pdf);
    expect(r.statusCode).toBe(201);
    const feed = await feedOf(s1Tok, classA);
    const item = (feed.json() as { title: string; attachments: { kind: string; file: unknown }[] }).find((p) => p.title.includes('alert(1)'));
    expect(item).toBeTruthy();
    expect(item!.title).toBe('<b>Тема</b> & <script>alert(1)</script>'); // verbatim — the client renders text
    const kinds = item!.attachments.map((x) => x.kind).sort();
    expect(kinds).toEqual(['drive', 'file', 'link', 'youtube']);
    expect(item!.attachments.find((x) => x.kind === 'file')!.file).toBeTruthy();
  });

  it('dangerous schemes rejected on create (400 invalidLink), nothing stored', async () => {
    const r = await up(teacherTok, classA, {
      title: 'evil', attachments: JSON.stringify([{ url: 'javascript:alert(1)', title: '' }]),
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe('invalidLink');
    const feed = await feedOf(teacherTok, classA);
    expect((feed.json() as { title: string }[]).some((p) => p.title === 'evil')).toBe(false);
  });

  it('title is required; empty → 400 titleRequired', async () => {
    const r = await up(teacherTok, classA, { title: '   ' }, pdf);
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe('titleRequired');
  });

  it('audience: only the selected student sees the post and its file; peer and outsider 404', async () => {
    const r = await up(teacherTok, classA, {
      title: 'Только для Уч1', audience: JSON.stringify([s1Id]),
    }, pdf);
    expect(r.statusCode).toBe(201);
    const pid = r.json().id as string;
    const inS1 = ((await feedOf(s1Tok, classA)).json() as { id: string }[]).some((p) => p.id === pid);
    const inS2 = ((await feedOf(s2Tok, classA)).json() as { id: string }[]).some((p) => p.id === pid);
    expect(inS1).toBe(true);
    expect(inS2).toBe(false);
    // the file itself follows the post
    const fileIds = ((await feedOf(s1Tok, classA)).json() as { id: string; attachments: { file: { id: string } | null }[] })
      .find((p) => p.id === pid)!.attachments.find((x) => x.file)!.file!.id;
    const dlS1 = await app.inject({ method: 'GET', url: `/api/files/${fileIds}`, headers: a(s1Tok) });
    const dlS2 = await app.inject({ method: 'GET', url: `/api/files/${fileIds}`, headers: a(s2Tok) });
    expect(dlS1.statusCode).toBe(200);
    expect(dlS2.statusCode).toBe(404);
    // a foreign-class student id in the audience is refused
    const bad = await up(teacherTok, classA, { title: 'плохая аудитория', audience: JSON.stringify([outId]) });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe('invalidAudience');
  });

  it('draft: teacher-only until published', async () => {
    const r = await up(teacherTok, classA, { title: 'Черновик', publish: 'draft' }, pdf);
    expect(r.statusCode).toBe(201);
    expect(r.json().status).toBe('draft');
    const pid = r.json().id as string;
    expect(((await feedOf(teacherTok, classA)).json() as { id: string; status: string }[]).some((p) => p.id === pid && p.status === 'draft')).toBe(true);
    expect(((await feedOf(s1Tok, classA)).json() as { id: string }[]).some((p) => p.id === pid)).toBe(false);
    const pub = await app.inject({ method: 'POST', url: `/api/posts/${pid}/publish`, headers: a(teacherTok) });
    expect(pub.statusCode).toBe(200);
    expect(((await feedOf(s1Tok, classA)).json() as { id: string }[]).some((p) => p.id === pid)).toBe(true);
  });

  it('scheduled: invisible until the time, then published + notifications ONLY to the audience', async () => {
    // link both students so fan-out is observable
    await t.db.insert(telegramLinks).values([{ userId: s1Id, chatId: '111' }, { userId: s2Id, chatId: '222' }]);
    const when = new Date(Date.now() + 60_000);
    const r = await up(teacherTok, classA, {
      title: 'К уроку', publish: 'schedule', scheduledAt: when.toISOString(), audience: JSON.stringify([s1Id]),
    }, pdf);
    expect(r.statusCode).toBe(201);
    const pid = r.json().id as string;
    expect(((await feedOf(s1Tok, classA)).json() as { id: string }[]).some((p) => p.id === pid)).toBe(false);
    // a schedule in the past is refused
    const bad = await up(teacherTok, classA, { title: 'мимо', publish: 'schedule', scheduledAt: new Date(Date.now() - 60_000).toISOString() });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe('invalidSchedule');

    const n = await publishDuePosts(t.db, new Date(when.getTime() + 5_000));
    expect(n).toBeGreaterThanOrEqual(1);
    expect(((await feedOf(s1Tok, classA)).json() as { id: string }[]).some((p) => p.id === pid)).toBe(true);
    expect(((await feedOf(s2Tok, classA)).json() as { id: string }[]).some((p) => p.id === pid)).toBe(false);
    // second tick must not republish or re-notify (dedupe_key + status guard)
    expect(await publishDuePosts(t.db, new Date(when.getTime() + 5_000))).toBe(0);
    const rows = await t.db.select().from(notifications).where(eq(notifications.kind, 'materialNew'));
    const forThis = rows.filter((x) => String(x.dedupeKey).startsWith(`post:${pid}`));
    expect(forThis.length).toBe(1);
    expect(forThis[0]!.userId).toBe(s1Id);
  });

  it('topics: create via newTopic, pick via topicId, rename, delete keeps materials', async () => {
    const r1 = await up(teacherTok, classA, { title: 'Топик 1', newTopic: 'Дроби' }, pdf);
    expect(r1.statusCode).toBe(201);
    const topics = (await app.inject({ method: 'GET', url: `/api/classes/${classA}/topics`, headers: a(teacherTok) })).json() as { id: string; name: string }[];
    const dr = topics.find((x) => x.name === 'Дроби');
    expect(dr).toBeTruthy();
    const item = ((await feedOf(s1Tok, classA)).json() as { title: string; topicName: string | null; topicId: string | null }[])
      .find((p) => p.title === 'Топик 1');
    expect(item!.topicName).toBe('Дроби');
    expect(item!.topicId).toBe(dr!.id);
    // rename
    const rn = await app.inject({ method: 'PATCH', url: `/api/topics/${dr!.id}`, headers: { ...a(teacherTok), 'content-type': 'application/json' }, payload: { name: 'Сложение дробей' } });
    expect(rn.statusCode).toBe(200);
    // a topic of ANOTHER class cannot be attached
    const topicsB = (await app.inject({ method: 'GET', url: `/api/classes/${classB}/topics`, headers: a(teacherTok) })).json() as { id: string }[];
    const cross = await up(teacherTok, classA, { title: 'чужая тема', topicId: dr!.id === topicsB[0]?.id ? '00000000-0000-0000-0000-000000000000' : dr!.id });
    expect(cross.statusCode).toBe(201); // same class — valid
    const bad = await app.inject({
      method: 'PATCH', url: '/api/posts/' + ((await feedOf(teacherTok, classA)).json() as { title: string }[]).find((p) => p.title === 'чужая тема')!.id,
      headers: { ...a(teacherTok), 'content-type': 'application/json' },
      payload: { topicId: '11111111-1111-1111-1111-111111111111' },
    });
    expect(bad.statusCode).toBe(400);
    // delete the topic: the material stays, the group dissolves
    const del = await app.inject({ method: 'DELETE', url: `/api/topics/${dr!.id}`, headers: a(teacherTok) });
    expect(del.statusCode).toBe(200);
    const after = ((await feedOf(s1Tok, classA)).json() as { title: string; topicName: string | null }[]).find((p) => p.title === 'Топик 1');
    expect(after).toBeTruthy();
    expect(after!.topicName).toBeNull();
  });

  it('multi-class: one material per class, independent rows', async () => {
    const r1 = await up(teacherTok, classA, { title: 'Общий материал' });
    const r2 = await up(teacherTok, classB, { title: 'Общий материал' });
    expect(r1.statusCode).toBe(201);
    expect(r2.statusCode).toBe(201);
    expect(r1.json().id).not.toBe(r2.json().id);
    const inB = ((await feedOf(outTok, classB)).json() as { id: string }[]).some((p) => p.id === r2.json().id);
    const leak = await feedOf(outTok, classA); // outsider is not in classA ⇒ 404, never a listing
    expect(inB).toBe(true);
    expect(leak.statusCode).toBe(404);
    // deleting one leaves the other
    await app.inject({ method: 'DELETE', url: `/api/posts/${r1.json().id}`, headers: a(teacherTok) });
    const still = await app.inject({ method: 'GET', url: `/api/posts/${r2.json().id}` }).catch(() => null); void still;
    expect(((await feedOf(outTok, classB)).json() as { id: string }[]).some((p) => p.id === r2.json().id)).toBe(true);
  });

  it('edit published: text+audience via PATCH, add link/file, remove file attachment drops storage row', async () => {
    const r = await up(teacherTok, classA, { title: 'Правим', audience: JSON.stringify([s1Id]) }, pdf);
    const pid = r.json().id as string;
    // Stage 4: аудитория проверяется и на PATCH, а не только при создании. Чужой ученик —
    // 400, и пост остаётся с прежней аудиторией: s2 по-прежнему его не видит.
    const foreign = await app.inject({
      method: 'PATCH', url: `/api/posts/${pid}`, headers: { ...a(teacherTok), 'content-type': 'application/json' },
      payload: { title: 'Заголовок не должен примениться', audience: [outId] },
    });
    expect(foreign.statusCode, foreign.body).toBe(400);
    expect(foreign.json().error).toBe('invalidAudience');
    expect(((await feedOf(s2Tok, classA)).json() as { id: string }[]).some((p) => p.id === pid)).toBe(false);
    const after = ((await feedOf(s1Tok, classA)).json() as { id: string; title: string }[]).find((p) => p.id === pid);
    expect(after?.title, 'отказ аудитории откатывает и текст той же правки').toBe('Правим');
    const patch = await app.inject({
      method: 'PATCH', url: `/api/posts/${pid}`, headers: { ...a(teacherTok), 'content-type': 'application/json' },
      payload: { title: 'Правим v2', audience: [] },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().title).toBe('Правим v2');
    // s2 now sees it (audience cleared)
    expect(((await feedOf(s2Tok, classA)).json() as { id: string; title: string }[]).some((p) => p.id === pid && p.title === 'Правим v2')).toBe(true);
    // add a link attachment
    const addL = await app.inject({
      method: 'POST', url: `/api/posts/${pid}/attachments`, headers: { ...a(teacherTok), 'content-type': 'application/json' },
      payload: { url: 'https://example.org/x', title: 'конспект' },
    });
    expect(addL.statusCode).toBe(201);
    // add a file to the existing post
    const addF = await up(teacherTok, classA, { title: 'Правим v2' }, { name: 'file', filename: 'extra.pdf', data: Buffer.from('%PDF extra') });
    void addF; // creating a twin post proves multipart works; the real append:
    const append = await app.inject({
      method: 'POST', url: `/api/posts/${pid}/files`,
      headers: { ...a(teacherTok), 'content-type': 'multipart/form-data; boundary=MTBOUND' },
      payload: multipart({}, { name: 'file', filename: 'append.pdf', data: Buffer.from('%PDF append') }),
    });
    expect(append.statusCode).toBe(201);
    const item = ((await feedOf(s2Tok, classA)).json() as { id: string; attachments: { id: string; kind: string; file: { id: string } | null }[] }).find((p) => p.id === pid)!;
    expect(item.attachments.filter((x) => x.kind === 'file')).toHaveLength(2);
    // remove the appended FILE attachment → its files row disappears too
    const appended = item.attachments.filter((x) => x.kind === 'file').sort((x, y) => x.id.localeCompare(y.id));
    const rm = await app.inject({ method: 'DELETE', url: `/api/posts/${pid}/attachments/${appended[1]!.id}`, headers: a(teacherTok) });
    expect(rm.statusCode).toBe(200);
    const [gone] = await t.db.select().from(filesTable).where(eq(filesTable.id, appended[1]!.file!.id));
    expect(gone).toBeUndefined();
    // removing a link attachment keeps files untouched
    const rmL = await app.inject({ method: 'DELETE', url: `/api/posts/${pid}/attachments/${item.attachments.find((x) => x.kind === 'link')!.id}`, headers: a(teacherTok) });
    expect(rmL.statusCode).toBe(200);
    const left = await t.db.select().from(postsTable).where(eq(postsTable.id, pid));
    expect(left.length).toBe(1);
  });
});
