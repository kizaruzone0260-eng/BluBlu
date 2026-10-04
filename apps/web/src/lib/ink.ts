/**
 * Pure drawing (item 3) serialization — no React. The drawing lives inside the
 * note body as <div class="note-drawing" data-note-drawing="encodeURIComponent(JSON)">
 * so it rides on the ordinary title/body autosave and the shared emptiness rule
 * (@klass/shared noteHasContent → noteHasDrawing) recognizes it.
 */

export interface InkStroke { c: string; w: number; e?: 1; pts: number[][] }
export interface InkData { strokes: InkStroke[] }

export const INK_MAX_ENCODED = 500_000; // ~500 KB per drawing (item 3 limit)
const MARKER_RE = /<div class="note-drawing" data-note-drawing="([^"]*)"\s*><\/div>/;

export function inkSize(ink: InkData | null): number {
  if (!ink || !ink.strokes.length) return 0;
  return encodeURIComponent(JSON.stringify({ strokes: ink.strokes })).length;
}

/** split a stored body into text-part + drawing; malformed payloads read as absent */
export function extractInk(bodyHtml: string): { rest: string; ink: InkData | null } {
  const m = MARKER_RE.exec(bodyHtml);
  if (!m) return { rest: bodyHtml, ink: null };
  let ink: InkData | null = null;
  try {
    const j = JSON.parse(decodeURIComponent(m[1]!));
    if (j && Array.isArray(j.strokes)) ink = { strokes: j.strokes } as InkData;
  } catch { /* treat as no drawing */ }
  return { rest: bodyHtml.replace(MARKER_RE, '').trim(), ink };
}

/** text-part (html or plain text) + drawing → stored body */
export function composeInk(rest: string, ink: InkData | null): string {
  if (!ink || !ink.strokes.length) return rest;
  const enc = encodeURIComponent(JSON.stringify({ strokes: ink.strokes }));
  if (enc.length > INK_MAX_ENCODED) return rest; // caller must surface the size error
  return `${rest}<div class="note-drawing" data-note-drawing="${enc}"></div>`;
}

export function pathD(pts: number[][]): string {
  if (!pts.length) return '';
  const [x0, y0] = pts[0]!;
  let d = `M ${x0} ${y0}`;
  for (let i = 1; i < pts.length; i++) d += ` L ${pts[i]![0]} ${pts[i]![1]}`;
  if (pts.length === 1) d += ` L ${(x0! + 0.01).toFixed(2)} ${y0!}`; // a dot still renders
  return d;
}
