/**
 * Which content owns the lesson's main window (task: screen demonstration, 2026-10-08).
 *
 * Pure function on purpose: the page has to turn LiveKit participants into booleans, and that
 * part is only observable with a real RTC room (see `apps/e2e/tests/zz13-screen-stage.spec.ts`,
 * which self-skips when LiveKit is unreachable). The DECISION itself is what the task specifies
 * — «когда у любого участника есть экранный трек, он становится главным окном у всех» — and it
 * is unit-tested here, so it also runs in CI (apps/api/test/unit/stage-model.test.ts).
 *
 * Precedence, highest first:
 *  1. an explicit PIN — the viewer clicked somebody, that is a local, deliberate choice;
 *  2. the SCREEN SHARE — beats the board, and beats an explicit «grid» layout: a shared screen
 *     that lives in a 180 px strip tile is the bug this task fixes;
 *  3. the BOARD when it is open (shared state, so it is the main window for the whole class);
 *  4. the layout the teacher picked: spotlight / active speaker / first person / honest grid.
 *
 * When a screen is shared AND the board is open, the viewer switches between them with
 * `showBoardInstead` (the «Экран | Доска» control) — the board never disappears, and the screen
 * still wins by default.
 */

export type LessonLayout = 'auto' | 'gallery' | 'stage' | 'teacher';

/** What the main window shows. `grid` means: no main window at all, everybody is a tile. */
export type StageContent = 'grid' | 'screen' | 'board' | 'pinned' | 'spotlight' | 'speaker';

export interface StageInput {
  /** `session.boardOpen` — shared, teacher-controlled. */
  boardOpen: boolean;
  layout: LessonLayout;
  /** at least one participant (including the local one) publishes a screen track */
  hasScreen: boolean;
  /** the viewer pinned a tile */
  hasPinned: boolean;
  /** `layout === 'auto'`: somebody who is not me is speaking and has a camera */
  hasSpeaker: boolean;
  /** there is a person to show (a remote camera, or my own as the last resort) */
  hasPerson: boolean;
  /** the viewer chose the board in the «Экран | Доска» switch while a screen is live */
  showBoardInstead?: boolean;
}

export function pickStageContent(i: StageInput): StageContent {
  if (i.hasPinned) return 'pinned';
  if (i.hasScreen && !i.showBoardInstead) return 'screen';
  if (i.boardOpen) return 'board';
  if (i.layout === 'gallery') return 'grid';
  if (i.layout === 'teacher') return i.hasPerson ? 'spotlight' : 'grid';
  if (i.layout === 'auto') return i.hasSpeaker ? 'speaker' : 'grid';
  return i.hasPerson ? 'spotlight' : 'grid';
}

/**
 * Should the «Экран | Доска» switch be offered? Only when BOTH exist and the screen is the one
 * currently winning — otherwise there is nothing to switch between.
 */
export function stageSwitchVisible(i: StageInput): boolean {
  return i.hasScreen && i.boardOpen;
}

/**
 * The strip must not show what the main window already shows, and the presenter's own camera is
 * the floating picture-in-picture rather than a strip slot (task B behaviour, kept).
 */
export function stripKeys(all: { key: string; local: boolean; screen: boolean }[], opts: {
  stageKey: string | null; hasStage: boolean; localCameraKey: string | null; teacherFloats: boolean;
  teacherKey: string | null;
}): string[] {
  const out: string[] = [];
  for (const t of all) {
    if (opts.stageKey && t.key === opts.stageKey) continue;
    if (opts.hasStage && opts.localCameraKey && t.key === opts.localCameraKey) continue;
    if (opts.teacherFloats && opts.teacherKey && t.key === opts.teacherKey) continue;
    out.push(t.key);
  }
  return out;
}

/* ── zoom of the shared picture (task 1.2: «для чтения мелкого текста») ─────────────── */

/** 1 = the picture fits the window as-is; 6 is where a whiteboard slide still stays sharp. */
export const SCREEN_MIN_K = 1;
export const SCREEN_MAX_K = 6;
export const SCREEN_ZOOM_STEP = 1.25;

export function clampScreenK(k: number): number {
  return Math.min(SCREEN_MAX_K, Math.max(SCREEN_MIN_K, k));
}

/**
 * Zoom by `factor` around the point (px, py) of the stage box, keeping that point still — the
 * same view math the notes drawing uses (`zoomAt`), with the screen's own clamp. `x`/`y` are the
 * world offset, i.e. what `translate(-x,-y) scale(k)` draws at.
 */
export function zoomScreenAt(
  v: { x: number; y: number; k: number }, px: number, py: number, factor: number,
): { x: number; y: number; k: number } {
  const k = clampScreenK(v.k * factor);
  const wx = v.x + px / v.k;
  const wy = v.y + py / v.k;
  return { x: wx - px / k, y: wy - py / k, k };
}

/** Pan the zoomed picture; a view at k = 1 has nothing to pan, so the offsets stay 0. */
export function panScreenBy(
  v: { x: number; y: number; k: number }, dxScreen: number, dyScreen: number,
): { x: number; y: number; k: number } {
  if (v.k <= 1) return { ...v, x: 0, y: 0 };
  return { x: v.x - dxScreen / v.k, y: v.y - dyScreen / v.k, k: v.k };
}
