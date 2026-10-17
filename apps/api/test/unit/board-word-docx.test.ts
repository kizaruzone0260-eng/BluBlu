/**
 * Часть E (2026-10-17): собранный .docx распаковывается и проверяется побайтово — без браузера.
 *
 * Это тот же разбор, что делает e2e-спека `zz22-board-word` своим `zipReader.ts`: центральный
 * каталог → локальные заголовки → данные (stored или deflate). Помощник скопирован, а не
 * импортирован, потому что `apps/api` не видит пакет `apps/e2e`; читается настоящий zip, а не
 * подстрока в байтах.
 *
 * Проверяются ровно те числа, которые требует постановка: число рамок = числу редактируемых
 * текстов (плюс одна рамка подложки — это тоже позиционируемый объект, и ниже это названо),
 * текст совпадает побуквенно, одно изображение на страницу, все рамки внутри страницы, число
 * страниц = числу выбранных досок, и «по порядку» содержит весь текст в нужном порядке.
 */
import { inflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { buildWordDocx, type WordBoardSource, type WordMode } from '@klass/shared/boardDocxBuild';
import { planWordBoard, placeWordBoard, WORD_PAGE_MM, type BoardWordElement } from '@klass/shared';

const TWIPS_PER_MM = 56.6929;
const A4_LANDSCAPE = { w: Math.round(297 * TWIPS_PER_MM), h: Math.round(210 * TWIPS_PER_MM) };
const MM_TO_TWIPS = TWIPS_PER_MM;

interface ZipEntry { name: string; data: Buffer }

function unzip(buf: Buffer): ZipEntry[] {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error('not a zip: end-of-central-directory not found');
  const count = buf.readUInt16LE(eocd + 10);
  const cdStart = buf.readUInt32LE(eocd + 16);
  const entries: ZipEntry[] = [];
  for (let off = cdStart, i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error(`bad central header at ${off}`);
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const start = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(start, start + compSize);
    entries.push({ name, data: method === 0 ? Buffer.from(raw) : inflateRawSync(raw) });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function find(entries: ZipEntry[], name: string): Buffer {
  const hit = entries.find((e) => e.name === name);
  if (!hit) throw new Error(`zip has no ${name}; got ${entries.map((e) => e.name).join(', ')}`);
  return hit.data;
}

/** 1×1 чёрный PNG — картинки в этих тестах не содержание, а объект упаковки. */
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

const el = (over: Partial<BoardWordElement> & { id: string; type: string }): BoardWordElement => ({
  x: 0, y: 0, width: 100, height: 40, isDeleted: false, angle: 0, fontSize: 28, ...over,
});

/** Фиктивная доска: фигура, два редактируемых текста (один многострочный, с узбекской буквой) и повёрнутый. */
const SCENE: BoardWordElement[] = [
  el({ id: 'rect', type: 'rectangle', x: 10, y: 10, width: 400, height: 300, strokeColor: '#1e1e1e' }),
  el({ id: 'ru', type: 'text', x: 30, y: 40, width: 240, height: 40, text: 'Проверка доски', strokeColor: '#c92a2a' }),
  el({
    id: 'uz', type: 'text', x: 30, y: 120, width: 240, height: 90, fontSize: 20, textAlign: 'center',
    text: 'Oʻzbekcha gʻaraza\n\nikkinchi qator',
  }),
  el({ id: 'rot', type: 'text', x: 300, y: 250, width: 90, height: 30, text: 'Na kos', angle: 0.6 }),
];

async function pack(mode: WordMode, boards: WordBoardSource[]): Promise<string> {
  const blob = await buildWordDocx({ mode, boards, cancelled: () => false });
  const bytes = Buffer.from(await blob.arrayBuffer());
  expect(bytes.length, 'docx собран').toBeGreaterThan(1_000);
  return find(unzip(bytes), 'word/document.xml').toString('utf8');
}

describe('собранный .docx: редактируемый режим', () => {
  const plan = planWordBoard(SCENE);
  const placed = placeWordBoard(plan);

  it('рамок ровно по числу редактируемых текстов, плюс одна — подложка', async () => {
    const doc = await pack('editable', [{ png: PNG_1PX, elements: SCENE }]);
    const frames = (doc.match(/<w:framePr/g) ?? []).length;
    expect(plan.texts.map((t) => t.id), 'редактируемых текста два: ru и uz').toEqual(['ru', 'uz']);
    expect(frames, 'рамка на каждый редактируемый текст + рамка подложки').toBe(placed.texts.length + 1);
    // и в режиме без подложки (одни только тексты) лишних рамок нет
    const onlyTexts = await pack('editable', [{ png: PNG_1PX, elements: SCENE.filter((e) => e.type === 'text' && !e.angle) }]);
    expect((onlyTexts.match(/<w:framePr/g) ?? []).length).toBe(2);
    expect((onlyTexts.match(/<w:drawing>/g) ?? []).length, 'подложки нет — рисунка нет').toBe(0);
  });

  it('текст совпадает побуквенно, многострочность сохранена, цвет и выравнивание на месте', async () => {
    const doc = await pack('editable', [{ png: PNG_1PX, elements: SCENE }]);
    const runs = [...doc.matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g)].map((m) => m[1]);
    expect(runs.join('|'), 'кириллица дошла без потерь').toContain('Проверка доски');
    expect(runs.join('|'), 'oʻ и gʻ (U+02BB) дошли без замены').toContain('Oʻzbekcha gʻaraza');
    expect(runs, 'вторая строка — отдельный run, а не склейка').toContain('ikkinchi qator');
    // пустая строка между строками доски = второй перенос подряд
    expect((doc.match(/<w:br\/>/g) ?? []).length, 'переносов ровно на один меньше, чем строк').toBe(2);
    expect(doc, 'цвет текста сохранён').toContain('w:val="c92a2a"');
    expect(doc, 'выравнивание сохранено').toContain('w:val="center"');
    expect(doc, 'шрифт — Arial').toContain('w:ascii="Arial"');
    expect(doc.includes('<w:embedFormat'), 'шрифты не внедряются').toBe(false);
    expect(doc.includes('w:fontW'), 'внешних шрифтов в документе нет').toBe(false);
    // повёрнутый текст НЕ стал редактируемым
    expect(runs.some((r) => r.includes('Na kos')), 'повёрнутый текст остаётся в подложке').toBe(false);
  });

  it('все рамки внутри страницы, страница альбомная A4 с полем 10 мм', async () => {
    const doc = await pack('editable', [{ png: PNG_1PX, elements: SCENE }]);
    expect(doc, 'альбомная ориентация').toContain('w:orient="landscape"');
    expect(doc).toContain(`w:w="${A4_LANDSCAPE.w}"`);
    expect(doc).toContain(`w:h="${A4_LANDSCAPE.h}"`);
    expect(doc).toContain(`w:left="${Math.round(10 * MM_TO_TWIPS)}"`);
    const boxes = [...doc.matchAll(/<w:framePr w:w="(\d+)" w:h="(\d+)" w:x="(-?\d+)" w:y="(-?\d+)"/g)]
      .map((m) => ({ w: Number(m[1]), h: Number(m[2]), x: Number(m[3]), y: Number(m[4]) }));
    expect(boxes.length, 'рамки прочитаны из document.xml').toBe(placed.texts.length + 1);
    for (const b of boxes) {
      expect(b.x, 'слева не залезает за поле').toBeGreaterThanOrEqual(Math.round(10 * MM_TO_TWIPS) - 1);
      expect(b.y, 'сверху не залезает за поле').toBeGreaterThanOrEqual(Math.round(10 * MM_TO_TWIPS) - 1);
      expect(b.x + b.w, 'не шире текстовой области').toBeLessThanOrEqual(A4_LANDSCAPE.w - Math.round(10 * MM_TO_TWIPS) + 1);
      expect(b.y + b.h, 'не выше текстовой области').toBeLessThanOrEqual(A4_LANDSCAPE.h - Math.round(10 * MM_TO_TWIPS) + 1);
    }
    expect(placed.outside).toBe(0);
  });

  it('одна доска — одна страница и ровно одно изображение', async () => {
    const doc = await pack('editable', [{ png: PNG_1PX, elements: SCENE }]);
    expect((doc.match(/<w:sectPr/g) ?? []).length).toBe(1);
    expect((doc.match(/<w:drawing>/g) ?? []).length).toBe(1);
  });

  it('несколько досок — столько же страниц, порядок сохранён', async () => {
    const second = [el({ id: 'b2rect', type: 'ellipse', x: 0, y: 0, width: 200, height: 200 }),
      el({ id: 'b2text', type: 'text', x: 20, y: 20, width: 150, height: 30, text: 'вторая доска' })];
    const doc = await pack('editable', [
      { png: PNG_1PX, elements: SCENE },
      { png: PNG_1PX, elements: second },
      { png: PNG_1PX, elements: SCENE },
    ]);
    expect((doc.match(/<w:sectPr/g) ?? []).length, 'страница на каждую выбранную доску').toBe(3);
    expect((doc.match(/<w:drawing>/g) ?? []).length).toBe(3);
    const firstRu = doc.indexOf('Проверка доски');
    const midSecond = doc.indexOf('вторая доска');
    const lastRu = doc.indexOf('Проверка доски', firstRu + 1);
    expect(firstRu, 'первая доска').toBeGreaterThanOrEqual(0);
    expect(midSecond, 'вторая доска идёт после первой').toBeGreaterThan(firstRu);
    expect(lastRu, 'третья доска идёт после второй').toBeGreaterThan(midSecond);
    expect(doc.indexOf('вторая доска', midSecond + 1), 'её текст не повторяется').toBe(-1);
  });
});

describe('собранный .docx: прежний режим «картинка» и режим «по порядку»', () => {
  it('«картинка» не содержит ни одной рамки и ни одного текста — поведение не изменилось', async () => {
    const doc = await pack('image', [{ png: PNG_1PX, width: 800, height: 600, elements: SCENE }]);
    expect((doc.match(/<w:framePr/g) ?? []).length, 'в режиме картинки рамок нет').toBe(0);
    expect(doc, 'текста в режиме картинки нет').not.toContain('Проверка доски');
    expect((doc.match(/<w:drawing>/g) ?? []).length).toBe(1);
  });

  it('«по порядку»: картинка, затем весь текст обычными абзацами в порядке чтения', async () => {
    const doc = await pack('stacked', [{ png: PNG_1PX, width: 800, height: 600, elements: SCENE }]);
    expect((doc.match(/<w:framePr/g) ?? []).length, 'в режиме «по порядку» рамок нет').toBe(0);
    expect((doc.match(/<w:drawing>/g) ?? []).length).toBe(1);
    const runs = [...doc.matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g)].map((m) => m[1]).filter((r) => r.length);
    // порядок чтения: верхняя строка раньше нижней, а повёрнутый текст в этом режиме тоже текст
    expect(runs[0], 'первым идёт текст у верха доски').toBe('Проверка доски');
    expect(runs.join('|')).toContain('ikkinchi qator');
    expect(runs.join('|'), 'повёрнутый текст в списке читается').toContain('Na kos');
    expect((doc.match(/<w:sectPr/g) ?? []).length).toBe(1);
  });

  it('отмена остановки сборку до того, как файл стал Blob', async () => {
    await expect(buildWordDocx({
      mode: 'editable', boards: [{ png: PNG_1PX, elements: SCENE }], cancelled: () => true,
    })).rejects.toThrow(/.*/);
  });
});
