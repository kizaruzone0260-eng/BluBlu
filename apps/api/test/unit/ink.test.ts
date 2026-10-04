import { describe, it, expect } from 'vitest';
import { composeInk, extractInk, inkSize, pathD, INK_MAX_ENCODED } from '../../../web/src/lib/ink';

/** item 3 — pure drawing serialization (lives in apps/web but tested with the API suite). */
describe('note ink serialization (lib/ink)', () => {
  const ink = { strokes: [{ c: '#0f766e', w: 4, pts: [[10, 20], [30, 40]] }] };

  it('compose → extract round-trips strokes', () => {
    const body = composeInk('<p>текст</p>', ink);
    expect(body).toContain('data-note-drawing="');
    const { rest, ink: back } = extractInk(body);
    expect(rest).toBe('<p>текст</p>');
    expect(back?.strokes[0]?.pts).toEqual([[10, 20], [30, 40]]);
  });

  it('no drawing → body unchanged; empty strokes compose to plain body', () => {
    expect(extractInk('<p>x</p>').ink).toBeNull();
    expect(composeInk('<p>x</p>', { strokes: [] })).toBe('<p>x</p>');
    expect(composeInk('<p>x</p>', null)).toBe('<p>x</p>');
  });

  it('malformed payload reads as no drawing (rest still stripped)', () => {
    const { rest, ink: back } = extractInk('<p>a</p><div class="note-drawing" data-note-drawing="%zz{"></div>');
    expect(back).toBeNull();
    expect(rest).toBe('<p>a</p>');
  });

  it('oversized drawings are NOT embedded (500 KB cap, item 3)', () => {
    const huge = { strokes: Array.from({ length: 40_000 }, () => ({ c: '#000', w: 1, pts: [[1, 2], [3, 4]] })) };
    expect(inkSize(huge)).toBeGreaterThan(INK_MAX_ENCODED);
    expect(composeInk('<p>a</p>', huge)).toBe('<p>a</p>');
  });

  it('a single-dot stroke still yields a path', () => {
    expect(pathD([[5, 5]])).toMatch(/^M 5 5 L/);
    expect(pathD([])).toBe('');
  });
});
