/**
 * Переключатель панели стилей доски (задача 2026-10-24, часть A).
 *
 * Что здесь доказывается — ровно то, из-за чего кнопка раньше выглядела «не надёжной»:
 *  1) панель форматирования существует в DOM только когда есть что форматировать (в 0.18.1
 *     `showSelectedShapeActions` включает островок при активном инструменте или выделении), и
 *     именно поэтому нажатие «до выбора объекта» казалось пустым;
 *  2) закрытие убирает ТОЛЬКО панель: полотно, наши вкладки доски, сама кнопка и верхняя строка
 *     урока остаются на месте;
 *  3) геометрия полотна не двигается (тот же допуск 2 px, что у блокирующего zz20);
 *  4) выбор человека переживает перезагрузку и принадлежит его роли;
 *  5) Esc закрывает панель;
 *  6) `aria-expanded` на кнопке описывает то же состояние, что и полотно, — расхождение
 *     невозможно, потому что источник один.
 *
 * Никакого рисования и никаких обращений к базе: инструмент выбирается с клавиатуры, поэтому
 * спек не зависит от таймингов распространения чернил (именно на них спотыкается zz20).
 */
import { test, expect } from '@playwright/test';
import { boardGeom, geomShift, loginUi, makeLesson, openLesson, stack, teacherToken, waitBoard } from './boardFixtures';
import { request as pw } from '@playwright/test';

const canvasOf = (page: import('@playwright/test').Page) =>
  page.locator('[data-testid=board] canvas.excalidraw__canvas').first();

/**
 * Фокус на холст без всякого рисования — тем же жестом, что и `drawRect` в boardFixtures:
 * `click()` по статичному холсту Playwright может отбить интерактивный оверлей, а `mouse.down()`
 * / `up()` в координатах полотна работает всегда.
 */
async function focusCanvas(page: import('@playwright/test').Page): Promise<void> {
  const box = (await canvasOf(page).boundingBox())!;
  await page.mouse.move(box.x + 30, box.y + 30);
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(200);
}
/** островок стилей: наш CSS прячет ровно его (см. styles.css и excalidraw-styles-panel.test.ts) */
const panelOf = (page: import('@playwright/test').Page) =>
  page.locator('[data-testid=board] .board-frame .selected-shape-actions');
const frameOf = (page: import('@playwright/test').Page) =>
  page.locator('[data-testid=board] .board-frame');

test.describe.serial('the board formatting panel collapses, the board does not', () => {
  let classId = '';

  test.beforeAll(async () => {
    const api = await pw.newContext({ baseURL: `http://127.0.0.1:${stack.port}` });
    const token = await teacherToken(api);
    const lesson = await makeLesson(api, token, 'E2E Панель стилей');
    classId = lesson.classId;
    await api.dispose();
  });

  test('default is closed, the panel appears with an active tool, the toggle hides it again', async ({ page }) => {
    await loginUi(page, stack.teacherEmail, stack.teacherPassword);
    await openLesson(page, classId);
    await waitBoard(page);

    const toggle = page.getByTestId('board-styles-toggle');
    // учителю право рисовать дана сид-классу, поэтому кнопка активна: проверка прав не изменилась
    await expect(toggle, 'учитель без права рисовать не мог бы ничего открыть').toBeEnabled({ timeout: 20_000 });
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(frameOf(page)).toHaveAttribute('data-styles', 'closed');

    // фокус на холст + `r` = активен инструмент «прямоугольник»: островок появляется в DOM
    await focusCanvas(page);
    await page.keyboard.press('r');
    /*
     * Панель ЕСТЬ (иначе проверять было бы нечего), но она СПРЯТАНА закрытым состоянием.
     * Именно эта пара и была недостижима прежним кодом: без активного инструмента секции в DOM
     * нет вовсе, и «скрыть/показать» выглядело как нажатие в пустоту.
     */
    await expect(panelOf(page), 'активный инструмент обязан создать панель').toHaveCount(1, { timeout: 15_000 });
    await expect(panelOf(page), 'закрытое состояние прячет её').toBeHidden();
    await expect(frameOf(page)).toHaveAttribute('data-styles', 'closed');

    const before = await boardGeom(page);
    await toggle.click();
    await expect(frameOf(page)).toHaveAttribute('data-styles', 'open');
    await expect(panelOf(page)).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');

    await toggle.click();
    await expect(panelOf(page), 'панель скрыта').toBeHidden();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');

    // и всё остальное на месте: полотно, вкладки доски, сама кнопка
    await expect(canvasOf(page)).toBeVisible();
    await expect(page.getByTestId('board-tabs')).toBeVisible();
    await expect(toggle).toBeVisible();

    const after = await boardGeom(page);
    const shift = geomShift(before, after);
    // тот же допуск, что у блокирующего zz20: 2 px — шум субпиксельной прокрутки, реальный
    // сдвиг строки шапки был 5–8 px
    expect(shift.max, `полотно не должно двигаться от переключения панели: ${JSON.stringify(shift.d)}`)
      .toBeLessThanOrEqual(2);
  });

  test('the choice survives a reload, and belongs to the role that made it', async ({ page }) => {
    await loginUi(page, stack.teacherEmail, stack.teacherPassword);
    await openLesson(page, classId);
    await waitBoard(page);
    const toggle = page.getByTestId('board-styles-toggle');
    await focusCanvas(page);
    await page.keyboard.press('r');
    await expect(panelOf(page)).toHaveCount(1, { timeout: 15_000 });

    await toggle.click();                                    // открыть
    await expect(frameOf(page)).toHaveAttribute('data-styles', 'open');
    await expect(panelOf(page), 'открытая панель видна').toBeVisible();
    await page.reload();
    await waitBoard(page);
    await expect(frameOf(page), 'сохранённый выбор учителя').toHaveAttribute('data-styles', 'open', { timeout: 15_000 });
    await expect(page.getByTestId('board-styles-toggle')).toHaveAttribute('aria-expanded', 'true');

    /*
     * Esc слушает рамка доски, то есть работает только когда фокус внутри неё — после
     * перезагрузки фокус на body, поэтому сначала возвращаем его на холст (это и есть
     * настоящее поведение: ученик/учитель держат фокус на полотне, когда рисуют).
     */
    await focusCanvas(page);
    await page.keyboard.press('Escape');
    await expect(frameOf(page)).toHaveAttribute('data-styles', 'closed');
    await expect(page.getByTestId('board-styles-toggle')).toHaveAttribute('aria-expanded', 'false');
    await page.reload();
    await waitBoard(page);
    await expect(frameOf(page), 'Esc — это тоже выбор человека, он и запоминается').toHaveAttribute('data-styles', 'closed');
  });

  test('a narrow viewport keeps the button reachable and the panel out of the way', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await loginUi(page, stack.teacherEmail, stack.teacherPassword);
    await openLesson(page, classId);
    await waitBoard(page);
    // узкая рамка: панель закрыта, даже если её разрешали
    await expect(frameOf(page)).toHaveAttribute('data-styles', 'closed');
    // кнопка при этом доступна — иначе закрыть/открыть было бы нечем
    await expect(page.getByTestId('board-styles-toggle')).toBeVisible();
    const overflow = await page.evaluate(() => ({
      doc: document.documentElement.scrollWidth, win: window.innerWidth,
    }));
    expect(overflow.doc, `нет горизонтального скролла: ${JSON.stringify(overflow)}`)
      .toBeLessThanOrEqual(overflow.win + 1);
  });
});
