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
  // Элемент без автора (вся доска, нарисованная до части 3) — НЕ ученика: прав на него у ученика
  // это не даёт ни одного, а учителю и не нужно, он правит всё.
  return { elements, appState: row?.snapshot.appState ?? {}, authors: { ...(row?.authors ?? {}) } as Record<string, string> };
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

/**
 * Часть 3 (2026-10-14): что одному ученику можно нарисовать на одной доске. Считается по
 * ФАКТИЧЕСКОЙ сцене сервера, а не по тому, что прислал клиент, и только по элементам, автором
 * которых сервер его записал.
 */
export const MAX_STUDENT_ELEMENTS = 300;
export const MAX_STUDENT_BYTES = 1_048_576;
/**
 * Часть 4 (2026-10-14): потолок ВСЕЙ сцены — 2 МБ разобранного JSON. Он касается и учителя:
 * архив уроков живёт в той же базе, и одна бесконечная доска не должна съедать её.
 */
export const MAX_SCENE_BYTES = 2_000_000;

/**
 * Часть 8 (замер 2026-10-14): потолок точек на один штрих.
 *
 * Измерено на сцене, какой Excalidraw хранит рисованное от руки (20 штрихов по 2000 точек):
 * **639 809 Б** JSON — больше 500 КБ на одну доску, и это один урок. Долгие нажатия пера/пальца
 * дают ~60 точек в секунду, так что 2000 точек — не аномалия, а нормальный плотный штрих. Ровные
 * 500 точек дают 168 475 Б (в 3,8 раза меньше) и не меняют форму: на холсте в 400 px шаг
 * децимации — доли пикселя.
 */
export const MAX_POINTS_PER_ELEMENT = 500;

/**
 * Упрощение штриха: равномерная децимация, где первая и последняя точка сохраняются всегда
 * (иначе оборвётся начало и конец линии). `pressures`/`thinPoints` считаются по прежнему массиву
 * и после децимации были бы парами разной длины — Excalidraw дорисует по устаревшим данным,
 * поэтому они снимаются.
 */
export function simplifyElement(el: ExEl): ExEl {
  const pts = (el as { points?: unknown }).points;
  if (!Array.isArray(pts) || pts.length <= MAX_POINTS_PER_ELEMENT) return el;
  const step = (pts.length - 1) / (MAX_POINTS_PER_ELEMENT - 1);
  const keep: unknown[] = [];
  for (let i = 0; i < MAX_POINTS_PER_ELEMENT - 1; i++) keep.push(pts[Math.round(i * step)]);
  keep.push(pts[pts.length - 1]);
  const next = { ...el, points: keep } as ExEl;
  delete (next as { pressures?: unknown }).pressures;
  delete (next as { thinPoints?: unknown }).thinPoints;
  return next;
}

/** Для маршрута прямого сохранения: та же норма, что и для живого кадра. */
export function simplifyScene(elements: ExEl[]): ExEl[] {
  return elements.map(simplifyElement);
}

/** Размер элемента в байтах (UTF-8), для лимита «1 МБ на ученика на доску». */
function sizeOf(el: ExEl): number {
  return Buffer.byteLength(JSON.stringify(el) ?? '', 'utf8');
}

export interface GateReport {
  accepted: ExEl[];
  /** элементы, которые отправителю трогать нельзя (чужие или сверх лимита) */
  rejected: string[];
  /** среди отказов есть хотя бы один по лимиту ученика — клиенту нужна другая подсказка */
  overLimit: boolean;
  /** хотя бы один отказ — по потолку всей сцены (2 МБ); он бывает и у учителя */
  overScene: boolean;
}

/**
 * Серверный гейт правки доски: что применить, что отбросить и кому принадлежит элемент.
 *
 * Три правила, которые здесь живут, и которые нельзя вынести на клиента:
 *  - автор берётся ИЗ ИДЕНТИЧНОСТИ СОКЕТА (`userId`), а не из тела сообщения: поле `authorId`
 *    в присланном элементе не читается вообще, иначе «поддельный автор» был бы тривиален;
 *  - ученик правит и удаляет только свои элементы. Чужой элемент (учителя или другого ученика)
 *    отбрасывается целиком — не «принимается, но потом откатывается», а не попадает в сцену;
 *  - учитель правит всё, но авторство НЕ переходит: исправленный им ученический элемент остаётся
 *    ученика, иначе «удалить рисунки ученика» оставляло бы на доске то, что ученик и нарисовал.
 *
 * `locked` из запроса выкидывается всегда: это свойство ПОЛУЧАТЕЛЯ, его сервер навешивает при
 * рассылке (чужое ученику не выделилось), и принимать его от клиента означало бы позволить ему
 * разблокировать чужой рисунок.
 *
 * `authors` и счётчики меняются на месте: сообщение может нести несколько элементов сразу, и
 * лимит считается накопленно, а не по каждому элементу отдельно.
 */
export function gateEdits(params: {
  incoming: ExEl[];
  scene: Record<string, ExEl>;
  authors: Record<string, string>;
  userId: string;
  teacher: boolean;
  maxElements?: number;
  maxBytes?: number;
  maxSceneBytes?: number;
}): GateReport {
  const { incoming, scene, authors, userId, teacher } = params;
  const maxElements = params.maxElements ?? MAX_STUDENT_ELEMENTS;
  const maxBytes = params.maxBytes ?? MAX_STUDENT_BYTES;
  const maxScene = params.maxSceneBytes ?? MAX_SCENE_BYTES;
  const accepted: ExEl[] = [];
  const rejected: string[] = [];
  let overLimit = false;
  let overScene = false;

  let mine = 0;
  let mineBytes = 0;
  let total = 0;
  for (const [id, el] of Object.entries(scene)) {
    if (el.isDeleted) continue;
    const size = sizeOf(el);
    total += size;
    if (!teacher && authors[id] === userId) { mine += 1; mineBytes += size; }
  }

  for (const raw of incoming) {
    if (!raw || typeof raw.id !== 'string' || typeof raw.version !== 'number') continue;
    delete (raw as { locked?: unknown }).locked;
    // Нормализация ДО подсчёта байт: лимиты должны считаться по тому, что реально ляжет в базу,
    // а не по тому, что прислал клиент.
    const el = simplifyElement(raw);
    const cur = scene[el.id];
    const author = authors[el.id];
    const curSize = cur && !cur.isDeleted ? sizeOf(cur) : 0;
    // Удаление сцену только уменьшает (merge по `isDeleted` убирает элемент), поэтому под потолок
    // оно не попадает никогда — иначе запретили бы именно то, что место и освобождает.
    const nextTotal = el.isDeleted ? total - curSize : total - curSize + sizeOf(el);

    if (!teacher && cur && author !== userId) { rejected.push(el.id); continue; }
    if (!cur && el.isDeleted) continue; // удалять нечего — это не право на чужое, а пустой кадр
    if (nextTotal > maxScene) { rejected.push(el.id); overScene = true; continue; }

    if (teacher) {
      if (!cur) authors[el.id] = userId;
      if (el.isDeleted) delete authors[el.id];
      total = nextTotal;
      accepted.push(el);
      continue;
    }

    const nextCount = el.isDeleted ? mine - 1 : cur && author === userId ? mine : mine + 1;
    const nextBytes = el.isDeleted
      ? mineBytes - curSize
      : cur && author === userId ? mineBytes - curSize + sizeOf(el) : mineBytes + sizeOf(el);
    if (nextCount > maxElements || nextBytes > maxBytes) {
      rejected.push(el.id);
      overLimit = true;
      continue;
    }
    mine = nextCount;
    mineBytes = nextBytes;
    total = nextTotal;
    if (!cur) authors[el.id] = userId;
    if (el.isDeleted) delete authors[el.id];
    accepted.push(el);
  }
  return { accepted, rejected, overLimit, overScene };
}

/**
 * Часть 3: «закрыть чужое» для конкретного получателя. Ученик не может выделить, сдвинуть,
 * изменить размер или стереть ластиком элемент, у которого `locked: true` (проверено в сборке
 * @excalidraw/excalidraw 0.18.1: `getElementsAtPosition`, лассо, select-all, drag, ручки
 * трансформации, `handleEraser`). Это только удобство интерфейса — право по-прежнему проверяет
 * `gateEdits`, а не клиент.
 */
export function lockForeign(elements: ExEl[], authors: Record<string, string>, userId: string): ExEl[] {
  return elements.map((el) => (authors[el.id] === userId ? el : { ...el, locked: true }));
}

/** Сколько элементов какого ученика лежит на доске — для учительского «удалить рисунки ученика». */
export function countByAuthor(scene: Record<string, ExEl>, authors: Record<string, string>) {
  const out: Record<string, number> = {};
  for (const [id, el] of Object.entries(scene)) {
    if (el.isDeleted) continue;
    const a = authors[id];
    if (!a) continue;
    out[a] = (out[a] ?? 0) + 1;
  }
  return out;
}

/**
 * Мягкое удаление всех элементов одного автора: возвращаются ТУМБСТОУНЫ с новой версией (иначе
 * mergeElements сочтёт их устаревшими и удаление никуда не поедет), а сцена остаётся на совести
 * обычного merge — тот же путь, что и у любой правки, поэтому и удаление исчезает из карты
 * элементов ровно так же, как у ученика, стёршего ластиком.
 */
export function wipeAuthor(scene: Record<string, ExEl>, authors: Record<string, string>, userId: string): ExEl[] {
  const wiped: ExEl[] = [];
  for (const [id, el] of Object.entries(scene)) {
    if (el.isDeleted || authors[id] !== userId) continue;
    wiped.push({
      ...el, isDeleted: true, version: (el.version ?? 0) + 1, versionNonce: (Math.random() * 2 ** 31) | 0,
    });
    delete authors[id];
  }
  return wiped;
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
