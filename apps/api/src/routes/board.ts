import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import type { WebSocket } from 'ws';
import { z } from 'zod';
import type { DB } from '../db/index.js';
import { consumeWsTicket } from '../services/wsTicket.js';
import { resolveClass } from '../services/classes.js';
import { getSession } from '../services/lessons.js';
import { whiteboards, lessonSessions } from '../db/schema.js';
import {
  loadPage, listPages, mergeElements, type ExEl,
} from '../services/board.js';
import { createMaterial } from '../services/posts.js';

const BROADCAST_MS = 30;   // §3.7 throttle
const AUTOSAVE_MS = 10_000; // §3.7 autosave every 10 s

interface BoardRoom {
  sessionId: string;
  teacherId: string;
  current: number;
  pages: number[];
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
  const pages = await listPages(db, sessionId);
  const first = pages[0]!;
  const snap = await loadPage(db, sessionId, first);
  r = {
    sessionId, teacherId: s.createdBy, current: first, pages,
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

async function switchPage(db: DB, r: BoardRoom, pageNo: number, from?: WebSocket) {
  await persist(db, r);
  const snap = await loadPage(db, r.sessionId, pageNo);
  r.current = pageNo;
  r.elements = snap.elements;
  broadcast(r, { type: 'current', page: pageNo, elements: Object.values(snap.elements) }, from);
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
    const pages = await listPages(db, id);
    const out: { pageNo: number; elements: unknown[] }[] = [];
    for (const p of pages) {
      const snap = await loadPage(db, id, p);
      out.push({ pageNo: p, elements: Object.values(snap.elements) });
    }
    return { pages: out };
  });

  // Teacher saves a page snapshot directly (offline editing after the lesson)
  app.put('/api/lessons/:id/board/page', { preHandler: app.authenticateTeacher }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const s = await getSession(db, id);
    if (!s) return reply.code(404).send({ error: 'notFound' });
    const cls = await resolveClass(db, req.user!.id, 'teacher', s.classId);
    if (!cls) return reply.code(404).send({ error: 'notFound' });
    const p = z.object({
      pageNo: z.number().int().min(1).max(50),
      elements: z.array(z.object({ id: z.string() }).passthrough()),
    }).safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: 'invalidInput' });
    const snapshot = { elements: p.data.elements, appState: {} };
    await db.insert(whiteboards)
      .values({ sessionId: id, pageNo: p.data.pageNo, snapshot: snapshot as never, updatedAt: new Date() })
      .onConflictDoUpdate({ target: [whiteboards.sessionId, whiteboards.pageNo], set: { snapshot: snapshot as never, updatedAt: new Date() } });
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
      { title: p.data.title, description: '' },
      [{ buffer, filename: `${p.data.title || 'board'}.${p.data.kind === 'png' ? 'png' : 'svg'}` }]);
    void mime;
    return reply.code(201).send({ postId: post.id });
  });

  // ── board WebSocket (one-time ticket auth, §audit) ──
  app.get('/api/ws/board/:id', { websocket: true }, (socket: WebSocket, req) => {
    void (async () => {
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
        page: r.current, pages: r.pages, elements: Object.values(r.elements),
      }));

      socket.on('message', (raw: Buffer) => {
        void (async () => {
          let msg: { type?: string; page?: number; elements?: ExEl[] };
          try { msg = JSON.parse(raw.toString()); } catch { return; }
          // SERVER-SIDE PERMISSION GATE: only the owning teacher may write (§3.7/§7)
          const who = r.sockets.get(socket);
          if (!who || who.role !== 'teacher' || consumed.userId !== r.teacherId) return;
          if (msg.type === 'edits' && Array.isArray(msg.elements)) {
            const { changed } = mergeElements(r.elements, msg.elements.filter((e) => e && typeof e.id === 'string'));
            if (changed.length) queueBroadcast(db, r, changed, socket);
            return;
          }
          if (msg.type === 'switch' && typeof msg.page === 'number' && r.pages.includes(msg.page)) {
            await switchPage(db, r, msg.page, socket);
            return;
          }
          if (msg.type === 'newpage') {
            await persist(db, r);
            const np = Math.max(...r.pages) + 1;
            r.pages.push(np);
            await db.insert(whiteboards).values({ sessionId: r.sessionId, pageNo: np, snapshot: { elements: [], appState: {} } as never });
            r.current = np; r.elements = {}; r.dirty = false;
            broadcast(r, { type: 'pages', pages: r.pages, current: np });
            return;
          }
          if (msg.type === 'delpage' && typeof msg.page === 'number' && r.pages.length > 1 && r.pages.includes(msg.page)) {
            await db.delete(whiteboards).where(and(eq(whiteboards.sessionId, r.sessionId), eq(whiteboards.pageNo, msg.page)));
            r.pages = r.pages.filter((x) => x !== msg.page);
            if (r.current === msg.page) { await switchPage(db, r, r.pages[0]!); }
            broadcast(r, { type: 'pages', pages: r.pages, current: r.current });
            return;
          }
        })().catch(() => undefined);
      });
    })().catch(() => socket.close(1011));
  });
}
