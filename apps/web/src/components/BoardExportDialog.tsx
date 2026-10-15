import { useEffect, useMemo, useRef, useState } from 'react';
import { exportToBlob } from '@excalidraw/excalidraw';
import { useTranslation } from 'react-i18next';
import { api } from '../lib/api';
import {
  BoardExportCancelled, boardPdfFileName, buildBoardPdf, fitDimensions,
  type BoardImage, type BoardPageSize,
} from '../lib/boardPdf';
import { DocxCancelled, boardWordFileName, buildBoardDocx } from '../lib/boardDocx';

type ExportKind = 'pdf' | 'word';

type RawEl = { id: string; isDeleted?: boolean; [k: string]: unknown };

interface BoardRow { pageNo: number; title: string; elements: RawEl[] }

/** A board is "empty" when no live element is on it — task 2а marks those and leaves them off. */
const liveOf = (els: RawEl[]) => els.filter((e) => !e.isDeleted);
const isEmpty = (els: RawEl[]) => liveOf(els).length === 0;

/** Longest side of a dialog thumbnail: 20 of them must stay cheap even on a phone. */
const THUMB_SIDE = 320;
/** The PDF picture is rendered at 2× per the task, clamped to a canvas a browser survives. */
const PDF_SCALE = 2;

/** PNG width/height straight out of the IHDR chunk — no decode, no extra canvas. */
function pngSize(bytes: Uint8Array): { width: number; height: number } {
  // 8-byte signature, then IHDR: 4 length, 4 "IHDR", width, height as 32-bit big-endian
  if (bytes.length < 24) return { width: 0, height: 0 };
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: dv.getUint32(16), height: dv.getUint32(20) };
}

/**
 * Task 2 — the «Скачать PDF» dialog: pick boards (thumbnails, checkboxes, «Выбрать все», a
 * counter), choose the page size, get ONE PDF with the chosen boards in tab order. Everything
 * happens in this tab: pdf-lib is imported only when the teacher presses Скачать, boards are
 * rasterized one at a time, and the file leaves as a `blob:` download.
 *
 * Часть 4: окно стало общим для урока и архива. В архиве нет «живой» сцены — показывать нечего,
 * поэтому `current`/`liveElements` необязательны, и без них окно работает по сохранённым доскам.
 */
export default function BoardExportDialog({ sessionId, classId, current, liveElements, onClose }: {
  sessionId: string;
  classId: string;
  /** the board open on the teacher's screen right now — absent in the archive */
  current?: number;
  /** the scene on the teacher's screen right now — it may hold ink not persisted yet */
  liveElements?: () => RawEl[] | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [boards, setBoards] = useState<BoardRow[] | null>(null);
  const [className, setClassName] = useState('');
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [thumbs, setThumbs] = useState<Record<number, string>>({});
  const [pageSize, setPageSize] = useState<BoardPageSize>('a4');
  const [busy, setBusy] = useState(false);
  /** какой формат сейчас собирается — по нему полоса прогресса называет файл правильно */
  const [busyKind, setBusyKind] = useState<ExportKind>('pdf');
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState('');
  const [loadError, setLoadError] = useState('');
  const cancelled = useRef(false);
  const objectUrls = useRef<string[]>([]);

  /** the localized default label of a board; a teacher's own name always wins (task 1б) */
  const label = (b: BoardRow, index: number) => (b.title ?? '').trim() || t('lesson.boardNamed', { n: index });

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const data = await api<{ pages: BoardRow[] }>(`/api/lessons/${sessionId}/board`);
        if (!alive) return;
        const rows = [...(data.pages ?? [])].sort((a, b) => a.pageNo - b.pageNo);
        // the board on screen now: export its live scene, not the copy persisted ≤10 s ago
        // (в архиве живого холста нет — `current` не передан, и цикл просто ничего не меняет)
        for (const r of rows) if (current !== undefined && r.pageNo === current) {
          const live = liveElements?.();
          if (live) r.elements = live as RawEl[];
        }
        setBoards(rows);
        setSelected(new Set(rows.filter((r) => !isEmpty(r.elements)).map((r) => r.pageNo)));
        const classes = await api<{ id: string; name: string }[]>('/api/classes');
        if (alive) setClassName(classes.find((c) => c.id === classId)?.name ?? '');
      } catch (e) {
        if (alive) setLoadError(String((e as Error).message));
      }
    })();
    return () => {
      alive = false;
      cancelled.current = true;
      for (const u of objectUrls.current) URL.revokeObjectURL(u);
      objectUrls.current = [];
    };
  }, [sessionId, classId, current]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Thumbnails are built one by one after the list arrives; the dialog never waits for them. */
  useEffect(() => {
    if (!boards) return;
    let stop = false;
    void (async () => {
      await document.fonts.ready;
      for (const b of boards) {
        if (stop || isEmpty(b.elements) || thumbs[b.pageNo]) continue;
        try {
          const { blob } = await renderBoard(liveOf(b.elements) as never, false);
          if (stop) { URL.revokeObjectURL(blob); return; }
          const url = URL.createObjectURL(blob);
          objectUrls.current.push(url);
          setThumbs((cur) => ({ ...cur, [b.pageNo]: url }));
        } catch { /* a thumbnail is decoration — the export path reports real failures */ }
      }
    })();
    return () => { stop = true; };
  }, [boards]); // eslint-disable-line react-hooks/exhaustive-deps

  async function renderBoard(elements: RawEl[], forPdf: boolean) {
    const blob = await exportToBlob({
      elements: elements as never,
      appState: { exportBackground: true, viewBackgroundColor: '#ffffff', exportWithDarkMode: false } as never,
      files: {},
      mimeType: 'image/png',
      exportPadding: 8,
      // Excalidraw hands us the content box; we pick the pixel size, clamped to a safe canvas
      // (task 2в): thumbnails at ≤320 px, the PDF picture at 2× of the content, never more than
      // a browser can allocate.
      getDimensions: (w: number, h: number) =>
        forPdf ? fitDimensions(w, h, PDF_SCALE) : fitDimensions(w, h, 1, THUMB_SIDE),
    });
    const png = new Uint8Array(await blob.arrayBuffer());
    return { blob, png, ...pngSize(png) };
  }

  const ordered = useMemo(() => [...(boards ?? [])].sort((a, b) => a.pageNo - b.pageNo), [boards]);
  const chosen = ordered.filter((b) => selected.has(b.pageNo));
  const allSelected = !!boards && boards.length > 0 && chosen.length === boards.length;

  function toggle(pageNo: number) {
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(pageNo)) next.delete(pageNo); else next.add(pageNo);
      return next;
    });
  }

  /**
   * Одна и та же сборка картинок для обоих форматов: доска растеризуется ровно один раз и
   * одинаково, поэтому PDF и Word показывают один и тот же рисунок (часть 5). Разница только в
   * упаковке — и `docx`, и `pdf-lib` подгружаются внутри своих сборщиков.
   */
  async function download(kind: ExportKind) {
    if (!chosen.length || busy) return;
    setBusy(true);
    setBusyKind(kind);
    setError('');
    cancelled.current = false;
    setProgress({ done: 0, total: chosen.length });
    const images: BoardImage[] = [];
    try {
      // fonts first: a board with text paints boxes instead of glyphs when Excalidraw runs too early
      await document.fonts.ready;
      for (let i = 0; i < chosen.length; i++) {
        if (cancelled.current) throw new BoardExportCancelled();
        const b = chosen[i]!;
        const { png, width, height } = await renderBoard(liveOf(b.elements) as never, true);
        images.push({ png, width, height });
        setProgress({ done: i + 1, total: chosen.length });
      }
      const file = kind === 'pdf'
        ? await buildBoardPdf({
          images, pageSize,
          cancelled: () => cancelled.current,
          onProgress: (done, total) => setProgress({ done, total }),
        })
        // Word всегда альбомный A4 с полями — это формат документа, а не выбора учителя
        : await buildBoardDocx({
          images,
          cancelled: () => cancelled.current,
          onProgress: (done, total) => setProgress({ done, total }),
        });
      const url = URL.createObjectURL(file);
      objectUrls.current.push(url);
      const a = document.createElement('a');
      a.href = url;
      a.download = kind === 'pdf' ? boardPdfFileName(className) : boardWordFileName(className);
      document.body.appendChild(a);
      a.click();
      a.remove();
      onClose();
    } catch (e) {
      if (e instanceof BoardExportCancelled || e instanceof DocxCancelled) setError(t('lesson.pdfCancelled'));
      else setError(t(kind === 'pdf' ? 'lesson.pdfFailed' : 'lesson.wordFailed', { message: String((e as Error)?.message ?? e) }));
    } finally {
      setBusy(false);
    }
  }

  /*
   * Окно обязано закрываться так же, как всё остальное: Escape и клик по затемнению за пределами
   * карточки. До этого единственным выходом была кнопка «✕» внутри.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  return (
    <div className="modal-backdrop" data-testid="pdf-dialog" role="dialog" aria-modal="true"
      aria-label={t('lesson.pdfTitle')}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal pdf-modal">
        <div className="row">
          <h2 style={{ margin: 0 }}>{t('lesson.pdfTitle')}</h2>
          <div className="spacer" />
          <button type="button" className="ghost" style={{ marginTop: 0 }} data-testid="pdf-close"
            onClick={onClose} aria-label={t('common.close')}>✕</button>
        </div>
        {loadError && <p className="error" data-testid="pdf-load-error">
          {t('lesson.pdfFailed', { message: loadError })}
        </p>}
        {!boards && !loadError && <p className="muted" data-testid="pdf-loading">{t('common.loading')}</p>}
        {boards && (
          <>
            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              <button type="button" className="secondary" style={{ marginTop: 0 }} data-testid="pdf-select-all"
                onClick={() => setSelected(allSelected ? new Set() : new Set(boards.map((b) => b.pageNo)))}>
                {allSelected ? t('lesson.pdfSelectNone') : t('lesson.pdfSelectAll')}
              </button>
              <span className="muted" data-testid="pdf-count">
                {t('lesson.pdfSelected', { n: chosen.length, total: boards.length })}
              </span>
              <div className="spacer" />
              <label className="row" style={{ gap: 4, margin: 0 }}>
                <span className="muted">{t('lesson.pdfPageSize')}</span>
                <select value={pageSize} data-testid="pdf-page-size" style={{ width: 'auto' }}
                  onChange={(e) => setPageSize(e.target.value as BoardPageSize)}>
                  <option value="a4">{t('lesson.pdfSizeA4')}</option>
                  <option value="content">{t('lesson.pdfSizeContent')}</option>
                </select>
              </label>
            </div>

            <ul className="pdf-boards" data-testid="pdf-boards">
              {boards.map((b, i) => (
                <li key={b.pageNo} className="pdf-board">
                  <label className="row" style={{ gap: 8 }}>
                    <input type="checkbox" data-testid={`pdf-pick-${b.pageNo}`} checked={selected.has(b.pageNo)}
                      onChange={() => toggle(b.pageNo)} aria-label={label(b, i + 1)} />
                    {thumbs[b.pageNo]
                      ? <img src={thumbs[b.pageNo]} alt="" data-testid={`pdf-thumb-${b.pageNo}`} className="pdf-thumb" />
                      : <span className="pdf-thumb pdf-thumb-empty" data-testid={`pdf-thumb-${b.pageNo}`} aria-hidden="true" />}
                    <span data-testid={`pdf-name-${b.pageNo}`}>
                      {label(b, i + 1)}
                      {isEmpty(b.elements) && <span className="muted"> · {t('lesson.pdfEmpty')}</span>}
                    </span>
                  </label>
                </li>
              ))}
            </ul>

            {busy && (
              <div className="pdf-progress" data-testid="pdf-progress" role="status">
                <div className="pdf-bar" style={{ width: `${progress && progress.total ? Math.round(100 * progress.done / progress.total) : 0}%` }} />
                <span>{t(busyKind === 'pdf' ? 'lesson.pdfWorking' : 'lesson.wordWorking',
                  { done: progress?.done ?? 0, total: progress?.total ?? chosen.length })}</span>
                <button type="button" className="secondary" style={{ marginTop: 0 }} data-testid="pdf-cancel"
                  onClick={() => { cancelled.current = true; }}>
                  {t('common.cancel')}
                </button>
              </div>
            )}
            {error && <p className="error" data-testid="pdf-error">{error}</p>}

            <div className="row" style={{ marginTop: 8 }}>
              {/* while the file is building the only cancel is the one inside the progress row —
                  two «Отмена» buttons in one dialog read as two different actions */}
              {!busy && (
                <button type="button" className="secondary" style={{ marginTop: 0 }} data-testid="pdf-cancel-close"
                  onClick={() => { cancelled.current = true; onClose(); }}>
                  {t('common.cancel')}
                </button>
              )}
              <div className="spacer" />
              <button type="button" style={{ marginTop: 0 }} data-testid="pdf-download"
                disabled={busy || chosen.length === 0} onClick={() => void download('pdf')}>
                {t('lesson.pdfDownload', { n: chosen.length })}
              </button>
              {/* часть 5: тот же набор досок, другой контейнер. Word не имеет выбора размера
                  страницы — у документа он фиксированный (альбомный A4 с полями). */}
              <button type="button" className="secondary" style={{ marginTop: 0 }} data-testid="word-download"
                disabled={busy || chosen.length === 0} onClick={() => void download('word')}>
                {t('lesson.wordDownload', { n: chosen.length })}
              </button>
            </div>
            <p className="muted" style={{ fontSize: '.85rem' }} data-testid="pdf-hint">{t('lesson.pdfHint')}</p>
          </>
        )}
      </div>
    </div>
  );
}
