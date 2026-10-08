import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TEST_DATABASE_URL, preparedDb, makeTeacher, type TestDB } from './util.js';
import { buildApp } from '../../src/app.js';
import { classes, inviteCodes } from '../../src/db/schema.js';
import { hashInviteCode } from '../../src/lib/invite.js';
import { mergeElements, type ExEl } from '../../src/services/board.js';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';

const suite = TEST_DATABASE_URL ? describe : describe.skip;

suite('board merge rules (unit)', () => {
  it('higher version wins, ties by nonce, deletes remove', () => {
    const target: Record<string, ExEl> = {};
    mergeElements(target, [{ id: 'a', version: 1, versionNonce: 10, x: 0 }]);
    mergeElements(target, [{ id: 'a', version: 1, versionNonce: 20, x: 1 }]); // same version, higher nonce
    expect((target.a as ExEl).x).toBe(1);
    mergeElements(target, [{ id: 'a', version: 0, versionNonce: 99, x: 2 }]); // older ignored
    expect((target.a as ExEl).x).toBe(1);
    mergeElements(target, [{ id: 'a', version: 2, versionNonce: 1, isDeleted: true }]);
    expect(target.a).toBeUndefined();
  });
});

suite('stage 5: board WS rights + late joiner + student sheets', () => {
  let t: TestDB;
  let classId = '';
  let teacher: { id: string; email: string; password: string; token: string };
  let studentToken = '';
  let app: FastifyInstance;
  let port = 0;
  let sessionId = '';

  const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
  const genCode = () => Array.from({ length: 8 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join('');

  /** The boards of a session as the database sees them (page_no, title, live elements). */
  async function dbBoardRows(sessionId: string) {
    const { whiteboards: wb } = await import('../../src/db/schema.js');
    const rows = await t.db.select({ pageNo: wb.pageNo, title: wb.title, snapshot: wb.snapshot })
      .from(wb).where(eq(wb.sessionId, sessionId)).orderBy(wb.pageNo);
    return rows.map((r) => ({
      pageNo: r.pageNo, title: r.title,
      elements: ((r.snapshot.elements ?? []) as { id: string; isDeleted?: boolean }[]).filter((e) => !e.isDeleted),
    }));
  }

  beforeAll(async () => {
    t = await preparedDb(TEST_DATABASE_URL);
    teacher = await makeTeacher(t.sql, `brd${Date.now()}@x.io`) as typeof teacher;
    const [cls] = await t.db.insert(classes).values({ teacherId: teacher.id, name: 'Board class' }).returning();
    classId = cls!.id;
    app = await buildApp(t.db);
    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address();
    port = typeof addr === 'object' && addr ? addr.port : 0;
    const l = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: teacher.email, password: teacher.password } });
    teacher.token = l.json().accessToken as string;
    const code = genCode();
    await t.db.insert(inviteCodes).values({ classId, codeHash: hashInviteCode(code, process.env.JWT_SECRET!), createdBy: teacher.id, expiresAt: new Date(Date.now() + 86400000) });
    const r = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { firstName: 'Pupil', lastName: 'Test', email: `brd${Date.now()}@x.io`, password: 'Secret1234', code } });
    studentToken = r.json().accessToken as string;
    const st = await app.inject({ method: 'POST', url: '/api/lessons/start', headers: { authorization: `Bearer ${teacher.token}` }, payload: { classId } });
    sessionId = st.json().id as string;
  });
  afterAll(async () => { await app?.close(); await t?.sql.end(); });

  async function wsConnect(token: string): Promise<{ ws: WebSocket; next: (ms?: number) => Promise<unknown> }> {    const tr = await app.inject({ method: 'POST', url: '/api/ws/ticket', headers: { authorization: `Bearer ${token}` }, payload: { sessionId } });
    const ticket = (tr.json() as { ticket?: string }).ticket ?? 'invalid';
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws/board/${sessionId}?ticket=${encodeURIComponent(ticket)}`);
      const queue: unknown[] = [];
      let wake: ((v: unknown) => void) | null = null;
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data as string);
        if (wake) { const w = wake; wake = null; w(msg); }
        else queue.push(msg);
      };
      const next = (ms = 1500) => new Promise<unknown>((res, rej) => {
        if (queue.length) return res(queue.shift());
        const timer = setTimeout(() => rej(new Error('ws timeout')), ms);
        wake = (v) => { clearTimeout(timer); res(v); };
      });
      ws.onopen = () => resolve({ ws, next });
      ws.onerror = (e) => reject(e);
    });
  }

  it('teacher edit broadcasts to student; student writes are IGNORED server-side', async () => {
    const student = await wsConnect(studentToken);
    const init1 = await student.next() as { type: string; canEdit: boolean };
    expect(init1).toMatchObject({ type: 'init', canEdit: false });

    const teacherC = await wsConnect(teacher.token);
    const init2 = await teacherC.next() as { type: string; canEdit: boolean };
    expect(init2).toMatchObject({ type: 'init', canEdit: true });

    teacherC.ws.send(JSON.stringify({ type: 'edits', page: 1, elements: [{ id: 'r1', version: 1, versionNonce: 5, type: 'rectangle', x: 10 }] }));
    const got = await student.next() as { type: string; elements: { id: string }[] };
    expect(got.type).toBe('edits');
    expect(got.elements[0]!.id).toBe('r1');

    // student tries to write → no broadcast back to teacher, no echo
    student.ws.send(JSON.stringify({ type: 'edits', page: 1, elements: [{ id: 'hack', version: 9, versionNonce: 9 }] }));
    await expect(teacherC.next(400)).rejects.toThrow('timeout');

    student.ws.close(); teacherC.ws.close();
  });

  it('late joiner gets full current snapshot immediately', async () => {
    const late = await wsConnect(studentToken);
    const init = await late.next() as { elements: { id: string }[] };
    expect(init.elements.some((e) => e.id === 'r1')).toBe(true);
    late.ws.close();
  });

  it('pages: new/switch/del sync to student', async () => {
    const stud = await wsConnect(studentToken);
    await stud.next();
    const teach = await wsConnect(teacher.token);
    await teach.next();
    teach.ws.send(JSON.stringify({ type: 'newpage' }));
    const pagesMsg = await stud.next() as { type: string; pages: number[]; current: number };
    expect(pagesMsg).toMatchObject({ type: 'pages', current: 2 });
    teach.ws.send(JSON.stringify({ type: 'edits', page: 2, elements: [{ id: 'p2el', version: 1, versionNonce: 1 }] }));
    await stud.next();
    teach.ws.send(JSON.stringify({ type: 'switch', page: 1 }));
    const cur = await stud.next() as { type: string; page: number; elements: { id: string }[] };
    expect(cur).toMatchObject({ type: 'current', page: 1 });
    expect(cur.elements.some((e) => e.id === 'r1')).toBe(true);
    stud.ws.close(); teach.ws.close();
    await new Promise((r) => setTimeout(r, 100));
  });

  it('snapshot persists to DB; GET board REST returns it for members only', async () => {
    await new Promise((r) => setTimeout(r, 300));
    const g = await app.inject({ method: 'GET', url: `/api/lessons/${sessionId}/board`, headers: { authorization: `Bearer ${studentToken}` } });
    expect(g.statusCode).toBe(200);
    const pages = g.json().pages as { pageNo: number; elements: { id: string }[] }[];
    const p1 = pages.find((p) => p.pageNo === 1);
    expect(p1?.elements.some((e) => e.id === 'r1')).toBe(true);
    const { whiteboards: wbTable } = await import('../../src/db/schema.js');
    const [wb] = await t.db.select().from(wbTable).where(eq(wbTable.pageNo, 1)).limit(1);
    expect(JSON.stringify(wb?.snapshot)).toContain('r1');
    const out = await app.inject({ method: 'GET', url: `/api/lessons/${sessionId}/board`, headers: { authorization: 'Bearer junk' } });
    expect(out.statusCode).toBe(401);
  });

  it('student sheets: private CRUD; teacher cannot see them; foreign student 404', async () => {
    const n = await app.inject({
      method: 'POST', url: '/api/student-notes', headers: { authorization: `Bearer ${studentToken}` },
      payload: { classId, sessionId, title: 'L1', body: 'notes text' },
    });
    expect(n.statusCode).toBe(201);
    const noteId = n.json().id as string;
    const upd = await app.inject({ method: 'PATCH', url: `/api/student-notes/${noteId}`, headers: { authorization: `Bearer ${studentToken}` }, payload: { body: 'v2' } });
    expect(upd.json().body).toBe('v2');
    const list = await app.inject({ method: 'GET', url: '/api/student-notes', headers: { authorization: `Bearer ${studentToken}` } });
    expect((list.json() as unknown[]).length).toBe(1);
    // teacher sees nothing (route returns [] for teacher)
    const asTeach = await app.inject({ method: 'GET', url: '/api/student-notes', headers: { authorization: `Bearer ${teacher.token}` } });
    expect(asTeach.json()).toEqual([]);
    // teacher cannot patch student's note (404: not theirs)
    const theft = await app.inject({ method: 'PATCH', url: `/api/student-notes/${noteId}`, headers: { authorization: `Bearer ${teacher.token}` }, payload: { body: 'x' } });
    expect(theft.statusCode).toBe(404);
    // foreign student cannot read it
    const oc = genCode();
    const [otherClass] = await t.db.insert(classes).values({ teacherId: teacher.id, name: 'OC' }).returning();
    await t.db.insert(inviteCodes).values({ classId: otherClass!.id, codeHash: hashInviteCode(oc, process.env.JWT_SECRET!), createdBy: teacher.id, expiresAt: new Date(Date.now() + 86400000) });
    const reg = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { firstName: 'Other P', lastName: 'Test', email: `op${Date.now()}@x.io`, password: 'Secret1234', code: oc } });
    const oth = await app.inject({ method: 'GET', url: '/api/student-notes', headers: { authorization: `Bearer ${reg.json().accessToken}` } });
    expect(oth.json()).toEqual([]);
  });

  it('board publish PNG creates feed material; svg allowed as download-only', async () => {
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const dataUrl = 'data:image/png;base64,' + pngBytes.toString('base64');
    const pub = await app.inject({
      method: 'POST', url: `/api/lessons/${sessionId}/board/publish`, headers: { authorization: `Bearer ${teacher.token}` },
      payload: { dataUrl, kind: 'png', title: 'Board 1' },
    });
    expect(pub.statusCode).toBe(201);
    const feed = await app.inject({ method: 'GET', url: `/api/classes/${classId}/feed`, headers: { authorization: `Bearer ${studentToken}` } });
    expect((feed.json() as { title: string }[]).some((p) => p.title === 'Board 1')).toBe(true);
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>');
    const pub2 = await app.inject({
      method: 'POST', url: `/api/lessons/${sessionId}/board/publish`, headers: { authorization: `Bearer ${teacher.token}` },
      payload: { dataUrl: 'data:image/svg+xml;base64,' + svg.toString('base64'), kind: 'svg', title: 'Board svg' },
    });
    expect(pub2.statusCode).toBe(201);
    const f2 = await app.inject({ method: 'GET', url: `/api/classes/${classId}/feed`, headers: { authorization: `Bearer ${studentToken}` } });
    const item = (f2.json() as { title: string; attachments: { kind: string; file: { id: string } | null }[] }).find((x) => x.title === 'Board svg');
    const fileId = item!.attachments[0]!.file!.id;
    const inline = await app.inject({ method: 'GET', url: `/api/files/${fileId}/inline`, headers: { authorization: `Bearer ${studentToken}` } });
    expect(inline.statusCode).toBe(400); // SVG never inline (XSS)
  });

  // ── board pages, task 1 (names / duplicate / delete / limit) ──────────────────
  // Added for the board-pages task; nothing above it was changed. The verbs travel over the
  // same board WS, behind the teacher gate that already refuses non-teachers.

  it('rename: the teacher label is stored sanitized and reaches every socket', async () => {
    const teach = await wsConnect(teacher.token);
    await teach.next();
    const stud = await wsConnect(studentToken);
    await stud.next();

    teach.ws.send(JSON.stringify({ type: 'rename', page: 1, title: '  Алгебра\n\t— 7 «Б»   ' }));
    const titles = await stud.next() as { type: string; titles: Record<string, string> };
    expect(titles).toMatchObject({ type: 'titles', titles: { 1: 'Алгебра — 7 «Б»' } });
    // whitespace flattened, line breaks gone, the text kept as text
    expect(titles.titles['1']).not.toContain('\n');

    teach.ws.send(JSON.stringify({ type: 'rename', page: 1, title: 'x'.repeat(80) }));
    const capped = await stud.next() as { titles: Record<string, string> };
    expect(capped.titles['1']).toHaveLength(40);

    const g = await app.inject({ method: 'GET', url: `/api/lessons/${sessionId}/board`, headers: { authorization: `Bearer ${studentToken}` } });
    const pages = g.json().pages as { pageNo: number; title: string }[];
    expect(pages.find((p) => p.pageNo === 1)?.title).toBe('x'.repeat(40));
    teach.ws.close(); stud.ws.close();
    await new Promise((r) => setTimeout(r, 120));
  });

  it('sanitizeBoardTitle: plain text only, 40 characters, empty is allowed', async () => {
    const { sanitizeBoardTitle, MAX_BOARD_TITLE } = await import('../../src/routes/board.js');
    expect(sanitizeBoardTitle('  a\nb  c ')).toBe('a b c');
    expect(sanitizeBoardTitle('<img src=x onerror=1>')).toBe('<img src=x onerror=1>'); // kept as TEXT
    expect(sanitizeBoardTitle('Привет, oʻzbek gʻoya')).toBe('Привет, oʻzbek gʻoya');
    expect(sanitizeBoardTitle(''.padEnd(200, 'ы'))).toHaveLength(MAX_BOARD_TITLE);
    expect(sanitizeBoardTitle('\n\t  ')).toBe('');
    expect(sanitizeBoardTitle(undefined)).toBe('');
    expect(sanitizeBoardTitle(42)).toBe('');
  });

  it('duplicate copies the scene into a new board and switches to it', async () => {
    const teach = await wsConnect(teacher.token);
    await teach.next();
    teach.ws.send(JSON.stringify({ type: 'rename', page: 1, title: 'Оригинал' }));
    await teach.next();
    teach.ws.send(JSON.stringify({ type: 'duplicate', page: 1 }));
    const pages = await teach.next() as { type: string; pages: number[]; current: number; titles: Record<string, string> };
    expect(pages.type).toBe('pages');
    const newest = Math.max(...pages.pages);
    expect(pages.current).toBe(newest);
    expect(pages.titles[String(newest)]).toBe('Оригинал');

    const g = await app.inject({ method: 'GET', url: `/api/lessons/${sessionId}/board`, headers: { authorization: `Bearer ${teacher.token}` } });
    const rows = g.json().pages as { pageNo: number; elements: { id: string }[] }[];
    const src = rows.find((r) => r.pageNo === 1)!;
    const copy = rows.find((r) => r.pageNo === newest)!;
    expect(src.elements.length, 'the source board has content to copy').toBeGreaterThan(0);
    expect(copy.elements.map((e) => e.id).sort()).toEqual(src.elements.map((e) => e.id).sort());
    teach.ws.close();
    await new Promise((r) => setTimeout(r, 120));
  });

  it('delete: a board goes away for everyone, and the row is removed', async () => {
    const teach = await wsConnect(teacher.token);
    await teach.next();
    // make sure there is something to delete besides the last board
    if ((await dbBoardRows(sessionId)).length < 2) {
      teach.ws.send(JSON.stringify({ type: 'newpage' }));
      await teach.next();
    }
    const before = await dbBoardRows(sessionId);
    const target = Math.max(...before.map((r) => r.pageNo));
    teach.ws.send(JSON.stringify({ type: 'delpage', page: target }));
    const after = await teach.next() as { type: string; pages: number[] };
    expect(after.type).toBe('pages');
    expect(after.pages).not.toContain(target);
    teach.ws.close();
    await new Promise((r) => setTimeout(r, 200));
    const left = await dbBoardRows(sessionId);
    expect(left.length).toBe(before.length - 1);
    expect(left.some((r) => r.pageNo === target), 'the row is gone from the database too').toBe(false);
  });

  it('the last board survives: delpage answers boardLastPage instead', async () => {
    // bring the session down to one board
    let rows = await dbBoardRows(sessionId);
    while (rows.length > 1) {
      const teach = await wsConnect(teacher.token);
      await teach.next();
      teach.ws.send(JSON.stringify({ type: 'delpage', page: Math.max(...rows.map((r) => r.pageNo)) }));
      await teach.next();
      teach.ws.close();
      await new Promise((r) => setTimeout(r, 120));
      rows = await dbBoardRows(sessionId);
    }
    expect(rows.length).toBe(1);

    const teach = await wsConnect(teacher.token);
    await teach.next();
    teach.ws.send(JSON.stringify({ type: 'delpage', page: rows[0]!.pageNo }));
    const notice = await teach.next() as { type: string; code: string };
    expect(notice).toMatchObject({ type: 'notice', code: 'boardLastPage' });
    expect((await dbBoardRows(sessionId)).length, 'the last board is still there').toBe(1);
    teach.ws.close();
  });

  it('the 21st board is refused with boardLimit, and the count never exceeds the cap', async () => {
    const teach = await wsConnect(teacher.token);
    await teach.next();
    const notices: Record<string, unknown>[] = [];
    teach.ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data as string) as Record<string, unknown>;
      if (msg.type === 'notice') notices.push(msg);
    };
    for (let i = 0; i < 25; i++) teach.ws.send(JSON.stringify({ type: 'newpage' }));
    await new Promise((r) => setTimeout(r, 1_500));
    const { MAX_BOARD_PAGES } = await import('../../src/routes/board.js');
    const rows = await dbBoardRows(sessionId);
    expect(rows.length, 'the server keeps at most MAX_BOARD_PAGES rows').toBeLessThanOrEqual(MAX_BOARD_PAGES);
    expect(notices.some((n) => n.code === 'boardLimit'), 'the teacher is told the board limit was reached').toBe(true);
    expect(notices.find((n) => n.code === 'boardLimit')?.max).toBe(MAX_BOARD_PAGES);
    teach.ws.close();
    await new Promise((r) => setTimeout(r, 200));
  });

  it('a student cannot create, rename, duplicate, delete or switch boards', async () => {
    const teach = await wsConnect(teacher.token);
    await teach.next();
    const stud = await wsConnect(studentToken);
    const init = await stud.next() as { pages: number[] };
    const before = init.pages.slice();

    for (const msg of [
      { type: 'newpage' },
      { type: 'rename', page: before[0] ?? 1, title: 'взлом' },
      { type: 'duplicate', page: before[0] ?? 1 },
      { type: 'delpage', page: before[0] ?? 1 },
      { type: 'switch', page: before[0] ?? 1 },
    ]) stud.ws.send(JSON.stringify(msg));
    await new Promise((r) => setTimeout(r, 900));

    // the teacher receives nothing: the server dropped every one of those verbs
    await expect(teach.next(400)).rejects.toThrow('timeout');
    const after = await dbBoardRows(sessionId);
    expect(after.map((r) => r.pageNo)).toEqual(before.slice().sort((a, b) => a - b));
    expect(after.every((r) => r.title !== 'взлом'), 'a student cannot rename a board').toBe(true);
    stud.ws.close(); teach.ws.close();
    await new Promise((r) => setTimeout(r, 150));
  });

  it('a teacher of another class gets 404 on the board REST paths', async () => {
    const other = await makeTeacher(t.sql, `othbrd${Date.now()}@x.io`) as { id: string; email: string; password: string };
    const l = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: other.email, password: other.password } });
    const otherToken = l.json().accessToken as string;
    const g = await app.inject({ method: 'GET', url: `/api/lessons/${sessionId}/board`, headers: { authorization: `Bearer ${otherToken}` } });
    expect(g.statusCode).toBe(404);
    const p = await app.inject({
      method: 'PUT', url: `/api/lessons/${sessionId}/board/page`, headers: { authorization: `Bearer ${otherToken}` },
      payload: { pageNo: 1, title: 'не моя', elements: [] },
    });
    expect(p.statusCode).toBe(404);
    const pub = await app.inject({
      method: 'POST', url: `/api/lessons/${sessionId}/board/publish`, headers: { authorization: `Bearer ${otherToken}` },
      payload: { dataUrl: 'data:image/png;base64,AAAA', kind: 'png', title: 'не моя доска' },
    });
    expect(pub.statusCode).toBe(404);
    const rows = await dbBoardRows(sessionId);
    expect(rows.every((r) => r.title !== 'не моя'), 'and nothing was written').toBe(true);
  });
});
