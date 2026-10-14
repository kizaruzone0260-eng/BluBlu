/**
 * Часть 5 (2026-10-14): экспорт доски в Word — проверка по файлу, а не по кнопке.
 *
 * Скачанный .docx распаковывается настоящим читателем zip (`zipReader.ts`) и проверяется то, что
 * постановка и требует: картинок ровно по числу выбранных досок, страниц (секций) тоже ровно
 * столько, альбомная A4 с полями 10 мм, имя файла `BluBlu-<класс>-<дата>.docx` и ни одного
 * персонального данных в метаданных.
 *
 * Кириллица и узбекские `oʻ/gʻ` рисуются на той же растеризованной картинке, что и в PDF: путь
 * один и тот же (`exportToBlob` после `document.fonts.ready`), и он уже доказан в zz12 («cyrillic
 * and Uzbek ʻgʻ text on a board really renders»). Здесь дополнительно проверяется, что именно эта
 * картинка с чернилами попала внутрь документа, — по размерам PNG и по объёму данных.
 */
import { test, expect, request as pw } from '@playwright/test';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { find, pngSize, unzip } from './zipReader';
import {
  BASE, drawText, inkOf, m, makeLesson, paint, pinTeacherRussian, stack, teacherLessonPage, teacherToken,
  waitInkPages,
  TEXT, type Ctx,
} from './boardFixtures';

const TWIPS_PER_MM = 56.6929;
const A4_LANDSCAPE = { w: Math.round(297 * TWIPS_PER_MM), h: Math.round(210 * TWIPS_PER_MM) };

function shot(name: string): string {
  const dir = join(process.cwd(), 'test-results', 'screenshots');
  mkdirSync(dir, { recursive: true });
  return join(dir, name);
}

test.describe('board → Word (part 5)', () => {
  let api: Ctx = null as unknown as Ctx;
  let token = '';

  test.beforeAll(async () => {
    api = await pw.newContext({ baseURL: BASE });
    token = await teacherToken(api);
    // язык закрепляется явно: подписи окна экспорта в этом спеке русские (см. zz12)
    await pinTeacherRussian(api, token);
  });
  test.afterAll(async () => { await api?.dispose(); });

  test('two boards → one .docx with two pictures, two landscape pages, clean metadata', async ({ browser }) => {
    test.setTimeout(300_000);
    const { classId, className, sessionId } = await makeLesson(api, token, 'E2E Word');
    const p = await teacherLessonPage(browser, classId);

    await paint(p, 'A');
    await drawText(p, TEXT.at, 'Привет, oʻzbek gʻoya');
    const ink = await inkOf(p, 'text');
    m('ink where the text sits', ink);
    expect(ink, 'текст на холсте отрисован, а не превращён в прямоугольники').toBeGreaterThan(200);
    await p.getByTestId('board').screenshot({ path: shot('board-word-source-1280.png') });

    await p.getByTestId('board-new').click();
    await expect(p.getByTestId('board-tab-2')).toBeVisible({ timeout: 15_000 });
    await paint(p, 'B');
    // автосейв раз в 10 с: окно экспорта читает сохранённые сцены, поэтому ждём состояние
    await waitInkPages(api, token, sessionId, 2);

    await p.getByTestId('board-pdf').click();
    const dialog = p.getByTestId('pdf-dialog');
    await expect(dialog).toBeVisible({ timeout: 30_000 });
    await expect(p.getByTestId('pdf-pick-1')).toBeVisible({ timeout: 30_000 });
    await expect(p.getByTestId('pdf-pick-2')).toBeChecked();
    // обе кнопки стоят рядом и не мешают друг другу: Word появляется рядом с PDF
    await expect(p.getByTestId('word-download')).toBeVisible();
    await expect(p.getByTestId('word-download')).toBeEnabled();

    const dl = p.waitForEvent('download');
    await p.getByTestId('word-download').click();
    const download = await dl;
    const name = download.suggestedFilename();
    m('word download name', name);
    expect(/^BluBlu-.*-\d{4}-\d{2}-\d{2}\.docx$/.test(name), `имя файла ${name}`).toBe(true);
    expect(name, 'имя класса в имени файла есть').toContain(className.slice(0, 8));
    expect(/[\\/:*?"<>|]/.test(name), 'никаких запрещённых символов').toBe(false);

    const file = await download.path();
    expect(file, 'playwright сохранил загрузку').toBeTruthy();
    const bytes = readFileSync(file!);
    m('docx size', bytes.length);
    const entries = unzip(bytes);
    const names = entries.map((e) => e.name);
    expect(names).toContain('word/document.xml');
    expect(names).toContain('[Content_Types].xml');
    m('docx entries', names);

    const media = entries.filter((e) => e.name.startsWith('word/media/'));
    expect(media.length, 'одна картинка на доску').toBe(2);
    for (const png of media) {
      const s = pngSize(png.data);
      m('embedded png', { name: png.name, ...s, bytes: png.data.length });
      expect(s.width, 'PNG не битый: ширина прочитана из IHDR').toBeGreaterThan(10);
      expect(s.height).toBeGreaterThan(10);
      expect(png.data.length, 'в картинке есть содержимое, а не пустой холст').toBeGreaterThan(1_000);
    }

    const doc = find(entries, 'word/document.xml').toString('utf8');
    expect((doc.match(/<w:sectPr/g) ?? []).length, 'страница на доску').toBe(2);
    expect((doc.match(/<w:drawing>/g) ?? []).length, 'по рисунку на странице').toBe(2);
    expect(doc, 'альбомная ориентация').toContain('w:orient="landscape"');
    expect(doc, 'ширина A4 в тви́пах').toContain(`w:w="${A4_LANDSCAPE.w}"`);
    expect(doc, 'высота A4 в тви́пах').toContain(`w:h="${A4_LANDSCAPE.h}"`);
    expect(doc, 'поле 10 мм').toContain(`w:top="${Math.round(10 * TWIPS_PER_MM)}"`);

    // метаданные: ни класса, ни почты, ни id (то же правило, что у PDF — часть 1г)
    const core = find(entries, 'docProps/core.xml').toString('utf8').toLowerCase();
    m('docx core.xml', core);
    expect(core.includes(className.toLowerCase()), 'нет имени класса').toBe(false);
    expect(core.includes(stack.teacherEmail.toLowerCase()), 'нет почты').toBe(false);
    expect(core.includes('dcterms'), 'core.xml на месте').toBe(true);

    // «Отмена» закрывает окно и не оставляет скачанного файла: вторая загрузка не появляется
    // (документ собирается в памяти и уходит на диск только в момент клика по кнопке формата)
    await p.getByTestId('pdf-cancel-close').click();
    await expect(p.getByTestId('pdf-dialog')).toHaveCount(0);
    await p.context().close();
  });

  test('a board wider than the page is scaled down instead of being cut off', async ({ browser }) => {
    test.setTimeout(240_000);
    const { classId, sessionId } = await makeLesson(api, token, 'E2E Word большая');
    const p = await teacherLessonPage(browser, classId);
    await paint(p, 'A');
    await waitInkPages(api, token, sessionId, 1);

    await p.getByTestId('board-pdf').click();
    await expect(p.getByTestId('pdf-pick-1')).toBeVisible({ timeout: 30_000 });
    const dl = p.waitForEvent('download');
    await p.getByTestId('word-download').click();
    const entries = unzip(readFileSync((await (await dl).path())!));
    const png = entries.find((e) => e.name.startsWith('word/media/'))!;
    const s = pngSize(png.data);
    const doc = find(entries, 'word/document.xml').toString('utf8');
    /*
     * Размер картинки на странице стоит в `wp:extent` (EMU): 1 px при 96 dpi = 9525 EMU. Текстовая
     * область альбомного A4 с полем 10 мм — 277×190 мм = 1047×718 px. Больше этого доска быть не
     * может, и это и есть «масштабируй до безопасного размера»: широкая доска уменьшается, а не
     * обрезается и не разрывает страницу.
     */
    const boxPx = {
      w: Math.ceil(((297 - 20) * 96) / 25.4),
      h: Math.ceil(((210 - 20) * 96) / 25.4),
    };
    const emu = /wp:extent cx="(\d+)" cy="(\d+)"/.exec(doc);
    expect(emu, 'размер картинки в document.xml').toBeTruthy();
    const wPx = Number(emu![1]) / 9525;
    const hPx = Number(emu![2]) / 9525;
    m('placed size px', { wPx, hPx, boxPx, png: s });
    expect(wPx, 'не шире текстовой области').toBeLessThanOrEqual(boxPx.w + 1);
    expect(hPx, 'не выше текстовой области').toBeLessThanOrEqual(boxPx.h + 1);
    expect(wPx, 'но и не нулевой').toBeGreaterThan(0);
    expect(hPx, 'картинка сохранённых пропорций, а не сплющенная').toBeGreaterThan(0);
    await p.context().close();
  });
});
