/**
 * Часть E (2026-10-17): сборка .docx из доски — три режима в одном окне экспорта.
 *
 *   `image`    — прежний «Word: картинка» (часть 5, 2026-10-14): одна страница на доску, картинка
 *                целиком в текстовой области листа. Размещение и размеры не изменены.
 *   `editable` — «Word: редактируемый»: подложка (все НЕ текстовые элементы + повёрнутый текст) и
 *                каждый текст отдельным абзацем с `w:framePr` на том же месте и в том же масштабе.
 *                Текста в подложке нет, поэтому он не дублируется.
 *   `stacked`  — «Картинка и текст по порядку»: картинка доски целиком, ниже — весь текст обычными
 *                абзацами в порядке чтения (сверху вниз, слева направо).
 *
 * Разбором сцены, масштабом и позициями заведует чистая функция из `boardWord.ts` — она видна
 * юнит-тестам без браузера. `docx` (MIT) подгружается динамически и только здесь, поэтому в
 * начальный чанк страницы урока и архива библиотека не попадает (размер ленивого чанка — в отчёте).
 * Отсюда же второй упаковщик — `buildWordDocxBytes`: он отдаёт Uint8Array через `Packer.toBuffer`,
 * чтобы собранный документ можно было распаковать и разобрать в тесте без браузера.
 *
 * Метаданные — без персональных данных: ни имени класса, ни людей, ни id (как в PDF, часть 1г).
 */
import type { IFrameOptions, ISectionOptions } from 'docx';
import {
  allTexts, placeWordBoard, planWordBoard, readingOrder, stackedFontPt, type PlacedWordFrame,
} from './boardWord.js';

/** A4 в портретных миллиметрах — см. пояснение в `boardSectionProps`: docx сам разворачивает пару. */
const A4_PORTRAIT_MM = { width: 210, height: 297 };
const MARGIN_MM = 10;
/** 1 мм в тви́пах (единица Measure у docx для полей и размеров страницы). */
const MM_TO_TWIPS = 56.6929;
/** px при 96 dpi — в этих единицах docx задаёт размер картинки на странице. */
const MM_TO_PX = 96 / 25.4;

export type WordMode = 'image' | 'editable' | 'stacked';

export type WordBoardSource = {
  png: Uint8Array;
  /** пиксели PNG — нужны режимам `image` и `stacked` */
  width?: number;
  height?: number;
  /** элементы доски (сцена Excalidraw, как её отдаёт сервер) — нужны `editable` и `stacked` */
  elements?: unknown[];
};

export interface WordBuildOptions {
  mode: WordMode;
  boards: WordBoardSource[];
  cancelled: () => boolean;
  onProgress?: (done: number, total: number) => void;
}

export class DocxCancelled extends Error {}

/** Размер картинки внутри полей: содержимое целиком, но не больше текстовой области страницы. */
export function docxImageSize(width: number, height: number): { width: number; height: number } {
  const boxW = (A4_PORTRAIT_MM.height - 2 * MARGIN_MM) * MM_TO_PX;
  const boxH = (A4_PORTRAIT_MM.width - 2 * MARGIN_MM) * MM_TO_PX;
  const s = Math.min(boxW / Math.max(1, width), boxH / Math.max(1, height));
  return { width: Math.max(1, Math.round(width * s)), height: Math.max(1, Math.round(height * s)) };
}

/**
 * Одна секция = одна страница (тот же порядок, что в прежнем режиме).
 *
 * docx 9.11.0 кладёт в `w:pgSz/@w` то, что получил в `width`, а при ориентации LANDSCAPE меняет их
 * местами; Word трактует `@w` как фактическую ширину, а `orient` — как метаданные. Поэтому сюда
 * намеренно идут ПОРТРЕТНЫЕ числа: на выходе `<w:pgSz w:w="16838" w:h="11906"
 * w:orient="landscape"/>` — настоящая альбомная A4. Если передать 297×210, получится перевёрнутая
 * пара (проверено на установленном пакете), и страница в Word была бы книжной, а не альбомной.
 */
function boardSectionProps(): ISectionOptions['properties'] {
  const mm = Math.round(MARGIN_MM * MM_TO_TWIPS);
  return {
    page: {
      size: {
        orientation: 'landscape',
        width: Math.round(A4_PORTRAIT_MM.width * MM_TO_TWIPS),
        height: Math.round(A4_PORTRAIT_MM.height * MM_TO_TWIPS),
      },
      margin: { top: mm, right: mm, bottom: mm, left: mm },
    },
  };
}

/** Абзац-рамка: абсолютные координаты от верхнего левого угла СТРАНИЦЫ, без обтекания. */
function absoluteFrame(f: PlacedWordFrame): IFrameOptions {
  return {
    type: 'absolute',
    position: { x: f.xTwips, y: f.yTwips },
    width: f.widthTwips,
    height: f.heightTwips,
    anchor: { horizontal: 'page', vertical: 'page' },
    wrap: 'none',
  };
}

/** Одна доска → одна секция: подложка и (в редактируемом режиме) рамка на каждый текст. */
async function boardSection(mode: WordMode, board: WordBoardSource): Promise<ISectionOptions> {
  const { AlignmentType, ImageRun, Paragraph, TextRun } = await import('docx');
  const children: InstanceType<typeof Paragraph>[] = [];

  if (mode === 'image') {
    const size = docxImageSize(board.width ?? 1, board.height ?? 1);
    children.push(new Paragraph({
      children: [new ImageRun({ type: 'png', data: board.png, transformation: size })],
    }));
  } else if (mode === 'editable') {
    const placed = placeWordBoard(planWordBoard(board.elements ?? []));
    if (placed.picture) {
      children.push(new Paragraph({
        frame: absoluteFrame(placed.picture),
        children: [new ImageRun({
          type: 'png', data: board.png,
          transformation: { width: placed.picture.widthPx, height: placed.picture.heightPx },
        })],
      }));
    }
    for (const t of placed.texts) {
      children.push(new Paragraph({
        frame: absoluteFrame(t),
        alignment: t.align === 'center' ? AlignmentType.CENTER
          : t.align === 'right' ? AlignmentType.RIGHT : AlignmentType.LEFT,
        // многострочность сохраняется переносом внутри одного абзаца: строки доски не сливаются
        children: t.lines.map((line, n) => new TextRun({
          text: line, break: n === 0 ? undefined : 1,
          font: 'Arial', size: Math.round(t.fontPt * 2), color: t.color,
        })),
      }));
    }
  } else {
    // «по порядку»: картинка доски целиком, затем все тексты обычными абзацами в порядке чтения
    const size = docxImageSize(board.width ?? 1, board.height ?? 1);
    children.push(new Paragraph({
      children: [new ImageRun({ type: 'png', data: board.png, transformation: size })],
    }));
    for (const t of readingOrder(allTexts(board.elements ?? []))) {
      const fontPt = stackedFontPt(t);
      children.push(new Paragraph({
        children: t.lines.map((line, n) => new TextRun({
          text: line, break: n === 0 ? undefined : 1, font: 'Arial', size: fontPt * 2, color: t.color,
        })),
      }));
    }
  }

  return { properties: boardSectionProps(), children };
}

/** Сборка документа: по одной секции на доску, прогресс и отмена — как у PDF. */
async function assemble(opts: WordBuildOptions): Promise<import('docx').Document> {
  const { Document } = await import('docx');
  const sections: ISectionOptions[] = [];
  for (let i = 0; i < opts.boards.length; i++) {
    if (opts.cancelled()) throw new DocxCancelled();
    opts.onProgress?.(i + 1, opts.boards.length);
    sections.push(await boardSection(opts.mode, opts.boards[i]!));
  }
  return new Document({
    // метаданные без персональных данных: ни класса, ни людей, ни id
    creator: 'BluBlu',
    title: 'BluBlu',
    lastModifiedBy: 'BluBlu',
    description: '',
    sections,
  });
}

/** Для браузера: файл уходит как Blob (тот же путь, что раньше). */
export async function buildWordDocx(opts: WordBuildOptions): Promise<Blob> {
  const { Packer } = await import('docx');
  const doc = await assemble(opts);
  if (opts.cancelled()) throw new DocxCancelled();
  return Packer.toBlob(doc);
}

/** Для проверок без браузера: те же байты, что получит учитель, только Buffer. */
export async function buildWordDocxBytes(opts: WordBuildOptions): Promise<Uint8Array> {
  const { Packer } = await import('docx');
  const doc = await assemble(opts);
  if (opts.cancelled()) throw new DocxCancelled();
  return Packer.toBuffer(doc);
}
