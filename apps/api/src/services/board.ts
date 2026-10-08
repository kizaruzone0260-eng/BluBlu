import { and, eq } from 'drizzle-orm';
import { whiteboards, lessonSessions } from '../db/schema.js';
import type { DB } from '../db/index.js';
import type { WebSocket } from 'ws';

export interface ExEl {
  id: string; version: number; versionNonce: number; isDeleted?: boolean;
  type?: string; [k: string]: unknown;
}

type Snap = { elements: Record<string, ExEl>; current: number; pages: number[] };

/**
 * Live board rooms (§3.7). Only the owning teacher's edits are accepted;
 * messages from anyone else are ignored on the server. Clients get an
 * incremental broadcast throttled to ~30 ms and a full snapshot on join.
 */
interface BoardRoom {
  sessionId: string;
  teacherIdentity: string;
  page: Snap;               // current merged page cache per page no
  sockets: Map<WebSocket, { role: 'teacher' | 'student' }>;
  dirty: Set<number>;
  timer: NodeJS.Timeout | null;
}

const rooms = new Map<string, BoardRoom>();

export async function loadPage(db: DB, sessionId: string, pageNo: number) {
  const [row] = await db.select().from(whiteboards)
    .where(and(eq(whiteboards.sessionId, sessionId), eq(whiteboards.pageNo, pageNo))).limit(1);
  const elements: Record<string, ExEl> = {};
  for (const el of (row?.snapshot.elements ?? []) as ExEl[]) elements[el.id] = el;
  return { elements, appState: row?.snapshot.appState ?? {} };
}

export async function listPages(db: DB, sessionId: string) {
  const rows = await db.select({ pageNo: whiteboards.pageNo }).from(whiteboards)
    .where(eq(whiteboards.sessionId, sessionId));
  const nums = rows.map((r) => r.pageNo);
  return nums.length ? nums : [1];
}

/**
 * Pages with the teacher's labels (board-pages task 1б). A session whose board was never
 * written has no rows at all, so page 1 is synthesised — it exists conceptually and gets its
 * row on the first persist.
 */
export async function listPagesWithTitles(db: DB, sessionId: string) {
  const rows = await db.select({ pageNo: whiteboards.pageNo, title: whiteboards.title }).from(whiteboards)
    .where(eq(whiteboards.sessionId, sessionId)).orderBy(whiteboards.pageNo);
  return rows.length ? rows : [{ pageNo: 1, title: '' }];
}

export function getRoom(sessionId: string, teacherIdentity: string): BoardRoom {
  let r = rooms.get(sessionId);
  if (!r) {
    r = { sessionId, teacherIdentity, page: { elements: {}, current: 1, pages: [1] }, sockets: new Map(), dirty: new Set(), timer: null };
    rooms.set(sessionId, r);
  }
  return r;
}

export async function initRoom(db: DB, sessionId: string): Promise<BoardRoom> {
  const r = getRoom(sessionId, '');
  r.page.pages = await listPages(db, sessionId);
  r.page.current = r.page.pages[0]!;
  const snap = await loadPage(db, sessionId, r.page.current);
  r.page.elements = snap.elements;
  return r;
}

/** Merge per Excalidraw collab rules: higher version wins; ties broken by nonce. */
export function mergeElements(target: Record<string, ExEl>, incoming: ExEl[]): { changed: ExEl[] } {
  const changed: ExEl[] = [];
  for (const el of incoming) {
    if (!el || typeof el.id !== 'string' || typeof el.version !== 'number') continue;
    const cur = target[el.id];
    if (!cur || el.version > cur.version || (el.version === cur.version && (el.versionNonce ?? 0) > (cur.versionNonce ?? 0))) {
      if (el.isDeleted) delete target[el.id];
      else target[el.id] = el;
      changed.push(el);
    }
  }
  return { changed };
}

export function snapshotOf(r: BoardRoom) {
  return {
    elements: Object.values(r.page.elements),
    appState: {},
  };
}

export async function flushPage(db: DB, r: BoardRoom) {
  if (r.dirty.size === 0) return;
  for (const pageNo of r.dirty) {
    const snapshot = snapshotOf({ ...r, page: r.page }); // current page only for now
    await db.insert(whiteboards)
      .values({ sessionId: r.sessionId, pageNo, snapshot: snapshot as never, updatedAt: new Date() })
      .onConflictDoUpdate({ target: [whiteboards.sessionId, whiteboards.pageNo], set: { snapshot: snapshot as never, updatedAt: new Date() } });
  }
  r.dirty.clear();
}

/** 10-second autosave timer (§3.7) started on first edit, stopped on room close. */
export function ensureAutosave(db: DB, r: BoardRoom) {
  if (r.timer) return;
  r.timer = setInterval(() => { void flushPage(db, r); }, 10_000);
  r.timer.unref?.();
}

export function stopRoom(sessionId: string) {
  const r = rooms.get(sessionId);
  if (!r) return;
  if (r.timer) clearInterval(r.timer);
  rooms.delete(sessionId);
}

export function roomSockets(sessionId: string): Map<WebSocket, { role: 'teacher' | 'student' }> | null {
  return rooms.get(sessionId)?.sockets ?? null;
}

export function registerSocket(sessionId: string, socket: WebSocket, role: 'teacher' | 'student') {
  const r = getRoom(sessionId, role === 'teacher' ? '' : '');
  r.sockets.set(socket, { role });
  socket.on('close', () => {
    r.sockets.delete(socket);
    if (r.sockets.size === 0) stopRoom(sessionId);
  });
  return r;
}

export async function setSessionTeacher(db: DB, sessionId: string) {
  const [s] = await db.select({ createdBy: lessonSessions.createdBy }).from(lessonSessions).where(eq(lessonSessions.id, sessionId)).limit(1);
  return s?.createdBy ?? '';
}
