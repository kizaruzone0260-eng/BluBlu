/*
 * Task F (2026-10-28): /mini глазами телефона, но БЕЗ настоящего Telegram.
 *
 * Три состояния открытия — единственные, которые можно проверить браузером честно, не
 * подделывая подписанный initData: «открыто вне Telegram», «SDK не загрузился» и «сервер не
 * настроен». Именно здесь ломается доверие: страница, которая вечно крутит спиннер или
 * показывает пустой экран вместо «открой бота», выглядит как поломка продукта.
 *
 * SDK подменяется на уровне маршрута, а не через addInitScript: настоящий код страницы
 * вставляет <script src="https://telegram.org/js/telegram-web-app.js">, и подмена ответа
 * проверяет заодно, что CSP документа /mini РАЗРЕШАЕТ этот источник. Со строгой политикой
 * остальных страниц (script-src 'self') тест упал бы в «Telegram did not load».
 *
 * Профиль — телефонный вьюпорт 393×851, заданный в этом файле: так проверка горизонтального
 * скролла и целей нажатия исполняется и на локальной машине (Edge — chromium), и в CI. Отдельный
 * проект `pixel7` (файлы m-*.spec.ts) требует скачанного chromium, которого на этой машине нет.
 */
import { expect, test, type Page } from '@playwright/test';

/** Полный стенд `window.Telegram.WebApp`: страница вызывает ready/expand/тему, а не только читает initData. */
function sdkScript(initData: string, colorScheme: 'light' | 'dark' = 'dark'): string {
  return `window.Telegram = { WebApp: {
    initData: ${JSON.stringify(initData)},
    initDataUnsafe: { user: { id: 42, first_name: 'E2E' } },
    colorScheme: ${JSON.stringify(colorScheme)},
    themeParams: {
      bg_color: '#101010', secondary_bg_color: '#181818', text_color: '#eeeeee',
      hint_color: '#999999', link_color: '#7aa2f7', button_color: '#7aa2f7',
      button_text_color: '#ffffff'
    },
    ready() {}, expand() {}, close() {}, onEvent() {}, offEvent() {},
    disableVerticalSwipes() {}, isVersionAtLeast() { return true; },
    BackButton: { show() {}, hide() {}, onClick() {}, offClick() {} },
    MainButton: { text: '', show() {}, hide() {}, enable() {}, disable() {},
      setText() {}, onClick() {}, offClick() {} },
    HapticFeedback: { impactOccurred() {}, notificationOccurred() {}, selectionChanged() {} },
    setHeaderColor() {}, setBackgroundColor() {}
  } };`;
}

async function noHorizontalScroll(page: Page, where: string): Promise<void> {
  const box = await page.evaluate(() => ({
    scrollW: document.documentElement.scrollWidth,
    innerW: window.innerWidth,
  }));
  expect(box.scrollW, `горизонтальный скролл на «${where}»`).toBeLessThanOrEqual(box.innerW + 1);
}

/** Любая ошибка JS на странице — это сломанный экран, даже если подпись успела нарисоваться. */
function collectPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(String(err)));
  return errors;
}

test.describe('Mini App outside Telegram', () => {
  test.use({ viewport: { width: 393, height: 851 }, hasTouch: true });
  /*
   * Service workers off. The offline shell calls `clients.claim()` and intercepts every GET,
   * including the cross-origin Telegram SDK; requests made by a service worker bypass
   * `page.route`, so the SDK stub below was sometimes skipped and the real (unreachable)
   * telegram.org request failed with `net::ERR_FAILED` — seen in the full run of 2026-10-28 as
   * the first spec turning into "Telegram did not load". With the worker blocked the route is
   * the only network layer and the three opening states are deterministic.
   */
  test.use({ serviceWorkers: 'block' });

  /*
   * Task G.2 (2026-11-04): эти три экрана больше не тупики. Раньше «открыто вне Telegram» и
   * «SDK не загрузился» были финальными ответами, и именно из-за них Mini App выглядел сломанным
   * в клиенте, который умеет только открыть ссылку. Теперь оба состояния — это рабочая дверь с
   * обычным входом BluBlu; проверяется то же, что и раньше: CSP документа, отсутствие запросов
   * к /api/mini без сессии, горизонтальный скролл и размер цели нажатия.
   */
  test('opens outside Telegram as the web door, with no sideways scroll', async ({ page }) => {
    const errors = collectPageErrors(page);
    const calls: string[] = [];
    page.on('request', (r) => {
      if (new URL(r.url(), 'http://127.0.0.1').pathname.startsWith('/api/mini')) calls.push(r.url());
    });
    await page.route('https://telegram.org/**', (route) => route.fulfill({
      status: 200,
      contentType: 'application/javascript',
      body: sdkScript(''), // SDK загрузился, но initData пуст — ровно как в обычном браузере
    }));

    const response = await page.goto('/mini');
    expect(response?.status()).toBe(200);
    // Документ /mini обязан разрешать официальный SDK и не запрещать рамку Telegram;
    // подменённый скрипт иначе не выполнился бы и экран ушёл бы в «Telegram did not load».
    const csp = String(response?.headers()['content-security-policy'] ?? '');
    expect(csp).toContain('https://telegram.org');
    expect(response?.headers()['x-frame-options']).toBeUndefined();

    const signin = page.getByTestId('mini-signin');
    await expect(signin).toBeVisible();
    await expect(signin).toContainText('Sign in to BluBlu');
    await expect(signin).toContainText('Browser mode');
    // Telegram-автозаявки нет и быть не может: страница не отправляет ничего, пока человек не вошёл
    expect(calls).toEqual([]);
    await noHorizontalScroll(page, 'outside Telegram');
    expect(errors).toEqual([]);
  });

  test('an unreachable SDK opens the web door instead of announcing a failure', async ({ page }) => {
    const errors = collectPageErrors(page);
    // сеть до telegram.org недоступна — сценарий школьного wi-fi, из-за которого у загрузчика есть таймаут
    await page.route('https://telegram.org/**', (route) => route.abort());
    await page.goto('/mini');

    await expect(page.getByTestId('mini-outside')).toHaveCount(0);
    await expect(page.getByTestId('mini-sdk-failed')).toHaveCount(0);
    const signin = page.getByTestId('mini-signin');
    await expect(signin).toBeVisible();
    // моста нет (это обычный браузер) — значит извиняться не за что, и экран просто предлагает вход
    await expect(page.getByTestId('mini-telegram-unavailable')).toHaveCount(0);

    // у выхода есть действие, и оно не меньше пальца
    const submit = page.getByTestId('mini-signin-submit');
    await expect(submit).toBeVisible();
    const height = (await submit.boundingBox())?.height ?? 0;
    expect(height).toBeGreaterThanOrEqual(44);

    await noHorizontalScroll(page, 'SDK blocked');
    expect(errors).toEqual([]);
  });

  test('shows the server’s honest unavailability instead of a fake session', async ({ page }) => {
    const errors = collectPageErrors(page);
    await page.route('https://telegram.org/**', (route) => route.fulfill({
      status: 200,
      contentType: 'application/javascript',
      // любой initData: проверять его некому — на стенде e2e у бота нет токена
      body: sdkScript('query_id=AAE&user=%7B%22id%22%3A42%7D&auth_date=1700000000&hash=deadbeef'),
    }));

    const auth = page.waitForResponse((r) => r.request().method() === 'POST'
      && new URL(r.url()).pathname === '/api/mini/auth');
    await page.goto('/mini');
    const authResponse = await auth;
    expect(authResponse.status()).toBe(503);
    await expect(authResponse.json()).resolves.toMatchObject({ error: 'miniUnavailable' });

    /*
     * Task G.2: ненастроенный бот — это не «ошибка, попробуй позже» на пустом экране, а то же
     * предложение войти паролем с честной строкой о причине. Фейковой сессии по-прежнему нет.
     */
    const signin = page.getByTestId('mini-signin');
    await expect(signin).toBeVisible();
    await expect(signin).toContainText('temporarily unavailable');

    /*
     * Тема применена из themeParams ещё до ответа сервера: внутри Telegram клиент обязан
     * подчиняться светлой/тёмной теме пользователя, даже если сам Mini App потом не открылся.
     */
    const theme = await page.evaluate(() => ({
      scheme: document.documentElement.dataset.theme,
      bg: getComputedStyle(document.querySelector('.mini-app') as HTMLElement).backgroundColor,
    }));
    expect(theme.scheme).toBe('dark');
    expect(theme.bg).toBe('rgb(16, 16, 16)');

    await noHorizontalScroll(page, 'server error');
    expect(errors).toEqual([]);
  });
});
