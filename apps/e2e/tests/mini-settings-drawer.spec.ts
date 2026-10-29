/*
 * Task G.1 (2026-10-29): настройки Mini App живут в выдвижной панели, а не в карточке на главной.
 *
 * Проверяется клиентская половина по десяти пунктам задания: панели нет на закрытой главной;
 * кнопка открывает; повторное нажатие и клик по затемнению закрывают; Escape закрывает на
 * десктопе; смена темы действительно перекрашивает; выбранный язык переживает повторное
 * открытие и перезагрузку; черновик (группы, поля, текст) не сбрасывается от настроек; на
 * телефоне это нижний лист поверх интерфейса, на десктопе — правая панель; остальная навигация
 * продолжает работать. Сервер и Telegram SDK подменяются на уровне сети: у стенда e2e нет
 * токена бота, а подпись initData и права проверяют интеграционные тесты API.
 *
 * Геометрия не придумана заново: панель повторяет уже существующий ящик заметок BluBlu
 * (`.sheet-panel`): на телефоне — снизу, от 720 px — справа шириной 380 px. Поэтому здесь же
 * фиксируются края: низ = 851, ширина = 393; на десктопе правый край = 1280, ширина = 380.
 */
import { expect, test, type Page } from '@playwright/test';

const BOT = 'classblu_bot';
const AUTH = {
  token: 'e2e-mini-token',
  expiresAt: '2030-01-01T00:00:00.000Z',
  teacher: { id: 'u-1', name: 'E2E Teacher', locale: 'en', tz: 'Asia/Tashkent' },
  bot: { username: BOT },
};

const GROUP = {
  id: 'g-1', title: 'Grade 7A', kind: 'offline', status: 'active',
  chatShort: '…7A', materialCount: 2, lastPublication: null,
};

const MATERIALS = [
  { id: 'm-1', title: 'Round-up 4', kind: 'book', fileName: 'round-up-4.pdf', fileSize: 1024, recommendedFor: [] },
];

function newDraft() {
  return {
    id: 'd-1', status: 'selecting', title: '', instruction: '', dueAt: null,
    formattedText: 'My draft text', groups: [] as { id: string; title: string; kind: string }[],
    materials: [] as { materialId: string; title: string }[],
    links: [] as { url: string; label: string }[],
    warnings: [] as string[], questions: [] as string[], provider: '', lastError: '',
    canEdit: true, canPublish: false, canRetry: false, publications: [] as unknown[],
    createdAt: '2026-10-29T08:00:00.000Z', updatedAt: '2026-10-29T08:00:00.000Z',
    publishedAt: null,
  };
}

interface MiniState {
  /** the teacher's locale on the SERVER: POST /api/mini/locale persists it, bootstrap reads it back */
  locale: string;
  draft: ReturnType<typeof newDraft>;
}

function state(): MiniState {
  return { locale: 'en', draft: newDraft() };
}

function bootstrap(st: MiniState) {
  return {
    teacher: { name: 'E2E Teacher', locale: st.locale, tz: 'Asia/Tashkent' },
    groups: [GROUP],
    drafts: [],
    publications: [],
    materialsCount: MATERIALS.length,
    limits: { groups: 10, materials: 8, links: 5, title: 120, instruction: 4000, text: 4000, items: 50 },
    ai: { remote: false },
    bot: { username: BOT },
    legal: {
      accepted: true, privacyVersion: '2026-10-29', termsVersion: '2026-10-29',
      currentPrivacyVersion: '2026-10-29', currentTermsVersion: '2026-10-29',
      acceptedAt: '2026-10-29T08:00:00.000Z', locale: st.locale,
    },
    links: { privacy: 'https://blublu.example/privacy', terms: 'https://blublu.example/terms' },
  };
}

/**
 * The honest Telegram chrome: BackButton records its callback and whether it is visible, the
 * MainButton records text/visibility, `themeChanged` is callable. This is exactly what the page
 * may rely on inside a real client.
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
    MainButton: {
      text: '', visible: false, enabled: false,
      show() { this.visible = true; }, hide() { this.visible = false; },
      enable() { this.enabled = true; }, disable() { this.enabled = false; },
      setText(t) { this.text = t; window.__miniMainText = t; },
      onClick(cb) { window.__miniMain = cb; },
      offClick(cb) { if (window.__miniMain === cb) window.__miniMain = null; }
    },
    HapticFeedback: { impactOccurred() {}, notificationOccurred() {}, selectionChanged() {} },
    setHeaderColor() {}, setBackgroundColor() {}
  } };`;
}

/** Every `/api/mini/**` answer these screens may ask for, with the server's own shapes. */
async function stubMini(page: Page, st: MiniState): Promise<string[]> {
  const paths: string[] = [];
  await page.route('**/api/mini/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    paths.push(`${method} ${path}`);
    const json = (status: number, body: unknown) => route.fulfill({
      status, contentType: 'application/json', body: JSON.stringify(body),
    });
    const body = (): Record<string, unknown> => {
      try { return JSON.parse(request.postData() ?? '{}') as Record<string, unknown>; } catch { return {}; }
    };

    if (path === '/api/mini/auth' && method === 'POST') return json(200, AUTH);
    if (path === '/api/mini/bootstrap') return json(200, bootstrap(st));
    if (path === '/api/mini/locale' && method === 'POST') {
      st.locale = String(body().locale ?? st.locale);
      return json(200, { ok: true, locale: st.locale });
    }
    if (path === '/api/mini/materials' && method === 'GET') return json(200, { materials: MATERIALS });

    if (path === '/api/mini/drafts' && method === 'POST') return json(201, { draft: st.draft });
    if (path === '/api/mini/drafts/d-1' && method === 'PATCH') {
      const b = body();
      if (typeof b.title === 'string') st.draft.title = b.title;
      if (typeof b.instruction === 'string') st.draft.instruction = b.instruction;
      if (typeof b.formattedText === 'string') st.draft.formattedText = b.formattedText;
      return json(200, { draft: st.draft });
    }
    if (path === '/api/mini/drafts/d-1/groups' && method === 'PUT') {
      const ids = Array.isArray(body().groupIds) ? (body().groupIds as string[]) : [];
      st.draft.groups = ids.map((id) => ({ id, title: id === 'g-1' ? 'Grade 7A' : id, kind: 'offline' }));
      return json(200, { draft: st.draft, droppedMaterials: [] });
    }
    if (path === '/api/mini/drafts/d-1/materials' && method === 'GET') {
      return json(200, { materials: MATERIALS });
    }
    if (path === '/api/mini/drafts/d-1/materials' && method === 'PUT') {
      const ids = Array.isArray(body().materialIds) ? (body().materialIds as string[]) : [];
      st.draft.materials = ids.map((id) => ({ materialId: id, title: id }));
      return json(200, { draft: st.draft });
    }
    return json(404, { error: 'notFound' });
  });
  return paths;
}

async function openMini(page: Page, st: MiniState): Promise<string[]> {
  await page.route('https://telegram.org/**', (route) => route.fulfill({
    status: 200, contentType: 'application/javascript', body: sdkScript(),
  }));
  const paths = await stubMini(page, st);
  await page.goto('/mini');
  await expect(page.getByTestId('mini-home')).toBeVisible();
  return paths;
}

function collectPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(String(err)));
  return errors;
}

async function openDrawer(page: Page): Promise<void> {
  await page.getByTestId('mini-settings-open').click();
  await expect(page.getByTestId('mini-settings')).toBeVisible();
  await settled(page);
}

/**
 * The panel slides in for 180 ms. Geometry must be read on the settled frame: measuring
 * mid-animation reports an edge 0–24 px outside the viewport, which is the animation, not
 * the layout. A user's first painted frame is the same panel, just translated.
 */
async function settled(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-testid="mini-settings"]');
    return Boolean(el) && el.getAnimations().every((a) => a.playState === 'finished');
  });
}

async function themeState(page: Page) {
  return page.evaluate(() => ({
    theme: document.documentElement.dataset.theme,
    source: document.documentElement.dataset.themeSource ?? '',
    stored: localStorage.getItem('klass_theme'),
  }));
}

/** The painted surface of the Mini App — the thing a theme change must actually alter. */
async function appBackground(page: Page): Promise<{ r: number; g: number; b: number }> {
  return page.evaluate(() => {
    const raw = getComputedStyle(document.querySelector('.mini-app')!).backgroundColor;
    const [r, g, b] = raw.replace(/[^0-9.,]/g, '').split(',').map(Number);
    return { r, g, b };
  });
}

/** Page geometry that a fixed overlay must not disturb: the CTA position and total height. */
async function pageMetrics(page: Page) {
  return page.evaluate(() => {
    const cta = document.querySelector('[data-testid="mini-new"]')!.getBoundingClientRect();
    return { ctaY: cta.y, scrollHeight: document.documentElement.scrollHeight };
  });
}

async function scrollLock(page: Page) {
  return page.evaluate(() => ({
    html: document.documentElement.style.overflow,
    body: document.body.style.overflow,
  }));
}

/** One tap on the real Telegram MainButton. */
async function tapMain(page: Page): Promise<void> {
  await page.evaluate(() => (window as unknown as { __miniMain?: () => void }).__miniMain?.());
}

async function mainButton(page: Page) {
  return page.evaluate(() => {
    const mb = (window as unknown as {
      Telegram: { WebApp: { MainButton?: { visible: boolean; text: string } } };
    }).Telegram.WebApp.MainButton;
    return { visible: Boolean(mb?.visible), text: mb?.text ?? '' };
  });
}

async function backButtonVisible(page: Page): Promise<boolean> {
  return page.evaluate(() => Boolean((window as unknown as { __miniBackVisible?: boolean }).__miniBackVisible));
}

test.describe('Mini App settings drawer — phone', () => {
  test.use({
    viewport: { width: 393, height: 851 }, hasTouch: true, isMobile: true, serviceWorkers: 'block',
  });

  test('closed by default: one icon opens a bottom sheet; the same icon, the backdrop and the Telegram Back close it', async ({ page }) => {
    const errors = collectPageErrors(page);
    const st = state();
    await openMini(page, st);

    // 1. Закрытая главная: карточки настроек нет ни в каком виде, панели и затемнения нет.
    await expect(page.getByTestId('mini-settings')).toHaveCount(0);
    await expect(page.getByTestId('mini-settings-backdrop')).toHaveCount(0);
    await expect(page.getByTestId('mini-settings-inline')).toHaveCount(0);

    const button = page.getByRole('button', { name: 'Settings' });
    await expect(button).toBeVisible();
    await expect(button).toHaveAttribute('aria-expanded', 'false');
    const tap = (await button.boundingBox())!;
    expect(tap.width).toBeGreaterThanOrEqual(44);
    expect(tap.height).toBeGreaterThanOrEqual(44);

    const before = await pageMetrics(page);

    // 2. Кнопка открывает ровно одну панель с обеими настройками.
    await button.click();
    const panel = page.getByTestId('mini-settings');
    await expect(panel).toBeVisible();
    await settled(page);
    await expect(panel).toHaveAttribute('role', 'dialog');
    await expect(page.getByTestId('mini-settings-title')).toHaveText('Settings');
    await expect(button).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByTestId('mini-settings-backdrop')).toBeVisible();
    await expect(page.getByTestId('mini-settings')).toHaveCount(1);
    await expect(page.getByTestId('mini-theme-system')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('mini-lang-en')).toHaveAttribute('aria-pressed', 'true');

    // Телефон: нижний лист во всю ширину, прижат к нижнему краю, не выше 80 % экрана.
    const box = (await panel.boundingBox())!;
    expect(Math.round(box.width)).toBe(393);
    expect(box.x).toBeLessThanOrEqual(0.5);
    expect(Math.abs(box.y + box.height - 851)).toBeLessThanOrEqual(1);
    expect(box.height).toBeLessThanOrEqual(641);

    // 4. Панель лежит поверх интерфейса и не растит страницу: CTA и высота не сдвинулись.
    const opened = await pageMetrics(page);
    expect(Math.abs(opened.ctaY - before.ctaY)).toBeLessThanOrEqual(1);
    expect(opened.scrollHeight).toBe(before.scrollHeight);
    expect(await scrollLock(page)).toEqual({ html: 'hidden', body: 'hidden' });

    // 3. Повторное нажатие той же кнопки (она над затемнением) закрывает панель.
    await button.click();
    await expect(page.getByTestId('mini-settings')).toHaveCount(0);
    await expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(await scrollLock(page)).toEqual({ html: '', body: '' });
    expect((await pageMetrics(page)).scrollHeight).toBe(before.scrollHeight);

    // 4. Клик по затемнению закрывает.
    await button.click();
    await expect(page.getByTestId('mini-settings')).toBeVisible();
    await page.getByTestId('mini-settings-backdrop').click({ position: { x: 20, y: 40 } });
    await expect(page.getByTestId('mini-settings')).toHaveCount(0);
    await expect(button).toHaveAttribute('aria-expanded', 'false');

    // Telegram BackButton совместим: пока панель открыта, он виден и закрывает её.
    await button.click();
    await expect.poll(() => backButtonVisible(page)).toBe(true);
    await page.evaluate(() => (window as unknown as { __miniBack?: () => void }).__miniBack?.());
    await expect(page.getByTestId('mini-settings')).toHaveCount(0);
    await expect.poll(() => backButtonVisible(page)).toBe(false);

    // 10. После закрытия приложение работает дальше: дверь в библиотеку открывается.
    await page.getByTestId('mini-nav-materials').click();
    await expect(page.getByTestId('mini-materials')).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('Light and Dark really repaint the app, and the choice is selected again when reopened', async ({ page }) => {
    const errors = collectPageErrors(page);
    const st = state();
    await openMini(page, st);

    // «System» на тёмной теме Telegram — тёмный фон, а не догадка об ОС.
    expect(await themeState(page)).toEqual({ theme: 'dark', source: 'telegram', stored: null });
    const dark = await appBackground(page);
    expect((dark.r + dark.g + dark.b) / 3).toBeLessThan(60);

    await openDrawer(page);
    await page.getByTestId('mini-theme-light').click();
    expect(await themeState(page)).toEqual({ theme: 'light', source: '', stored: 'light' });
    const light = await appBackground(page);
    // 6. Смена темы — это пиксели, а не только атрибут: фон действительно посветлел.
    expect((light.r + light.g + light.b) / 3).toBeGreaterThan(200);

    await page.getByTestId('mini-settings-close').click();
    await expect(page.getByTestId('mini-settings')).toHaveCount(0);

    // 7. Повторное открытие показывает выбор, а не сбрасывает на «System».
    await openDrawer(page);
    await expect(page.getByTestId('mini-theme-light')).toHaveAttribute('aria-pressed', 'true');
    await page.getByTestId('mini-theme-dark').click();
    expect(await themeState(page)).toEqual({ theme: 'dark', source: '', stored: 'dark' });
    const backToDark = await appBackground(page);
    expect((backToDark.r + backToDark.g + backToDark.b) / 3).toBeLessThan(60);
    expect(errors).toEqual([]);
  });

  test('the language choice survives closing the drawer and a reload', async ({ page }) => {
    const errors = collectPageErrors(page);
    const st = state();
    await openMini(page, st);
    await expect(page.getByTestId('mini-home')).toContainText('Homework');

    await openDrawer(page);
    await page.getByTestId('mini-lang-ru').click();
    await expect(page.getByTestId('mini-settings-title')).toHaveText('Настройки');
    await expect(page.getByTestId('mini-lang-ru')).toHaveAttribute('aria-pressed', 'true');
    // Выбор записан и на устройстве, и на сервере — иначе после перезагрузки он бы пропал.
    expect(await page.evaluate(() => localStorage.getItem('klass_locale'))).toBe('ru');
    expect(st.locale).toBe('ru');

    await page.getByTestId('mini-settings-close').click();
    await expect(page.getByTestId('mini-settings')).toHaveCount(0);
    await expect(page.getByTestId('mini-home')).toContainText('Домашние задания');

    // 7. Повторное открытие: выбран именно русский, панель уже на русском.
    await openDrawer(page);
    await expect(page.getByTestId('mini-settings-title')).toHaveText('Настройки');
    await expect(page.getByTestId('mini-lang-ru')).toHaveAttribute('aria-pressed', 'true');

    // И перезагрузка: bootstrap сервера возвращает сохранённый язык.
    await page.reload();
    await expect(page.getByTestId('mini-home')).toBeVisible();
    await expect(page.getByTestId('mini-home')).toContainText('Домашние задания');
    await openDrawer(page);
    await expect(page.getByTestId('mini-lang-ru')).toHaveAttribute('aria-pressed', 'true');
    expect(errors).toEqual([]);
  });

  test('settings mid-draft keep the step, the fields and the groups; the native action waits', async ({ page }) => {
    const errors = collectPageErrors(page);
    const st = state();
    await openMini(page, st);

    // 8. Черновик: группа, поля шага 2 и текст шага 4 — до открытия настроек.
    await page.getByTestId('mini-new').click();
    await expect(page.getByTestId('mini-step-1')).toBeVisible();
    await page.getByTestId('mini-group-g-1').check();
    await tapMain(page);
    await expect(page.getByTestId('mini-step-2')).toBeVisible();
    await page.getByTestId('mini-title').fill('Unit 4');
    await page.getByTestId('mini-instruction').fill('Read the text');
    await tapMain(page);
    await expect(page.getByTestId('mini-step-3')).toBeVisible();
    await expect(page.getByTestId('mini-material-m-1')).toBeVisible();
    await tapMain(page);
    await expect(page.getByTestId('mini-step-4')).toBeVisible();
    await page.getByTestId('mini-text').fill('Teacher words');
    await expect.poll(async () => (await mainButton(page)).text).toBe('Next');

    await openDrawer(page);
    // Пока лист открыт, нативная главная кнопка не может отправить или перелистнуть шаг.
    await expect.poll(async () => (await mainButton(page)).visible).toBe(false);

    await page.getByTestId('mini-theme-light').click();
    await page.getByTestId('mini-lang-ru').click();
    await expect(page.getByTestId('mini-settings-title')).toHaveText('Настройки');

    await page.getByTestId('mini-settings-backdrop').click({ position: { x: 12, y: 30 } });
    await expect(page.getByTestId('mini-settings')).toHaveCount(0);

    // Тот же шаг, тот же текст; заголовок уже на выбранном языке.
    await expect(page.getByTestId('mini-step-4')).toBeVisible();
    await expect(page.getByTestId('mini-text')).toHaveValue('Teacher words');
    await expect(page.getByTestId('mini-wizard')).toContainText('Текст');
    await expect.poll(async () => (await mainButton(page)).visible).toBe(true);
    await expect.poll(async () => (await mainButton(page)).text).toBe('Далее');

    // Поля и группы на месте: шаг назад ничего не теряет.
    await page.getByTestId('mini-back').click();
    await expect(page.getByTestId('mini-step-3')).toBeVisible();
    await page.getByTestId('mini-back').click();
    await expect(page.getByTestId('mini-step-2')).toBeVisible();
    await expect(page.getByTestId('mini-title')).toHaveValue('Unit 4');
    await expect(page.getByTestId('mini-instruction')).toHaveValue('Read the text');
    await page.getByTestId('mini-back').click();
    await expect(page.getByTestId('mini-step-1')).toBeVisible();
    await expect(page.getByTestId('mini-group-g-1')).toBeChecked();

    // Нативный Back на мастере закрывает панель, а не шаг.
    await openDrawer(page);
    await page.evaluate(() => (window as unknown as { __miniBack?: () => void }).__miniBack?.());
    await expect(page.getByTestId('mini-settings')).toHaveCount(0);
    await expect(page.getByTestId('mini-step-1')).toBeVisible();
    expect(errors).toEqual([]);
  });
});

test.describe('Mini App settings drawer — desktop', () => {
  test.use({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });

  test('a fixed right-hand panel of the BluBlu drawer width; Escape closes and focus returns', async ({ page }) => {
    const errors = collectPageErrors(page);
    const st = state();
    await openMini(page, st);
    const before = await pageMetrics(page);

    const button = page.getByRole('button', { name: 'Settings' });
    await button.click();
    const panel = page.getByTestId('mini-settings');
    await expect(panel).toBeVisible();
    await settled(page);

    // 9. Десктоп: не карточка в потоке, а правая панель — 380 px, правый край прижат к окну.
    const box = (await panel.boundingBox())!;
    expect(Math.round(box.width)).toBe(380);
    expect(Math.abs(box.x + box.width - 1280)).toBeLessThanOrEqual(1);
    expect(Math.abs(box.y - 64)).toBeLessThanOrEqual(1);
    const opened = await pageMetrics(page);
    expect(Math.abs(opened.ctaY - before.ctaY)).toBeLessThanOrEqual(1);
    expect(opened.scrollHeight).toBe(before.scrollHeight);

    // Обе настройки целиком внутри панели, ничего не обрезано.
    await expect(page.getByTestId('mini-theme-dark')).toBeVisible();
    await expect(page.getByTestId('mini-lang-ru')).toBeVisible();

    // 5. Escape закрывает на десктопе и возвращает фокус на кнопку, открывшую панель.
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('mini-settings')).toHaveCount(0);
    await expect(button).toHaveAttribute('aria-expanded', 'false');
    await expect(button).toBeFocused();
    expect(await scrollLock(page)).toEqual({ html: '', body: '' });
    expect(errors).toEqual([]);
  });
});
