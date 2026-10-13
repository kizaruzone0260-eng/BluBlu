import { describe, it, expect } from 'vitest';
import {
  gateEdits, lockForeign, countByAuthor, wipeAuthor, mergeElements,
  MAX_STUDENT_ELEMENTS, MAX_STUDENT_BYTES, type ExEl,
} from '../../src/services/board.js';

/**
 * Часть 3 (2026-10-14): серверный гейт правки доски.
 *
 * Это та функция, которая решает «можно или нельзя», и она обязана быть проверяемой без
 * браузера и без сокета: e2e покажет только то, что разрешение работает, а то, что его НЕЛЬЗЯ
 * обойти, видно именно здесь. Каждый случай ниже — отдельная дыра, которую закрыли:
 *  - автор берётся из сокета, а не из тела сообщения (иначе «поддельный автор» тривиален);
 *  - чужой элемент не применяется к сцене даже частично (не «приняли и откатили», а не приняли);
 *  - лимит считается накопленно по всему кадру, а не по каждому элементу (кадр несёт десятки);
 *  - учитель, поправивший ученический рисунок, не становится его автором — иначе «удалить
 *    рисунки ученика» оставляло бы на доске ровно то, что ученик и нарисовал.
 */
const el = (id: string, version = 1, extra: Record<string, unknown> = {}): ExEl =>
  ({ id, version, versionNonce: 100 + version, type: 'draw', points: [[0, 0], [1, 1]], ...extra });

const T = 'teacher-1';
const A = 'student-a';
const B = 'student-b';

function fresh(...seed: [string, ExEl][]) {
  const scene: Record<string, ExEl> = {};
  const authors: Record<string, string> = {};
  for (const [who, e] of seed) { scene[e.id] = e; authors[e.id] = who; }
  return { scene, authors };
}

describe('gateEdits — кто что имеет право менять на доске', () => {
  it('a new element is accepted and recorded as drawn by the socket owner', () => {
    const { scene, authors } = fresh();
    const r = gateEdits({ incoming: [el('x1')], scene, authors, userId: A, teacher: false });
    expect(r.accepted.map((e) => e.id)).toEqual(['x1']);
    expect(r.rejected).toEqual([]);
    expect(authors.x1).toBe(A);
  });

  it('the author the client claims in the body is ignored — authorship comes from the socket', () => {
    const { scene, authors } = fresh();
    // Ни `authorId`, ни `userId` в элементе сервер не читает: у Excalidraw вообще нет поля автора,
    // и единственное, чему здесь верят, — идентичность сокета, попавшая в `gateEdits`.
    const fake = el('x1', 1, { authorId: T, userId: T });
    const r = gateEdits({ incoming: [fake], scene, authors, userId: A, teacher: false });
    expect(r.accepted.length).toBe(1);
    expect(authors.x1).toBe(A);
  });

  it('a student may change their own element and delete it', () => {
    const { scene, authors } = fresh([A, el('x1')]);
    const moved = gateEdits({ incoming: [el('x1', 2, { x: 40 })], scene, authors, userId: A, teacher: false });
    expect(moved.accepted.map((e) => e.id)).toEqual(['x1']);
    expect(moved.rejected).toEqual([]);

    const gone = gateEdits({ incoming: [el('x1', 3, { isDeleted: true })], scene, authors, userId: A, teacher: false });
    expect(gone.accepted.length).toBe(1);
    expect(authors.x1).toBeUndefined();
  });

  it('a student cannot touch the teacher’s element, and it never reaches the scene', () => {
    const { scene, authors } = fresh([T, el('t1')]);
    const r = gateEdits({ incoming: [el('t1', 9, { x: 999 })], scene, authors, userId: A, teacher: false });
    expect(r.accepted).toEqual([]);
    expect(r.rejected).toEqual(['t1']);
    expect(scene.t1.x).toBeUndefined();
    expect(authors.t1).toBe(T);
  });

  it('a student cannot touch another student’s element either', () => {
    const { scene, authors } = fresh([B, el('b1')]);
    const r = gateEdits({ incoming: [el('b1', 5), el('b1', 6, { isDeleted: true })], scene, authors, userId: A, teacher: false });
    expect(r.accepted).toEqual([]);
    expect(r.rejected).toEqual(['b1', 'b1']);
  });

  it('deleting something that is not there is not a violation and not a change', () => {
    const { scene, authors } = fresh();
    const r = gateEdits({ incoming: [el('ghost', 2, { isDeleted: true })], scene, authors, userId: A, teacher: false });
    expect(r.accepted).toEqual([]);
    expect(r.rejected).toEqual([]);
  });

  it('the element count limit is cumulative across ONE frame', () => {
    const { scene, authors } = fresh();
    const r = gateEdits({
      incoming: [el('a'), el('b'), el('c'), el('d')], scene, authors, userId: A, teacher: false,
      maxElements: 2, maxBytes: MAX_STUDENT_BYTES,
    });
    expect(r.accepted.map((e) => e.id)).toEqual(['a', 'b']);
    expect(r.rejected).toEqual(['c', 'd']);
    expect(r.overLimit).toBe(true);
    expect(Object.keys(authors)).toEqual(['a', 'b']);
  });

  it('growing your own element past the byte limit is refused, and the old version stays', () => {
    const { scene, authors } = fresh([A, el('x1')]);
    const before = JSON.stringify(scene.x1);
    const fat = el('x1', 2, { data: 'x'.repeat(4000) });
    const r = gateEdits({ incoming: [fat], scene, authors, userId: A, teacher: false, maxElements: 300, maxBytes: 1000 });
    expect(r.accepted).toEqual([]);
    expect(r.rejected).toEqual(['x1']);
    expect(r.overLimit).toBe(true);
    expect(JSON.stringify(scene.x1)).toBe(before);
  });

  it('the defaults are the documented ones: 300 elements and 1 MB per student per board', () => {
    expect(MAX_STUDENT_ELEMENTS).toBe(300);
    expect(MAX_STUDENT_BYTES).toBe(1_048_576);
  });

  it('the teacher may edit anything and does NOT steal authorship of a student’s element', () => {
    const { scene, authors } = fresh([A, el('x1')]);
    const r = gateEdits({ incoming: [el('x1', 2, { x: 7 }), el('new1')], scene, authors, userId: T, teacher: true });
    expect(r.accepted.map((e) => e.id)).toEqual(['x1', 'new1']);
    expect(authors.x1).toBe(A);
    expect(authors.new1).toBe(T);
  });

  it('the teacher is not bound by the student limits', () => {
    const seed: [string, ExEl][] = Array.from({ length: 400 }, (_, i) => [T, el(`t${i}`)] as [string, ExEl]);
    const { scene, authors } = fresh(...seed);
    const r = gateEdits({ incoming: [el('extra', 1)], scene, authors, userId: T, teacher: true });
    expect(r.accepted.length).toBe(1);
    expect(r.overLimit).toBe(false);
  });

  it('a frame without a version is dropped silently — it is not a permission case', () => {
    const { scene, authors } = fresh();
    const r = gateEdits({ incoming: [{ id: 'nope' } as unknown as ExEl], scene, authors, userId: A, teacher: false });
    expect(r.accepted).toEqual([]);
    expect(r.rejected).toEqual([]);
  });

  it('`locked` never comes from the client: the server strips it before the scene sees it', () => {
    const { scene, authors } = fresh();
    const r = gateEdits({ incoming: [el('x1', 1, { locked: false })], scene, authors, userId: A, teacher: false });
    const stored: Record<string, ExEl> = {};
    mergeElements(stored, r.accepted);
    expect('locked' in stored.x1).toBe(false);
  });
});

describe('lockForeign / countByAuthor / wipeAuthor — что сервер делает с авторством', () => {
  it('foreign elements arrive locked for a student, own ones untouched', () => {
    const { authors } = fresh([A, el('mine')], [T, el('theirs')]);
    const out = lockForeign([el('mine'), el('theirs')], authors, A);
    expect('locked' in out[0]).toBe(false);
    expect(out[1].locked).toBe(true);
  });

  it('an element without an author is foreign too (the board predates part 3)', () => {
    const out = lockForeign([el('legacy')], {}, A);
    expect(out[0].locked).toBe(true);
  });

  it('counts skip deleted and unauthored elements', () => {
    const { scene, authors } = fresh([A, el('a1')], [A, el('a2')], [B, el('b1')]);
    scene.a2 = el('a2', 2, { isDeleted: true });
    scene.legacy = el('legacy');
    expect(countByAuthor(scene, authors)).toEqual({ [A]: 1, [B]: 1 });
  });

  it('wiping an author soft-deletes with a NEW version, and the usual merge removes the element', () => {
    const { scene, authors } = fresh([A, el('a1', 4)], [B, el('b1', 2)]);
    const wiped = wipeAuthor(scene, authors, A);
    expect(wiped.length).toBe(1);
    expect(wiped[0].isDeleted).toBe(true);
    expect(wiped[0].version).toBe(5);
    expect(authors.a1).toBeUndefined();
    expect(authors.b1).toBe(B); // чужое не тронуто
    mergeElements(scene, wiped);
    expect(scene.a1, 'merge по isDeleted убирает элемент со сцены').toBeUndefined();
    expect(scene.b1).toBeDefined();
  });
});
