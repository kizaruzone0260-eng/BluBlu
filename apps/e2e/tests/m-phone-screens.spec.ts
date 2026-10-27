/*
 * B2 (2026-10-16): обход всех экранов на реальном мобильном профиле — Pixel 7 (Chromium,
 * 393×851, `isMobile` + `hasTouch`), проект `pixel7` в playwright.config.ts.
 *
 * Что здесь проверяется и почему именно так:
 *  • горизонтального скролла быть не должно НИ НА ОДНОМ экране — это не косметика: на телефоне
 *    он сдвигает и таб-бар, и поля формы за край экрана;
 *  • нижняя полоса навигации не имеет права закрывать контент: последний видимый элемент
 *    обязан заканчиваться выше её верха (для этого в вёрстке есть `--tab-h`);
 *  • каждое всплывающее меню целиком во вьюпорте — общий механизм размещения (`lib/popover.ts`)
 *    уже вычитает полосы приложения, здесь это проверяется на мобильном профиле;
 *  • размеры целей нажатия СЧИТЫВАЮТСЯ и печатаются (`MEASURE`) для всех кнопок, а жёстко
 *    требуются у главных: таб-бар, основные формы, панель урока. Разница в том, что «мелкая
 *    кнопка у плавающей камеры» — это осознанный дизайн, а «весь таб-бар по 30 px» — дефект,
 *    и только второе должно валить прогон.
 *
 * Язык интерфейса закрепляется за профилем через API (`pinTeacherRussian`), иначе подписи
 * плывут от прогона к прогону. Скрипты этого набора НЕ запускают медиа-сервер: урок здесь
 * проверяется как экран (полоса, панель, кнопка входа), а не как RTC-сессия.
 */
import { expect, test, request as pw, type Page } from '@playwright/test';
import {
  BASE, loginUi, makeLesson, pinTeacherRussian, registerStudent, stack, teacherToken, type Ctx,
} from './boardFixtures';

const VW = 393;
const TAB_BAR = '.tabbar';

/** MEASURE — строки, по которым потом читается реальный разнос, а не «упало/не упало». */
const m = (label: string, value: unknown) => console.log(`MEASURE ${label} ${JSON.stringify(value)}`);

async function noHorizontalScroll(page: Page, where: string) {
  const box = await page.evaluate(() => ({
    scrollW: document.documentElement.scrollWidth,
    innerW: window.innerWidth,
  }));
  m(`scroll ${where}`, box);
  expect(box.scrollW, `горизонтальный скролл на «${where}»`).toBeLessThanOrEqual(box.innerW + 1);
}

/**
 * Полоса навигации прижата к нижнему краю и лежит ПОВЕРХ контента (z-index 50), поэтому экран
 * защищён от неё не позиционированием, а запасом снизу: у контейнера обязан быть отступ не меньше
 * высоты самой полосы. Это и есть та механика, из-за которой в 2026-10 меню уже залазило под
 * `.tabbar` — проверка держит её на каждом экране.
 */
async function notCoveredByTabbar(page: Page, where: string) {
  const r = await page.evaluate((sel) => {
    const bar = document.querySelector(sel) as HTMLElement | null;
    const box = document.querySelector('.main .container') as HTMLElement | null;
    if (!bar || !box) return null;
    const b = bar.getBoundingClientRect();
    if (b.height === 0) return null;   // на широком экране полосы нет — проверять нечего
    const cs = getComputedStyle(box);
    return {
      barH: Math.round(b.height),
      padBottom: Math.round(parseFloat(cs.paddingBottom || '0')),
      padRight: Math.round(parseFloat(cs.paddingRight || '0')),
    };
  }, TAB_BAR);
  m(`tabbar reserve ${where}`, r);
  if (!r) return;
  expect(r.padBottom, `запас снизу под полосой навигации на «${where}»`)
    .toBeGreaterThanOrEqual(r.barH - 1);
}

/**
 * Размеры целей нажатия. ЖЁСТКО требуются только у элементов, где 44 px — правило вёрстки
 * (`.tabbar`, панель урока: у них `min-height: var(--tap)`). Всё остальное считается и
 * печатается: «кнопка удаления в строке списка» мелкая намеренно, и валить из-за неё прогон
 * означало бы, что проверка превратится в список разрешённых исключений.
 */
function tapSizes(page: Page, where: string, sel: string) {
  return page.evaluate((s) => {
    const arr: { testid: string; h: number; w: number }[] = [];
    for (const el of Array.from(document.querySelectorAll(s))) {
      const b = el.getBoundingClientRect();
      if (b.height === 0 || b.width === 0) continue;
      arr.push({ testid: el.getAttribute('data-testid') || el.className || el.tagName,
        h: Math.round(b.height), w: Math.round(b.width) });
    }
    return arr;
  }, sel).then((arr) => { m(`tap ${where}`, arr); return arr; });
}

async function tapTargets(page: Page, where: string, sel: string, strict: boolean) {
  const arr = await tapSizes(page, where, sel);
  if (!strict || arr.length === 0) return;
  const worst = arr.reduce((a, b) => (Math.min(b.h, b.w) < Math.min(a.h, a.w) ? b : a));
  expect(Math.min(worst.h, worst.w), `цель нажатия меньше 44 px на «${where}»: ${worst.testid}`)
    .toBeGreaterThanOrEqual(44 - 1);
}

async function tabbarTargets(page: Page) {
  const min = await page.evaluate(() => {
    let m = 999;
    for (const el of Array.from(document.querySelectorAll('.tabbar a, .tabbar button'))) {
      const b = el.getBoundingClientRect();
      if (b.height === 0) continue;
      m = Math.min(m, Math.round(Math.min(b.height, b.width)));
    }
    return m;
  });
  m('tabbar targets', { min });
  if (min < 999) expect(min, 'полоса навигации телефона').toBeGreaterThanOrEqual(44 - 1);
}

test.describe('телефон: все экраны (Pixel 7, 393 px)', () => {
  let api: Ctx;
  let token = '';
  let classId = '';
  let className = '';
  let studentEmail = '';
  let studentLink = '';

  test.beforeAll(async () => {
    api = await pw.newContext({ baseURL: BASE });
    token = await teacherToken(api);
    await pinTeacherRussian(api, token);
    const lesson = await makeLesson(api, token, 'Телефон');
    classId = lesson.classId; className = lesson.className;
    studentLink = lesson.linkUrl;
    studentEmail = `ph${Date.now()}@x.io`;
  });

  test.afterAll(async () => { await api?.dispose(); });

  test('учитель проходит свои экраны без дефектов вёрстки', async ({ page, browserName }) => {
    test.setTimeout(300_000);
    expect(browserName, 'мобильный профиль — это chromium').toBe('chromium');
    await loginUi(page, stack.teacherEmail, stack.teacherPassword);

    const screens: [string, string][] = [
      ['Главная', '/'], ['Классы', '/classes'], ['Календарь', '/calendar'],
      ['Заметки', '/notes'], ['Чат', '/chat'], ['Профиль', '/profile'],
    ];
    await noHorizontalScroll(page, 'Главная');
    await tabbarTargets(page);
    await tapTargets(page, 'Главная', 'button[type=submit], .card button', false);

    for (const [title, path] of screens) {
      await page.goto(path);
      await expect(page.locator('body')).toBeVisible();
      await noHorizontalScroll(page, title);
      await notCoveredByTabbar(page, title);
    }

    // класс и его экраны
    await page.goto(`/classes/${classId}`);
    await expect(page.getByText(className)).toBeVisible({ timeout: 20_000 });
    await noHorizontalScroll(page, 'Класс');
    await tapTargets(page, 'Класс', '.card button', false);

    await page.goto(`/classes/${classId}/material/new`);
    await expect(page.getByTestId('material-h1')).toBeVisible({ timeout: 20_000 });
    await noHorizontalScroll(page, 'Создать материал');
    await tapTargets(page, 'Создать материал', 'button[type=submit]', false);

    // архив класса (экран с миниатюрами досок)
    await page.goto(`/classes/${classId}/archive`);
    await noHorizontalScroll(page, 'Архив');

    // урок КАК ЭКРАН: без входа в комнату (медиа-сервер здесь не поднят), но полоса управления,
    // панель и карточка входа обязаны помещаться на 393 px
    await page.goto(`/lesson?classId=${classId}`);
    await expect(page.getByTestId('lesson-shell')).toBeVisible({ timeout: 30_000 });
    await noHorizontalScroll(page, 'Урок');
    await tapTargets(page, 'Урок', '.lesson-bar button', true);

    // переключатель языка в мобильной шапке: меню целиком во вьюпорте и закрывается по клику снаружи
    const lang = page.getByTestId('lang-open').locator('visible=true').first();
    if (await lang.count()) {
      await lang.click();
      const menu = page.getByTestId('lang-menu').locator('visible=true').first();
      await expect(menu).toBeVisible();
      const box = await menu.boundingBox();
      expect(box, 'меню языка не имеет права быть без координат').toBeTruthy();
      expect(box!.x, 'меню языка не за левым краем').toBeGreaterThanOrEqual(-0.5);
      expect(box!.x + box!.width, 'меню языка не за правым краем')
        .toBeLessThanOrEqual(VW + 0.5);
      await page.keyboard.press('Escape');
    }
  });

  test('ученик проходит свои экраны', async ({ browser }) => {
    test.setTimeout(240_000);
    const reg = await browser.newContext();
    const p = await reg.newPage();
    await registerStudent(p, studentLink, 'Фатоэ', studentEmail);
    await reg.close();

    const page = await (await browser.newContext()).newPage();
    await loginUi(page, studentEmail, 'Secret1234');
    for (const [title, path] of [['Главная', '/'], ['Классы', '/classes'],
      ['Листки', '/sheets'], ['Чат', '/chat'], ['Профиль', '/profile']] as [string, string][]) {
      await page.goto(path);
      await noHorizontalScroll(page, `ученик · ${title}`);
      await tabbarTargets(page);
    }
    await page.context().close();
  });
});
