/**
 * Переключатель панели стилей доски (задача 2026-10-24, часть A; правка того же числа).
 *
 * Почему здесь ДВА браузерных прогона, а не один. Excalidraw 0.18.1 рисует панель форматирования
 * в двух разных узлах и выбирает узел сам, по размеру СВОЕГО контейнера
 * (`excalidrawMobileChrome`: w < 730 или (h < 500 и w < 1000)):
 *  • десктоп — `.selected-shape-actions` слева сверху: узел создаётся, когда есть что форматировать,
 *    и дальше им распоряжается наш CSS по `data-styles` на рамке;
 *  • мобильная — `.App-mobile-menu` в нижнем баре: узла в DOM нет, пока полотно не переведёт
 *    `appState.openMenu` в «shape». На тестовом 1280×720 полотно выходит ~912×446 px, то есть
 *    ровно вторая раскладка — и именно из-за неё прежнее «нажми «Стили» и проверь, что островка
 *    нет» выглядело как кнопка, которая работает через раз.
 * Спек проверяет пользовательский контракт в обеих раскладках: закрыто — панели не видно, открыто
 * — она видна, и заодно что полотно, вкладки и сама кнопка не сдвинулись.
 *
 * Никакого рисования и никаких обращений к базе: инструмент выбирается с клавиатуры, поэтому
 * спек не зависит от таймингов распространения чернил (именно на них спотыкается zz20).
 */
import { test, expect } from '@playwright/test';
import { boardGeom, geomShift, loginUi, makeLesson, openLesson, stack, teacherToken, waitBoard } from './boardFixtures';
import { request as pw } from '@playwright/test';

type P = import('@playwright/test').Page;

const canvasOf = (page: P) => page.locator('[data-testid=board] canvas.excalidraw__canvas').first();
const frameOf = (page: P) => page.locator('[data-testid=board] .board-frame');

/**
 * Панель форматирования — ОДИН локатор на обе раскладки (см. комментарий выше и CSS-правило в
 * styles.css). Проверяем всегда «видно / не видно», а не «есть ли узел в DOM»: в закрытом
 * состоянии десктопная панель в DOM есть и спрятана, а мобильной там нет вовсе.
 */
const panelOf = (page: P) => page.locator(
  '[data-testid=board] .board-frame .selected-shape-actions, [data-testid=board] .board-frame .App-mobile-menu',
);

/**
 * Фокус на холст без всякого рисования — тем же жестом, что и `drawRect` в boardFixtures:
 * `click()` по статичному холсту Playwright может отбить интерактивный оверлей, а `mouse.down()`
 * / `up()` в координатах полотна работает всегда.
 */
async function focusCanvas(page: P): Promise<void> {
  const box = (await canvasOf(page).boundingBox())!;
  await page.mouse.move(box.x + 30, box.y + 30);
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(200);
}

/** Активен инструмент «прямоугольник»: с этого момента панели есть что показывать. */
async function activateRect(page: P): Promise<void> {
  await focusCanvas(page);
  await page.keyboard.press('r');
}

/** Размер рамки в текст ошибки: по нему видно, какую раскладку выбрала библиотека. */
async function frameSize(page: P): Promise<string> {
  const b = (await frameOf(page).boundingBox())!;
  return `${Math.round(b.width)}×${Math.round(b.height)} px`;
}

/**
 * Открыть панель нашей кнопкой и дождаться, пока её станет видно. Именно этот шаг был
 * «ненадёжным»: в мобильной раскладке показ требует ещё и `openMenu === 'shape'`.
 */
async function openByToggle(page: P): Promise<void> {
  await page.getByTestId('board-styles-toggle').click();
  await expect(frameOf(page)).toHaveAttribute('data-styles', 'open');
  await expect(panelOf(page), `открытая панель обязана быть видна (рамка ${await frameSize(page)})`)
    .toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('board-styles-toggle')).toHaveAttribute('aria-expanded', 'true');
}

test.describe.serial('the board formatting panel collapses, the board does not', () => {
  let classId = '';

  test.beforeAll(async () => {
    const api = await pw.newContext({ baseURL: `http://127.0.0.1:${stack.port}` });
    const token = await teacherToken(api);
    const lesson = await makeLesson(api, token, 'E2E Панель стилей');
    classId = lesson.classId;
    await api.dispose();
  });

  test('mobile chrome (the lesson board at 1280×720): the toggle shows and hides the panel', async ({ page }) => {
    await loginUi(page, stack.teacherEmail, stack.teacherPassword);
    await openLesson(page, classId);
    await waitBoard(page);

    const toggle = page.getByTestId('board-styles-toggle');
    // учителю право рисовать дана сид-классу, поэтому кнопка активна: проверка прав не изменилась
    await expect(toggle, 'учитель без права рисовать не мог бы ничего открыть').toBeEnabled({ timeout: 20_000 });
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(frameOf(page)).toHaveAttribute('data-styles', 'closed');

    await activateRect(page);
    await expect(panelOf(page), `закрытая панель не видна (рамка ${await frameSize(page)})`).toBeHidden({ timeout: 15_000 });
    await expect(frameOf(page)).toHaveAttribute('data-styles', 'closed');

    const before = await boardGeom(page);
    await openByToggle(page);

    await toggle.click();
    await expect(panelOf(page), 'панель скрыта').toBeHidden();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(frameOf(page)).toHaveAttribute('data-styles', 'closed');

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

  test('the choice survives a reload, and Esc closes the panel again', async ({ page }) => {
    await loginUi(page, stack.teacherEmail, stack.teacherPassword);
    await openLesson(page, classId);
    await waitBoard(page);

    await activateRect(page);
    await openByToggle(page);

    await page.reload();
    await waitBoard(page);
    await expect(frameOf(page), 'сохранённый выбор учителя').toHaveAttribute('data-styles', 'open', { timeout: 15_000 });
    await expect(page.getByTestId('board-styles-toggle')).toHaveAttribute('aria-expanded', 'true');

    /*
     * После перезагрузки инструмент снова «выделение», а панели показывать нечего — она обязана
     * появиться, как только инструмент вернётся на холст. Это и есть примирение с полотном:
     * состояние человека пережило перезагрузку, а узел создаётся, когда для него есть повод.
     */
    await activateRect(page);
    await expect(panelOf(page), 'открытый выбор после перезагрузки').toBeVisible({ timeout: 15_000 });

    /*
     * Esc слушает рамка доски, то есть работает только когда фокус внутри неё — поэтому холст
     * сначала фокусится (это и есть настоящее поведение: рисуют с фокусом на полотне). Перед этим
     * полотно возвращается на «выделение»: клик по холсту с активным инструментом «прямоугольник»
     * нарисовал бы фигуру, а тест про панель, не про сцену.
     */
    await page.keyboard.press('v');
    await focusCanvas(page);
    await page.keyboard.press('Escape');
    await expect(frameOf(page)).toHaveAttribute('data-styles', 'closed');
    await expect(page.getByTestId('board-styles-toggle')).toHaveAttribute('aria-expanded', 'false');
    await expect(panelOf(page)).toBeHidden();
    await page.reload();
    await waitBoard(page);
    await expect(frameOf(page), 'Esc — это тоже выбор человека, он и запоминается').toHaveAttribute('data-styles', 'closed');
  });

  test('desktop chrome (a tall board): the same button hides and shows the left island', async ({ page }) => {
    /*
     * Как минимум 500 px высоты полотна — и полотно переходит на десктопный узел
     * `.selected-shape-actions`. Формулы высоты в Lesson.tsx две (`40vh` в сцене и
     * `min(60vh, 100dvh − 420px)` в сетке), поэтому берём вьюпорт 1400 px: и там, и там рамка
     * выходит ≥ 560 px, то есть ниже порога мобильной раскладки. Здесь рычаг ровно один — CSS по
     * `data-styles`, и проверка подтверждает, что примирение с `openMenu` его не сломало.
     */
    await page.setViewportSize({ width: 1280, height: 1400 });
    await loginUi(page, stack.teacherEmail, stack.teacherPassword);
    await openLesson(page, classId);
    await waitBoard(page);
    const island = page.locator('[data-testid=board] .board-frame .selected-shape-actions');
    await activateRect(page);
    await expect(island, `на рамке ${await frameSize(page)} полотно обязано быть в десктопной раскладке`)
      .toHaveCount(1, { timeout: 15_000 });
    await expect(island, 'закрыто — узел на месте, но спрятан').toBeHidden();

    await openByToggle(page);
    await expect(island).toBeVisible();

    await page.getByTestId('board-styles-toggle').click();
    await expect(island).toBeHidden();
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
