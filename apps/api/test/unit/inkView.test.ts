import { describe, it, expect } from 'vitest';
import { zoomAt, panBy, toWorld, viewBoxOf, fitView, strokesBBox, clampK, INK_MIN_K, INK_MAX_K } from '@klass/shared';

const SIZE = { w: 800, h: 400 };

describe('ink viewport math (drawing task §6)', () => {
  it('zoomAt keeps the anchor point under the cursor', () => {
    const v = { x: 10, y: 20, k: 1 };
    const z = zoomAt(v, SIZE, 400, 200, 2);
    expect(z.k).toBe(2);
    // the world point under (400,200) before and after must be identical
    expect(toWorld(z, 400, 200)).toEqual(toWorld(v, 400, 200));
  });

  it('zoom is clamped to [0.25, 8]', () => {
    expect(clampK(100)).toBe(INK_MAX_K);
    expect(clampK(0.01)).toBe(INK_MIN_K);
    const tiny = zoomAt({ x: 0, y: 0, k: 0.3 }, SIZE, 0, 0, 0.01);
    expect(tiny.k).toBe(INK_MIN_K);
  });

  it('panBy moves the window opposite to the drag (screen px / k)', () => {
    const v = panBy({ x: 0, y: 0, k: 2 }, 100, 50);
    expect(v).toEqual({ x: -50, y: -25, k: 2 });
  });

  it('viewBoxOf exposes the window; world coords are unbounded (field grows)', () => {
    const vb = viewBoxOf({ x: -1000, y: -2000, k: 1 }, SIZE);
    expect(vb).toBe('-1000 -2000 800 400');
    const far = toWorld({ x: 0, y: 0, k: 1 }, 1e6, 1e6);
    expect(far).toEqual([1e6, 1e6]); // no clamping anywhere
  });

  it('strokesBBox + fitView: whole drawing visible, old (0..1000) drawings fit', () => {
    const strokes = [{ pts: [[0, 0], [1000, 400]] }]; // exactly what pre-§6 drawings used
    const box = strokesBBox(strokes)!;
    expect(box).toEqual({ x: 0, y: 0, w: 1000, h: 400 });
    const v = fitView(SIZE, strokes);
    expect(v.k).toBeGreaterThan(0.5);
    expect(v.k).toBeLessThanOrEqual(2);
    const [wx0, wy0] = toWorld(v, 0, 0);
    const [wx1, wy1] = toWorld(v, SIZE.w, SIZE.h);
    expect(wx0).toBeLessThanOrEqual(0);
    expect(wy0).toBeLessThanOrEqual(0);
    expect(wx1).toBeGreaterThanOrEqual(1000);
    expect(wy1).toBeGreaterThanOrEqual(400);
  });

  it('fitView without strokes is the identity view', () => {
    expect(fitView(SIZE, [])).toEqual({ x: 0, y: 0, k: 1 });
    expect(strokesBBox([])).toBeNull();
  });
});
