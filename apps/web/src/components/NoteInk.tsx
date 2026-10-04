/**
 * Lightweight in-note drawing (item 3). Custom SVG ink instead of Excalidraw:
 * a few KB instead of another lazy chunk, full pointer support (mouse/touch/
 * pen/stylus via Pointer Events), trivially serialisable to the strokes JSON
 * we embed in the note body. Decision recorded in docs/DECISIONS.md.
 * Pure (de)serialization lives in lib/ink.ts.
 */
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { INK_MAX_ENCODED, composeInk, extractInk, inkSize, pathD, type InkData, type InkStroke } from '../lib/ink';

export { INK_MAX_ENCODED, composeInk, extractInk, inkSize };
export type { InkData, InkStroke };

const VB_W = 1000;
const VB_H = 400;

export function InkView({ ink, height = 180 }: { ink: InkData | null; height?: number }) {
  if (!ink || !ink.strokes.length) return null;
  return (
    <svg className="note-ink" viewBox={`0 0 ${VB_W} ${VB_H}`} style={{ height, touchAction: 'auto' }} role="img" aria-label="drawing">
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
 * Editor block under the note text. «Drawing mode» OFF → the canvas is inert and
 * the page scrolls normally under a finger; ON → touch-action:none, strokes are
 * captured. Undo/redo/clear per item 3.
 */
export function InkEditor({ ink, onChange }: { ink: InkData | null; onChange: (next: InkData | null) => void }) {
  const { t } = useTranslation();
  const [mode, setMode] = useState(false);
  const [tool, setTool] = useState<'pen' | 'eraser'>('pen');
  const [color, setColor] = useState(PALETTE[0]!);
  const [width, setWidth] = useState(4);
  const [err, setErr] = useState('');
  const svgRef = useRef<SVGSVGElement | null>(null);
  const cur = useRef<InkStroke | null>(null);
  const undoStack = useRef<InkStroke[][]>([]);
  const redoStack = useRef<InkStroke[][]>([]);
  const [, force] = useState(0);

  const strokes = ink?.strokes ?? [];

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

  function toXY(e: React.PointerEvent): [number, number] {
    const r = svgRef.current!.getBoundingClientRect();
    return [
      Math.max(0, Math.min(VB_W, ((e.clientX - r.left) / r.width) * VB_W)),
      Math.max(0, Math.min(VB_H, ((e.clientY - r.top) / r.height) * VB_H)),
    ];
  }

  function down(e: React.PointerEvent) {
    if (!mode) return;
    e.preventDefault();
    try { (e.target as Element).setPointerCapture(e.pointerId); } catch { /* no capture ok */ }
    pushHistory();
    cur.current = tool === 'eraser'
      ? { c: '#ffffff', w: 24, e: 1, pts: [toXY(e)] }
      : { c: color, w: width, pts: [toXY(e)] };
    force((n) => n + 1);
  }
  function move(e: React.PointerEvent) {
    if (!mode || !cur.current) return;
    const [x, y] = toXY(e);
    const last = cur.current.pts[cur.current.pts.length - 1]!;
    if (Math.hypot(x - last[0]!, y - last[1]!) < 2) return; // decimate
    cur.current.pts.push([Number(x.toFixed(1)), Number(y.toFixed(1))]);
    force((n) => n + 1); // live preview; the note itself is saved on pointerup
  }
  function up() {
    if (!cur.current) return;
    const done = cur.current;
    cur.current = null;
    if (!commit([...strokes, done])) undoStack.current.pop();
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
    <div className="ink-editor">
      <div className="row" style={{ gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <button type="button" className={mode ? undefined : 'secondary'} data-testid="ink-mode"
          style={{ marginTop: 0, minWidth: 44 }} aria-pressed={mode} onClick={() => setMode((v) => !v)}>
          ✎ {t('notes.draw.mode')}
        </button>
        {mode && (
          <>
            <button type="button" data-testid="ink-pen" className={tool === 'pen' ? undefined : 'secondary'} style={{ marginTop: 0 }} onClick={() => setTool('pen')}>✒ {t('notes.draw.pen')}</button>
            <button type="button" data-testid="ink-eraser" className={tool === 'eraser' ? undefined : 'secondary'} style={{ marginTop: 0 }} onClick={() => setTool('eraser')}>◻ {t('notes.draw.eraser')}</button>
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
      </div>
      {err && <p className="error" data-testid="ink-error" style={{ fontSize: 13 }}>{err}</p>}
      <svg ref={svgRef} className="note-ink" viewBox={`0 0 ${VB_W} ${VB_H}`}
        style={{ touchAction: mode ? 'none' : 'auto', pointerEvents: mode ? 'auto' : 'none' }}
        data-testid="ink-canvas" aria-label={t('notes.draw.mode')}
        onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={() => { cur.current = null; }}>
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
