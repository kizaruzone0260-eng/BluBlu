/*
 * Task G.2 (2026-11-04): Telegram mode и Browser mode глазами браузера.
 *
 * Прежний набор (`mini.spec.ts`) проверял три «открытия», одним из которых был фатальный
 * «Telegram did not load». Здесь — то, ради чего задача затевалась: ни одно состояние SDK не
 * имеет права заканчиваться тупиком, а браузерная дверь обязана работать без Telegram вообще.
 *
 * Два уровня честности:
 *  • `/api/mini/*` подменяется роутами там, где нужен настоящий бот (публикация, подписанный
 *    запуск): подпись `initData` проверяет сервер, и это покрыто
 *    `apps/api/test/integration/mini-app.test.ts`, а не браузером;
 *  • вход преподавателя в Browser mode идёт через НАСТОЯЩИЙ `/api/auth/login` и настоящий
 *    `/api/mini/web/auth` этого стека: «обычная авторизация BluBlu» проверяется как факт, а не
 *    как обещание в комментарии.
 *
 * Отдельно держится `serviceWorkers: 'allow'` — ровно один тест. Старый worker перехватывал
 * запрос SDK и глушил его (net::ERR_FAILED), из-за чего `mini.spec.ts` в 2026-10-28 и ловил
 * «Telegram did not load» первым же спеком. Теперь чужие домены worker'у не интересны, и
 * подмена ответа снова работает — это и есть проверка матрицы №14.
 */
import { expect, test, type Page } from '@playwright/test';

const SDK_URL = '**/telegram-web-app.js**';

/**
 * SDK-заглушка: ровно то, что даёт настоящий клиент, плюс метка, что скрипт исполнился.
 * Флаги включают/выключают отдельные части API — матрица №13 («клиент дал половину Surface’а»)
 * проверяется именно так, а не комментарием «мы это обработаем».
 */
function sdkStub(initData: string, parts: { backButton?: boolean; mainButton?: boolean; haptic?: boolean } = {}): string {
  const { backButton = true, mainButton = true, haptic = true } = parts;
  const surface: string[] = [
    `initData: ${JSON.stringify(initData)}`,
    'initDataUnsafe: { user: { id: 42, first_name: \'E2E\' } }',
    'colorScheme: \'dark\'',
    'themeParams: { bg_color: \'#101010\', text_color: \'#eeeeee\' }',
    'version: \'7.0\'',
    'ready() {}, expand() {}, close() {}, onEvent() {}, offEvent() {}',
    'disableVerticalSwipes() {}, isVersionAtLeast() { return true; }',
    'setHeaderColor() {}, setBackgroundColor() {}',
  ];
  if (backButton) surface.push('BackButton: { show() {}, hide() {}, onClick() {}, offClick() {}, isVisible: false }');
  if (mainButton) surface.push('MainButton: { text: \'\', show() {}, hide() {}, enable() {}, disable() {}, setText() {}, onClick() {}, offClick() {} }');
  if (haptic) surface.push('HapticFeedback: { impactOccurred() {}, notificationOccurred() {}, selectionChanged() {} }');
  return `window.__tgStubRan = true;\nwindow.Telegram = { WebApp: { ${surface.join(',\n  ')} } };`;
}

/** Клиент с нативным мостом, но без дошедшего SDK (школьная сеть, заблокированный telegram.org). */
async function withTelegramBridge(page: Page) {
  await page.addInitScript(() => {
    (window as unknown as { TelegramWebviewProxy?: unknown }).TelegramWebviewProxy = { postEvent() {} };
  });
}

const BOOTSTRAP = {
  teacher: { name: 'E2E Teacher', locale: 'en', tz: 'Asia/Tashkent' },
  groups: [{ id: 'g-1', title: 'Группа А', kind: 'online', status: 'active', chatShort: '-91', materialCount: 1, lastPublication: null }],
  drafts: [],
  publications: [],
  materialsCount: 1,
  limits: { groups: 8, materials: 8, links: 5, title: 120, instruction: 4_000, text: 12_000, items: 12 },
  ai: { remote: false },
  bot: { username: 'classblu_bot' },
  legal: {
    accepted: true, privacyVersion: '2026-10-29', termsVersion: '2026-10-29',
    currentPrivacyVersion: '2026-10-29', currentTermsVersion: '2026-09-29', acceptedAt: '2026-10-29T08:00:00.000Z', locale: 'en',
  },
  links: { privacy: '/privacy', terms: '/terms' },
};

/**
 * Все ответы Mini App. `onAuth` — единственный перехватчик тела: он смотрит, ЧТО именно клиент
 * отправил на обмен, и не мешает маршруту ответить настоящим токеном.
 */
async function stubMiniApi(page: Page, onAuth?: (body: string) => void) {
  await page.route('**/api/mini/**', (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    const json = (status: number, body: unknown) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

    if (path.endsWith('/auth') || path.endsWith('/web/auth')) {
      if (onAuth) onAuth(req.postData() ?? '');
      return json(200, {
        token: 'e2e-mini-token', expiresAt: '2030-01-01T00:00:00.000Z',
        teacher: { id: 'u-1', name: 'E2E Teacher', locale: 'en', tz: 'Asia/Tashkent' },
        bot: { username: 'classblu_bot' },
      });
    }
    if (path.endsWith('/bootstrap')) return json(200, BOOTSTRAP);
    if (path.endsWith('/drafts') && req.method() === 'POST') return json(201, { draft: DRAFT });
    if (path.includes('/format')) {
      return json(200, {
        draft: { ...DRAFT, status: 'preview', formattedText: 'Домашнее задание\n\nстр. 42' },
        warnings: [], questions: [], provider: 'plain', usedAi: false,
      });
    }
    if (path.includes('/preview')) return json(200, { draft: { ...DRAFT, status: 'preview' } });
    if (path.includes('/publish')) {
      return json(200, {
        kind: 'done',
        draft: { ...DRAFT, status: 'published', publishedAt: '2026-11-04T08:00:00.000Z' },
      });
    }
    if (path.includes('/history')) return json(200, { drafts: [], publications: [] });
    return json(200, { draft: DRAFT });
  });
}

const DRAFT = {
  id: 'd-1', status: 'collecting' as const, title: 'Дроби', instruction: 'стр. 42', dueAt: null,
  formattedText: '', groups: [{ id: 'g-1', title: 'Группа А', kind: 'online' as const }],
  materials: [], links: [], warnings: [], questions: [], provider: 'none', lastError: '',
  canEdit: true, canPublish: true, canRetry: false, publications: [],
  createdAt: '2026-11-04T08:00:00.000Z', updatedAt: '2026-11-04T08:00:00.000Z', publishedAt: null,
};

/** Ни одного мёртвого экрана: эти слова были приговором, теперь их не должно быть. */
async function expectNoFatalScreen(page: Page) {
  await expect(page.getByTestId('mini-sdk-failed')).toHaveCount(0);
  await expect(page.getByTestId('mini-outside')).toHaveCount(0);
  await expect(page.getByText('Telegram did not load')).toHaveCount(0);
}

test.describe('Browser mode без Telegram вообще', () => {
  test.use({ viewport: { width: 393, height: 851 }, hasTouch: true, serviceWorkers: 'block' });

  // матрица 2: скрипт вернул ошибку сети
  test('a blocked SDK opens the web door, not a dead end', async ({ page }) => {
    await page.route(SDK_URL, (route) => route.abort('failed'));
    await page.goto('/mini');
    await expect(page.getByTestId('mini-signin')).toBeVisible();
    await expectNoFatalScreen(page);
    // в обычном браузере извиняться не за что: Telegram здесь никогда и не обещался
    await expect(page.getByTestId('mini-telegram-unavailable')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Try again/i })).toBeVisible();
    await expect(page.getByRole('link', { name: /Open web version/i })).toHaveAttribute('href', '/web');
  });

  /*
   * Тот же отказ сети, но клиент с нативным мостом: вот здесь человек имеет право узнать, что
   * автовход не состоялся. Признак — `TelegramWebviewProxy`, а не user-agent.
   */
  test('the same failure inside a Telegram client says so, and still lets the teacher in', async ({ page }) => {
    await withTelegramBridge(page);
    await page.route(SDK_URL, (route) => route.abort('failed'));
    await page.goto('/mini');
    await expect(page.getByTestId('mini-signin')).toBeVisible();
    await expect(page.getByTestId('mini-telegram-unavailable')).toBeVisible();
    await expectNoFatalScreen(page);
  });

  // матрица 3 и 4: скрипт загрузился, но `Telegram.WebApp` не появился (клиент без моста)
  test('an SDK that loads but defines nothing still opens the web door', async ({ page }) => {
    await page.route(SDK_URL, (route) => route.fulfill({ status: 200, contentType: 'application/javascript', body: '/* no WebApp */' }));
    await page.goto('/mini');
    await expect(page.getByTestId('mini-signin')).toBeVisible();
    await expectNoFatalScreen(page);
  });

  // матрица 5: SDK есть, подписи нет — доступа через Telegram mode нет
  test('a live SDK without initData asks for a normal sign-in', async ({ page }) => {
    await page.route(SDK_URL, (route) => route.fulfill({ status: 200, contentType: 'application/javascript', body: sdkStub('') }));
    await page.goto('/mini');
    await expect(page.getByTestId('mini-signin')).toBeVisible();
    await expectNoFatalScreen(page);
  });

  // §4: явная веб-дверь не тянет чужой скрипт и не спрашивает про Telegram
  test('/web needs no Telegram at all', async ({ page }) => {
    let sdkRequested = false;
    await page.route(SDK_URL, (route) => { sdkRequested = true; return route.abort('failed'); });
    await stubMiniApi(page);
    await page.goto('/web');
    await expect(page.getByTestId('mini-signin')).toBeVisible();
    await expect(page.getByText(/plain web door/i)).toBeVisible();
    expect(sdkRequested, 'веб-дверь не должна просить telegram.org').toBe(false);
  });
});

test.describe('Browser mode против настоящего API', () => {
  test.use({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' });

  // матрица 10 и 12: вход существующим преподавателем BluBlu и черновик после входа
  test('the teacher signs in with her usual BluBlu password', async ({ page }) => {
    await page.route(SDK_URL, (route) => route.abort('failed'));
    await page.goto('/mini');
    await page.getByLabel(/Email/i).fill('owner@e2e.io');
    await page.getByLabel(/Password/i).fill('Passw0rd123');
    await page.getByTestId('mini-signin-submit').click();

    await expect(page.getByTestId('mini-home')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('mini-mode')).toContainText(/Browser mode/i);
    await expect(page.getByTestId('mini-signout')).toBeVisible();
    // surface записан сервером, а не клиентом: сессия помнит, что она веб
    expect(await page.evaluate(() => sessionStorage.getItem('klass_mini_surface'))).toBe('web');

    // «создать домашнее задание» после входа — настоящий запрос к настоящему API этого стека
    await page.getByTestId('mini-new').click();
    await expect(page.getByTestId('mini-wizard')).toBeVisible({ timeout: 15_000 });
  });

  // матрица 11: аноним не получает защищённые данные
  test('an anonymous mini token reveals nothing', async ({ page }) => {
    const anon = await page.request.get('/api/mini/bootstrap');
    expect(anon.status()).toBe(401);
    const mint = await page.request.post('/api/mini/web/auth');
    expect(mint.status(), 'нельзя обменять ничего на сессию').toBe(401);
  });
});

test.describe('Telegram mode и service worker', () => {
  test.use({ viewport: { width: 393, height: 851 }, hasTouch: true });

  // матрица 1 и 8: подписанный запуск живёт в адресе, и приложение входит через него
  test('a signed launch exchanges initData for a session', async ({ page }) => {
    const initData = 'auth_date=1730000000&query_id=AA-e2e&user=%7B%22id%22%3A4242%7D&hash=abc';
    await page.route(SDK_URL, (route) => route.fulfill({
      status: 200, contentType: 'application/javascript', body: sdkStub(initData),
    }));
    let sent = '';
    await stubMiniApi(page, (body) => { sent = body; });
    await page.goto('/mini');
    await expect(page.getByTestId('mini-home')).toBeVisible({ timeout: 20_000 });
    // сервер получил РОВНО ту строку, что дал Telegram: ни initDataUnsafe, ни выдуманный payload
    expect(JSON.parse(sent).initData).toBe(initData);
    expect(await page.evaluate(() => sessionStorage.getItem('klass_mini_surface'))).toBe('tg');
  });

  // §3: SDK не доехал, а запуск подписан — подпись по-прежнему читается из адреса
  test('a signed launch still authenticates when the SDK is blocked', async ({ page }) => {
    const initData = 'auth_date=1730000000&user=%7B%22id%22%3A4242%7D&hash=def';
    await page.route(SDK_URL, (route) => route.abort('failed'));
    let sent = '';
    await stubMiniApi(page, (body) => { sent = body; });
    await page.goto(`/mini#tgWebAppPlatform=android&tgWebAppData=${encodeURIComponent(initData)}`);
    await expect(page.getByTestId('mini-home')).toBeVisible({ timeout: 20_000 });
    expect(JSON.parse(sent).initData).toBe(initData);
    await expectNoFatalScreen(page);
  });

  // матрица 13: клиент дал половину API — экран живёт, кнопка остаётся HTML
  test('a partial Telegram API does not break the wizard', async ({ page }) => {
    await page.route(SDK_URL, (route) => route.fulfill({
      status: 200, contentType: 'application/javascript',
      // ни BackButton, ни MainButton, ни HapticFeedback — только объект с initData
      body: sdkStub('auth_date=1730000000&user=%7B%22id%22%3A4242%7D&hash=aaa',
        { backButton: false, mainButton: false, haptic: false }),
    }));
    await stubMiniApi(page);
    await page.goto('/mini');
    await expect(page.getByTestId('mini-home')).toBeVisible({ timeout: 20_000 });
    await page.getByTestId('mini-new').click();
    await expect(page.getByTestId('mini-wizard')).toBeVisible();
    // там, где нет телеграм-панели, главное действие рисует страница
    await expect(page.getByTestId('mini-next')).toBeVisible();
    await expect(page.getByTestId('mini-back')).toBeVisible();
  });

  /*
   * Матрица 14. Единственный тест с разрешённым worker'ом: он и есть доказательство, что
   * перехват чужих доменов снят. Со старым worker'ом подмена ответа не срабатывала (запрос шёл
   * от имени SW мимо page.route) и страница выдавала net::ERR_FAILED.
   */
  test('the service worker does not intercept the entry point or the SDK', async ({ page }) => {
    const initData = 'auth_date=1730000000&user=%7B%22id%22%3A4242%7D&hash=eee';
    await page.route(SDK_URL, (route) => route.fulfill({
      status: 200, contentType: 'application/javascript', body: sdkStub(initData),
    }));
    await stubMiniApi(page);

    await page.goto('/mini');
    await expect(page.getByTestId('mini-home')).toBeVisible({ timeout: 25_000 });
    expect(await page.evaluate(
      () => !!(window as unknown as { __tgStubRan?: boolean }).__tgStubRan,
    ), 'SDK дошёл до страницы под worker\'ом').toBe(true);

    // вторая навигация при активном worker'е — та, где всё и ломалось
    await page.reload();
    await expect(page.getByTestId('mini-home')).toBeVisible({ timeout: 25_000 });
    await expectNoFatalScreen(page);

    // в кеше нет ни HTML-документов, ни чужих доменов: подменить точку входа нечем
    const stored = await page.evaluate(async () => {
      const cache = await caches.open('klass-shell-v2');
      return (await cache.keys()).map((r) => new URL(r.url).pathname);
    });
    expect(stored.some((p) => p === '/' || p === '/mini' || p === '/login'), `документы в кеше: ${stored}`).toBe(false);
    expect(stored.some((p) => p.includes('telegram'))).toBe(false);
  });
});
