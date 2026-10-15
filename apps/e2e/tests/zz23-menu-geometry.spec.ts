/**
 * Аудит всплывающих меню (2026-10-15): каждое меню — целиком внутри окна.
 *
 * Причина аудита — найденный zz20 дефект: меню «Удалить рисунки ученика» было `position: fixed`
 * с `top: 100%`, а фиксированный элемент проценты отсчитывает от высоты ОКНА, то есть список
 * всегда рождался за нижним краем экрана. Такое же «прижми к кнопке» без проверки вьюпорта было
 * у каждого меню своё (`.bar-menu` — снизу вверх через `translateX(-50%)`, `.lang-menu` — сверху
 * вниз, `.chat-menu` — у правого края пузыря), поэтому теперь все они на одном механизме
 * (`apps/web/src/lib/popover`), а этот тест проверяет следствие: меню помещается, пункты кликабельны,
 * Escape и клик снаружи закрывают.
 *
 * Два окна: 1280×500 (низкий десктоп — полоса управления и карточки не оставляют места под
 * кнопкой) и 390×600 (телефон — меню крайней кнопки свешивалось за правый край). Никаких
 * `sleep`: открытие подтверждается `toBeVisible`, закрытие — `toHaveCount(0)`.
 */
import { test, expect, request as pw, type Page } from '@playwright/test';
import { BASE, loginUi, makeLesson, stack, teacherToken, waitBoard, type Ctx } from './boardFixtures';

const SIZES = [
  { name: 'низкое окно 1280×500', viewport: { width: 1280, height: 500 } },
  { name: 'телефон 390×600', viewport: { width: 390, height: 600 } },
];

/**
 * Открыть меню по кнопке `trigger` и проверить его.
 *
 * `minItems` — сколько пунктов обязано быть: у меню purge на уроке без ученических рисунков их
 * нет (там одна строка «пусто»), и это нормальное состояние, а не сломанное меню; кликабельность
 * его пунктов проверяет zz20, где рисунок ученика действительно есть.
 */
async function checkMenu(page: Page, trigger: string, testid: string, label: string, minItems = 1): Promise<void> {
  const vp = page.viewportSize()!;
  const menu = page.getByTestId(testid);
  // язык рендерится дважды (широкая колонка и мобильная шапка) — кликаем тот, что виден
  const open = async () => {
    await page.getByTestId(trigger).locator('visible=true').first().click();
    await expect(menu, `${label}: меню открылось`).toBeVisible({ timeout: 10_000 });
  };
  await open();

  const box = await menu.boundingBox();
  expect(box, `${label}: меню имеет размер`).not.toBeNull();
  const gap = {
    left: box!.x, top: box!.y,
    right: vp.width - (box!.x + box!.width),
    bottom: vp.height - (box!.y + box!.height),
  };
  expect(Math.min(gap.left, gap.top, gap.right, gap.bottom),
    `${label}: меню за краем вьюпорта ${JSON.stringify(gap)} при ${vp.width}×${vp.height}`)
    .toBeGreaterThanOrEqual(-0.5);

  const items = menu.locator('[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"]');
  const n = await items.count();
  expect(n, `${label}: пунктов не меньше ожидаемого`).toBeGreaterThanOrEqual(minItems);
  for (let i = 0; i < n; i++) {
    // trial: проверка доступности для клика (виден, стабилен, событие доходит до него, не перекрыто) БЕЗ самого
    // клика — иначе меню закрылось бы на первом же пункте
    await items.nth(i).click({ trial: true, timeout: 5_000 });
  }

  await page.keyboard.press('Escape');
  await expect(menu, `${label}: Escape закрывает меню`).toHaveCount(0);

  await open();
  await page.mouse.click(Math.round(vp.width * 0.6), 6);
  await expect(menu, `${label}: клик снаружи закрывает меню`).toHaveCount(0);
}

test.describe('всплывающие меню помещаются в окно (аудит 2026-10-15)', () => {
  let api: Ctx;
  let token = '';
  let classId = '';
  let sessionId = '';;

  test.beforeAll(async () => {
    api = await pw.newContext({ baseURL: BASE });
    token = await teacherToken(api);
    const lesson = await makeLesson(api, token, 'Меню');
    classId = lesson.classId; sessionId = lesson.sessionId;
    const msg = await api.post(`/api/classes/${classId}/chat/messages`, {
      headers: { authorization: `Bearer ${token}` }, data: { text: 'привет' },
    });
    expect(msg.status(), 'учитель обязан уметь написать в чат класса').toBe(201);
  });

  test.afterAll(async () => {
    try { await api?.post(`/api/lessons/${sessionId}/end`, { headers: { authorization: `Bearer ${token}` } }); } catch { /* уже закрыт */ }
    await api?.dispose();
  });

  test('каждое меню — целиком во вьюпорте, пункты кликабельны, Esc и клик снаружи закрывают',
    async ({ browser }) => {
      test.setTimeout(240_000);
      for (const size of SIZES) {
        const ctx = await browser.newContext({ viewport: size.viewport });
        const page = await ctx.newPage();
        await loginUi(page, stack.teacherEmail, stack.teacherPassword);

        // язык интерфейса — он есть на любой странице, и на телефоне его список прижимается к краю
        await page.goto('/');
        await checkMenu(page, 'lang-open', 'lang-menu', `${size.name}: меню языка`);

        // публикация материала
        await page.goto(`/classes/${classId}/material/new`);
        await checkMenu(page, 'publish-menu', 'publish-options', `${size.name}: меню публикации`);

        // действие над сообщением чата
        await page.goto(`/chat/${classId}`);
        await expect(page.getByTestId('chat-more').first()).toBeVisible({ timeout: 20_000 });
        await checkMenu(page, 'chat-more', 'chat-menu', `${size.name}: меню сообщения`);

        // полоса управления уроком: устройства, «Ещё», «Выйти» + оба меню доски
        await page.goto(`/lesson?classId=${classId}`);
        await waitBoard(page);
        await checkMenu(page, 'mic-toggle-menu', 'mic-menu', `${size.name}: меню микрофона`, 0);
        await checkMenu(page, 'cam-toggle-menu', 'cam-menu', `${size.name}: меню камеры`, 0);
        await checkMenu(page, 'more-btn', 'more-menu', `${size.name}: «Ещё»`);
        await checkMenu(page, 'leave-btn', 'leave-menu', `${size.name}: меню выхода`, 0);
        await checkMenu(page, 'board-menu-1', 'board-pop-1', `${size.name}: меню вкладки доски`);
        await checkMenu(page, 'board-purge-btn', 'board-purge-pop', `${size.name}: меню «удалить рисунки»`, 0);

        // окно экспорта — не меню, но тоже обязано помещаться и закрываться по Escape
        await page.getByTestId('board-pdf').click();
        const dialog = page.getByTestId('pdf-dialog');
        await expect(dialog, `${size.name}: окно экспорта открылось`).toBeVisible();
        const dbox = (await dialog.boundingBox())!;
        expect(dbox.x, `${size.name}: окно экспорта по левому краю`).toBeGreaterThanOrEqual(-0.5);
        expect(dbox.y, `${size.name}: окно экспорта по верхнему краю`).toBeGreaterThanOrEqual(-0.5);
        expect(dbox.x + dbox.width, `${size.name}: окно экспорта по правому краю`)
          .toBeLessThanOrEqual(size.viewport.width + 0.5);
        expect(dbox.y + dbox.height, `${size.name}: окно экспорта по нижнему краю`)
          .toBeLessThanOrEqual(size.viewport.height + 0.5);
        await page.keyboard.press('Escape');
        await expect(dialog, `${size.name}: Escape закрывает окно экспорта`).toHaveCount(0);

        await ctx.close();
      }
    });
});
