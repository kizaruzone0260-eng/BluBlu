/**
 * Часть 3 (2026-10-14): «ученик рисует на доске, если учитель разрешил».
 *
 * Проверяется живыми сокетами, а не юнитом, потому что ровно здесь живёт обещание задачи: право
 * смотрит СЕРВЕР на каждом сообщении. Клиентские кнопки — косметика, поэтому тест шлёт в сокет то,
 * что интерфейс ученика никогда не покажет (новую страницу, чужой элемент, удаление, «purge»), и
 * требует, чтобы сцена от этого не изменилась.
 *
 * Порядок доказательств (без пауз и без «поспим 500 мс»):
 *  - состояние сцены читается из `init` НОВОГО сокета учителя: комната доски живёт в памяти
 *    сервера, а GET /board отдаёт сохранённый снимок, который дописывается раз в 10 с;
 *  - отказ (`notice`) сервер шлёт уже ПОСЛЕ того, как сообщение обработано, — значит ожидание
 *    отказа это и барьер: «сообщение дошло и разобрано»;
 *  - принятая правка доказывается кадром `edits` у наблюдателя-учителя (рассылка идёт после
 *    merge), а не паузой.
 *
 * Что здесь НЕ доказуемо и берёт на себя zz20 (e2e, только в CI): что то же самое видно глазами —
 * значок «вы можете рисовать», урезанная панель и одинаковая доска у обоих участников.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import WebSocket from 'ws';
import { TEST_DATABASE_URL, preparedDb, type TestDB } from './util.js';
import { buildApp } from '../../src/app.js';
import { classMembers, classes, users } from '../../src/db/schema.js';
import { hashPassword } from '../../src/lib/password.js';
import { MAX_STUDENT_ELEMENTS } from '../../src/services/board.js';
import type { FastifyInstance } from 'fastify';

const suite = TEST_DATABASE_URL ? describe : describe.skip;
const PW = 'Passw0rd123';

interface Frame {
  type: string; code?: string; canDraw?: boolean; maxElements?: number;
  elements?: { id: string; x?: number; locked?: boolean; isDeleted?: boolean; version?: number }[];
  pages?: number[]; title?: string; titles?: Record<number, string>;
}
type Live = {
  ws: WebSocket; frames: Frame[];
  until: (pred: (f: Frame) => boolean, why: string) => Promise<Frame>;
};

suite('students drawing on the lesson board (part 3)', () => {
  let t: TestDB;
  let app: FastifyInstance;
  let port = 0;
  let teacherTok = '';
  let aTok = '';
  let bTok = '';
  let cTok = '';
  let outsiderTok = '';
  let aId = '';
  let bId = '';
  let cId = '';
  let sessionId = '';
  let foreignSessionId = '';

  const auth = (tok: string) => ({ authorization: `Bearer ${tok}` });
  const post = (tok: string, url: string, body: unknown = {}) =>
    app.inject({ method: 'POST', url, headers: auth(tok), payload: body as object });
  const get = (tok: string, url: string) => app.inject({ method: 'GET', url, headers: auth(tok) });

  /** Элемент той же формы, что присылает клиент Excalidraw: id + версия + нунс. */
  const el = (id: string, version = 1, extra: Record<string, unknown> = {}) =>
    ({ id, version, versionNonce: 1000 + version, type: 'draw', points: [[0, 0], [3, 4]], ...extra });

  const ids = (l: Live) => {
    const init = l.frames.find((f) => f.type === 'init')!;
    return (init.elements ?? []).map((e) => e.id);
  };

  async function openBoard(tok: string, sid = sessionId): Promise<Live> {
    const tk = await post(tok, '/api/ws/ticket', { sessionId: sid });
    expect(tk.statusCode, 'билет даёт свой класс и активный урок').toBe(200);
    const ws = new WebSocket(
      `ws://127.0.0.1:${port}/api/ws/board/${sid}?ticket=${encodeURIComponent(String(tk.json().ticket))}`);
    const frames: Frame[] = [];
    const waiters: { pred: (f: Frame) => boolean; res: (f: Frame) => void }[] = [];
    ws.on('message', (d: Buffer) => {
      const f = JSON.parse(d.toString()) as Frame;
      frames.push(f);
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i]!.pred(f)) { const w = waiters.splice(i, 1)[0]!; w.res(f); }
      }
    });
    const until = (pred: (f: Frame) => boolean, why: string) => new Promise<Frame>((res, rej) => {
      const hit = frames.find(pred);
      if (hit) return res(hit);
      const timer = setTimeout(() => rej(new Error(
        `нет кадра: ${why}; получено ${JSON.stringify(frames.map((f) => f.type))}`)), 5_000);
      waiters.push({ pred, res: (f) => { clearTimeout(timer); res(f); } });
    });
    const opened = await new Promise<boolean>((res) => {
      ws.on('open', () => res(true));
      ws.on('error', () => res(false));
      setTimeout(() => res(false), 5_000);
    });
    expect(opened, 'сокет доски открылся').toBe(true);
    const live: Live = { ws, frames, until };
    await live.until((f) => f.type === 'init', 'init доски');
    return live;
  }

  /** Живое состояние доски: короткий сокет учителя, читаем `init` и закрываем. */
  async function liveIds(): Promise<string[]> {
    const l = await openBoard(teacherTok);
    const out = ids(l);
    l.ws.close();
    return out;
  }

  const send = (ws: WebSocket, msg: Record<string, unknown>) => ws.send(JSON.stringify(msg));
  const initOf = (l: Live) => l.frames.find((f) => f.type === 'init') as Frame & { canEdit?: boolean; canDraw?: boolean };

  async function allow(userId: string, on: boolean) {
    const r = await post(teacherTok, `/api/lessons/${sessionId}/board/draw`, { userId, allow: on });
    expect(r.statusCode, 'учитель своего класса меняет право рисовать').toBe(200);
    return r.json() as { all: boolean; students: Record<string, true> };
  }

  beforeAll(async () => {
    t = await preparedDb(TEST_DATABASE_URL);
    app = await buildApp(t.db);
    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address();
    port = typeof addr === 'object' && addr ? addr.port : 0;
    expect(port).toBeGreaterThan(0);

    const pw = await hashPassword(PW);
    const mk = (role: 'teacher' | 'student', email: string, name: string) =>
      t.db.insert(users).values({ role, name, email, passwordHash: pw, tz: 'UTC' }).returning();
    const [teacher] = await mk('teacher', 'bd@x.io', 'BD Teacher');
    const [a] = await mk('student', 'bda@x.io', 'BD A');
    const [b] = await mk('student', 'bdb@x.io', 'BD B');
    const [c] = await mk('student', 'bdc@x.io', 'BD C');
    const [outsider] = await mk('teacher', 'bdo@x.io', 'BD Other');
    const [cls] = await t.db.insert(classes).values({ name: '7BD', teacherId: teacher.id }).returning();
    const [foreign] = await t.db.insert(classes).values({ name: '9BD', teacherId: outsider.id }).returning();
    await t.db.insert(classMembers).values([
      { classId: cls.id, userId: a.id }, { classId: cls.id, userId: b.id },
      { classId: foreign.id, userId: c.id },
    ]);
    const login = async (email: string) =>
      (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: PW } }))
        .json().accessToken as string;
    teacherTok = await login('bd@x.io');
    aTok = await login('bda@x.io');
    bTok = await login('bdb@x.io');
    cTok = await login('bdc@x.io');
    outsiderTok = await login('bdo@x.io');
    aId = a.id; bId = b.id; cId = c.id;
    sessionId = (await post(teacherTok, '/api/lessons/start', { classId: cls.id })).json().id as string;
    foreignSessionId = (await post(outsiderTok, '/api/lessons/start', { classId: foreign.id })).json().id as string;
  });

  afterAll(async () => { await app?.close(); await t?.sql.end(); });

  it('a student without permission is refused, and nothing lands on the board', async () => {
    const s = await openBoard(aTok);
    expect(initOf(s).canDraw, 'без разрешения рисовать нельзя').toBe(false);
    expect(initOf(s).canEdit, 'и учителем сокет не притворяется').toBe(false);

    send(s.ws, { type: 'edits', page: 1, elements: [el('nope')] });
    // отказ шлётся после обработки сообщения — он и барьер, и доказательство одновременно
    await s.until((f) => f.type === 'notice' && f.code === 'boardNoPermission', 'отказ права');
    expect(await liveIds(), 'элемента на доске нет').toEqual([]);
    s.ws.close();
  });

  it('an allowed student draws: the teacher receives it and the server records the author', async () => {
    const teacher = await openBoard(teacherTok);
    const state = await allow(aId, true);
    expect(state.students[aId]).toBe(true);

    const s = await openBoard(aTok);
    expect(initOf(s).canDraw, 'разрешение пришло с init').toBe(true);

    send(s.ws, { type: 'edits', page: 1, elements: [el('a1')] });
    const got = await teacher.until(
      (f) => f.type === 'edits' && (f.elements ?? []).some((e) => e.id === 'a1'),
      'учитель получил рисунок ученика');
    expect(got.elements!.find((e) => e.id === 'a1')!.locked, 'учителю ничего не блокируется').toBeUndefined();

    const authors = await get(teacherTok, `/api/lessons/${sessionId}/board/authors`);
    expect(authors.statusCode).toBe(200);
    expect(authors.json().byAuthor[aId], 'автор записан сервером').toBe(1);
    s.ws.close(); teacher.ws.close();
  });

  it('a permission change reaches the open socket, and the revocation acts at once', async () => {
    const s = await openBoard(bTok);
    expect(initOf(s).canDraw).toBe(false);

    await allow(bId, true);
    await s.until((f) => f.type === 'perms' && f.canDraw === true, 'perms: разрешён');
    const teacher = await openBoard(teacherTok);
    send(s.ws, { type: 'edits', page: 1, elements: [el('b1')] });
    await teacher.until((f) => f.type === 'edits' && (f.elements ?? []).some((e) => e.id === 'b1'), 'b1 принят');

    await allow(bId, false);
    await s.until((f) => f.type === 'perms' && f.canDraw === false, 'perms: отозван');
    send(s.ws, { type: 'edits', page: 1, elements: [el('b2')] });
    await s.until((f) => f.type === 'notice' && f.code === 'boardNoPermission', 'отказ после отзыва');
    const after = await liveIds();
    expect(after).toContain('b1');
    expect(after, 'отзыв действует сразу: b2 не нарисован').not.toContain('b2');
    s.ws.close(); teacher.ws.close();
  });

  it('a student cannot change the teacher’s element, and gets the authoritative scene back', async () => {
    const teacher = await openBoard(teacherTok);
    const witness = await openBoard(teacherTok); // второй сокет учителя: наблюдатель, ему эхо придёт
    send(teacher.ws, { type: 'edits', page: 1, elements: [el('t1', 1, { x: 11 })] });
    await witness.until((f) => f.type === 'edits' && (f.elements ?? []).some((e) => e.id === 't1'), 't1 на доске');
    witness.ws.close();

    const s = await openBoard(aTok);
    expect(ids(s), 'рисунок учителя виден ученику').toContain('t1');

    send(s.ws, { type: 'edits', page: 1, elements: [el('t1', 99, { x: 999 })] });
    await s.until((f) => f.type === 'notice' && f.code === 'boardForeign', 'отказ: чужой элемент');
    const back = await s.until((f) => f.type === 'current', 'авторитетный снимок страницы');
    const t1 = back.elements!.find((e) => e.id === 't1')!;
    expect(t1.x, 'учительский элемент вернулся к своему значению').toBe(11);
    expect(t1.locked, 'чужое ученику приезжает заблокированным').toBe(true);
    expect(await liveIds(), 'и на сервере ничего не поехало').toContain('t1');
    s.ws.close(); teacher.ws.close();
  });

  it('a mixed batch keeps the student’s own accepted stroke in the snapshot sent back to them', async () => {
    /*
     * Регресс на порядок «отказ → снимок» (разбор прогона 40075097179 и локальный повтор
     * 2026-10-24). Клиент, который переставил сцену с сервера, шлёт обратно ВСЮ её состав — свой
     * новый штрих и чужой элемент учителя вместе. Сервер чужое отвергает и возвращает
     * «авторитетный» кадр страницы; раньше этот кадр собирался ДО применения принятых правок,
     * поэтому в нём собственного штриха ещё не было. Клиент на `current` переставляет полотно
     * целиком — и человек видел, как его собственная рисовка исчезает с его же экрана. Это и есть
     * второй симптом zz20: метка у учителя есть (чернила дошли), а на полотне автора их нет.
     */
    await allow(aId, true);
    const teacher = await openBoard(teacherTok);
    const witness = await openBoard(teacherTok);
    send(teacher.ws, { type: 'edits', page: 1, elements: [el('t-mix', 1, { x: 21 })] });
    await witness.until((f) => f.type === 'edits' && (f.elements ?? []).some((e) => e.id === 't-mix'), 't-mix на доске');
    witness.ws.close();

    const s = await openBoard(aTok);
    send(s.ws, {
      type: 'edits', page: 1,
      elements: [el('t-mix', 99, { x: 777 }), el('a-mine', 3, { x: 42 })],
    });
    await s.until((f) => f.type === 'notice' && f.code === 'boardForeign', 'отказ: чужой элемент в кадре');
    const back = await s.until((f) => f.type === 'current', 'авторитетный снимок страницы');

    const ids2 = (back.elements ?? []).map((e) => e.id);
    expect(ids2, 'принятый сервером собственный штрих обязан быть в снимке, который вернули автору')
      .toContain('a-mine');
    expect(back.elements!.find((e) => e.id === 'a-mine')!.x, 'и с теми координатами, что принял сервер').toBe(42);
    expect(back.elements!.find((e) => e.id === 'a-mine')!.locked, 'своё не блокируется').not.toBe(true);
    const kept = back.elements!.find((e) => e.id === 't-mix')!;
    expect(kept.x, 'чужое остаётся учительским значением').toBe(21);
    expect(kept.locked, 'чужое ученику приезжает заблокированным').toBe(true);
    expect(await liveIds(), 'оба элемента на серверной доске').toEqual(expect.arrayContaining(['t-mix', 'a-mine']));
    s.ws.close(); teacher.ws.close();
  });

  it('one student cannot delete another student’s element', async () => {
    await allow(bId, true);
    const b = await openBoard(bTok);
    const teacher = await openBoard(teacherTok);
    send(b.ws, { type: 'edits', page: 1, elements: [el('b9')] });
    await teacher.until((f) => f.type === 'edits' && (f.elements ?? []).some((e) => e.id === 'b9'), 'b9 на доске');

    const a = await openBoard(aTok);
    send(a.ws, { type: 'edits', page: 1, elements: [el('b9', 5, { isDeleted: true })] });
    await a.until((f) => f.type === 'notice' && f.code === 'boardForeign', 'отказ: чужой элемент');
    expect(await liveIds(), 'чужой элемент уцелел').toContain('b9');
    a.ws.close(); b.ws.close(); teacher.ws.close();
  });

  it('page verbs and purge from a student never reach the board, whatever the client claims', async () => {
    const before = await liveIds();
    const teacher = await openBoard(teacherTok);
    const s = await openBoard(aTok);
    send(s.ws, { type: 'newpage' });
    send(s.ws, { type: 'rename', page: 1, title: 'взломано' });
    send(s.ws, { type: 'delpage', page: 1 });
    send(s.ws, { type: 'switch', page: 7 });
    send(s.ws, { type: 'purge', userId: bId });
    // барьер без паузы: разрешённая правка того же сокета придёт учителю только после того, как
    // сервер разобрал ВСЕ предыдущие сообщения этого сокета (отказы возвращаются синхронно)
    send(s.ws, { type: 'edits', page: 1, elements: [el('marker')] });
    await teacher.until((f) => f.type === 'edits' && (f.elements ?? []).some((e) => e.id === 'marker'), 'маркер принят');

    expect(teacher.frames.some((f) => f.type === 'pages'), 'ни одной новой страницы не объявлено').toBe(false);
    const res = await get(teacherTok, `/api/lessons/${sessionId}/board`);
    const pages = res.json().pages as { pageNo: number; title: string }[];
    expect(pages.map((p) => p.pageNo), 'состав страниц не изменился').toEqual([1]);
    expect(pages[0]!.title, 'подпись страницы не переименована').toBe('');
    const after = await liveIds();
    expect(after, 'ничего не удалилось, маркер появился').toEqual(expect.arrayContaining([...before, 'marker']));
    s.ws.close(); teacher.ws.close();
  });

  it('a late joiner gets the whole scene, including what students drew', async () => {
    const fresh = await openBoard(aTok);
    expect(ids(fresh)).toEqual(expect.arrayContaining(['a1', 'b1', 'b9', 't1', 'marker']));
    fresh.ws.close();
  });

  it('the teacher’s “delete a student’s drawings” removes only that student’s ink', async () => {
    const teacher = await openBoard(teacherTok);
    send(teacher.ws, { type: 'purge', userId: aId });
    const gone = await teacher.until(
      (f) => f.type === 'edits' && (f.elements ?? []).some((e) => e.id === 'a1'), 'кадр удаления');
    const a1 = gone.elements!.find((e) => e.id === 'a1')!;
    expect(a1.isDeleted).toBe(true);
    expect(a1.version, 'версия поднята — иначе merge сочтёт удаление устаревшим').toBeGreaterThan(1);

    const after = await liveIds();
    expect(after, 'своё ученика снялось').not.toEqual(expect.arrayContaining(['a1', 'marker']));
    expect(after, 'чужое не тронуто').toEqual(expect.arrayContaining(['b1', 'b9', 't1']));
    const authors = (await get(teacherTok, `/api/lessons/${sessionId}/board/authors`)).json();
    expect(authors.byAuthor[aId], 'ученика больше нет в списке «кого удалять»').toBeUndefined();
    teacher.ws.close();
  });

  it('the per-student element limit is enforced inside one frame', async () => {
    const s = await openBoard(aTok);
    const many = Array.from({ length: MAX_STUDENT_ELEMENTS + 5 }, (_, i) => el(`lim${i}`));
    send(s.ws, { type: 'edits', page: 1, elements: many });
    const n = await s.until((f) => f.type === 'notice' && f.code === 'boardStudentLimit', 'отказ по лимиту');
    expect(n.maxElements, 'подсказка называет потолок').toBe(MAX_STUDENT_ELEMENTS);
    const live = await liveIds();
    expect(live.filter((id) => id.startsWith('lim')).length)
      .toBe(MAX_STUDENT_ELEMENTS);
    s.ws.close();
  });

  it('a message flood is refused, and an oversized frame ends the socket at the protocol', async () => {
    const s = await openBoard(bTok);
    for (let i = 0; i < 80; i++) send(s.ws, { type: 'edits', page: 1, elements: [el(`spam${i}`)] });
    await s.until((f) => f.type === 'notice' && f.code === 'boardTooFast', 'отказ по частоте');
    s.ws.close();

    /*
     * Потолок одного кадра стоит НЕ в обработчике, а на сокете: `maxPayload: 256 КБ` в app.ts, и
     * сообщение больше него до логики доски не доходит вовсе — соединение рвётся с кодом 1009.
     * Проверяем ровно это, а не выдуманную подсказку «кадр слишком большой», которой сервер не
     * говорит и не может сказать.
     */
    const big = await openBoard(bTok);
    const closed = new Promise<number>((res) => big.ws.on('close', (code) => res(code)));
    send(big.ws, { type: 'edits', page: 1, elements: [el('fat', 1, { data: 'y'.repeat(300_000) })] });
    const code = await closed;
    // 1009 — «message too big», если сервер успел закрыть по протоколу; 1006 — если он оборвал
    // TCP-соединение раньше (на этом Node/ws это случается чаще). И то и другое — «кадр не принят».
    expect([1009, 1006], 'кадр больше потолка сокета обрывает соединение').toContain(code);
    const live = await liveIds();
    expect(live, 'ни затопления, ни «жирного» элемента на доске нет')
      .not.toEqual(expect.arrayContaining(['fat', 'spam0']));
  });

  it('the right lives on the session: a reconnect sees it again', async () => {
    await allow(bId, true);
    const first = await openBoard(bTok);
    expect(initOf(first).canDraw).toBe(true);
    first.ws.close();
    const again = await openBoard(bTok);
    expect(initOf(again).canDraw, 'переподключение не теряет разрешение').toBe(true);
    again.ws.close();
    await allow(bId, false);
    const third = await openBoard(bTok);
    expect(initOf(third).canDraw, 'и отзыв переживает переподключение').toBe(false);
    third.ws.close();
  });

  it('«разрешить всем» on, and a student without a personal grant can draw too', async () => {
    // у Б рисование было отозвано выше — он и есть «ученик без точечного разрешения»
    const before = await openBoard(bTok);
    expect(initOf(before).canDraw, 'без точечного и общего разрешения — нельзя').toBe(false);
    before.ws.close();

    const r = await post(teacherTok, `/api/lessons/${sessionId}/board/draw`, { all: true });
    expect(r.statusCode).toBe(200);
    expect(r.json().all).toBe(true);
    const late = await openBoard(bTok);
    expect(initOf(late).canDraw, 'общее разрешение действует и на тех, кто подключился позже').toBe(true);
    late.ws.close();

    const off = await post(teacherTok, `/api/lessons/${sessionId}/board/draw`, { all: false });
    expect(off.json().all).toBe(false);
    const back = await openBoard(aTok);
    expect(initOf(back).canDraw, 'после выключения «всем» остаётся точечное разрешение').toBe(true);
    back.ws.close();
  });

  it('rights: a student cannot grant, and a foreign teacher answers like a made-up lesson', async () => {
    expect((await post(aTok, `/api/lessons/${sessionId}/board/draw`, { userId: bId, allow: true })).statusCode).toBe(403);
    const foreign = await post(outsiderTok, `/api/lessons/${sessionId}/board/draw`, { userId: bId, allow: true });
    const madeUp = await post(outsiderTok,
      '/api/lessons/00000000-0000-4000-8000-000000000000/board/draw', { userId: bId, allow: true });
    expect([foreign.statusCode, madeUp.statusCode]).toEqual([404, 404]);
    expect(foreign.body).toBe(madeUp.body);

    // чужой ученик и несуществующий пользователь отвечают одинаково и ничего не меняют
    const stranger = await post(teacherTok, `/api/lessons/${sessionId}/board/draw`,
      { userId: '00000000-0000-4000-8000-000000000000', allow: true });
    const foreignStudent = await post(teacherTok, `/api/lessons/${sessionId}/board/draw`, { userId: cId, allow: true });
    expect([stranger.statusCode, foreignStudent.statusCode]).toEqual([404, 404]);
    expect(stranger.body).toBe(foreignStudent.body);
    const body = (await get(teacherTok, `/api/lessons/${sessionId}/board/draw`)).json();
    expect(body.students[aId], 'разрешение Анны от этих попыток не поехало').toBe(true);
    expect(body.students[cId], 'чужого ученика в списке нет').toBeUndefined();
  });

  it('a student of another class cannot open this board, and their own stays empty', async () => {
    expect((await post(cTok, '/api/ws/ticket', { sessionId })).statusCode,
      'чужой класс билет на этот урок не получает').toBe(404);
    const own = await get(cTok, `/api/lessons/${foreignSessionId}/board`);
    expect(own.statusCode).toBe(200);
    expect(own.json().pages[0].elements, 'чужая доска пуста').toEqual([]);
  });
});
