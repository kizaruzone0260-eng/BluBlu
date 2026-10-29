/*
 * Task F.1 (2026-10-29): навигация Mini App глазами телефона.
 *
 * Здесь проверяется только интерфейс: главная с одной главной кнопкой и тремя разделами,
 * разделы Groups / Materials / History, возврат из раздела к домашнему заданию и кнопка
 * «Назад» самого Telegram. Сервер и SDK подменяются на уровне сети — на стенде e2e у бота нет
 * токена, поэтому настоящий initData подписать нечем. Это осознанная граница: подпись,
 * срок жизни токена и права проверяют интеграционные тесты API
 * (`apps/api/test/integration/mini-app.test.ts`), а не этот файл.
 *
 * Подмена SDK идёт через `page.route`, а не `addInitScript`: настоящий код страницы вставляет
 * <script src="https://telegram.org/js/telegram-web-app.js">, так что заодно проверяется, что
 * CSP документа /mini разрешает этот источник. Service workers выключены: offline-shell
 * перехватывает GET и обходит `page.route` (та же причина, что и в mini.spec.ts).
 */
import { expect, test, type Page } from '@playwright/test';

const BOT = 'classblu_bot';
const AUTH = {
  token: 'e2e-mini-token',
  expiresAt: '2030-01-01T00:00:00.000Z',
  teacher: { id: 'u-1', name: 'E2E Teacher', locale: 'en', tz: 'Asia/Tashkent' },
  bot: { username: BOT },
};

const GROUPS = [
  {
    id: 'g-1', title: 'Grade 7A', kind: 'offline', status: 'active',
    chatShort: '…7A', materialCount: 2, lastPublication: null,
  },
  {
    id: 'g-2', title: 'Online B2', kind: 'online', status: 'removed',
    chatShort: '…B2', materialCount: 0, lastPublication: null,
  },
];

const PUBLICATIONS = [
  {
    id: 'p-1', groupId: 'g-1', groupTitle: 'Grade 7A', status: 'sent', error: '',
    parts: [{ kind: 'text', label: '', method: 'text', status: 'sent', messageId: 11, error: '' }],
    delivered: 1, attempts: 1, updatedAt: '2026-10-28T10:00:00.000Z',
  },
];

const MATERIALS = [
  { id: 'm-1', title: 'Round-up 4', kind: 'book', fileName: 'round-up-4.pdf', fileSize: 1024, recommendedFor: [] },
  { id: 'm-2', title: 'Workbook 4', kind: 'workbook', fileName: 'workbook-4.pdf', fileSize: 2048, recommendedFor: [] },
];

function bootstrap() {
  return {
    teacher: { name: 'E2E Teacher', locale: 'en', tz: 'Asia/Tashkent' },
    groups: GROUPS,
    drafts: [],
    publications: PUBLICATIONS,
    materialsCount: MATERIALS.length,
    limits: { groups: 10, materials: 8, links: 5, title: 120, instruction: 4000, text: 4000, items: 50 },
    ai: { remote: false },
    bot: { username: BOT },
    // Task G: the gate is decided by this object; these tests are about navigation, so the
    // teacher has already accepted the current documents.
    legal: {
      accepted: true, privacyVersion: '2026-10-29', termsVersion: '2026-10-29',
      currentPrivacyVersion: '2026-10-29', currentTermsVersion: '2026-10-29',
      acceptedAt: '2026-10-29T08:00:00.000Z', locale: 'en',
    },
    links: { privacy: 'https://blublu.example/privacy', terms: 'https://blublu.example/terms' },
  };
}

/** The draft the wizard opens with; the wizard itself is covered by the API tests and Task F. */
function newDraft() {
  return {
    id: 'd-1', status: 'selecting', title: '', instruction: '', dueAt: null, formattedText: '',
    groups: [], materials: [], links: [], warnings: [], questions: [], provider: '', lastError: '',
    canEdit: true, canPublish: false, canRetry: false, publications: [],
    createdAt: '2026-10-29T08:00:00.000Z', updatedAt: '2026-10-29T08:00:00.000Z', publishedAt: null,
  };
}

/**
 * `window.Telegram.WebApp` with a BackButton that actually records its callback, so the test can
 * imitate the Telegram chrome button instead of only pressing the in-page one.
 */
function sdkScript(): string {
  return `window.__miniBack = null; window.__miniBackVisible = false;
  window.__miniMain = null; window.__miniMainText = ''; window.__tgThemeChange = null;
  window.Telegram = { WebApp: {
    initData: 'query_id=AAE&user=%7B%22id%22%3A42%7D&auth_date=1700000000&hash=deadbeef',
    initDataUnsafe: { user: { id: 42, first_name: 'E2E' } },
    colorScheme: 'dark',
    themeParams: {
      bg_color: '#101010', secondary_bg_color: '#181818', text_color: '#eeeeee',
      hint_color: '#999999', link_color: '#7aa2f7', button_color: '#7aa2f7',
      button_text_color: '#ffffff'
    },
    ready() {}, expand() {}, close() {},
    onEvent(ev, cb) { if (ev === 'themeChanged') window.__tgThemeChange = cb; },
    offEvent(ev, cb) { if (window.__tgThemeChange === cb) window.__tgThemeChange = null; },
    disableVerticalSwipes() {}, isVersionAtLeast() { return true; },
    BackButton: {
      show() { window.__miniBackVisible = true; },
      hide() { window.__miniBackVisible = false; },
      onClick(cb) { window.__miniBack = cb; },
      offClick(cb) { if (window.__miniBack === cb) window.__miniBack = null; }
    },
    MainButton: { text: '', visible: false, enabled: false,
      show() { this.visible = true; }, hide() { this.visible = false; },
      enable() { this.enabled = true; }, disable() { this.enabled = false; },
      setText(t) { this.text = t; window.__miniMainText = t; },
      onClick(cb) { window.__miniMain = cb; },
      offClick(cb) { if (window.__miniMain === cb) window.__miniMain = null; } },
    HapticFeedback: { impactOccurred() {}, notificationOccurred() {}, selectionChanged() {} },
    setHeaderColor() {}, setBackgroundColor() {}
  } };`;
}

interface MiniCalls {
  auth: number;
  paths: string[];
  /** Authorization seen on the calls that must carry the Mini App token. */
  bearer: string[];
}

/** Every `/api/mini/**` answer the page may ask for, with honest shapes from `services/homework/mini.ts`. */
async function stubMini(page: Page): Promise<MiniCalls> {
  const calls: MiniCalls = { auth: 0, paths: [], bearer: [] };
  await page.route('**/api/mini/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    calls.paths.push(`${request.method()} ${path}${url.search}`);
    if (path !== '/api/mini/auth') calls.bearer.push(request.headers().authorization ?? '');

    const json = (status: number, body: unknown) => route.fulfill({
      status, contentType: 'application/json', body: JSON.stringify(body),
    });

    if (path === '/api/mini/auth' && request.method() === 'POST') {
      calls.auth++;
      return json(200, AUTH);
    }
    if (path === '/api/mini/bootstrap') return json(200, bootstrap());
    if (path === '/api/mini/history') {
      return json(200, { drafts: [], publications: PUBLICATIONS });
    }
    // Task G: the health endpoint answers from Bot API on the server; the stand-in reports a
    // group the bot can actually send to.
    if (path === '/api/mini/groups/health') {
      return json(200, { groups: [{ id: 'g-1', health: 'ok' }] });
    }
    if (path === '/api/mini/materials') {
      const q = (url.searchParams.get('q') ?? '').trim().toLowerCase();
      const materials = q
        ? MATERIALS.filter((m) => `${m.title} ${m.fileName}`.toLowerCase().includes(q))
        : MATERIALS;
      return json(200, { materials });
    }
    if (path === '/api/mini/drafts' && request.method() === 'POST') {
      return json(201, { draft: newDraft() });
    }
    return json(404, { error: 'notFound' });
  });
  return calls;
}

async function openMini(page: Page, calls: MiniCalls): Promise<void> {
  await page.route('https://telegram.org/**', (route) => route.fulfill({
    status: 200, contentType: 'application/javascript', body: sdkScript(),
  }));
  await page.goto('/mini');
  await expect(page.getByTestId('mini-home')).toBeVisible();
  expect(calls.auth).toBe(1);
}

async function noHorizontalScroll(page: Page, where: string): Promise<void> {
  const box = await page.evaluate(() => ({
    scrollW: document.documentElement.scrollWidth,
    innerW: window.innerWidth,
  }));
  expect(box.scrollW, `горизонтальный скролл на «${where}»`).toBeLessThanOrEqual(box.innerW + 1);
}

function collectPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(String(err)));
  return errors;
}

async function tapTarget(page: Page, testId: string, where: string): Promise<void> {
  const box = await page.getByTestId(testId).boundingBox();
  expect(box, `нет кнопки ${testId} на «${where}»`).not.toBeNull();
  expect(box!.height, `цель нажатия ${testId} меньше пальца`).toBeGreaterThanOrEqual(44);
}

test.describe('Mini App navigation', () => {
  // A phone profile, not just a narrow window: mobile emulation changes the viewport meta
  // handling and hover behaviour. Edge is Chromium, which is the only engine that supports it.
  test.use({
    viewport: { width: 393, height: 851 }, hasTouch: true, isMobile: true, serviceWorkers: 'block',
  });

  test('home answers "where do I start" without scrolling and names every section', async ({ page }) => {
    const errors = collectPageErrors(page);
    const calls = await stubMini(page);
    await openMini(page, calls);

    const home = page.getByTestId('mini-home');
    // один главный поступок и точный порядок шагов — над сгибом телефона 851 px
    const cta = page.getByTestId('mini-new');
    await expect(cta).toBeVisible();
    await expect(cta).toHaveText('New homework');
    const ctaBox = await cta.boundingBox();
    expect(ctaBox!.y + ctaBox!.height).toBeLessThanOrEqual(851);
    await expect(home).toContainText('Groups → task → library → text → send');

    // счётчики — из ответа сервера, а не выдуманные
    await expect(home).toContainText('Groups: 1');
    await expect(home).toContainText('In the library: 2');
    // bootstrap carries the 12 most recent sends, so the chip says «recent», not «all time»
    await expect(home).toContainText('Recent sends: 1');
    await expect(home).toContainText(`@${BOT}`);

    for (const id of ['mini-nav-groups', 'mini-nav-materials', 'mini-nav-history']) {
      await expect(page.getByTestId(id)).toBeVisible();
      await tapTarget(page, id, 'home');
    }
    await tapTarget(page, 'mini-new', 'home');

    // токен из initData — единственный ключ: каждый вызов /api/mini несёт Bearer
    expect(calls.bearer.length).toBeGreaterThan(0);
    for (const header of calls.bearer) expect(header).toBe('Bearer e2e-mini-token');

    await noHorizontalScroll(page, 'home');
    expect(errors).toEqual([]);
  });

  test('a normal reload keeps the session and lands on the same home page', async ({ page }) => {
    const errors = collectPageErrors(page);
    const calls = await stubMini(page);
    await openMini(page, calls);

    await page.reload();
    await expect(page.getByTestId('mini-home')).toBeVisible();
    // токен уже был в sessionStorage: второй обмен initData не нужен и не должен происходить
    expect(calls.auth).toBe(1);
    expect(calls.paths.some((p) => p === 'GET /api/mini/bootstrap')).toBe(true);
    await noHorizontalScroll(page, 'home after reload');
    expect(errors).toEqual([]);
  });

  test('Groups shows the real list and gets back home', async ({ page }) => {
    const errors = collectPageErrors(page);
    const calls = await stubMini(page);
    await openMini(page, calls);

    await page.getByTestId('mini-nav-groups').click();
    const groups = page.getByTestId('mini-groups');
    await expect(groups).toBeVisible();
    await expect(groups).toContainText('Grade 7A');
    await expect(groups).toContainText('Online B2');
    await expect(groups).toContainText('connected');
    await expect(groups).toContainText('removed');
    await expect(page.getByTestId('mini-group-row-g-1')).toHaveCount(1);

    await page.getByTestId('mini-groups-home').click();
    await expect(page.getByTestId('mini-home')).toBeVisible();
    await noHorizontalScroll(page, 'groups');
    expect(errors).toEqual([]);
  });

  test('Library searches the server and its action starts a new homework', async ({ page }) => {
    const errors = collectPageErrors(page);
    const calls = await stubMini(page);
    await openMini(page, calls);

    await page.getByTestId('mini-nav-materials').click();
    await expect(page.getByTestId('mini-materials')).toBeVisible();
    await expect(page.getByTestId('mini-library-m-1')).toBeVisible();
    await expect(page.getByTestId('mini-library-m-2')).toBeVisible();
    await expect(page.getByTestId('mini-materials')).toContainText('Materials are attached inside a homework');

    // поиск уходит на сервер и сужает список; подпись «создать» остаётся на месте
    await page.getByTestId('mini-library-search').fill('work');
    await expect(page.getByTestId('mini-library-m-1')).toHaveCount(0);
    await expect(page.getByTestId('mini-library-m-2')).toBeVisible();
    expect(calls.paths.some((p) => p === 'GET /api/mini/materials?q=work')).toBe(true);

    // из раздела Library можно сразу вернуться к созданию домашнего задания
    await page.getByTestId('mini-materials-new').click();
    await expect(page.getByTestId('mini-wizard')).toBeVisible();
    await expect(page.getByTestId('mini-step-1')).toBeVisible();
    await expect(page.getByTestId('mini-step-1')).toContainText('Only your own active groups are shown');
    await expect(page.getByTestId('mini-group-g-1')).toBeVisible();
    expect(calls.paths).toContain('POST /api/mini/drafts');

    await noHorizontalScroll(page, 'library and wizard');
    expect(errors).toEqual([]);
  });

  test('a failed "New homework" in a section is reported, not swallowed', async ({ page }) => {
    const errors = collectPageErrors(page);
    const calls = await stubMini(page);
    // the stand-in server refuses to create a draft; older handlers below it stay in place
    await page.route('**/api/mini/drafts', (route) => route.request().method() === 'POST'
      ? route.fulfill({
        status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'miniUnavailable' }),
      })
      : route.fallback());
    await openMini(page, calls);

    await page.getByTestId('mini-nav-materials').click();
    await page.getByTestId('mini-materials-new').click();
    await expect(page.getByTestId('mini-materials').getByRole('alert'))
      .toContainText('temporarily unavailable');
    await expect(page.getByTestId('mini-wizard')).toHaveCount(0);
    // the action is retryable: a failed click does not leave the button disabled forever
    await expect(page.getByTestId('mini-materials-new')).toBeEnabled();

    expect(errors).toEqual([]);
  });

  test('History shows real sends and returns home', async ({ page }) => {
    const errors = collectPageErrors(page);
    const calls = await stubMini(page);
    await openMini(page, calls);

    await page.getByTestId('mini-nav-history').click();
    await expect(page.getByTestId('mini-history')).toBeVisible();
    await expect(page.getByTestId('mini-history-row')).toHaveCount(1);
    await expect(page.getByTestId('mini-history-row')).toContainText('Grade 7A');
    await expect(page.getByTestId('mini-history')).toContainText('Sent');

    await page.getByTestId('mini-history-home').click();
    await expect(page.getByTestId('mini-home')).toBeVisible();
    await noHorizontalScroll(page, 'history');
    expect(errors).toEqual([]);
  });

  test('the Telegram BackButton itself returns from a section', async ({ page }) => {
    const errors = collectPageErrors(page);
    const calls = await stubMini(page);
    await openMini(page, calls);

    await page.getByTestId('mini-nav-materials').click();
    await expect(page.getByTestId('mini-materials')).toBeVisible();
    // раздел обязан показать кнопку «назад» в хроме Telegram, а не только свою кнопку внизу
    await expect.poll(() => page.evaluate(() => (window as unknown as { __miniBackVisible?: boolean }).__miniBackVisible))
      .toBe(true);

    await page.evaluate(() => (window as unknown as { __miniBack?: () => void }).__miniBack?.());
    await expect(page.getByTestId('mini-home')).toBeVisible();
    await expect.poll(() => page.evaluate(() => (window as unknown as { __miniBackVisible?: boolean }).__miniBackVisible))
      .toBe(false);

    expect(errors).toEqual([]);
  });
});
