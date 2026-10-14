import { describe, it, expect } from 'vitest';
import {
  gateEdits, lockForeign, countByAuthor, wipeAuthor, mergeElements,
  simplifyElement, simplifyScene, MAX_POINTS_PER_ELEMENT,
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

  it('the whole scene is capped — and the cap holds the teacher too', () => {
    const big = el('t1', 1, { data: 'x'.repeat(600_000) });
    const { scene, authors } = fresh([T, big], [T, el('t2')]);
    const r = gateEdits({
      incoming: [el('t3', 1, { data: 'y'.repeat(600_000) })], scene, authors, userId: T, teacher: true,
      maxSceneBytes: 900_000,
    });
    expect(r.accepted).toEqual([]);
    expect(r.overScene).toBe(true);
    expect(r.overLimit, 'это не лимит ученика — подсказка другая').toBe(false);
  });

  it('deleting never hits the scene cap: it is what frees the space', () => {
    const big = el('t1', 1, { data: 'x'.repeat(600_000) });
    const { scene, authors } = fresh([T, big]);
    const r = gateEdits({
      incoming: [el('t1', 2, { data: 'x'.repeat(600_000), isDeleted: true })], scene, authors,
      userId: T, teacher: true, maxSceneBytes: 100,
    });
    expect(r.accepted.length).toBe(1);
    expect(r.overScene).toBe(false);
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

describe('плотный штрих от руки: замер и упрощение (часть 8, 2026-10-14)', () => {
  /**
   * Штрих ровно в том виде, в каком Excalidraw кладёт его в snapshot: массив пар координат.
   * 2000 точек — не выдумка: перо/палец дают ~60 снимков в секунду, долгий росчерк их набирает
   * столько сам.
   */
  const stroke = (id: string, n: number): ExEl => ({
    id, version: 1, versionNonce: 1, type: 'draw', x: 12, y: 34, width: 400, height: 220,
    points: Array.from({ length: n }, (_, i) => [
      Math.round(400 * (i / (n - 1)) * 100) / 100,
      Math.round(220 * Math.sin((i / (n - 1)) * 6.2) * 100) / 100,
    ]),
    pressures: Array.from({ length: n }, (_, i) => i % 3),
    lastCommittedPoint: null, simulatePressureParsing: false,
  });
  const bytes = (o: unknown) => Buffer.byteLength(JSON.stringify(o), 'utf8');

  it('измеряет плотную доску: до упрощения за 500 КБ, после — внутри', () => {
    const raw = Array.from({ length: 20 }, (_, i) => stroke(`d${i}`, 2000));
    const rawBytes = bytes({ elements: raw });
    const gate = gateEdits({
      incoming: raw, scene: {}, authors: {}, userId: T, teacher: true,
    });
    const afterBytes = bytes({ elements: gate.accepted });
    console.log(`MEASURE freehand 20x2000: до ${rawBytes} Б, после ${afterBytes} Б, отказов ${gate.rejected.length}`);
    expect(gate.accepted).toHaveLength(20);
    expect(gate.rejected, 'после нормализации сцена не упирается в потолок').toEqual([]);
    expect(rawBytes, 'замер: такая доска больше порога в 500 КБ').toBeGreaterThan(500_000);
    expect(afterBytes, 'упрощённая та же доска — меньше порога').toBeLessThan(500_000);
    for (const e of gate.accepted) {
      expect((e.points as unknown[]).length, 'потолок точек на штрих').toBe(MAX_POINTS_PER_ELEMENT);
      expect(e.pressures, 'давления по прежнему массиву снимаются').toBeUndefined();
    }
  });

  it('упрощение держит первую и последнюю точки, а короткий штрих не трогает вовсе', () => {
    const long = stroke('d1', 2000);
    const simple = simplifyElement(long);
    const pts = simple.points as number[][];
    expect(pts.length).toBe(MAX_POINTS_PER_ELEMENT);
    expect(pts[0], 'начало линии остаётся на месте').toEqual((long.points as number[][])[0]);
    expect(pts[pts.length - 1], 'конец линии остаётся на месте').toEqual((long.points as number[][]).at(-1));
    const short = el('short');
    expect(simplifyElement(short), 'то, что короче потолка, возвращается тем же объектом').toBe(short);
  });

  it('прямое сохранение страницы нормализует так же', () => {
    const out = simplifyScene([stroke('a', 1200), el('b')]);
    expect((out[0].points as unknown[]).length).toBe(MAX_POINTS_PER_ELEMENT);
    expect((out[1].points as unknown[]).length, 'короткий элемент не тронут').toBe(2);
  });
});
