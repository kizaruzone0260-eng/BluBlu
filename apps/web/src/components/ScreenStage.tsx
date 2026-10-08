import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { clampScreenK, panScreenBy, zoomScreenAt, SCREEN_ZOOM_STEP } from '@klass/shared';

/**
 * The main window while somebody demonstrates a screen (task 1.2/1.3, 2026-10-08).
 *
 * It wraps the `<video>` of the screen tile and adds what the plain tile never had:
 *  - «На весь экран» — the Fullscreen API on the CONTAINER, so the caption and the compact
 *    controls stay visible inside it (fullscreen on a bare <video> would drop them);
 *  - «Развернуть в окне» — `position: fixed` over the whole viewport, the fallback for iOS
 *    Safari and any browser without the Fullscreen API (and the automatic fallback when a
 *    fullscreen request is refused);
 *  - «Вписать / заполнить» — object-fit contain ⇄ cover;
 *  - zoom by buttons, wheel and pinch, with drag-to-pan while zoomed in, so small text on the
 *    shared slide is readable;
 *  - double-click toggles fullscreen, `F` toggles it, `Esc` closes both modes.
 *
 * Nothing here changes who may publish or what the server accepts — it is presentation only.
 */
export default function ScreenStage({ presenter, caption, lead, children, controls }: {
  /** true for the participant whose own screen this is (they get no self-echo and no mirror) */
  presenter: boolean;
  /** whose screen this is, already localized */
  caption: string;
  /** the «Экран | Доска» pill, when the board is open too: it lives in the caption band */
  lead?: React.ReactNode;
  /** the <video> tile */
  children: React.ReactNode;
  /** the compact controls that must stay reachable on top of a fullscreen stage */
  controls?: React.ReactNode;
}) {
  const { t } = useTranslation();
  const boxRef = useRef<HTMLDivElement | null>(null);
  const [full, setFull] = useState(false);
  const [windowed, setWindowed] = useState(false);
  const [fit, setFit] = useState<'contain' | 'cover'>('contain');
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const [rotateHint, setRotateHint] = useState(false);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ dist: number; k: number } | null>(null);
  const drag = useRef<{ x: number; y: number } | null>(null);

  const zoomBy = useCallback((factor: number, px?: number, py?: number) => {
    const box = boxRef.current?.getBoundingClientRect();
    const cx = px ?? (box ? box.width / 2 : 0);
    const cy = py ?? (box ? box.height / 2 : 0);
    setView((v) => zoomScreenAt(v, cx, cy, factor));
  }, []);

  // ── fullscreen ────────────────────────────────────────────────────────────────────────
  const exitAll = useCallback(() => {
    setWindowed(false);
    setView({ x: 0, y: 0, k: 1 });
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
  }, []);

  const toggleFull = useCallback(() => {
    const el = boxRef.current;
    if (!el) return;
    if (document.fullscreenElement) { void document.exitFullscreen().catch(() => undefined); return; }
    if (typeof el.requestFullscreen !== 'function') { setWindowed(true); return; }   // iOS Safari
    el.requestFullscreen({ navigationUI: 'hide' })
      // a refused request (iframe without allowfullscreen, a browser gesture rule) must not
      // leave the user with nothing: the windowed mode is the same result without the API
      .catch(() => setWindowed(true));
  }, []);

  useEffect(() => {
    const onFs = () => setFull(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, []);

  // A phone in portrait sees a letterboxed slide; ask for landscape and try to lock it where the
  // browser allows. `lock()` is a promise that REJECTS on desktop and on iOS — that is expected,
  // so the failure is swallowed instead of shown.
  useEffect(() => {
    if (!full && !windowed) { setRotateHint(false); return; }
    const portrait = window.matchMedia?.('(orientation: portrait)').matches ?? false;
    const small = Math.min(window.innerWidth, window.innerHeight) < 720;
    setRotateHint(portrait && small);
    if (portrait && small) {
      const o = (screen as unknown as { orientation?: { lock?: (s: string) => Promise<void> } }).orientation;
      void o?.lock?.('landscape').catch(() => undefined);
    }
  }, [full, windowed]);

  // ── keyboard: F toggles, Esc leaves (Esc inside fullscreen is the browser's own) ───────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      if (e.key === 'f' || e.key === 'F') { e.preventDefault(); toggleFull(); }
      else if (e.key === 'Escape') {
        // Real browsers swallow Escape for their own "leave fullscreen" before the page sees it,
        // so this is normally a no-op — but any engine that DOES deliver it (and the headless
        // browsers our tests run in) gets the same documented behaviour: Esc closes both modes.
        if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
        if (windowed) setWindowed(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggleFull, windowed]);

  // ── wheel zoom: a native listener, because React registers `onWheel` passively and
  //    preventDefault() would be ignored (the page would scroll instead of zooming) ───────
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && Math.abs(e.deltaY) < 4) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      zoomBy(e.deltaY < 0 ? SCREEN_ZOOM_STEP : 1 / SCREEN_ZOOM_STEP, e.clientX - r.left, e.clientY - r.top);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [zoomBy]);

  // ── pointers: two fingers pinch, one finger pans while zoomed ─────────────────────────
  function onPointerDown(e: React.PointerEvent) {
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    if (pointers.current.size === 2) {
      const pts = [...pointers.current.values()];
      const a = pts[0], b = pts[1];
      if (a && b) pinch.current = { dist: Math.hypot(a.x - b.x, a.y - b.y), k: view.k };
      drag.current = null;
    } else if (pointers.current.size === 1 && view.k > 1) {
      drag.current = { x: e.clientX, y: e.clientY };
    }
  }
  function onPointerMove(e: React.PointerEvent) {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2 && pinch.current) {
      const pts = [...pointers.current.values()];
      const a = pts[0], b = pts[1];
      const r = boxRef.current?.getBoundingClientRect();
      if (!a || !b || !r) return;
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const mx = (a.x + b.x) / 2 - r.left;
      const my = (a.y + b.y) / 2 - r.top;
      const target = clampScreenK(pinch.current.k * (d / (pinch.current.dist || 1)));
      // the midpoint between the fingers is the anchor, so the picture does not slide away
      setView((v) => (v.k === target ? v : zoomScreenAt(v, mx, my, target / v.k)));
      return;
    }
    if (drag.current) {
      const dx = e.clientX - drag.current.x, dy = e.clientY - drag.current.y;
      drag.current = { x: e.clientX, y: e.clientY };
      setView((v) => panScreenBy(v, dx, dy));
    }
  }
  function onPointerUp(e: React.PointerEvent) {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
    if (pointers.current.size === 0) drag.current = null;
  }

  const zoomed = view.k > 1.001;
  const expanded = full || windowed;

  return (
    <div
      className={`screen-stage${expanded ? ' screen-expanded' : ''}${windowed && !full ? ' screen-windowed' : ''}`}
      ref={boxRef} data-testid="screen-stage" data-fit={fit} data-zoom={view.k.toFixed(2)}
    >
      {/* three bands — caption, picture, tools — instead of everything floating over the
          picture, which clipped the caption and hid the tools behind the presenter's
          preview at 390 px (2026-10-08 screenshot review) */}
      <div className="screen-head">
        {lead}
        <span className="screen-caption" data-testid="screen-caption">{caption}</span>
        {presenter && <span className="muted screen-you" data-testid="screen-you">{t('lesson.screenYou')}</span>}
      </div>

      <div className="screen-viewport" data-testid="screen-viewport">
        <div
          className="screen-picture" data-testid="screen-picture"
          onPointerDown={onPointerDown} onPointerMove={onPointerMove}
          onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
          onDoubleClick={toggleFull}
          style={{
            transform: `translate(${-view.x * view.k}px, ${-view.y * view.k}px) scale(${view.k})`,
            transformOrigin: 'top left',
          }}
        >
          {children}
        </div>
        {/* in fullscreen the room controls must stay reachable on top of the picture */}
        {expanded && controls && <div className="screen-overlay" data-testid="screen-overlay">{controls}</div>}
      </div>

      {rotateHint && (
        <p className="screen-note" role="status" data-testid="screen-rotate">{t('lesson.screenRotateHint')}</p>
      )}
      <div className="screen-tools" data-testid="screen-tools">
        <button type="button" className="ghost" style={{ marginTop: 0 }} data-testid="screen-full"
          aria-label={t('lesson.screenFull')} aria-pressed={full} title={t('lesson.screenFull')}
          onClick={toggleFull}>⛶</button>
        <button type="button" className="ghost" style={{ marginTop: 0 }} data-testid="screen-window"
          aria-label={t('lesson.screenWindow')} aria-pressed={windowed} title={t('lesson.screenWindow')}
          onClick={() => setWindowed((v) => !v)}>⤢</button>
        <button type="button" className="ghost" style={{ marginTop: 0 }} data-testid="screen-fit"
          aria-label={fit === 'contain' ? t('lesson.screenFill') : t('lesson.screenFit')}
          title={fit === 'contain' ? t('lesson.screenFill') : t('lesson.screenFit')}
          // ▢ = the whole picture with letterbox bars, ▣ = the picture fills the window
          onClick={() => setFit((f) => (f === 'contain' ? 'cover' : 'contain'))}>
          {fit === 'contain' ? '▢' : '▣'}
        </button>
        <span className="screen-zoom" data-testid="screen-zoom-value">{Math.round(view.k * 100)}%</span>
        <button type="button" className="ghost" style={{ marginTop: 0 }} data-testid="screen-zoom-out"
          aria-label={t('lesson.screenZoomOut')} onClick={() => zoomBy(1 / SCREEN_ZOOM_STEP)}>−</button>
        <button type="button" className="ghost" style={{ marginTop: 0 }} data-testid="screen-zoom-in"
          aria-label={t('lesson.screenZoomIn')} onClick={() => zoomBy(SCREEN_ZOOM_STEP)}>+</button>
        {zoomed && (
          <button type="button" className="ghost" style={{ marginTop: 0 }} data-testid="screen-zoom-reset"
            aria-label={t('lesson.screenZoomReset')} onClick={() => setView({ x: 0, y: 0, k: 1 })}>↺</button>
        )}
        {expanded && (
          <button type="button" className="ghost" style={{ marginTop: 0 }} data-testid="screen-exit"
            aria-label={t('lesson.screenExit')} onClick={exitAll}>✕</button>
        )}
      </div>
    </div>
  );
}
