/**
 * Часть 4 (2026-10-14): архив завершённых уроков — путь пользователя целиком.
 *
 * Первый сценарий — тот, что требует живого урока: два раза нарисовать, переключить доску,
 * завершить урок, открыть архив, увидеть обе доски (миниатюра действительно построена из
 * сохранённой сцены, а не подставлена заглушкой), выбрать одну и скачать PDF. Проверка идёт по
 * файлу: страница в PDF ровно одна.
 *
 * Второй сценарий правам, и он к комнате не заходит: без переключателя класса ученик получает
 * экран 404, с переключателем — только доски, без вкладок комментариев и участников и без кнопки
 * удаления.
 */
import { test, expect, request as pw } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { PDFDocument } from 'pdf-lib';
import {
  BASE, dbBoard, m, makeLesson, paint, pinTeacherRussian, registerStudent, waitInkPages,
  teacherLessonPage, teacherToken, type Ctx,
} from './boardFixtures';

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

test.describe('lesson archive (part 4)', () => {
  let api: Ctx = null as unknown as Ctx;
  let token = '';

  test.beforeAll(async () => {
    api = await pw.newContext({ baseURL: BASE });
    token = await teacherToken(api);
    // подписи и имена досок в этой спеке русские — язык фиксируем явно, как в zz12
    await pinTeacherRussian(api, token);
  });
  test.afterAll(async () => { await api?.dispose(); });

  test('two boards survive the lesson, are seen in the archive, and one exports to PDF', async ({ browser }) => {
    test.setTimeout(300_000);
    const { classId, className, sessionId } = await makeLesson(api, token, 'E2E архив');
    const p = await teacherLessonPage(browser, classId);

    await paint(p, 'A');
    await p.getByTestId('board-new').click();
    await expect(p.getByTestId('board-tab-2')).toBeVisible({ timeout: 15_000 });
    await paint(p, 'B');
    // ждём состояния, а не времени: архив читает то, что уже легло на сервер
    await waitInkPages(api, token, sessionId, 2);
    const beforeEnd = await dbBoard(sessionId);
    m('boards on disk before the lesson ends', beforeEnd);
    expect(beforeEnd.length, 'оба листа доски на диске').toBeGreaterThanOrEqual(2);

    const ended = await api.post(`/api/lessons/${sessionId}/end`, { headers: auth(token), data: {} });
    expect(ended.status(), 'урок завершён').toBe(200);

    await p.goto(`/classes/${classId}/archive`);
    const short = sessionId.slice(0, 8);
    await expect(p.getByTestId('archive-title')).toBeVisible({ timeout: 20_000 });
    await expect(p.getByTestId(`archive-row-${short}`)).toBeVisible({ timeout: 20_000 });
    await expect(p.getByTestId(`archive-boards-count-${short}`)).toContainText('2');
    // учитель видит счётчики комментариям и участникам; ученик — нет (проверяется вторым спеком)
    await expect(p.getByTestId(`archive-people-count-${short}`)).toBeVisible();

    await p.getByTestId(`archive-open-${short}`).click();
    await expect(p.getByTestId('archive-entry')).toBeVisible({ timeout: 20_000 });
    await expect(p.getByTestId('archive-tab-comments')).toBeVisible();
    await expect(p.getByTestId('archive-tab-people')).toBeVisible();

    // обе доски на месте, и миниатюры — картинки, а не заглушки
    await expect(p.getByTestId('archive-board-open-1')).toBeVisible({ timeout: 20_000 });
    await expect(p.getByTestId('archive-board-open-2')).toBeVisible();
    await expect(p.getByTestId('archive-thumb-1')).toHaveCount(1);
    await p.waitForFunction(() => {
      const img = document.querySelector('img[data-testid="archive-thumb-1"]') as HTMLImageElement | null;
      return !!img && img.complete && img.naturalWidth > 0;
    }, null, { timeout: 60_000 });
    const px = await p.locator('img[data-testid="archive-thumb-1"]').evaluate(
      (el) => ({ w: (el as HTMLImageElement).naturalWidth, h: (el as HTMLImageElement).naturalHeight }));
    m('archive thumbnail of board 1', px);
    expect(px.w, 'миниатюра построена из сохранённой сцены').toBeGreaterThan(0);

    await p.getByTestId('archive-pdf').click();
    await expect(p.getByTestId('pdf-dialog')).toBeVisible({ timeout: 30_000 });
    await expect(p.getByTestId('pdf-pick-1')).toBeVisible({ timeout: 30_000 });
    await p.getByTestId('pdf-pick-2').setChecked(false);
    await expect(p.getByTestId('pdf-count')).toContainText('1');

    const dl = p.waitForEvent('download');
    await p.getByTestId('pdf-download').click();
    const download = await dl;
    const name = download.suggestedFilename();
    m('archive pdf name', name);
    expect(/^BluBlu-.*-\d{4}-\d{2}-\d{2}\.pdf$/.test(name), `имя файла ${name}`).toBe(true);
    expect(name).toContain(className.slice(0, 8));
    const file = await download.path();
    expect(file, 'скачанный файл сохранён').toBeTruthy();
    const doc = await PDFDocument.load(readFileSync(file!), { updateMetadata: false });
    expect(doc.getPageCount(), 'в PDF одна выбранная доска').toBe(1);

    // удаление записи архива уносит и доски (каскад на стороне базы)
    await p.getByTestId(`archive-delete-${short}`).click();
    await p.getByTestId('archive-delete-yes').click();
    await expect(p.getByTestId(`archive-row-${short}`)).toHaveCount(0, { timeout: 20_000 });
    m('boards after the archive entry was deleted', await dbBoard(sessionId));
    expect((await dbBoard(sessionId)).length, 'доски удалились вместе с записью').toBe(0);
    await p.context().close();
  });

  test('a student reaches the archive only when the class switch is on — and sees boards only', async ({ browser }) => {
    test.setTimeout(240_000);
    const { classId, sessionId, linkUrl } = await makeLesson(api, token, 'E2E архив доступ');
    // доска без урока: архив проверяет права, а не способ появления доски
    const saved = await api.put(`/api/lessons/${sessionId}/board/page`, {
      headers: auth(token),
      data: { pageNo: 1, title: 'Лист про дроби', elements: [{ id: 'e1', version: 1, versionNonce: 1, type: 'draw' }] },
    });
    expect(saved.status(), 'страница сохранена').toBe(200);
    const ended = await api.post(`/api/lessons/${sessionId}/end`, { headers: auth(token), data: {} });
    expect(ended.status(), 'урок завершён').toBe(200);

    const ctxS = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const s = await ctxS.newPage();
    const email = `e2arch${Date.now()}@x.io`;
    // ученик регистрируется сам по одноразовой ссылке (приём по коду выведен 2026-10-27)
    await registerStudent(s, linkUrl, 'Архив', email);

    // переключатель выключен: страница класса вообще не предлагает архив, а прямой заход — 404
    await s.goto(`/classes/${classId}`);
    await expect(s.getByTestId('student-archive-link')).toHaveCount(0);
    await s.goto(`/classes/${classId}/archive`);
    await expect(s.getByRole('alert')).toContainText('404', { timeout: 20_000 });

    // учитель включает переключатель — и ученик видит ровно доски
    const on = await api.patch(`/api/classes/${classId}`, {
      headers: auth(token), data: { boardArchivePublic: true },
    });
    expect(on.status(), 'переключатель класса включён').toBe(200);

    await s.goto(`/classes/${classId}`);
    await expect(s.getByTestId('student-archive-link')).toBeVisible({ timeout: 20_000 });
    await s.getByTestId('student-archive-link').click();
    const short = sessionId.slice(0, 8);
    await expect(s.getByTestId(`archive-row-${short}`)).toBeVisible({ timeout: 20_000 });
    // счётчиков комментариев и участников в таблице ученика нет
    await expect(s.getByTestId(`archive-comments-count-${short}`)).toHaveCount(0);
    await expect(s.getByTestId(`archive-people-count-${short}`)).toHaveCount(0);
    await expect(s.getByTestId(`archive-delete-${short}`)).toHaveCount(0);

    await s.getByTestId(`archive-open-${short}`).click();
    await expect(s.getByTestId('archive-entry')).toBeVisible({ timeout: 20_000 });
    await expect(s.getByTestId('archive-tab-boards')).toBeVisible();
    await expect(s.getByTestId('archive-tab-comments'), 'расшифровка урока ученику не положена').toHaveCount(0);
    await expect(s.getByTestId('archive-tab-people'), 'список присутствовавших — тем более').toHaveCount(0);
    await expect(s.getByTestId('archive-board-open-1')).toBeVisible({ timeout: 20_000 });
    await expect(s.getByTestId('archive-pdf'), 'экспорт остаётся кнопкой учителя').toHaveCount(0);
    await ctxS.close();
  });
});
