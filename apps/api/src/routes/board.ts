import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import type { WebSocket } from 'ws';
import { z } from 'zod';
import type { DB } from '../db/index.js';
import { consumeWsTicket } from '../services/wsTicket.js';
import { wsOriginAllowed } from '../lib/wsOrigin.js';
import { attachErrorLogging } from '../lib/errorObservers.js';
import { resolveClass } from '../services/classes.js';
import { getSession } from '../services/lessons.js';
import { whiteboards, lessonSessions } from '../db/schema.js';
import {
  loadPage, listPages, listPagesWithTitles, mergeElements, gateEdits, lockForeign,
  countByAuthor, wipeAuthor, MAX_STUDENT_ELEMENTS, MAX_STUDENT_BYTES, MAX_SCENE_BYTES, type ExEl,
} from '../services/board.js';
import { createMaterial } from '../services/posts.js';

const BROADCAST_MS = 30;   // §3.7 throttle
const AUTOSAVE_MS = 10_000; // §3.7 autosave every 10 s

/** Task 1г: a lesson gets at most this many boards — enforced here, on the server. */
export const MAX_BOARD_PAGES = 20;
/** Task 1б: the label length cap, in characters. */
export const MAX_BOARD_TITLE = 40;

/**
 * A board title is PLAIN TEXT: control characters and line breaks are collapsed, the value is
 * trimmed and cut to 40 chars. Nothing is interpreted as markup anywhere — the client renders it
 * as a React text child — and an empty result means "no label", so the localized «Доска N» shows.
 */
export function sanitizeBoardTitle(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const flat = raw.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  return [...flat].slice(0, MAX_BOARD_TITLE).join('');
}

/**
 * Часть 3: частота сообщений ученика. Клиент троттлит правки ~30 мс (BROADCAST_MS), то есть шлёт
 * не больше ~34 кадров в секунду; 60 — это «вдвое больше, чем может честный клиент», и ловит
 * только цикл-по-ошибке или злой скрипт.
 *
 * Размер кадра здесь не проверяется намеренно: потолок стоит на самом сокете
 * (`maxPayload: 256 КБ` в app.ts), и сообщение больше него до обработчика не доходит — соединение
 * рвётся на уровне протокола. Проверка «внутри» обработчика была бы мёртвым кодом.
 */
const MAX_MSGS_PER_SEC = 60;

/** Что клиенту показать в подсказке при отказе по лимиту (часть 3). */
const LIMITS = { elements: MAX_STUDENT_ELEMENTS, bytes: MAX_STUDENT_BYTES };

interface BoardRoom {
  sessionId: string;
  teacherId: string;
  current: number;
  pages: number[];
  titles: Record<number, string>;
  elements: Record<string, ExEl>;
  /** часть 3: `id элемента → userId` автора; пишет только сервер, из идентичности сокета */
  authors: Record<string, string>;
  /** часть 3: право рисовать, прочитанное с сессии при создании комнаты */
  drawAll: boolean;
  drawStudents: Record<string, true>;
  sockets: Map<WebSocket, { role: 'teacher' | 'student'; userId: string; msgs: number; window: number }>;
  pending: ExEl[];
  broadcastTimer: NodeJS.Timeout | null;
  autosaveTimer: NodeJS.Timeout | null;
  dirty: boolean;
  saving: Promise<void> | null;
}

const rooms = new Map<string, BoardRoom>();

/** Часть 3: имеет ли этот участник право рисовать прямо сейчас. */
function canDrawFor(r: BoardRoom, who: { role: 'teacher' | 'student'; userId: string }): boolean {
  return who.role === 'teacher' || r.drawAll || r.drawStudents[who.userId] === true;
}

async function getBoardRoom(db: DB, sessionId: string): Promise<BoardRoom> {
  let r = rooms.get(sessionId);
  if (r) return r;
  const [s] = await db.select().from(lessonSessions).where(eq(lessonSessions.id, sessionId)).limit(1);
  if (!s) throw new Error('no session');
  const rows = await listPagesWithTitles(db, sessionId);
  const pages = rows.map((x) => x.pageNo);
  const titles: Record<number, string> = {};
  for (const x of rows) titles[x.pageNo] = x.title;
  const first = pages[0]!;
  const snap = await loadPage(db, sessionId, first);
  r = {
    sessionId, teacherId: s.createdBy, current: first, pages, titles,
    elements: snap.elements, authors: snap.authors,
    drawAll: s.boardDrawAll, drawStudents: { ...s.boardDrawStudents },
    sockets: new Map(), pending: [],
    broadcastTimer: null, autosaveTimer: null, dirty: false, saving: null,
  };
  rooms.set(sessionId, r);
  r.autosaveTimer = setInterval(() => { void persist(db, r!); }, AUTOSAVE_MS);
  r.autosaveTimer.unref?.();
  return r;
}

async function persistNow(db: DB, r: BoardRoom) {
  r.dirty = false;
  const snapshot = { elements: Object.values(r.elements), appState: {} };
  await db.insert(whiteboards)
    .values({
      sessionId: r.sessionId, pageNo: r.current, snapshot: snapshot as never,
      authors: r.authors as never, updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [whiteboards.sessionId, whiteboards.pageNo],
      set: { snapshot: snapshot as never, authors: r.authors as never, updatedAt: new Date() },
    });
}

/** Coalescing persist: a second call while a write is in flight joins it. */
async function persist(db: DB, r: BoardRoom): Promise<void> {
  if (!r.dirty && !r.saving) return;
  if (r.dirty) r.saving = persistNow(db, r);
  const p = r.saving;
  if (!p) return;
  try { await p; } finally {
    if (r.saving === p) r.saving = null;
  }
  if (r.dirty) await persist(db, r);
}

function broadcast(r: BoardRoom, msg: unknown, except?: WebSocket) {
  const data = JSON.stringify(msg);
  for (const [sock] of r.sockets) {
    if (sock !== except && sock.readyState === 1) { try { sock.send(data); } catch { /* ignore */ } }
  }
}

/**
 * Часть 3: кадр со СЦЕНОЙ шлётся каждому по-своему. Ученику чужие элементы приезжают с
 * `locked: true` — Excalidraw 0.18.1 не даёт такой элемент ни выделить, ни сдвинуть, ни стереть
 * ластиком, поэтому человек не оказывается в ситуации «я дёрнул чужой рисунок, а он сам вернулся».
 * Право при этом по-прежнему решает сервер в `gateEdits`: блокировка здесь — вежливость, а не
 * защита. Учителю сцена уходит как есть: он правит всё.
 */
function sendScene(r: BoardRoom, msg: Record<string, unknown>, except?: WebSocket) {
  const els = Array.isArray(msg.elements) ? (msg.elements as ExEl[]) : null;
  for (const [sock, who] of r.sockets) {
    if (sock === except || sock.readyState !== 1) continue;
    const payload = els && who.role === 'student'
      ? { ...msg, elements: lockForeign(els, r.authors, who.userId) }
      : msg;
    try { sock.send(JSON.stringify(payload)); } catch { /* ignore */ }
  }
}

/** Часть 3: тот же снимок, но одному сокету — ответ опоздавшему/отвергнутому клиенту. */
function sendSceneTo(r: BoardRoom, sock: WebSocket, who: { role: 'teacher' | 'student'; userId: string }) {
  if (sock.readyState !== 1) return;
  const els = Object.values(r.elements);
  const payload = {
    type: 'current', page: r.current, title: r.titles[r.current] ?? '',
    elements: who.role === 'student' ? lockForeign(els, r.authors, who.userId) : els,
  };
  try { sock.send(JSON.stringify(payload)); } catch { /* ignore */ }
}

function queueBroadcast(db: DB, r: BoardRoom, els: ExEl[], from: WebSocket) {
  r.pending.push(...els);
  r.dirty = true;
  if (r.broadcastTimer) return;
  r.broadcastTimer = setTimeout(() => {
    r.broadcastTimer = null;
    const batch = r.pending.splice(0);
    sendScene(r, { type: 'edits', page: r.current, elements: batch }, from);
  }, BROADCAST_MS);
  r.broadcastTimer.unref?.();
}

async function switchPage(db: DB, r: BoardRoom, pageNo: number) {
  await persist(db, r);
  const snap = await loadPage(db, r.sessionId, pageNo);
  r.current = pageNo;
  r.elements = snap.elements;
  r.authors = snap.authors;
  // EVERY socket gets the new scene — including the one that asked for the switch. It used to be
  // excluded (`except: from`), and the measurement of 2026-10-08 showed what that cost: the
  // teacher's own canvas was never replaced, so after «+ стр.» the previous page's ink stayed on
  // screen and the two pages were shown as one merged picture. Students were right, the teacher
  // was wrong — and anything they then drew landed on the page the server had switched to.
  sendScene(r, {
    type: 'current', page: pageNo, title: r.titles[pageNo] ?? '',
    elements: Object.values(snap.elements),
  });
}

export async function boardRoutes(app: FastifyInstance, opts: { db: DB }) {
  const { db } = opts;

  // REST snapshot for late joiners / reopening after the lesson (§3.7)
  app.get('/api/lessons/:id/board', { preHandler: app.authenticate }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const s = await getSession(db, id);
    if (!s) return reply.code(404).send({ error: 'notFound' });
    const cls = await resolveClass(db, req.user!.id, req.user!.role, s.classId);
    if (!cls) return reply.code(404).send({ error: 'notFound' });
    /*
     * Часть 4 СПОРНА ЭТОЙ ДВЕРЬЮ И ОТКАТИЛА ЕЁ. Первая версия навешивала на этот GET условие
     * «завершённый урок ученик читает только при включённом архиве» — и это молча отнимало
     * возможность, которая была всегда (см. подпись маршрута: reopening after the lesson, §3.7):
     * после выключенного по умолчанию переключателя ученики переставали открывать доски урока,
     * который только что прошли. Переключатель класса решает про РАЗДЕЛ «Архив уроков»
     * (`routes/lessonArchive.ts`), а не про доступ к доске того урока, на котором ребёнок был.
     * Права при этом проверяются так же: чужой класс и чужой урок — 404.
     */
    const rows = await listPagesWithTitles(db, id);
    const out: { pageNo: number; title: string; elements: unknown[] }[] = [];
    for (const row of rows) {
      const snap = await loadPage(db, id, row.pageNo);
      out.push({ pageNo: row.pageNo, title: row.title, elements: Object.values(snap.elements) });
    }
    return { pages: out, maxPages: MAX_BOARD_PAGES };
  });

  // Teacher saves a page snapshot directly (offline editing after the lesson)
  app.put('/api/lessons/:id/board/page', {
    preHandler: app.authenticateTeacher,
  }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const s = await getSession(db, id);
    if (!s) return reply.code(404).send({ error: 'notFound' });
    const cls = await resolveClass(db, req.user!.id, 'teacher', s.classId);
    if (!cls) return reply.code(404).send({ error: 'notFound' });
    const p = z.object({
      pageNo: z.number().int().min(1).max(MAX_BOARD_PAGES),
      title: z.string().optional(),
      elements: z.array(z.object({ id: z.string() }).passthrough()),
    }).safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: 'invalidInput' });
    const snapshot = { elements: p.data.elements, appState: {} };
    // Часть 3: авторство переживает прямую запись. То, что уже было на странице, остаётся у своего
    // автора (в том числе у ученика), а всё новое считается учительским — этот маршрут доступен
    // только учителю, и выдумать ученика он не может.
    const [prev] = await db.select({ authors: whiteboards.authors }).from(whiteboards)
      .where(and(eq(whiteboards.sessionId, id), eq(whiteboards.pageNo, p.data.pageNo))).limit(1);
    const prevAuthors: Record<string, string> = { ...(prev?.authors ?? {}) };
    const authors: Record<string, string> = {};
    for (const el of p.data.elements as Array<{ id: string }>) {
      authors[el.id] = prevAuthors[el.id] ?? req.user!.id;
    }
    const r = rooms.get(id);
    if (r && r.current === p.data.pageNo) r.authors = authors;
    // A label is written only when the caller sent one — an edit to the drawing must never clear
    // the teacher's page name.
    const title = p.data.title === undefined ? undefined : sanitizeBoardTitle(p.data.title);
    await db.insert(whiteboards)
      .values({
        sessionId: id, pageNo: p.data.pageNo, snapshot: snapshot as never, authors: authors as never,
        ...(title === undefined ? {} : { title }), updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [whiteboards.sessionId, whiteboards.pageNo],
        set: {
          snapshot: snapshot as never, authors: authors as never, updatedAt: new Date(),
          ...(title === undefined ? {} : { title }),
        },
      });
    if (r && title !== undefined) r.titles[p.data.pageNo] = title;
    return { ok: true };
  });

  // Publish a page as PNG/SVG material into the class feed (§3.7)
  app.post('/api/lessons/:id/board/publish', { preHandler: app.authenticateTeacher }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const s = await getSession(db, id);
    if (!s) return reply.code(404).send({ error: 'notFound' });
    const cls = await resolveClass(db, req.user!.id, 'teacher', s.classId);
    if (!cls) return reply.code(404).send({ error: 'notFound' });
    const p = z.object({
      dataUrl: z.string().max(12_000_000), // ~8 MB decoded ceiling
      kind: z.enum(['png', 'svg']),
      title: z.string().trim().min(1).max(200),
    }).safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: 'invalidInput' });
    const mime = p.data.kind === 'png' ? 'image/png' : 'image/svg+xml';
    const b64 = p.data.dataUrl.slice(p.data.dataUrl.indexOf(',') + 1);
    const buffer = Buffer.from(b64, 'base64');
    const post = await createMaterial(db, req.user!.id, cls.id,
      { title: p.data.title, description: '', topicId: null, newTopic: null, status: 'published', scheduledAt: null, audience: [], links: [] },
      [{ buffer, filename: `${p.data.title || 'board'}.${p.data.kind === 'png' ? 'png' : 'svg'}` }]);
    void mime;
    return reply.code(201).send({ postId: post.id });
  });

  /**
   * Часть 3: право рисовать — учителю этого класса, и только.
   *
   * `{ all: true|false }` — «разрешить всем»; `{ userId, allow }` — точечно. Состояние пишется на
   * СЕССИЮ (миграция 0029), потому что ученик переподключается и перезагружает страницу посреди
   * урока: разрешение, живущее в клиенте или в сокете, пережил бы только первый экран.
   *
   * Комната доски, если она уже стоит, синхронизируется в том же запросе и получает `perms`-кадр:
   * отзыв должен подействовать сразу, а не после переподключения. Проверка права при этом всё
   * равно на каждом сообщении (`gateEdits`) — кадр `perms` это подсказка интерфейсу, не защита.
   */
  async function setDrawPermission(db: DB, s: { id: string; classId: string }, userId: string | undefined, all: boolean | undefined, allow: boolean) {
    const [cur] = await db.select({ all: lessonSessions.boardDrawAll, students: lessonSessions.boardDrawStudents })
      .from(lessonSessions).where(eq(lessonSessions.id, s.id)).limit(1);
    const students = { ...(cur?.students ?? {}) };
    let nextAll = cur?.all ?? false;
    if (all !== undefined) {
      nextAll = all;
    } else if (userId) {
      if (allow) students[userId] = true; else delete students[userId];
    }
    await db.update(lessonSessions).set({ boardDrawAll: nextAll, boardDrawStudents: students })
      .where(eq(lessonSessions.id, s.id));
    const r = rooms.get(s.id);
    if (r) {
      r.drawAll = nextAll;
      r.drawStudents = students;
      for (const [sock, who] of r.sockets) {
        if (who.role === 'teacher' || (userId && who.userId !== userId)) continue;
        if (sock.readyState === 1) {
          try { sock.send(JSON.stringify({ type: 'perms', canDraw: canDrawFor(r, who) })); } catch { /* ignore */ }
        }
      }
    }
    return { ok: true, all: nextAll, students };
  }

  app.post('/api/lessons/:id/board/draw', { preHandler: app.authenticateTeacher }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const s = await getSession(db, id);
    if (!s) return reply.code(404).send({ error: 'notFound' });
    const cls = await resolveClass(db, req.user!.id, 'teacher', s.classId);
    if (!cls) return reply.code(404).send({ error: 'notFound' });
    const p = z.object({
      userId: z.string().uuid().optional(),
      all: z.boolean().optional(),
      allow: z.boolean().default(true),
    }).safeParse(req.body ?? {});
    if (!p.success || (p.data.userId === undefined && p.data.all === undefined)) {
      return reply.code(400).send({ error: 'invalidInput' });
    }
    // Разрешение дают только своему ученику: чужой класс и несуществующий пользователь
    // отвечают одинаковым 404 (общее правило прав в этом проекте).
    if (p.data.userId && !await resolveClass(db, p.data.userId, 'student', s.classId)) {
      return reply.code(404).send({ error: 'notFound' });
    }
    return await setDrawPermission(db, s, p.data.userId, p.data.all, p.data.allow);
  });

  app.get('/api/lessons/:id/board/draw', { preHandler: app.authenticateTeacher }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const s = await getSession(db, id);
    if (!s) return reply.code(404).send({ error: 'notFound' });
    const cls = await resolveClass(db, req.user!.id, 'teacher', s.classId);
    if (!cls) return reply.code(404).send({ error: 'notFound' });
    const r = rooms.get(id);
    if (r) return { ok: true, all: r.drawAll, students: r.drawStudents };
    const [row] = await db.select({ all: lessonSessions.boardDrawAll, students: lessonSessions.boardDrawStudents })
      .from(lessonSessions).where(eq(lessonSessions.id, id)).limit(1);
    return { ok: true, all: row?.all ?? false, students: row?.students ?? {} };
  });

  /**
   * Часть 3: чьи рисунки лежат на доске — нужно учительской кнопке «Удалить рисунки ученика».
   * Возвращает счётчики, а не сами элементы: имена учитель уже видит в списке участников, а
   * лишняя пересылка сцены не нужна.
   */
  app.get('/api/lessons/:id/board/authors', { preHandler: app.authenticateTeacher }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const s = await getSession(db, id);
    if (!s) return reply.code(404).send({ error: 'notFound' });
    const cls = await resolveClass(db, req.user!.id, 'teacher', s.classId);
    if (!cls) return reply.code(404).send({ error: 'notFound' });
    const q = z.object({ page: z.coerce.number().int().min(1).optional() }).safeParse(req.query ?? {});
    if (!q.success) return reply.code(400).send({ error: 'invalidInput' });
    const r = rooms.get(id);
    const page = q.data.page ?? r?.current ?? 1;
    if (!r || r.current !== page) {
      const pages = await listPages(db, id);
      if (!pages.includes(page)) return reply.code(404).send({ error: 'notFound' });
      const snap = await loadPage(db, id, page);
      return { page, byAuthor: countByAuthor(snap.elements, snap.authors), limits: LIMITS };
    }
    return { page, byAuthor: countByAuthor(r.elements, r.authors), limits: LIMITS };
  });

  // ── board WebSocket (one-time ticket auth, §audit) ──
  app.get('/api/ws/board/:id', { websocket: true }, (socket: WebSocket, req) => {
    void (async () => {
      if (!wsOriginAllowed(req)) { socket.close(4403); return; }
      const url = new URL(req.url, 'http://local');
      const ticket = url.searchParams.get('ticket') ?? '';
      const sessionId = url.pathname.split('/').pop() ?? '';
      const s = await getSession(db, sessionId);
      if (!s) { socket.close(4404); return; }
      const consumed = await consumeWsTicket(db, ticket, sessionId);
      if (!consumed) { socket.close(4401); return; }
      const cls = await resolveClass(db, consumed.userId, consumed.role, s.classId);
      if (!cls) { socket.close(4404); return; }
      const role: 'teacher' | 'student' = consumed.role === 'teacher' ? 'teacher' : 'student';
      const r = await getBoardRoom(db, sessionId);
      if (role === 'teacher') r.teacherId = consumed.userId;
      const who = { role, userId: consumed.userId, msgs: 0, window: 0 };
      r.sockets.set(socket, who);
      attachErrorLogging(socket, 'board socket'); // see lib/errorObservers.ts
      socket.on('close', () => {
        r.sockets.delete(socket);
        // flush pending edits, then persist; keep the room in the map until the
        // write finishes so a reconnecting client reuses the in-memory state.
        if (r.broadcastTimer) {
          clearTimeout(r.broadcastTimer); r.broadcastTimer = null;
          const batch = r.pending.splice(0);
          if (batch.length) sendScene(r, { type: 'edits', page: r.current, elements: batch });
        }
        void persist(db, r).then(() => {
          if (r.sockets.size === 0 && rooms.get(sessionId) === r) {
            if (r.autosaveTimer) clearInterval(r.autosaveTimer);
            rooms.delete(sessionId);
          }
        }).catch(() => undefined);
      });
      socket.send(JSON.stringify({
        type: 'init', canEdit: role === 'teacher', canDraw: canDrawFor(r, who),
        page: r.current, pages: r.pages, titles: r.titles,
        elements: role === 'teacher'
          ? Object.values(r.elements)
          : lockForeign(Object.values(r.elements), r.authors, consumed.userId),
      }));

      socket.on('message', (raw: Buffer) => {
        void (async () => {
          // Частота сообщений — до всякой логики: ученик с циклом-по-ошибке не должен уметь
          // положить сервер или залить доску мусором.
          const now = Date.now();
          if (now - who.window > 1000) { who.window = now; who.msgs = 0; }
          if (++who.msgs > MAX_MSGS_PER_SEC) {
            socket.send(JSON.stringify({ type: 'notice', code: 'boardTooFast' }));
            return;
          }
          let msg: { type?: string; page?: number; title?: unknown; elements?: ExEl[]; userId?: string };
          try { msg = JSON.parse(raw.toString()); } catch { return; }
          const notice = (code: string, extra: Record<string, unknown> = {}) =>
            socket.send(JSON.stringify({ type: 'notice', code, ...extra }));

          /**
           * Часть 3: право рисовать проверяется на КАЖДОМ сообщении, а не при подключении.
           * Учитель отозвал разрешение посреди рисования — следующий кадр уже не пройдёт, и
           * ничего из него в сцену не попадёт (проверка стоит до merge).
           */
          if (who.role !== 'teacher' && !canDrawFor(r, who)) {
            notice('boardNoPermission');
            return;
          }

          /**
           * SERVER-SIDE PERMISSION GATE: only the owning teacher may write (§3.7/§7). This covers
           * every page-management verb too — a student's newpage/rename/duplicate/delpage/switch
           * returns here, before any state is touched (task 1г).
           */
          const isTeacherMsg = who.role === 'teacher' && who.userId === r.teacherId;
          if (!isTeacherMsg && msg.type !== 'edits') return;
          if (msg.type === 'edits' && Array.isArray(msg.elements)) {
            const els = msg.elements.filter((e) => e && typeof e.id === 'string');
            if (!els.length) return;
            const gate = gateEdits({
              incoming: els, scene: r.elements, authors: r.authors,
              userId: who.userId, teacher: isTeacherMsg,
            });
            if (gate.rejected.length && (isTeacherMsg ? gate.overScene : true)) {
              // Отказанному возвращаем авторитетный снимок ВСЕЙ страницы: версии у его локальной
              // копии уже выше, чем у отброшенных элементов, поэтому точечная доставка ничего бы
              // не исправила — клиент обязан переставить сцену целиком.
              notice(gate.overScene ? 'boardSceneLimit'
                : gate.overLimit ? 'boardStudentLimit' : 'boardForeign',
              gate.overScene ? { maxBytes: MAX_SCENE_BYTES }
                : gate.overLimit ? { maxElements: MAX_STUDENT_ELEMENTS, maxBytes: MAX_STUDENT_BYTES } : {});
              sendSceneTo(r, socket, who);
            }
            const { changed } = mergeElements(r.elements, gate.accepted);
            if (changed.length) queueBroadcast(db, r, changed, socket);
            return;
          }
          /**
           * Часть 3: «Удалить рисунки ученика» — учительское действие, и только учительское.
           * Снимаются мягко (isDeleted + новая версия), чтобы дельта-синхрон донёс удаление до
           * всех, а карта авторства чистится: ученик, у которого удалили рисунок, не получает
           * потом «свой» пустой элемент.
           */
          if (msg.type === 'purge' && typeof msg.userId === 'string') {
            const wiped = wipeAuthor(r.elements, r.authors, msg.userId);
            if (!wiped.length) { notice('boardNothingToPurge', { userId: msg.userId }); return; }
            // тот же путь, что у любой правки: merge снимает элементы со сцены по `isDeleted`
            mergeElements(r.elements, wiped);
            r.dirty = true;
            // БЕЗ `except`: учителю этот кадр тоже нужен — его полотно ещё показывает чужой рисунок
            sendScene(r, { type: 'edits', page: r.current, elements: wiped });
            await persist(db, r);
            return;
          }
          if (msg.type === 'switch' && typeof msg.page === 'number' && r.pages.includes(msg.page)) {
            await switchPage(db, r, msg.page);
            return;
          }
          if (msg.type === 'newpage') {
            if (r.pages.length >= MAX_BOARD_PAGES) {
              notice('boardLimit', { max: MAX_BOARD_PAGES, pages: r.pages.length });
              return;
            }
            // RESERVE SYNCHRONOUSLY. Every message handler here is its own async task
            // (`socket.on('message')` fires one after another without waiting), so a check placed
            // before an `await` and a mutation placed after it is not atomic: 25 «newpage» frames
            // in one batch all saw `pages.length === 1` while they were waiting for the persist,
            // and the session ended up with 26 boards over a cap of 20. The push happens before
            // any await, and the row insert undoes it if it fails.
            const np = Math.max(...r.pages) + 1;
            r.pages.push(np);
            r.titles[np] = '';
            try {
              await persist(db, r);
              await db.insert(whiteboards).values({
                sessionId: r.sessionId, pageNo: np, title: '', snapshot: { elements: [], appState: {} } as never,
              });
            } catch {
              r.pages = r.pages.filter((x) => x !== np);
              delete r.titles[np];
              return;
            }
            r.current = np; r.elements = {}; r.authors = {}; r.dirty = false;
            // `elements` travels with the page list: the client that created the board has to
            // drop the previous board's scene from its canvas too (see switchPage) — otherwise
            // the teacher keeps seeing the old drawing on top of the new board.
            sendScene(r, { type: 'pages', pages: r.pages, current: np, titles: r.titles, elements: [] });
            return;
          }
          /**
           * Task 1б/1в: a page label. Plain text only — sanitizeBoardTitle flattens line breaks,
           * collapses whitespace and cuts to 40 chars. Empty is a legal value ("no label", the
           * client shows the localized «Доска N»).
           */
          if (msg.type === 'rename' && typeof msg.page === 'number' && r.pages.includes(msg.page)) {
            const title = sanitizeBoardTitle(msg.title);
            r.titles[msg.page] = title;
            await db.update(whiteboards).set({ title })
              .where(and(eq(whiteboards.sessionId, r.sessionId), eq(whiteboards.pageNo, msg.page)));
            broadcast(r, { type: 'titles', titles: r.titles });
            return;
          }
          /**
           * Task 1в: duplicate the page's scene into a new board. The copies keep their element
           * ids — two boards never share a screen (the client replaces the scene on every
           * switch), so ids only ever have to be unique inside one page. No localized suffix is
           * stored: the copy has the same label as its source, or none.
           */
          if (msg.type === 'duplicate' && typeof msg.page === 'number' && r.pages.includes(msg.page)) {
            if (r.pages.length >= MAX_BOARD_PAGES) {
              notice('boardLimit', { max: MAX_BOARD_PAGES, pages: r.pages.length });
              return;
            }
            const np = Math.max(...r.pages) + 1;
            const title = r.titles[msg.page] ?? '';
            r.pages.push(np);            // reserve before the first await — see newpage
            r.titles[np] = title;
            try {
              await persist(db, r);
              const snap = await loadPage(db, r.sessionId, msg.page);
              await db.insert(whiteboards).values({
                sessionId: r.sessionId, pageNo: np, title,
                snapshot: { elements: Object.values(snap.elements), appState: {} } as never,
                // копия доски копирует и авторство: иначе «удалить рисунки ученика» на дубликате
                // находило бы пустоту, хотя рисунок ученика на нём виден
                authors: snap.authors as never,
              });
              r.current = np; r.elements = snap.elements; r.authors = snap.authors; r.dirty = false;
            } catch {
              r.pages = r.pages.filter((x) => x !== np);
              delete r.titles[np];
              return;
            }
            sendScene(r, {
              type: 'pages', pages: r.pages, current: np, titles: r.titles,
              elements: Object.values(r.elements),
            });
            return;
          }
          if (msg.type === 'delpage' && typeof msg.page === 'number' && r.pages.includes(msg.page)) {
            // task 1в: the last board cannot be deleted — only cleared
            if (r.pages.length <= 1) {
              notice('boardLastPage', { page: msg.page });
              return;
            }
            const next = r.pages.filter((x) => x !== msg.page);
            if (!next.length) return;
            r.pages = next;              // reserve before the first await — see newpage
            delete r.titles[msg.page];
            await db.delete(whiteboards).where(and(eq(whiteboards.sessionId, r.sessionId), eq(whiteboards.pageNo, msg.page)));
            if (r.current === msg.page) {
              // switchPage already sends the new scene to everyone, including this socket
              await switchPage(db, r, next[0]!);
              broadcast(r, { type: 'pages', pages: r.pages, current: r.current, titles: r.titles });
            } else {
              sendScene(r, {
                type: 'pages', pages: r.pages, current: r.current, titles: r.titles,
                elements: Object.values(r.elements),
              });
            }
            return;
          }
        })().catch(() => undefined);
      });
    })().catch(() => socket.close(1011));
  });
}
