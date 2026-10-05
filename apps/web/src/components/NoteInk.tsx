/**
 * Lightweight in-note drawing (item 3, grown by calendar/ink task §6).
 * Custom SVG ink instead of Excalidraw. Strokes live in WORLD coordinates;
 * the editor adds a viewport: hand tool (mouse/touchpad/two fingers), wheel
 * and pinch zoom, +/− and «Show all», fullscreen. Old drawings (made before
 * pan/zoom) are ordinary world-coordinate strokes — they open unchanged.
 * Pure math lives in @klass/shared/inkView (unit-tested); serialization in
 * lib/ink.ts. Drawing mode blocks page scrolling ONLY over the canvas.
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  INK_MAX_ENCODED, composeInk, extractInk, inkSize, pathD, type InkData, type InkStroke,
} from '../lib/ink';
import {
  fitView, panBy, toWorld, viewBoxOf, zoomAt, type InkView0,
} from '@klass/shared';

export { INK_MAX_ENCODED, composeInk, extractInk, inkSize };
export type { InkData, InkStroke };

/** Read-only render: fit the viewBox to the drawing so it is never cut off. */
export function InkView({ ink, height = 180 }: { ink: InkData | null; height?: number }) {
  if (!ink || !ink.strokes.length) return null;
  const pad = 20;
  const xs = ink.strokes.flatMap((s) => s.pts.map((p) => p[0] ?? 0));
  const ys = ink.strokes.flatMap((s) => s.pts.map((p) => p[1] ?? 0));
  const x0 = Math.min(...xs) - pad;
  const y0 = Math.min(...ys) - pad;
  const w = Math.max(...xs) - Math.min(...xs) + pad * 2;
  const h = Math.max(...ys) - Math.min(...ys) + pad * 2;
  return (
    <svg className="note-ink" viewBox={`${x0} ${y0} ${w} ${h}`} preserveAspectRatio="xMidYMid meet"
      style={{ height, width: '100%', touchAction: 'auto' }} role="img" aria-label="drawing">
      {ink.strokes.map((s, i) => (
        <path key={i} d={pathD(s.pts)} fill="none"
          className={s.e ? 'ink-eraser' : undefined}
          stroke={s.e ? undefined : s.c} strokeWidth={s.w} strokeLinecap="round" strokeLinejoin="round" />
      ))}
    </svg>
  );
}

/**
 * Render any stored note body: text part + embedded drawing. Teacher notes carry
 * Tiptap HTML; the platform NEVER injects foreign HTML (posts/feed render plain
 * text), so here we strip tags to plain lines and draw the ink on top.
 */
export function NoteBodyView({ body, plain = false }: { body: string; plain?: boolean }) {
  const { rest, ink } = extractInk(body);
  const text = plain ? rest : rest.replace(/<\/p>|<\/h2>|<\/li>/gi, '\n').replace(/<[^>]*>/g, '').trim();
  return (
    <>
      {text && <p style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{text}</p>}
      <InkView ink={ink} />
    </>
  );
}

const PALETTE = ['#17211d', '#0f766e', '#c0392f', '#2563eb', '#f59e0b', '#8e44ad'];

/**
 * Editor block under the note text. «Drawing mode» OFF → the canvas is inert
 * and the page scrolls normally under a finger; ON → touch-action:none over
 * the canvas only. Tools: pen / eraser / hand; zoom by wheel (ctrl+wheel too),
 * pinch, +/−; «Show all» fits the drawing; fullscreen expands the block.
 */
export function InkEditor({ ink, onChange }: { ink: InkData | null; onChange: (next: InkData | null) => void }) {
  const { t } = useTranslation();
  const [mode, setMode] = useState(false);
  const [tool, setTool] = useState<'pen' | 'eraser' | 'hand'>('pen');
  const [color, setColor] = useState(PALETTE[0]!);
  const [width, setWidth] = useState(4);
  const [err, setErr] = useState('');
  const [view, setView] = useState<InkView0>({ x: 0, y: 0, k: 1 });
  const [size, setSize] = useState({ w: 800, h: 320 });
  const [full, setFull] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const cur = useRef<InkStroke | null>(null);
  const pointers = useRef<Map<number, { x: number; y: number }>>(new Map());
  const pinch = useRef<{ dist: number; cx: number; cy: number } | null>(null);
  const panStart = useRef<{ x: number; y: number } | null>(null);
  const undoStack = useRef<InkStroke[][]>([]);
  const redoStack = useRef<InkStroke[][]>([]);
  const [, force] = useState(0);

  const strokes = ink?.strokes ?? [];

  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      setSize({ w: Math.max(r.width, 1), h: Math.max(r.height, 1) });
    });
    ro.observe(el);
    const onFs = () => setFull(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onFs);
    return () => { ro.disconnect(); document.removeEventListener('fullscreenchange', onFs); };
  }, []);

  function pushHistory() {
    undoStack.current.push(strokes.slice());
    if (undoStack.current.length > 60) undoStack.current.shift();
    redoStack.current = [];
  }
  function commit(next: InkStroke[]): boolean {
    const data: InkData | null = next.length ? { strokes: next } : null;
    if (inkSize(data) > INK_MAX_ENCODED) { setErr(t('notes.draw.toobig')); return false; }
    setErr('');
    onChange(data);
    return true;
  }

  function rel(e: { clientX: number; clientY: number }): [number, number] {
    const r = svgRef.current!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }
  function toXY(e: { clientX: number; clientY: number }): [number, number] {
    const [px, py] = rel(e);
    const [x, y] = toWorld(view, px, py);
    return [Number(x.toFixed(1)), Number(y.toFixed(1))]; // world coords, no clamping — the field grows
  }

  function onDown(e: React.PointerEvent) {
    if (!mode) return;
    e.preventDefault();
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try { svgRef.current?.setPointerCapture(e.pointerId); } catch { /* no capture ok */ }
    if (pointers.current.size === 2) {
      // second finger: this becomes a pinch/pan gesture — drop the in-flight stroke
      cur.current = null;
      const [a, b] = [...pointers.current.values()];
      pinch.current = {
        dist: Math.hypot((a?.x ?? 0) - (b?.x ?? 0), (a?.y ?? 0) - (b?.y ?? 0)) || 1,
        cx: ((a?.x ?? 0) + (b?.x ?? 0)) / 2, cy: ((a?.y ?? 0) + (b?.y ?? 0)) / 2,
      };
      return;
    }
    if (tool === 'hand') {
      panStart.current = { x: e.clientX, y: e.clientY };
      return;
    }
    pushHistory();
    cur.current = tool === 'eraser'
      ? { c: '#ffffff', w: 24, e: 1, pts: [toXY(e)] }
      : { c: color, w: width, pts: [toXY(e)] };
    force((n) => n + 1);
  }

  function onMove(e: React.PointerEvent) {
    if (!mode) return;
    const live = pointers.current.get(e.pointerId);
    if (live) { live.x = e.clientX; live.y = e.clientY; }
    if (pointers.current.size >= 2 && pinch.current) {
      const [a, b] = [...pointers.current.values()];
      const dist = Math.hypot((a?.x ?? 0) - (b?.x ?? 0), (a?.y ?? 0) - (b?.y ?? 0)) || 1;
      const cx = ((a?.x ?? 0) + (b?.x ?? 0)) / 2;
      const cy = ((a?.y ?? 0) + (b?.y ?? 0)) / 2;
      const [rx, ry] = rel({ clientX: cx, clientY: cy });
      let v = zoomAt(view, size, rx, ry, dist / pinch.current.dist);
      v = panBy(v, cx - pinch.current.cx, cy - pinch.current.cy);
      pinch.current = { dist, cx, cy };
      setView(v);
      return;
    }
    if (tool === 'hand') {
      if (!panStart.current) return;
      const dx = e.clientX - panStart.current.x;
      const dy = e.clientY - panStart.current.y;
      if (dx || dy) {
        panStart.current = { x: e.clientX, y: e.clientY };
        setView((v) => panBy(v, dx, dy));
      }
      return;
    }
    if (!cur.current) return;
    const [x, y] = toXY(e);
    const last = cur.current.pts[cur.current.pts.length - 1]!;
    if (Math.hypot(x - (last[0] ?? 0), y - (last[1] ?? 0)) < 2 / view.k) return; // decimate (screen-stable)
    cur.current.pts.push([x, y]);
    force((n) => n + 1);
  }

  function onUp(e: React.PointerEvent) {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
    if (tool === 'hand') { panStart.current = null; return; }
    if (!cur.current) return;
    const done = cur.current;
    cur.current = null;
    if (!commit([...strokes, done])) undoStack.current.pop();
  }

  function onWheel(e: React.WheelEvent) {
    if (!mode) return;
    e.preventDefault(); // zooming the canvas never scrolls the page
    const [px, py] = rel(e);
    const factor = e.ctrlKey ? Math.exp(-e.deltaY * 0.01) : Math.exp(-e.deltaY * 0.002);
    setView((v) => zoomAt(v, size, px, py, factor));
  }

  function zoomButton(factor: number) {
    setView((v) => zoomAt(v, size, size.w / 2, size.h / 2, factor));
  }
  function showAll() {
    setView(fitView(size, strokes));
  }
  function toggleFull() {
    const el = wrapRef.current;
    if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    else void el.requestFullscreen?.().catch(() => undefined);
  }

  function undo() {
    const prev = undoStack.current.pop();
    if (!prev) return;
    redoStack.current.push(strokes);
    onChange(prev.length ? { strokes: prev } : null);
  }
  function redo() {
    const nxt = redoStack.current.pop();
    if (!nxt) return;
    undoStack.current.push(strokes);
    onChange(nxt.length ? { strokes: nxt } : null);
  }
  function clearAll() {
    pushHistory();
    if (!commit([])) undoStack.current.pop();
  }

  return (
    <div className="ink-editor" ref={wrapRef} data-testid="ink-wrap">
      <div className="row" style={{ gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <button type="button" className={mode ? undefined : 'secondary'} data-testid="ink-mode"
          style={{ marginTop: 0, minWidth: 44 }} aria-pressed={mode} onClick={() => setMode((v) => !v)}>
          ✎ {t('notes.draw.mode')}
        </button>
        {mode && (
          <>
            <button type="button" data-testid="ink-pen" className={tool === 'pen' ? undefined : 'secondary'} style={{ marginTop: 0 }} onClick={() => setTool('pen')}>✒ {t('notes.draw.pen')}</button>
            <button type="button" data-testid="ink-eraser" className={tool === 'eraser' ? undefined : 'secondary'} style={{ marginTop: 0 }} onClick={() => setTool('eraser')}>◻ {t('notes.draw.eraser')}</button>
            <button type="button" data-testid="ink-hand" className={tool === 'hand' ? undefined : 'secondary'} style={{ marginTop: 0 }} aria-pressed={tool === 'hand'} onClick={() => setTool('hand')}>✋ {t('notes.draw.hand')}</button>
            <span className="row" role="group" aria-label={t('notes.draw.color')} style={{ gap: 4 }}>
              {PALETTE.map((c) => (
                <button key={c} type="button" data-testid={`ink-color-${c.slice(1)}`} aria-label={c}
                  onClick={() => { setColor(c); setTool('pen'); }}
                  style={{ width: 26, height: 26, minWidth: 26, padding: 0, margin: 0, marginTop: 0, background: c, borderRadius: '50%', border: c === color ? '3px solid var(--accent)' : '1px solid var(--border-strong)' }} />
              ))}
              <input type="color" value={color} aria-label={t('notes.draw.color')} onChange={(e) => { setColor(e.target.value); setTool('pen'); }}
                style={{ width: 32, height: 30, padding: 2, margin: 0, marginTop: 0 }} />
            </span>
            <label className="row" style={{ gap: 4, margin: 0 }}>
              <input type="range" min={1} max={24} value={width} aria-label={t('notes.draw.thickness')}
                onChange={(e) => setWidth(Number(e.target.value))} style={{ width: 90, margin: 0 }} />
              <span className="muted">{width}</span>
            </label>
            <button type="button" data-testid="ink-undo" className="secondary" style={{ marginTop: 0 }} onClick={undo} disabled={!undoStack.current.length}>↩</button>
            <button type="button" data-testid="ink-redo" className="secondary" style={{ marginTop: 0 }} onClick={redo} disabled={!redoStack.current.length}>↪</button>
            <button type="button" data-testid="ink-clear" className="secondary" style={{ marginTop: 0 }} onClick={clearAll}>{t('notes.draw.clear')}</button>
          </>
        )}
        <div className="spacer" />
        {mode && (
          <span className="row" style={{ gap: 4 }} role="group" aria-label={t('notes.draw.zoom')}>
            <button type="button" data-testid="ink-zoom-out" className="secondary" style={{ marginTop: 0, minWidth: 44 }} onClick={() => zoomButton(1 / 1.3)}>−</button>
            <span className="muted" data-testid="ink-zoom-level" style={{ minWidth: 44, textAlign: 'center' }}>{Math.round(view.k * 100)}%</span>
            <button type="button" data-testid="ink-zoom-in" className="secondary" style={{ marginTop: 0, minWidth: 44 }} onClick={() => zoomButton(1.3)}>+</button>
            <button type="button" data-testid="ink-fit" className="secondary" style={{ marginTop: 0 }} onClick={showAll}>{t('notes.draw.fit')}</button>
          </span>
        )}
        <button type="button" data-testid="ink-full" className="secondary" style={{ marginTop: 0 }} aria-pressed={full} onClick={toggleFull}>
          {full ? '🗗' : '⛶'} {t('notes.draw.full')}
        </button>
      </div>
      {err && <p className="error" data-testid="ink-error" style={{ fontSize: 13 }}>{err}</p>}
      <svg ref={svgRef} className={`note-ink${full ? ' ink-full' : ''}`} viewBox={viewBoxOf(view, size)}
        preserveAspectRatio="none"
        style={{ touchAction: mode ? 'none' : 'auto', pointerEvents: mode ? 'auto' : 'none', height: full ? 'calc(100vh - 64px)' : undefined }}
        data-testid="ink-canvas" aria-label={t('notes.draw.mode')}
        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp}
        onPointerCancel={onUp} onWheel={onWheel} onContextMenu={(e) => { if (mode) e.preventDefault(); }}>
        {/* a soft origin marker so the borderless field is still orientable */}
        <line x1={view.x - 10000} y1={0} x2={view.x + size.w / view.k + 10000} y2={0} stroke="rgba(128,128,128,.15)" strokeWidth={1 / view.k} />
        <line x1={0} y1={view.y - 10000} x2={0} y2={view.y + size.h / view.k + 10000} stroke="rgba(128,128,128,.15)" strokeWidth={1 / view.k} />
        {strokes.map((s, i) => (
          <path key={i} d={pathD(s.pts)} fill="none" className={s.e ? 'ink-eraser' : undefined}
            stroke={s.e ? undefined : s.c} strokeWidth={s.w} strokeLinecap="round" strokeLinejoin="round" />
        ))}
        {cur.current && (
          <path d={pathD(cur.current.pts)} fill="none" className={cur.current.e ? 'ink-eraser' : undefined}
            stroke={cur.current.e ? undefined : cur.current.c} strokeWidth={cur.current.w} strokeLinecap="round" strokeLinejoin="round" />
        )}
      </svg>
    </div>
  );
}
