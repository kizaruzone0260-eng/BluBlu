import { describe, it, expect } from 'vitest';
import {
  pickStageContent, stageSwitchVisible, stripKeys, clampScreenK, zoomScreenAt, panScreenBy,
  SCREEN_MIN_K, SCREEN_MAX_K, type StageInput,
} from '@klass/shared';

/** The stage decision of the lesson page (screen-demonstration task, 2026-10-08). */
const base: StageInput = {
  boardOpen: false, layout: 'auto', hasScreen: false, hasPinned: false,
  hasSpeaker: false, hasPerson: true,
};

describe('lesson stage: what owns the main window', () => {
  it('a screen share becomes the main window in every layout', () => {
    for (const layout of ['auto', 'gallery', 'stage', 'teacher'] as const) {
      expect(pickStageContent({ ...base, layout, hasScreen: true }), `layout ${layout}`)
        .toBe('screen');
    }
  });

  it('the screen beats the open board, and the board stays reachable', () => {
    expect(pickStageContent({ ...base, hasScreen: true, boardOpen: true })).toBe('screen');
    expect(pickStageContent({ ...base, hasScreen: true, boardOpen: true, showBoardInstead: true })).toBe('board');
    // the switch only makes sense while both exist
    expect(stageSwitchVisible({ ...base, hasScreen: true, boardOpen: true })).toBe(true);
    expect(stageSwitchVisible({ ...base, hasScreen: true, boardOpen: false })).toBe(false);
    expect(stageSwitchVisible({ ...base, hasScreen: false, boardOpen: true })).toBe(false);
  });

  it('without a screen the board is still the main window (task B behaviour kept)', () => {
    expect(pickStageContent({ ...base, boardOpen: true, layout: 'gallery' })).toBe('board');
  });

  it('an explicit pin wins over the screen — it is a deliberate local choice', () => {
    expect(pickStageContent({ ...base, hasScreen: true, hasPinned: true })).toBe('pinned');
  });

  it('stopping the share returns the layout that was in force before it', () => {
    expect(pickStageContent({ ...base, layout: 'gallery' })).toBe('grid');
    expect(pickStageContent({ ...base, layout: 'teacher' })).toBe('spotlight');
    expect(pickStageContent({ ...base, layout: 'stage' })).toBe('spotlight');
    expect(pickStageContent({ ...base, layout: 'auto', hasSpeaker: true })).toBe('speaker');
    expect(pickStageContent({ ...base, layout: 'auto' })).toBe('grid');
  });

  it('an empty room is a grid, not an empty main window', () => {
    expect(pickStageContent({ ...base, hasPerson: false, layout: 'teacher' })).toBe('grid');
    expect(pickStageContent({ ...base, hasPerson: false, layout: 'stage' })).toBe('grid');
  });

  it('the strip drops whatever the main window already shows', () => {
    const tiles = [
      { key: 'screen', local: false, screen: true },
      { key: 'me', local: true, screen: false },
      { key: 'teacher', local: false, screen: false },
      { key: 'p3', local: false, screen: false },
    ];
    expect(stripKeys(tiles, {
      stageKey: 'screen', hasStage: true, localCameraKey: 'me', teacherFloats: false, teacherKey: 'teacher',
    })).toEqual(['teacher', 'p3']);
    // while the board owns the stage, the teacher's camera floats instead of sitting in the strip
    expect(stripKeys(tiles, {
      stageKey: null, hasStage: true, localCameraKey: 'me', teacherFloats: true, teacherKey: 'teacher',
    })).toEqual(['screen', 'p3']);
  });
});

describe('lesson stage: zoom of the shared picture', () => {
  it('clamps to [1, 6]', () => {
    expect(clampScreenK(0.2)).toBe(SCREEN_MIN_K);
    expect(clampScreenK(99)).toBe(SCREEN_MAX_K);
    expect(zoomScreenAt({ x: 0, y: 0, k: 5 }, 100, 100, 3).k).toBe(SCREEN_MAX_K);
    expect(zoomScreenAt({ x: 0, y: 0, k: 1.1 }, 100, 100, 0.2).k).toBe(SCREEN_MIN_K);
  });

  it('keeps the point under the cursor still, like the notes zoom does', () => {
    const v = { x: 30, y: 12, k: 1.4 };
    const z = zoomScreenAt(v, 400, 200, 1.5);
    const before = [(400 / v.k) + v.x, (200 / v.k) + v.y];
    const after = [(400 / z.k) + z.x, (200 / z.k) + z.y];
    expect(after[0]).toBeCloseTo(before[0], 9);
    expect(after[1]).toBeCloseTo(before[1], 9);
  });

  it('panning at k = 1 does nothing (there is nothing outside the box to reveal)', () => {
    expect(panScreenBy({ x: 0, y: 0, k: 1 }, 120, 80)).toEqual({ x: 0, y: 0, k: 1 });
    const p = panScreenBy({ x: 0, y: 0, k: 2 }, 40, 20);
    expect(p.x).toBe(-20);
    expect(p.y).toBe(-10);
  });
});
