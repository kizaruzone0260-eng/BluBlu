/**
 * Board → PDF, in the browser only (task 2). pdf-lib (MIT) is imported DYNAMICALLY, so the
 * library lands in its own lazy chunk and never in the initial bundle; nothing is uploaded and
 * no second party sees the drawing.
 *
 * Layout rules from the task:
 *  - A4 landscape, or the board's own size when the teacher chooses «по размеру содержимого»;
 *  - the picture is fitted inside the page and centered, with 10 mm margins;
 *  - one page per selected board, in tab order.
 *
 * Memory rules (task 2в): the caller renders ONE board at a time and hands us its PNG bytes;
 * we embed, drop the reference, and only build the output at the end. `cancelled()` is checked
 * before every page, so a phone that is struggling can stop early with a clear message instead
 * of a frozen tab.
 */

/** 1 mm in PostScript points: PDFs are 72 pt per inch, an inch is 25.4 mm. */
const MM = 72 / 25.4;
/** A4 landscape, in points: 297 × 210 mm ≈ 841.9 × 595.3 pt. */
export const A4_LANDSCAPE = { width: 297 * MM, height: 210 * MM };
export const DEFAULT_MARGIN_MM = 10;
/** 1 CSS px = 0.75 pt at 96 dpi — used for the "content size" page. */
const PX_TO_PT = 0.75;

export type BoardPageSize = 'a4' | 'content';

export interface BoardImage {
  /** PNG bytes of one board (already rendered by the caller). */
  png: Uint8Array;
  /** the picture's own size in CSS pixels, before any scaling */
  width: number;
  height: number;
}

/** Thrown when the teacher pressed Отменить — a cancel is not an error to show as a failure. */
export class BoardExportCancelled extends Error {
  constructor() { super('board export cancelled'); this.name = 'BoardExportCancelled'; }
}

export class BoardExportAborted extends Error {
  constructor() { super('board export aborted'); this.name = 'BoardExportAborted'; }
}

/**
 * The largest canvas a browser paints reliably. Excalidraw rasterizes into a canvas, and phones
 * (and Safari) start refusing or blanking past a few thousand pixels per side / ~268 MP of area,
 * so a huge board is scaled DOWN instead of being asked for at full size.
 */
export const SAFE_EXPORT_SIDE_PX = 6_000;
export const SAFE_EXPORT_AREA_PX = 40_000_000;

/**
 * Scale for an export of a `width × height` content box at a requested `scale`, clamped to the
 * safe canvas. Returned as the object Excalidraw's `getDimensions` wants.
 */
export function fitDimensions(
  width: number, height: number, scale: number, maxSide = SAFE_EXPORT_SIDE_PX,
): { width: number; height: number; scale: number } {
  const w = Math.max(1, width);
  const h = Math.max(1, height);
  let s = scale;
  const sideCap = Math.min(maxSide / w, maxSide / h);
  if (sideCap < s) s = sideCap;
  const areaCap = Math.sqrt(SAFE_EXPORT_AREA_PX / (w * h));
  if (areaCap < s) s = areaCap;
  s = Math.max(0.1, Math.min(s, scale));
  return { width: Math.round(w * s), height: Math.round(h * s), scale: s };
}

export async function buildBoardPdf(opts: {
  images: BoardImage[];
  pageSize: BoardPageSize;
  marginMm?: number;
  onProgress?: (done: number, total: number) => void;
  cancelled?: () => boolean;
}): Promise<Blob> {
  const { images, pageSize } = opts;
  if (!images.length) throw new BoardExportAborted();
  const margin = (opts.marginMm ?? DEFAULT_MARGIN_MM) * MM;

  // the only place pdf-lib is pulled in — a dynamic import keeps it out of the entry chunk
  const { PDFDocument } = await import('pdf-lib');
  const doc = await PDFDocument.create();
  doc.setProducer('pdf-lib');
  doc.setCreator('BluBlu');
  // task 2г: no personal data in the metadata — no class name, no teacher name, no lesson id
  doc.setTitle('BluBlu');
  doc.setSubject('BluBlu');
  doc.setAuthor('');
  doc.setKeywords([]);

  for (let i = 0; i < images.length; i++) {
    if (opts.cancelled?.()) throw new BoardExportCancelled();
    const img = images[i]!;
    const embedded = await doc.embedPng(img.png);
    const page = pageSize === 'a4'
      ? { width: A4_LANDSCAPE.width, height: A4_LANDSCAPE.height }
      // "content size": the page IS the picture, plus the same margins on all sides
      : { width: img.width * PX_TO_PT + margin * 2, height: img.height * PX_TO_PT + margin * 2 };
    const pdfPage = doc.addPage([page.width, page.height]);
    const availW = Math.max(1, page.width - margin * 2);
    const availH = Math.max(1, page.height - margin * 2);
    const k = Math.min(availW / embedded.width, availH / embedded.height);
    const w = embedded.width * k;
    const h = embedded.height * k;
    pdfPage.drawImage(embedded, {
      x: (page.width - w) / 2,
      y: (page.height - h) / 2,
      width: w,
      height: h,
    });
    opts.onProgress?.(i + 1, images.length);
  }
  if (opts.cancelled?.()) throw new BoardExportCancelled();

  const bytes = await doc.save({ useObjectStreams: false });
  return new Blob([bytes.slice()], { type: 'application/pdf' });
}

/**
 * Task 2г: `BluBlu-<class>-<date>.pdf`. Everything Windows/macOS/Android forbid in a name is
 * dropped, but Cyrillic and the Uzbek `ʻ`/`gʻ` letters survive (only characters illegal in a
 * filename are removed, and the result stays a safe ASCII-free-agnostic UTF-8 name).
 */
export function boardPdfFileName(className: string, at: Date = new Date()): string {
  const clean = (s: string) => s
    .replace(/[\u0000-\u001f\u007f]/g, '')            // control characters
    .replace(/[\\/:*?"'<>|]/g, '')                     // illegal on some platforms
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')                    // no leading dots/spaces, no trailing ones
    .slice(0, 60)
    .trim();
  const pad = (n: number) => String(n).padStart(2, '0');
  const date = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
  const name = clean(className) || 'board';
  return `BluBlu-${name}-${date}.pdf`;
}
