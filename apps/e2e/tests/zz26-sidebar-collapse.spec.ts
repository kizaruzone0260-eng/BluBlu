/**
 * Часть C (2026-10-17): свёрнутая боковая панель.
 *
 * Дефект был виден без измерения: в рейке 64 px подпись языка «EN» вместе со значком и отступами
 * кнопки занимала ~78 px и вылезала за рамку. Здесь проверяется геометрия: каждый видимый элемент
 * рейки обязан лежать ВНУТРИ её рамки, и меню языка в свёрнутом виде обязано открываться СПРАВА
 * от рейки, целиком во вьюпорте, и по клику из него язык действительно меняется.
 *
 * Три языка × две темы — потому что подпись «Русский»/«Oʻzbekcha» и тёмная палитра меняют именно
 * ширину и цвет, а не смысл. Локаль ставится профилем (не кликом), чтобы начало каждой проверки
 * было одинаковым; тема — через `localStorage.klass_theme` и перезагрузку, как её читает приложение.
 *
 * WebRTC не используется → спек исполняется в блокирующем наборе `e2e`.
 */
import { expect, test, request as pw, type Page } from '@playwright/test';
import { BASE, loginUi, m, stack, teacherToken, type Ctx } from './boardFixtures';

const LOCALES = ['uz', 'en', 'ru'] as const;
type Locale = typeof LOCALES[number];
const THEMES = ['light', 'dark'] as const;
/** порядок части A: `LANGUAGE_CHOICES` из `@klass/shared` (e2e-пакет от shared не зависит) */
const NATIVE: Record<Locale, string> = { uz: 'Oʻzbekcha', en: 'English', ru: 'Русский' };

async function pinLocale(api: Ctx, token: string, locale: Locale): Promise<void> {
  const me = await (await api.get('/api/me', { headers: { authorization: `Bearer ${token}` } })).json();
  const r = await api.patch('/api/me/profile', {
    headers: { authorization: `Bearer ${token}` },
    data: { name: me.name, lastName: me.lastName ?? '', tz: me.tz, locale },
  });
  expect(r.status(), `pinLocale(${locale}) → ${r.status()}`).toBe(200);
}

async function setTheme(page: Page, theme: typeof THEMES[number]): Promise<void> {
  await page.evaluate((value) => localStorage.setItem('klass_theme', value), theme);
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme, `тема ${theme} не применилась`);
}

/**
 * Всё, что видимо внутри рейки и не является всплывающим меню (`.menu-pop`, `.lang-menu` — они
 * НАМЕРЕНО вылезает за рейку, их проверяет отдельная проверка на вьюпорт).
 */
type RailItem = { name: string; x: number; y: number; w: number; h: number };

function railParts(page: Page): Promise<{ error: string | null; railW: number; railH: number; items: RailItem[] }> {
  return page.evaluate(() => {
    const out: { error: string | null; railW: number; railH: number; items: { name: string; x: number; y: number; w: number; h: number }[] }
      = { error: null, railW: 0, railH: 0, items: [] };
    const rail = document.querySelector<HTMLElement>('[data-testid=sidebar]');
    if (!rail) { out.error = 'нет [data-testid=sidebar]'; return out; }
    const rb = rail.getBoundingClientRect();
    out.railW = Math.round(rb.width);
    out.railH = Math.round(rb.height);
    for (const el of Array.from(rail.querySelectorAll<HTMLElement>('*'))) {
      if (el.closest('.menu-pop') || el.closest('.lang-menu')) continue;
      const b = el.getBoundingClientRect();
      if (b.width < 1 || b.height < 1) continue;
      if (getComputedStyle(el).visibility === 'hidden') continue;
      const cls = typeof el.className === 'string' ? el.className.split(' ')[0] : '';
      out.items.push({
        name: el.getAttribute('data-testid') || `${el.tagName.toLowerCase()}.${cls || 'plain'}`,
        x: Math.round(b.x - rb.x), y: Math.round(b.y - rb.y), w: Math.round(b.width), h: Math.round(b.height),
      });
    }
    return out;
  });
}

test.describe('свёрнутая боковая панель (часть C)', () => {
  let api: Ctx;
  let token = '';

  test.beforeAll(async () => {
    api = await pw.newContext({ baseURL: BASE });
    token = await teacherToken(api);
  });

  test.afterAll(async () => { await api?.dispose(); });

  for (const locale of LOCALES) {
    for (const theme of THEMES) {
      test(`${locale} · ${theme}: рейка не лопается, язык открывается справа`, async ({ page }) => {
        test.setTimeout(180_000);
        await pinLocale(api, token, locale);
        await loginUi(page, stack.teacherEmail, stack.teacherPassword);
        await expect(page.getByTestId('sidebar')).toBeVisible();
        await setTheme(page, theme);

        const rail = page.locator('[data-testid=sidebar]');

        // ── развёрнутое состояние: тот же замер, чтобы правка не сломала его
        const openState = await railParts(page);
        expect(openState.error, openState.error ?? '').toBeNull();
        const overflowOpen = openState.items.filter((i) => i.x < -1 || i.x + i.w > openState.railW + 1);
        m(`expanded ${locale}/${theme}`, { railW: openState.railW, count: openState.items.length, overflowOpen });
        expect(overflowOpen, `в развёрнутой панели за рамку вышло: ${JSON.stringify(overflowOpen)}`).toEqual([]);

        // ── свёрнутое состояние
        await page.getByTestId('sidebar-collapse').click();
        await expect(rail).toHaveClass(/collapsed/);
        /*
         * Класс меняется мгновенно, а ширина рейки анимируется (`transition: width 160ms`), и
         * замер сразу после клика давал развёрнутые 232 px вместо 64 — на этом и краснел zz26 в
         * прогоне 39034112298. `toHaveCSS` опрашивает значение, то есть дожидается конца перехода,
         * и заодно проверяет сам факт: свёрнутая рейка обязана стать ровно 64 px.
         */
        await expect(rail, 'свёрнутая рейка обязана доехать до 64 px').toHaveCSS('width', '64px');
        await expect(rail.getByTestId('lang-open')).toBeVisible();

        const got = await railParts(page);
        expect(got.error, got.error ?? '').toBeNull();
        const outside = got.items.filter((i) => i.x < -1 || i.x + i.w > got.railW + 1);
        m(`collapsed ${locale}/${theme}`, { railW: got.railW, count: got.items.length, outside });
        expect(outside, `за рамку рейки 64 px вышло: ${JSON.stringify(outside)}`).toEqual([]);
        expect(got.railW, 'свёрнутая рейка — 64 px').toBeLessThanOrEqual(64);

        // нижние элементы, о которых просит постановка: язык, раскрытие, аватар — цели нажатия
        for (const sel of ['[data-testid=lang-open]', '[data-testid=sidebar-collapse]', '.side-user']) {
          const b = await page.locator(sel).first().boundingBox();
          expect(b, `нет прямоугольника у ${sel}`).not.toBeNull();
          expect(b!.height, `высота цели нажатия ${sel}`).toBeGreaterThanOrEqual(44 - 1);
        }

        // ── меню языка: вылет вправо от рейки и целиком во вьюпорте
        const box = (await rail.boundingBox())!;
        const vp = page.viewportSize()!;
        // ВАЖНО: кнопка языка ищется ВНУТРИ рейки. На десктопе в DOM их три (в рейке, в меню
        // пользователя и в мобильной шапке, которая скрыта, но никуда не делась) — глобальный
        // getByTestId дал бы strict mode violation.
        await rail.getByTestId('lang-open').click();
        const menu = page.locator('.lang-menu');
        await expect(menu, `меню языка не открылось (${locale}/${theme})`).toBeVisible();
        const mb = (await menu.boundingBox())!;
        m(`lang-menu ${locale}/${theme}`, { railRight: Math.round(box.x + box.width), menu: mb });
        expect(mb.x, 'меню языка должно открываться СПРАВА от рейки').toBeGreaterThanOrEqual(box.x + box.width - 1);
        expect(mb.x).toBeGreaterThanOrEqual(0);
        expect(mb.x + mb.width).toBeLessThanOrEqual(vp.width + 1);
        expect(mb.y).toBeGreaterThanOrEqual(0);
        expect(mb.y + mb.height).toBeLessThanOrEqual(vp.height + 1);

        // порядок строк меню — часть A, и выбранный отмечен галочкой
        const labels = await menu.locator('button').allInnerTexts();
        expect(labels.map((s) => s.replace('✓', '').trim()), 'порядок языков в меню').toEqual(
          LOCALES.map((l) => NATIVE[l]));
        expect(labels[LOCALES.indexOf(locale)], 'текущий язык не отмечен галочкой').toContain('✓');

        // пункт другого языка работает из этого вылета (значит, до него можно дотянуться)
        const other = LOCALES.find((l) => l !== locale)!;
        await menu.locator(`[data-testid=lang-${other}]`).click();
        await expect(page.locator('html')).toHaveAttribute('lang', other, 'выбор из меню не поменял язык');
        await expect(page.getByTestId('lang-open')).toContainText(other.toUpperCase());
        await expect(menu).toHaveCount(0);

        // и в раскрытом виде панель возвращается к нормальной ширине
        await page.getByTestId('sidebar-collapse').click();
        await expect(rail).not.toHaveClass(/collapsed/);
        await expect(rail, 'развёрнутая рейка возвращается к 232 px').toHaveCSS('width', '232px');
      });
    }
  }

  test('меню пользователя в свёрнутой рейке не сжимается в полоску и помещается на экране', async ({ page }) => {
    await pinLocale(api, token, 'ru');
    await loginUi(page, stack.teacherEmail, stack.teacherPassword);
    await page.getByTestId('sidebar-collapse').click();
    await page.locator('.side-user').click();
    const pop = page.locator('.menu-pop');
    await expect(pop, 'меню пользователя не открылось').toBeVisible();
    const mb = (await pop.boundingBox())!;
    const rail = (await page.getByTestId('sidebar').boundingBox())!;
    const vp = page.viewportSize()!;
    m('menu-pop collapsed', { mb, railRight: Math.round(rail.x + rail.width) });
    // 48 px ширины рейки меню не повторяет: оно открывается вправо и остаётся во вьюпорте
    expect(mb.width, 'меню пользователя сжалось до ширины рейки').toBeGreaterThanOrEqual(200);
    expect(mb.x + mb.width).toBeLessThanOrEqual(vp.width + 1);
    expect(mb.y).toBeGreaterThanOrEqual(0);
    expect(mb.y + mb.height).toBeLessThanOrEqual(vp.height + 1);
    // и кнопка выхода в нём — цель нажатия
    const logout = pop.locator('button').last();
    const lb = (await logout.boundingBox())!;
    expect(lb.height, 'кнопка выхода меньше 44 px').toBeGreaterThanOrEqual(44 - 1);
    await page.keyboard.press('Escape');
  });
});
