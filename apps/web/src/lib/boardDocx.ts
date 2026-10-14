/**
 * Часть 5 (2026-10-14): экспорт досок в Word (.docx).
 *
 * Один файл, одна страница на доску, альбомный A4 с полями. Картинки те же, что и у PDF: сцена
 * растеризуется Excalidraw в масштабе 2 на белом фоне, поэтому в Word и в PDF попадает один и тот
 * же рисунок, а не две разные интерпретации одной доски.
 *
 * `docx` (MIT, 9.11.0) импортируется динамически и только здесь: в начальный чанк страницы урока
 * и архив библиотека не попадает — она нужна лишь в тот момент, когда учитель нажал «Скачать Word».
 */
import { boardExportBaseName } from './boardPdf';

/**
 * A4 в портретных миллиметрах (210×297) — их и надо передавать в docx вместе с
 * `orientation: LANDSCAPE`, см. пояснение в `buildBoardDocx`. Поле 10 мм со всех сторон.
 */
const A4_PORTRAIT_MM = { width: 210, height: 297 };
const MARGIN_MM = 10;
/** 1 мм в тви́пах (единицаMeasure у docx для полей и размеров страницы). */
const MM_TO_TWIPS = 56.6929;
/** px при 96 dpi — в этих единицах docx задаёт размер картинки на странице. */
const MM_TO_PX = 96 / 25.4;

export type DocxBoardImage = { png: Uint8Array; width: number; height: number };

/**
 * Размер картинки внутри полей: содержимое целиком, но не больше текстовой области страницы.
 * Большая доска тем самым УМЕНЬШАЕТСЯ до безопасного размера, а не разрывает страницу; пикселей
 * у неё и так не больше потолка `fitDimensions` (6 000 px на сторону), который стоит в растре.
 */
export function docxImageSize(width: number, height: number): { width: number; height: number } {
  // альбомная страница: 297 мм широкая, 210 мм высокая
  const boxW = (A4_PORTRAIT_MM.height - 2 * MARGIN_MM) * MM_TO_PX;
  const boxH = (A4_PORTRAIT_MM.width - 2 * MARGIN_MM) * MM_TO_PX;
  const s = Math.min(boxW / Math.max(1, width), boxH / Math.max(1, height));
  return { width: Math.max(1, Math.round(width * s)), height: Math.max(1, Math.round(height * s)) };
}

export class DocxCancelled extends Error {}

/** Имя файла в том же порядке, что у PDF: BluBlu-<класс>-<дата>.docx. */
export function boardWordFileName(className: string, at: Date = new Date()): string {
  return `${boardExportBaseName(className, at)}.docx`;
}

/**
 * Собирает .docx из готовых PNG. Прогресс и отмена — те же, что у PDF: учитель может остановить
 * сборку на любой доске, и тогда файла не будет вовсе, а не половина комплекта.
 */
export async function buildBoardDocx(opts: {
  images: DocxBoardImage[];
  cancelled: () => boolean;
  onProgress?: (done: number, total: number) => void;
}): Promise<Blob> {
  const { Document, Packer, Paragraph, ImageRun, PageOrientation } = await import('docx');
  const total = opts.images.length;
  const sections = opts.images.map((img, i) => {
    if (opts.cancelled()) throw new DocxCancelled();
    opts.onProgress?.(i + 1, total);
    const size = docxImageSize(img.width, img.height);
    return {
      properties: {
        page: {
          size: {
            orientation: PageOrientation.LANDSCAPE,
            /*
             * docx 9.11.0 разворачивает страницу сам: он кладёт в `w:pgSz/@w` то, что получил в
             * `width`, а в `@h` — то, что в `height`, и при ориентации LANDSCAPE меняет их местами.
             * Word трактует `@w` как фактическую ширину, а `orient` — как метаданные, поэтому сюда
             * намеренно идут портретные числа: на выходе `<w:pgSz w:w="16838" w:h="11906"
             * w:orient="landscape"/>` — настоящая альбомная A4. Если передать 297×210, получится
             * перевёрнутая пара (проверено на установленном пакете), и страница в Word была бы
             * книжной, а не альбомной.
             */
            width: Math.round(A4_PORTRAIT_MM.width * MM_TO_TWIPS),
            height: Math.round(A4_PORTRAIT_MM.height * MM_TO_TWIPS),
          },
          margin: {
            top: Math.round(MARGIN_MM * MM_TO_TWIPS), right: Math.round(MARGIN_MM * MM_TO_TWIPS),
            bottom: Math.round(MARGIN_MM * MM_TO_TWIPS), left: Math.round(MARGIN_MM * MM_TO_TWIPS),
          },
        },
      },
      children: [new Paragraph({
        children: [new ImageRun({ type: 'png', data: img.png, transformation: size })],
      })],
    };
  });
  const doc = new Document({
    // метаданные без персональных данных: ни класса, ни людей, ни id — как в PDF (часть 1г)
    creator: 'BluBlu',
    title: 'BluBlu',
    lastModifiedBy: 'BluBlu',
    description: '',
    sections,
  });
  if (opts.cancelled()) throw new DocxCancelled();
  return Packer.toBlob(doc);
}
