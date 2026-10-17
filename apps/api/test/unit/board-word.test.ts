/**
 * Часть E (2026-10-17): чистая функция «сцена → описание страницы Word».
 *
 * Проверяется ровно то, что нельзя увидеть глазами в браузере: фильтрация элементов, ОДИН масштаб
 * и ОДИН сдвиг для картинки и текста, пересчёт кегля, многострочность, сохранение цвета, порялок
 * чтения и то, что текст не теряется за страницей.
 */
import { describe, expect, it } from 'vitest';
import {
  TWIPS_PER_PX, WORD_PAGE_MM, asBoardElements, boxOf, contentBoxPx, planWordBoard, placeWordBoard,
  readingOrder, stackedFontPt, textLines, wordColor, wordScale,
  type BoardWordElement,
} from '@klass/shared';

const el = (over: Partial<BoardWordElement> & { id: string; type: string }): BoardWordElement => ({
  x: 0, y: 0, width: 100, height: 40, isDeleted: false, angle: 0, ...over,
});

const rect = el({ id: 'r1', type: 'rectangle', x: 10, y: 20, width: 300, height: 200 });
const note = el({ id: 't1', type: 'text', x: 40, y: 60, width: 200, height: 40, text: 'Проверка', fontSize: 28, strokeColor: '#c92a2a' });

describe('что уходит в подложку, а что становится текстом', () => {
  it('фигура остаётся картинкой, текст становится редактируемым', () => {
    const plan = planWordBoard([rect, note]);
    expect(plan.picture.map((e) => e.id)).toEqual(['r1']);
    expect(plan.texts.map((t) => t.id)).toEqual(['t1']);
    expect(plan.rotatedInPicture).toBe(0);
  });

  it('повёрнутый текст остаётся в подложке и не становится рамкой', () => {
    const rotated = el({ id: 't2', type: 'text', x: 500, y: 500, text: 'Na kos', angle: 0.5 });
    const plan = planWordBoard([rect, note, rotated]);
    expect(plan.picture.map((e) => e.id)).toEqual(['r1', 't2']);
    expect(plan.texts.map((t) => t.id)).toEqual(['t1']);
    expect(plan.rotatedInPicture).toBe(1);
  });

  it('текст внутри фигуры — отдельный элемент, и он редактируемый, а в картинке его нет', () => {
    const label = el({ id: 't3', type: 'text', x: 120, y: 100, width: 60, height: 30, text: 'Да', containerId: 'r1' });
    const plan = planWordBoard([rect, label]);
    expect(plan.picture.map((e) => e.id)).toEqual(['r1']);
    expect(plan.texts.map((t) => t.id)).toEqual(['t3']);
  });

  it('пустой текст, удалённый элемент и мусор без type не доходят до страницы', () => {
    const empty = el({ id: 't4', type: 'text', text: '' });
    const gone = el({ id: 'x1', type: 'text', text: 'было', isDeleted: true });
    const plan = planWordBoard([rect, empty, gone, null, { nope: true }, note]);
    expect(plan.texts.map((t) => t.id)).toEqual(['t1']);
    expect(plan.picture.map((e) => e.id)).toEqual(['r1']);
  });
  it('рамка — bounding box ВСЕХ живых элементов, а не только картинки', () => {
    const plan = planWordBoard([rect, note, el({ id: 't5', type: 'text', x: 900, y: 800, width: 50, height: 30, text: 'дальний' })]);
    // x: 10 … max(310, 240, 950) = 950 → 940; y: 20 … max(220, 100, 830) = 830 → 810
    expect(plan.frame).toEqual({ x: 10, y: 20, width: 940, height: 810 });
  });
});

describe('масштаб и сдвиг: один на картинку и на текст', () => {
  it('доска больше листа уменьшается целиком, а не рвётся', () => {
    const huge = el({ id: 'r2', type: 'rectangle', x: 0, y: 0, width: 4000, height: 2000 });
    const t = el({ id: 't6', type: 'text', x: 3900, y: 1900, width: 90, height: 40, text: 'у края', fontSize: 28 });
    const plan = planWordBoard([huge, t]);
    const box = contentBoxPx();
    const scale = wordScale(plan);
    expect(scale).toBeLessThanOrEqual(Math.min(box.width / 4000, box.height / 2000) + 1e-9);
    const placed = placeWordBoard(plan);
    expect(placed.outside).toBe(0);
    // и картинка, и текст считают координаты от одного начала координат: ширина рамки в тви́пах
    // равна ширине картинки в единицах сцены × масштаб (округление до тви́па даёт ~1e-4)
    const pxPerUnit = placed.picture!.widthTwips / (boxOf([huge]).width * scale * TWIPS_PER_PX);
    expect(pxPerUnit).toBeCloseTo(1, 3);
  });

  it('крошечная доска не растягивается больше чем втрое', () => {
    const tiny = el({ id: 'r3', type: 'rectangle', width: 10, height: 10 });
    const plan = planWordBoard([tiny]);
    expect(wordScale(plan)).toBeLessThanOrEqual(3);
  });

  it('сдвиг одинаковый: вектор от рамки до страницы один для всех', () => {
    const a = el({ id: 'ra', type: 'rectangle', x: 1000, y: 500, width: 200, height: 100 });
    const b = el({ id: 'tb', type: 'text', x: 1400, y: 700, width: 100, height: 40, text: 'тут', fontSize: 20 });
    const plan = planWordBoard([a, b]);
    const placed = placeWordBoard(plan);
    const scale = placed.scale;
    const marginPx = WORD_PAGE_MM.marginMm * (96 / 25.4);
    const expectTwips = (sceneX: number) => Math.round((marginPx + (sceneX - plan.frame.x) * scale) * TWIPS_PER_PX);
    expect(placed.texts[0]!.xTwips).toBe(expectTwips(1400));
    expect(placed.picture!.xTwips).toBe(expectTwips(1000));
  });

  it('кегль пересчитывается тем же коэффициентом и остаётся в пределах Word', () => {
    const plan = planWordBoard([note]);
    const placed = placeWordBoard(plan);
    const t = placed.texts[0]!;
    // сцены 28px → pt = px * scale * 72/96
    expect(t.fontPt).toBeCloseTo((28 * placed.scale * 72) / 96, 6);
    expect(t.fontPt).toBeGreaterThanOrEqual(1);
    expect(t.fontPt).toBeLessThanOrEqual(1584);
  });

  it('все рамки лежат внутри страницы', () => {
    const wide = el({ id: 'rw', type: 'rectangle', x: 0, y: 0, width: 5000, height: 400 });
    const many = [1, 2, 3, 4].map((n) => el({
      id: `tm${n}`, type: 'text', x: n * 1100, y: 300, width: 300, height: 60, text: `строка ${n}`, fontSize: 24,
    }));
    const plan = planWordBoard([wide, ...many]);
    const placed = placeWordBoard(plan);
    // альбомная страница: горизонталь — 297 мм, вертикаль — 210 мм, поле 10 мм с каждой стороны
    const pageWtw = Math.ceil((WORD_PAGE_MM.pageWidthMm - 2 * WORD_PAGE_MM.marginMm) * 56.6929);
    const pageHtw = Math.ceil((WORD_PAGE_MM.pageHeightMm - 2 * WORD_PAGE_MM.marginMm) * 56.6929);
    for (const t of placed.texts) {
      expect(t.xTwips).toBeGreaterThanOrEqual(0);
      expect(t.yTwips).toBeGreaterThanOrEqual(0);
      expect(t.xTwips + t.widthTwips, `горизонталь: ${JSON.stringify(t)}`).toBeLessThanOrEqual(pageWtw + 1);
      expect(t.yTwips + t.heightTwips, `вертикаль: ${JSON.stringify(t)}`).toBeLessThanOrEqual(pageHtw + 1);
    }
    expect(placed.outside).toBe(0);
  });
});

describe('текст: строки, цвет, порядок чтения', () => {
  it('многострочность и переносы сохраняются как есть', () => {
    const t = el({ id: 'multi', type: 'text', text: 'раз\r\nдва\n\nчетыре', fontSize: 20 });
    const plan = planWordBoard([t]);
    expect(plan.texts[0]!.lines).toEqual(['раз', 'два', '', 'четыре']);
  });

  it('кириллица, узбекские oʻ/gʻ (U+02BB) и латиница не искажаются', () => {
    const source = 'Доска · Oʻzbekcha gʻalaba · Alpha';
    const plan = planWordBoard([el({ id: 'u', type: 'text', text: source })]);
    expect(plan.texts[0]!.lines.join('\n')).toBe(source);
    expect(plan.texts[0]!.lines.join('\n')).toContain('ʻ'); // U+02BB, не апостроф и не U+2018
  });

  it('цвет сохраняется как 6 hex без решётки, тройка разворачивается, а негодный цвет становится основным', () => {
    expect(wordColor('#c92a2a')).toBe('c92a2a');
    expect(wordColor('#abc')).toBe('aabbcc');
    expect(wordColor('red')).toBe('1e1e1e');
    expect(wordColor(undefined)).toBe('1e1e1e');
    const plan = planWordBoard([note]);
    expect(plan.texts[0]!.color).toBe('c92a2a');
  });

  it('выравнивание доходит до страницы', () => {
    const plan = planWordBoard([el({ id: 'c', type: 'text', text: 'по центру', textAlign: 'center' })]);
    expect(plan.texts[0]!.align).toBe('center');
    expect(placeWordBoard(plan).texts[0]!.align).toBe('center');
  });

  it('порядок чтения: сверху вниз, а в одной строке — слева направо', () => {
    const rowTop = [
      el({ id: 'b', type: 'text', x: 300, y: 100, width: 50, height: 30, text: 'второй' }),
      el({ id: 'a', type: 'text', x: 100, y: 96, width: 50, height: 30, text: 'первый' }),
    ];
    const below = [el({ id: 'c', type: 'text', x: 10, y: 400, width: 50, height: 30, text: 'снизу' })];
    const ordered = readingOrder(planWordBoard([...below, ...rowTop]).texts);
    expect(ordered.map((t) => t.id)).toEqual(['a', 'b', 'c']);
  });

  it('в режиме «по порядку» кегль остаётся читаемым', () => {
    const giant = el({ id: 'g', type: 'text', text: 'огромный', fontSize: 400 });
    const small = el({ id: 's', type: 'text', text: 'мелкий', fontSize: 4 });
    const plan = planWordBoard([giant, small]);
    expect(stackedFontPt(plan.texts.find((t) => t.id === 'g')!)).toBeLessThanOrEqual(24);
    expect(stackedFontPt(plan.texts.find((t) => t.id === 's')!)).toBeGreaterThanOrEqual(8);
  });
});

describe('входные данные с сервера', () => {
  it('элементы без координат не превращаются в NaN-рамку', () => {
    const broken = { id: 'q', type: 'text', x: NaN, y: 0, width: 1, height: 1, text: 'нет' };
    // asBoardElements фильтрует форму (объект со строкой type), координаты смотрит planWordBoard
    expect(asBoardElements([rect, broken])).toHaveLength(2);
    const plan = planWordBoard([rect, broken]);
    expect(plan.texts).toEqual([]);
    expect(plan.picture.map((e) => e.id)).toEqual(['r1']);
    expect(Number.isFinite(plan.frame.width)).toBe(true);
  });

  it('пустая доска даёт годную страницу без рамки и без картинок', () => {
    const plan = planWordBoard([]);
    expect(plan.picture).toEqual([]);
    expect(plan.texts).toEqual([]);
    const placed = placeWordBoard(plan);
    expect(placed.picture).toBeNull();
    expect(Number.isFinite(placed.scale)).toBe(true);
  });

  it('доска без текста — это ровно подложка, и лишней страницы не появляется', () => {
    const plan = planWordBoard([rect]);
    expect(plan.texts).toEqual([]);
    expect(placeWordBoard(plan).texts).toEqual([]);
  });

  it('textLines не изобретает пустую строку в конце', () => {
    expect(textLines('одна')).toEqual(['одна']);
    expect(textLines('')).toEqual(['']);
  });
});
