/*
 * Часть G (2026-10-16): скриншоты основных экранов на телефоне — артефакт CI, не проверка.
 *
 * Зачем отдельный спек рядом с `m-phone-screens`: тот спрашивает геометрией (горизонтального
 * скролла нет, полоса не накрыта, цели по 44 px) и потому умеет только «упало / не упало».
 * Дефекты вида «подпись на узбекском легла в две строки и сдвинула таблицу» или «тёмная тема
 * забыла фон карточки» геометрией не ловятся — их видно только глазами. Глаз в CI нет, поэтому
 * кадр здесь ничего не утверждает, кроме факта, что экран отрисовался в нужном языке и теме:
 * файл обязан быть пригоден для просмотра, а не просто занимать место в архиве.
 *
 * Спек помечен `@shots`: блокирующий джоб `e2e` запускается с `--grep-invert "@unstable|@shots"`
 * и эти кадры не снимает, а неблокирующий джоб `phone-shots` (`.github/workflows/ci.yml`) снимает
 * и уносит PNG артефактом. Падают кадры — деплой не блокируется, но пустой архив виден по
 * `if-no-files-found: error`.
 *
 * Язык и тема сверяются ПОСЛЕ захода на экран: `documentElement.lang` ставит i18n,
 * `html[data-theme]` — `lib/theme.ts`. Без этой сверки архив из 60 PNG (9 экранов + меню «Ещё»
 * на шесть комбинаций языка и темы) мог бы оказаться шестью одинаковыми языками, а отличить их
 * постфактум было бы нечем.
 *
 * Медиа-сервер этот спек не трогает: урок снимается как экран (полоса управления, меню «Ещё»),
 * а не как RTC-сессия — вход в комнату здесь не делается намеренно.
 */
import { expect, test, request as pw, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { BASE, loginUi, makeLesson, stack, teacherToken, type Ctx } from './boardFixtures';

const OUT = join(process.cwd(), 'test-results', 'phone-shots');
const LOCALES = ['ru', 'uz', 'en'] as const;
const THEMES = ['light', 'dark'] as const;
type Locale = (typeof LOCALES)[number];

/** Экраны учителя. «Урок» открывается без входа в комнату. */
const SCREENS: [string, (classId: string) => string][] = [
  ['home', () => '/'],
  ['classes', () => '/classes'],
  ['class', (id) => `/classes/${id}`],
  ['material-new', (id) => `/classes/${id}/material/new`],
  ['calendar', () => '/calendar'],
  ['notes', () => '/notes'],
  ['chat', () => '/chat'],
  ['profile', () => '/profile'],
  ['lesson', (id) => `/lesson?classId=${id}`],
];

/**
 * Язык берётся из профиля (как в `pinTeacherRussian`), а не из шапки: иначе первые кадры прогона
 * снимались бы в языке, который последним поставил другой спек.
 */
async function pinLocale(api: Ctx, token: string, locale: Locale): Promise<void> {
  const me = await api.get('/api/me', { headers: { authorization: `Bearer ${token}` } });
  expect(me.status(), `pinLocale(${locale}): /api/me вернул ${me.status()}`).toBe(200);
  const p = await me.json();
  const r = await api.patch('/api/me/profile', {
    headers: { authorization: `Bearer ${token}` },
    data: { name: p.name, lastName: p.lastName ?? '', tz: p.tz, locale },
  });
  expect(r.status(), `pinLocale(${locale}): PATCH /api/me/profile вернул ${r.status()}`).toBe(200);
}

/**
 * Тема пишется в localStorage ДО первой навигации: `lib/theme.ts` читает её на старте приложения,
 * а после загрузки страницы её уже не поставить — кадр вышел бы светлым с именем `…-dark.png`.
 */
async function setTheme(page: Page, theme: typeof THEMES[number]): Promise<void> {
  await page.context().addInitScript((value) => {
    try { localStorage.setItem('klass_theme', value); } catch { /* приватный режим: тема останется системной */ }
  }, theme);
}

async function shoot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: join(OUT, `${name}.png`) });
  console.log(`SHOT ${name}`);
}

test.describe('телефон: скриншоты экранов (Pixel 7) @shots', () => {
  let api: Ctx;
  let token = '';
  let classId = '';

  test.beforeAll(async () => {
    mkdirSync(OUT, { recursive: true });
    api = await pw.newContext({ baseURL: BASE });
    token = await teacherToken(api);
    classId = (await makeLesson(api, token, 'Скриншоты')).classId;
  });

  test.afterAll(async () => { await api?.dispose(); });

  for (const locale of LOCALES) {
    for (const theme of THEMES) {
      test(`${locale} · ${theme}: все основные экраны сняты`, async ({ page }) => {
        test.setTimeout(300_000);
        await pinLocale(api, token, locale);
        await setTheme(page, theme);
        await loginUi(page, stack.teacherEmail, stack.teacherPassword);

        for (const [name, path] of SCREENS) {
          await page.goto(path(classId));
          // экран обязан что-то показать: `.main .container` есть на всех аутентифицированных
          // маршрутах (App.tsx: Shell), включая урок
          await expect(page.locator('.main .container')).toBeVisible({ timeout: 25_000 });
          await expect
            .poll(() => page.evaluate(() => document.documentElement.lang),
              { message: `${locale}: язык не применился на «${name}»` })
            .toBe(locale);
          expect(await page.evaluate(() => document.documentElement.dataset.theme),
            `${theme}: тема не применилась на «${name}»`).toBe(theme);
          if (name === 'lesson') {
            await expect(page.getByTestId('lesson-bar')).toBeVisible({ timeout: 30_000 });
          }
          await page.waitForTimeout(400);  // шрифты и тосты доезжают — кадр не полу-рендер
          await shoot(page, `${locale}-${theme}-${name}`);
        }

        /*
         * Меню «Ещё» на полосе урока: именно оно на телефоне собирает кнопки, скрытые с основного
         * экрана, и как оно размещается относительно двух полос приложения, по кадрам раньше не
         * смотрели.
         */
        await page.goto(`/lesson?classId=${classId}`);
        await expect(page.getByTestId('lesson-bar')).toBeVisible({ timeout: 30_000 });
        await page.getByTestId('more-btn').click();
        await expect(page.getByTestId('more-menu')).toBeVisible({ timeout: 15_000 });
        await shoot(page, `${locale}-${theme}-lesson-more`);
        await page.keyboard.press('Escape');
      });
    }
  }
});
