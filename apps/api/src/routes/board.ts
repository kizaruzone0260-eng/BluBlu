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
  loadPage, listPages, listPagesWithTitles, mergeElements, type ExEl,
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

interface BoardRoom {
  sessionId: string;
  teacherId: string;
  current: number;
  pages: number[];
  titles: Record<number, string>;
  elements: Record<string, ExEl>;
  sockets: Map<WebSocket, { role: 'teacher' | 'student' }>;
  pending: ExEl[];
  broadcastTimer: NodeJS.Timeout | null;
  autosaveTimer: NodeJS.Timeout | null;
  dirty: boolean;
  saving: Promise<void> | null;
}

const rooms = new Map<string, BoardRoom>();

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
    elements: snap.elements, sockets: new Map(), pending: [],
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
    .values({ sessionId: r.sessionId, pageNo: r.current, snapshot: snapshot as never, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: [whiteboards.sessionId, whiteboards.pageNo],
      set: { snapshot: snapshot as never, updatedAt: new Date() },
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

function queueBroadcast(db: DB, r: BoardRoom, els: ExEl[], from: WebSocket) {
  r.pending.push(...els);
  r.dirty = true;
  if (r.broadcastTimer) return;
  r.broadcastTimer = setTimeout(() => {
    r.broadcastTimer = null;
    const batch = r.pending.splice(0);
    broadcast(r, { type: 'edits', page: r.current, elements: batch }, from);
  }, BROADCAST_MS);
  r.broadcastTimer.unref?.();
}

async function switchPage(db: DB, r: BoardRoom, pageNo: number) {
  await persist(db, r);
  const snap = await loadPage(db, r.sessionId, pageNo);
  r.current = pageNo;
  r.elements = snap.elements;
  // EVERY socket gets the new scene — including the one that asked for the switch. It used to be
  // excluded (`except: from`), and the measurement of 2026-10-08 showed what that cost: the
  // teacher's own canvas was never replaced, so after «+ стр.» the previous page's ink stayed on
  // screen and the two pages were shown as one merged picture. Students were right, the teacher
  // was wrong — and anything they then drew landed on the page the server had switched to.
  broadcast(r, {
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
    const rows = await listPagesWithTitles(db, id);
    const out: { pageNo: number; title: string; elements: unknown[] }[] = [];
    for (const row of rows) {
      const snap = await loadPage(db, id, row.pageNo);
      out.push({ pageNo: row.pageNo, title: row.title, elements: Object.values(snap.elements) });
    }
    return { pages: out, maxPages: MAX_BOARD_PAGES };
  });

  // Teacher saves a page snapshot directly (offline editing after the lesson)
  app.put('/api/lessons/:id/board/page', { preHandler: app.authenticateTeacher }, async (req, reply) => {
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
    // A label is written only when the caller sent one — an edit to the drawing must never clear
    // the teacher's page name.
    const title = p.data.title === undefined ? undefined : sanitizeBoardTitle(p.data.title);
    await db.insert(whiteboards)
      .values({
        sessionId: id, pageNo: p.data.pageNo, snapshot: snapshot as never,
        ...(title === undefined ? {} : { title }), updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [whiteboards.sessionId, whiteboards.pageNo],
        set: {
          snapshot: snapshot as never, updatedAt: new Date(),
          ...(title === undefined ? {} : { title }),
        },
      });
    const r = rooms.get(id);
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
      const role = consumed.role === 'teacher' ? 'teacher' : 'student';
      const r = await getBoardRoom(db, sessionId);
      if (role === 'teacher') r.teacherId = consumed.userId;
      r.sockets.set(socket, { role });
      attachErrorLogging(socket, 'board socket'); // see lib/errorObservers.ts
      socket.on('close', () => {
        r.sockets.delete(socket);
        // flush pending edits, then persist; keep the room in the map until the
        // write finishes so a reconnecting client reuses the in-memory state.
        if (r.broadcastTimer) {
          clearTimeout(r.broadcastTimer); r.broadcastTimer = null;
          const batch = r.pending.splice(0);
          if (batch.length) broadcast(r, { type: 'edits', page: r.current, elements: batch });
        }
        void persist(db, r).then(() => {
          if (r.sockets.size === 0 && rooms.get(sessionId) === r) {
            if (r.autosaveTimer) clearInterval(r.autosaveTimer);
            rooms.delete(sessionId);
          }
        }).catch(() => undefined);
      });
      socket.send(JSON.stringify({
        type: 'init', canEdit: role === 'teacher',
        page: r.current, pages: r.pages, titles: r.titles, elements: Object.values(r.elements),
      }));

      socket.on('message', (raw: Buffer) => {
        void (async () => {
          let msg: { type?: string; page?: number; title?: unknown; elements?: ExEl[] };
          try { msg = JSON.parse(raw.toString()); } catch { return; }
          // SERVER-SIDE PERMISSION GATE: only the owning teacher may write (§3.7/§7). This covers
          // every page-management verb too — a student's newpage/rename/duplicate/delpage/switch
          // returns here, before any state is touched (task 1г).
          const who = r.sockets.get(socket);
          if (!who || who.role !== 'teacher' || consumed.userId !== r.teacherId) return;
          const notice = (code: string, extra: Record<string, unknown> = {}) =>
            socket.send(JSON.stringify({ type: 'notice', code, ...extra }));

          if (msg.type === 'edits' && Array.isArray(msg.elements)) {
            const { changed } = mergeElements(r.elements, msg.elements.filter((e) => e && typeof e.id === 'string'));
            if (changed.length) queueBroadcast(db, r, changed, socket);
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
            r.current = np; r.elements = {}; r.dirty = false;
            // `elements` travels with the page list: the client that created the board has to
            // drop the previous board's scene from its canvas too (see switchPage) — otherwise
            // the teacher keeps seeing the old drawing on top of the new board.
            broadcast(r, { type: 'pages', pages: r.pages, current: np, titles: r.titles, elements: [] });
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
              });
              r.current = np; r.elements = snap.elements; r.dirty = false;
            } catch {
              r.pages = r.pages.filter((x) => x !== np);
              delete r.titles[np];
              return;
            }
            broadcast(r, {
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
              broadcast(r, {
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
