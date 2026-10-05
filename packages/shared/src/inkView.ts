/**
 * Drawing viewport math (calendar/ink task §6) — pure, no DOM, so the unit
 * tests cover zoom/pan/fit without a browser. Strokes are stored in WORLD
 * coordinates; the visible window is view = { x, y, k }: the svg shows the
 * rect starting at (x, y) with 1 screen px = 1/k world units. Old drawings
 * (created before pan/zoom existed) are plain world strokes too — they open
 * unchanged, and «show all» simply fits them.
 */

export interface InkView0 { x: number; y: number; k: number }
export interface InkSize { w: number; h: number }
type Pts = { pts: number[][] };

export const INK_MIN_K = 0.25;
export const INK_MAX_K = 8;

export function clampK(k: number): number {
  return Math.min(INK_MAX_K, Math.max(INK_MIN_K, k));
}

/** Zoom by `factor` keeping the screen point (px, py) (relative to the svg box) fixed. */
export function zoomAt(v: InkView0, size: InkSize, px: number, py: number, factor: number): InkView0 {
  const k = clampK(v.k * factor);
  const wx = v.x + px / v.k;
  const wy = v.y + py / v.k;
  return { x: wx - px / k, y: wy - py / k, k };
}

/** Pan by a screen-pixel delta (drag with the hand tool / two fingers). */
export function panBy(v: InkView0, dxScreen: number, dyScreen: number): InkView0 {
  return { x: v.x - dxScreen / v.k, y: v.y - dyScreen / v.k, k: v.k };
}

/** Screen px → world coords. */
export function toWorld(v: InkView0, px: number, py: number): [number, number] {
  return [v.x + px / v.k, v.y + py / v.k];
}

export function viewBoxOf(v: InkView0, size: InkSize): string {
  return `${v.x} ${v.y} ${size.w / v.k} ${size.h / v.k}`;
}

export function strokesBBox(strokes: Pts[]): { x: number; y: number; w: number; h: number } | null {
  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
  for (const s of strokes) {
    for (const p of s.pts) {
      const x = p[0]; const y = p[1];
      if (x === undefined || y === undefined) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (!Number.isFinite(minX)) return null;
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** «Show all»: fit every stroke into the visible box with padding (identity when empty). */
export function fitView(size: InkSize, strokes: Pts[]): InkView0 {
  const box = strokesBBox(strokes);
  if (!box) return { x: 0, y: 0, k: 1 };
  const pad = 40;
  const k = clampK(Math.min((size.w - pad * 2) / Math.max(box.w, 1), (size.h - pad * 2) / Math.max(box.h, 1), 2));
  return {
    x: box.x + box.w / 2 - size.w / k / 2,
    y: box.y + box.h / 2 - size.h / k / 2,
    k,
  };
}
