/**
 * Часть E (2026-10-17): «доска → описание страницы Word».
 *
 * Это ЧИСТАЯ функция: на входе элементы сцены Excalidraw (в единицах сцены), на выходе — что
 * уходит в картинку-подложку, что становится редактируемым текстом, с каким масштабом и с каким
 * сдвигом. Никакого DOM, никакого `docx`, никакого браузера — поэтому проверяется юнит-тестами
 * сразу для трёх алфавитов (кириллица, узбекская `oʻ/gʻ` с U+02BB, латиница) и для досок, которые
 * не влезают на страницу.
 *
 * Главный инвариант: у картинки и у текста ОДИН масштаб и ОДИН сдвиг — они оба считаются от
 * рамки всей доски (`frame`), поэтому текст не разъезжается с подложкой и не теряется за краем:
 * если доска больше листа, уменьшается весь пояс, а не только картинка.
 */

/** Минимум того, что есть у живого элемента сцены (Excalidraw отдаёт больше — лишнее не мешает). */
export type BoardWordElement = {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  angle?: number;
  isDeleted?: boolean;
  text?: string | null;
  fontSize?: number;
  strokeColor?: string;
  textAlign?: 'left' | 'center' | 'right' | null;
  containerId?: string | null;
};

export type BoardBox = { x: number; y: number; width: number; height: number };

/** Текстовый элемент, ставший редактируемым текстом Word; координаты — в единицах сцены. */
export type WordText = {
  id: string;
  lines: string[];
  box: BoardBox;
  /** кегль в единицах сцены (Excalidraw `fontSize`); в pt он пересчитывается тем же масштабом */
  fontPx: number;
  /** 6 hex-символов без `#` */
  color: string;
  align: 'left' | 'center' | 'right';
};

export type WordPlan = {
  picture: BoardWordElement[];
  texts: WordText[];
  /** bounding box ВСЕХ живых элементов — и картинки, и текстов */
  frame: BoardBox;
  /** сколько текстов осталось в подложке (повёрнутые — их Word по framePr не умеет) */
  rotatedInPicture: number;
};

/** Word-страница режима «редактируемый»: альбомный A4, поле 10 мм (постановка части 5). */
export const WORD_PAGE_MM = { pageWidthMm: 297, pageHeightMm: 210, marginMm: 10 };
/** 1 px при 96 dpi = 15 тви́пов (единица docx для полей, рамок и размеров). */
export const TWIPS_PER_PX = 15;
const PX_PER_MM = 96 / 25.4;
/** Маленькую доску не растягиваем в бесконечность: не больше трёхкратного увеличения. */
const MAX_UPSCALE = 3;
/** Word не принимает кегль вне этого диапазона — граница формата, а не замысел. */
const MIN_PT = 1;
const MAX_PT = 1584;

const isLive = (e: BoardWordElement): boolean => !e.isDeleted && Number.isFinite(e.x) && Number.isFinite(e.y);
const isRotated = (e: BoardWordElement): boolean => Math.abs(e.angle ?? 0) > 0.001;
const isTextElement = (e: BoardWordElement): boolean => e.type === 'text';

/** form-проверка входных данных: объект с `type`-строкой. Координаты смотрит `planWordBoard`. */
export function asBoardElements(raw: unknown[]): BoardWordElement[] {
  const out: BoardWordElement[] = [];
  for (const item of raw) {
    const e = item as BoardWordElement | undefined;
    if (!e || typeof e !== 'object' || typeof e.type !== 'string') continue;
    out.push(e);
  }
  return out;
}

/** `#abc`/`#rrggbb` → `rrggbb`; всё остальное — цвет по умолчанию Excalidraw. */
export function wordColor(color: string | undefined): string {
  const c = (color ?? '').trim().toLowerCase();
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/.exec(c);
  if (!m?.[1]) return '1e1e1e';
  const hex = m[1];
  return hex.length === 3 ? hex.split('').map((h) => h + h).join('') : hex;
}

export function textLines(text: string | null | undefined): string[] {
  return (text ?? '').replace(/\r\n?/g, '\n').split('\n');
}

export function boxOf(elements: BoardWordElement[]): BoardBox {
  if (!elements.length) return { x: 0, y: 0, width: 1, height: 1 };
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const e of elements) {
    x0 = Math.min(x0, e.x);
    y0 = Math.min(y0, e.y);
    x1 = Math.max(x1, e.x + Math.max(1, e.width));
    y1 = Math.max(y1, e.y + Math.max(1, e.height));
  }
  return { x: x0, y: y0, width: Math.max(1, x1 - x0), height: Math.max(1, y1 - y0) };
}

/** Текстовый элемент → строки, позиция, кегль, цвет и выравнивание (в единицах сцены). */
function textItem(e: BoardWordElement): WordText {
  return {
    id: e.id,
    lines: textLines(e.text),
    box: { x: e.x, y: e.y, width: Math.max(1, e.width), height: Math.max(1, e.height) },
    fontPx: Math.max(1, e.fontSize ?? 28),
    color: wordColor(e.strokeColor),
    align: e.textAlign === 'center' || e.textAlign === 'right' ? e.textAlign : 'left',
  };
}

/**
 * Разбор сцены на подложку и редактируемый текст.
 *
 * В картинку идут все НЕ текстовые элементы и ПОВЁРНУТЫЙ текст (его framePr не воспроизводит —
 * честное ограничение одной строкой в окне экспорта). Текст внутри фигуры — это отдельный
 * элемент сцены с своим `containerId`, поэтому он уходит из подложки и становится редактируемым
 * на том же месте: дублирования нет.
 */
export function planWordBoard(raw: unknown[]): WordPlan {
  const live = asBoardElements(raw).filter(isLive);
  const picture: BoardWordElement[] = [];
  const texts: WordText[] = [];
  let rotatedInPicture = 0;

  for (const e of live) {
    // пустой текстовый элемент ничего не рисует: он не нужен ни в подложке, ни в редактируемых
    // строках, и оставлять его в рамке — значит портить масштаб доски
    if (isTextElement(e) && (e.text ?? '').length === 0) continue;
    const editable = isTextElement(e) && !isRotated(e);
    if (!editable) {
      picture.push(e);
      if (isTextElement(e)) rotatedInPicture += 1;
      continue;
    }
    texts.push(textItem(e));
  }

  // рамка — по всем живым элементам: и по тем, что в подложке, и по тем, что стали текстом
  return { picture, texts, frame: boxOf(live), rotatedInPicture };
}

/**
 * ВЕСЬ текст доски, включая повёрнутый — для режима «Картинка и текст по порядку»: там список
 * читается как расшифровка, а не как редактируемые объекты, поэтому поворот не причина терять
 * строки.
 */
export function allTexts(raw: unknown[]): WordText[] {
  return asBoardElements(raw)
    .filter((e) => isLive(e) && isTextElement(e) && (e.text ?? '').length > 0)
    .map(textItem);
}

export function contentBoxPx(page: typeof WORD_PAGE_MM = WORD_PAGE_MM): { width: number; height: number } {
  return {
    width: (page.pageWidthMm - 2 * page.marginMm) * PX_PER_MM,
    height: (page.pageHeightMm - 2 * page.marginMm) * PX_PER_MM,
  };
}

/** Сколько px@96dpi приходится на одну единицу сцены: влезает целиком, при этом не растёт втрое. */
export function wordScale(plan: WordPlan, page: typeof WORD_PAGE_MM = WORD_PAGE_MM): number {
  const box = contentBoxPx(page);
  const fit = Math.min(box.width / Math.max(1, plan.frame.width), box.height / Math.max(1, plan.frame.height));
  return Math.max(0.0001, Math.min(fit, MAX_UPSCALE));
}

/** Абзац-рамка Word: координаты от верхнего левого угла страницы, в тви́пах. */
export type PlacedWordFrame = {
  xTwips: number;
  yTwips: number;
  widthTwips: number;
  heightTwips: number;
};

export type PlacedWordText = PlacedWordFrame & {
  id: string;
  lines: string[];
  fontPt: number;
  color: string;
  align: 'left' | 'center' | 'right';
};

export type PlacedWordBoard = {
  scale: number;
  /** сколько px на сторону займёт подложка (для запроса растра) и её рамка на странице */
  picture: (PlacedWordFrame & { widthPx: number; heightPx: number }) | null;
  texts: PlacedWordText[];
  /** тексты, которые не влезли бы на страницу даже при этом масштабе (должно быть 0) */
  outside: number;
};

const twips = (px: number): number => Math.max(0, Math.round(px * TWIPS_PER_PX));

/**
 * Один масштаб и один сдвиг для картинки и текста: всё считается от `frame`, поэтому подложка и
 * редактируемые строки не расходятся, а доска больше листа уменьшается целиком.
 */
export function placeWordBoard(plan: WordPlan, page: typeof WORD_PAGE_MM = WORD_PAGE_MM): PlacedWordBoard {
  const scale = wordScale(plan, page);
  const marginPx = page.marginMm * PX_PER_MM;
  const box = contentBoxPx(page);

  const picture = plan.picture.length
    ? (() => {
      const b = boxOf(plan.picture);
      const widthPx = Math.max(1, Math.round(b.width * scale));
      const heightPx = Math.max(1, Math.round(b.height * scale));
      return {
        xTwips: twips(marginPx + (b.x - plan.frame.x) * scale),
        yTwips: twips(marginPx + (b.y - plan.frame.y) * scale),
        widthTwips: twips(widthPx),
        heightTwips: twips(heightPx),
        widthPx,
        heightPx,
      };
    })()
    : null;

  let outside = 0;
  const texts = plan.texts.map((t): PlacedWordText => {
    const x = marginPx + (t.box.x - plan.frame.x) * scale;
    const y = marginPx + (t.box.y - plan.frame.y) * scale;
    const w = t.box.width * scale;
    if (x < -1 || y < -1 || x + w > box.width + marginPx + 1) outside += 1;
    return {
      id: t.id,
      lines: t.lines,
      xTwips: twips(x),
      yTwips: twips(y),
      widthTwips: twips(Math.max(8, w)),
      heightTwips: twips(Math.max(8, t.box.height * scale)),
      fontPt: Math.min(MAX_PT, Math.max(MIN_PT, (t.fontPx * scale * 72) / 96)),
      color: t.color,
      align: t.align,
    };
  });

  return { scale, picture, texts, outside };
}

/**
 * Текст «по порядку чтения»: сверху вниз, слева направо. Строкой считается набор элементов,
 * чьи вертикальные диапазоны пересекаются, — два независимых текста на одной высоте должны
 * идти в порядке лево→право, а не по id.
 */
export function readingOrder(texts: WordText[]): WordText[] {
  const sorted = [...texts].sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
  type Row = { items: WordText[]; y0: number; y1: number };
  const rows: Row[] = [];
  for (const t of sorted) {
    const top = t.box.y;
    const bottom = t.box.y + t.box.height;
    const row = rows.find((r) => r.y0 <= bottom && top <= r.y1);
    if (row) {
      row.items.push(t);
      row.y0 = Math.min(row.y0, top);
      row.y1 = Math.max(row.y1, bottom);
    } else rows.push({ items: [t], y0: top, y1: bottom });
  }
  return rows
    .sort((a, b) => a.y0 - b.y0)
    .flatMap((r) => [...r.items].sort((a, b) => a.box.x - b.box.x));
}

/** Кегль для режима «по порядку»: тот же пересчёт, но в пределах читаемого. */
export function stackedFontPt(text: WordText): number {
  return Math.min(24, Math.max(8, Math.round((text.fontPx * 72) / 96)));
}
