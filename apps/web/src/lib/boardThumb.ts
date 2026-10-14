import { fitDimensions } from './boardPdf';

type RawEl = { id: string; isDeleted?: boolean; [k: string]: unknown };

/**
 * Часть 4 (2026-10-14): миниатюра доски для архива.
 *
 * Архив не рисует — он показывает сохранённые сцены. Значит вместо живого холста Excalidraw
 * достаточно растровой картинки, собранной из тех же элементов. Но тянуть `@excalidraw/excalidraw`
 * в чанк страницы архива нельзя: он весит больше всего остального урока и нужен только тогда,
 * когда доска действительно попала в поле зрения. Поэтому модуль импортируется динамически и
 * ровно один раз на сессию страницы.
 */
let mod: Promise<typeof import('@excalidraw/excalidraw')> | null = null;
const loadExcalidraw = () => (mod ??= import('@excalidraw/excalidraw'));

/** Длинная сторона миниатюры: двадцать досок на телефоне должны оставаться дешёвыми. */
export const THUMB_SIDE = 320;
/** Полноразмерный просмотр: крупнее нет смысла — больше canvas не помещается в экран. */
export const FULL_SIDE = 1600;

/**
 * PNG сцены. Белое фон и без тёмной темы — как в экспорте PDF (часть 1г): доска это материал,
 * а материал должен выглядеть одинаково у всех, кто его смотрит.
 */
export async function renderBoardBlob(elements: RawEl[], maxSide: number, scale = 1): Promise<Blob> {
  const { exportToBlob } = await loadExcalidraw();
  // шрифты заранее: текст доски превращается в прямоугольники, если Excalidraw рисуется раньше
  if (typeof document !== 'undefined') await document.fonts.ready;
  return exportToBlob({
    elements: elements.filter((e) => !e.isDeleted) as never,
    appState: { exportBackground: true, viewBackgroundColor: '#ffffff', exportWithDarkMode: false } as never,
    files: {},
    mimeType: 'image/png',
    exportPadding: 8,
    getDimensions: (w: number, h: number) => fitDimensions(w, h, scale, maxSide),
  });
}

/** Есть ли на доске живой элемент — пустую доску нечего ни рисовать, ни предлагать в экспорт. */
export const hasInk = (els: RawEl[]) => els.some((e) => !e.isDeleted);
