/*
 * Task G (2026-10-29): the Mini App surfaces added in this phase, seen from a phone.
 *
 * Scope of this file is the CLIENT half: what the page does with the server's answers. The
 * signatures, the 403 policy gate, the real Telegram delivery, the real `/bind` update and the
 * AI provider live in `apps/api/test/integration/task-g-mini.test.ts`; here the network is
 * replaced with the same shapes so the browser can be checked without a bot token.
 *
 * The SDK stub is the honest part of Telegram a phone has: a BackButton, a MainButton and a
 * `themeChanged` event. Every test starts from a cold browser profile, so `klass_theme` and
 * `sessionStorage` begin empty exactly like a first launch.
 */
import { expect, test, type Page } from '@playwright/test';

const BOT = 'classblu_bot';
const AUTH = {
  token: 'e2e-mini-token',
  expiresAt: '2030-01-01T00:00:00.000Z',
  teacher: { id: 'u-1', name: 'E2E Teacher', locale: 'en', tz: 'Asia/Tashkent' },
  bot: { username: BOT },
};

const MATERIALS = [
  { id: 'm-1', title: 'Round-up 4', kind: 'book', fileName: 'round-up-4.pdf', fileSize: 1024, recommendedFor: [] },
  { id: 'm-2', title: 'Workbook 4', kind: 'workbook', fileName: 'workbook-4.pdf', fileSize: 2048, recommendedFor: [] },
];

interface StubState {
  /** has the server recorded acceptance of the CURRENT documents? */
  accepted: boolean;
  /** did the group connection complete on the Telegram side? */
  connected: boolean;
  /** has the upload created a library row? */
  uploaded: boolean;
  uploadCalls: number;
  formatCalls: number;
  connectPolls: number;
  /** the second connection attempt is refused by the group limit */
  connectLimit: boolean;
  accepts: { privacyVersion: string; termsVersion: string }[];
}

function state(over: Partial<StubState> = {}): StubState {
  return {
    accepted: true, connected: false, uploaded: false,
    uploadCalls: 0, formatCalls: 0, connectPolls: 0, connectLimit: false,
    accepts: [], ...over,
  };
}

function legal(st: StubState) {
  return {
    accepted: st.accepted,
    privacyVersion: st.accepted ? '2026-10-29' : '',
    termsVersion: st.accepted ? '2026-10-29' : '',
    currentPrivacyVersion: '2026-10-29',
    currentTermsVersion: '2026-10-29',
    acceptedAt: st.accepted ? '2026-10-29T08:00:00.000Z' : null,
    locale: st.accepted ? 'en' : null,
  };
}

function groups(st: StubState) {
  const list = [{
    id: 'g-1', title: 'Grade 7A', kind: 'offline', status: 'active',
    chatShort: '…7A', materialCount: 2, lastPublication: null,
  }];
  if (st.connected) {
    list.push({
      id: 'g-2', title: 'Grade 8B', kind: 'online', status: 'active',
      chatShort: '…8B', materialCount: 0, lastPublication: null,
    });
  }
  return list;
}

function bootstrap(st: StubState) {
  return {
    teacher: { name: 'E2E Teacher', locale: 'en', tz: 'Asia/Tashkent' },
    groups: st.accepted ? groups(st) : [],
    drafts: [],
    publications: [],
    materialsCount: st.accepted ? MATERIALS.length : 0,
    limits: { groups: 10, materials: 8, links: 5, title: 120, instruction: 4000, text: 4000, items: 50 },
    ai: { remote: true },
    bot: { username: BOT },
    legal: legal(st),
    links: { privacy: 'https://blublu.example/privacy', terms: 'https://blublu.example/terms' },
  };
}

function draft(over: Record<string, unknown> = {}) {
  return {
    id: 'd-1', status: 'collecting', title: '', instruction: 'Read unit 4', dueAt: null,
    formattedText: 'My draft text',
    groups: [{ id: 'g-1', title: 'Grade 7A', kind: 'offline' }],
    materials: [], links: [], warnings: [], questions: [], provider: '', lastError: '',
    canEdit: true, canPublish: false, canRetry: false, publications: [],
    createdAt: '2026-10-29T08:00:00.000Z', updatedAt: '2026-10-29T08:00:00.000Z',
    publishedAt: null, ...over,
  };
}

/**
 * `mainButton: true` is the current Telegram client (MainButton is the only primary action);
 * `false` imitates an old client where the page must draw its own button — exactly once.
 */
function sdkScript(mainButton: boolean): string {
  return `window.__miniBack = null; window.__miniMain = null; window.__miniMainText = '';
  window.__tgThemeChange = null;
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
    BackButton: { show() {}, hide() {}, onClick() {}, offClick() {} },
    ${mainButton ? `MainButton: { text: '', show() {}, hide() {}, enable() {}, disable() {},
      setText(t) { window.__miniMainText = t; },
      onClick(cb) { window.__miniMain = cb; },
      offClick(cb) { if (window.__miniMain === cb) window.__miniMain = null; } },` : ''}
    HapticFeedback: { impactOccurred() {}, notificationOccurred() {}, selectionChanged() {} },
    setHeaderColor() {}, setBackgroundColor() {}
  } };`;
}

async function stubMini(page: Page, st: StubState): Promise<string[]> {
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
    if (path === '/api/mini/locale' && method === 'POST') return json(200, { ok: true, locale: 'en' });
    if (path === '/api/mini/accept-legal' && method === 'POST') {
      st.accepts.push(body() as unknown as { privacyVersion: string; termsVersion: string });
      st.accepted = true;
      return json(200, { ok: true, legal: legal(st) });
    }
    if (path === '/api/mini/groups/health') {
      return json(200, {
        groups: groups(st).map((g) => ({ id: g.id, health: 'ok' })),
      });
    }
    if (path === '/api/mini/groups/connect' && method === 'POST') {
      if (st.connectLimit) return json(400, { error: 'groupsLimit' });
      return json(201, {
        connect: {
          id: 'c-1', code: 'ABC123', expiresAt: '2026-10-29T09:00:00.000Z',
          botUsername: BOT, botLink: `https://t.me/${BOT}`,
        },
      });
    }
    if (path === '/api/mini/groups/connect/c-1') {
      st.connectPolls++;
      // The stand-in Telegram group spends the code between the first and the second poll, so
      // the screen has to show «pending» before it may show «connected».
      if (st.connectPolls < 2) return json(200, { status: 'pending', id: 'c-1', expiresAt: '2026-10-29T09:00:00.000Z' });
      st.connected = true;
      return json(200, {
        status: 'connected', id: 'c-1', group: { id: 'g-2', title: 'Grade 8B' }, health: 'ok',
      });
    }
    if (path === '/api/mini/materials' && method === 'GET') {
      const q = (url.searchParams.get('q') ?? '').trim().toLowerCase();
      const all = st.uploaded
        ? [...MATERIALS, {
          id: 'm-9', title: 'Round-up 4 (uploaded)', kind: 'book',
          fileName: 'round-up-4.pdf', fileSize: 11, recommendedFor: [],
        }]
        : MATERIALS;
      return json(200, { materials: q ? all.filter((m) => `${m.title} ${m.fileName}`.toLowerCase().includes(q)) : all });
    }
    if (path === '/api/mini/materials/upload' && method === 'POST') {
      st.uploadCalls++;
      if (st.uploadCalls === 1) return json(415, { error: 'unsupportedFile' });
      st.uploaded = true;
      return json(201, {
        material: {
          id: 'm-9', title: 'Round-up 4', kind: 'book', fileName: 'round-up-4.pdf',
          fileSize: 11, mediaType: 'application/pdf',
        },
        draft: null, draftAttached: false, replaced: false,
      });
    }
    if (path === '/api/mini/drafts' && method === 'POST') return json(201, { draft: draft() });
    if (path === '/api/mini/drafts/d-1' && method === 'GET') return json(200, { draft: draft() });
    if (path === '/api/mini/drafts/d-1' && method === 'PATCH') {
      const b = body();
      return json(200, {
        draft: draft({
          title: typeof b.title === 'string' ? b.title : '',
          instruction: typeof b.instruction === 'string' ? b.instruction : '',
          formattedText: typeof b.formattedText === 'string' ? b.formattedText : 'My draft text',
        }),
      });
    }
    if (path === '/api/mini/drafts/d-1/groups' && method === 'PUT') {
      return json(200, { draft: draft(), droppedMaterials: [] });
    }
    if (path === '/api/mini/drafts/d-1/materials' && method === 'GET') {
      return json(200, { materials: MATERIALS });
    }
    if (path === '/api/mini/drafts/d-1/materials' && method === 'PUT') {
      return json(200, { draft: draft() });
    }
    if (path === '/api/mini/drafts/d-1/format' && method === 'POST') {
      st.formatCalls++;
      // The real server answers a provider failure exactly like this: nothing is saved, the
      // teacher's text is untouched, and a plain version is offered as a separate decision.
      return json(502, { error: 'aiUnavailable', fallback: 'Plain unit 4 text.' });
    }
    return json(404, { error: 'notFound' });
  });
  return paths;
}

async function openMini(page: Page, st: StubState, opts: { mainButton?: boolean } = {}): Promise<string[]> {
  await page.route('https://telegram.org/**', (route) => route.fulfill({
    status: 200, contentType: 'application/javascript', body: sdkScript(opts.mainButton !== false),
  }));
  const paths = await stubMini(page, st);
  await page.goto('/mini');
  return paths;
}

/** Reads a CSS custom property from <html>; '' means «Telegram colour removed». */
async function cssVar(page: Page, name: string): Promise<string> {
  return page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);
}

async function themeState(page: Page) {
  return page.evaluate(() => ({
    theme: document.documentElement.dataset.theme,
    source: document.documentElement.dataset.themeSource ?? '',
    stored: localStorage.getItem('klass_theme'),
  }));
}

test.describe('Mini App Task G surfaces', () => {
  test.use({
    viewport: { width: 393, height: 851 }, hasTouch: true, isMobile: true, serviceWorkers: 'block',
  });

  test('the legal gate opens no functional view until the server records acceptance', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(String(err)));
    const st = state({ accepted: false });
    const paths = await openMini(page, st);

    await expect(page.getByTestId('mini-legal')).toBeVisible();
    // No home and no sections behind the gate: a direct URL cannot jump ahead.
    await expect(page.getByTestId('mini-home')).toHaveCount(0);
    await expect(page.getByTestId('mini-legal-privacy'))
      .toHaveAttribute('href', 'https://blublu.example/privacy');
    await expect(page.getByTestId('mini-legal-terms'))
      .toHaveAttribute('href', 'https://blublu.example/terms');
    await expect(page.getByTestId('mini-legal')).toContainText('Policy: 2026-10-29 · Terms: 2026-10-29');

    const accept = page.getByTestId('mini-legal-accept');
    await expect(accept).toBeDisabled();
    await page.getByTestId('mini-legal-check').check();
    await expect(accept).toBeEnabled();
    await accept.click();

    await expect(page.getByTestId('mini-home')).toBeVisible();
    expect(st.accepts).toEqual([{ privacyVersion: '2026-10-29', termsVersion: '2026-10-29' }]);
    // Nothing functional was attempted before the acceptance was stored.
    expect(paths.filter((p) => p === 'POST /api/mini/drafts')).toEqual([]);
    expect(errors).toEqual([]);
  });

  test('System follows Telegram and themeChanged; Light/Dark persist and win', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(String(err)));
    const st = state();
    await openMini(page, st);
    await expect(page.getByTestId('mini-home')).toBeVisible();

    // The default is «System»: inside Telegram that means Telegram's own dark theme.
    expect(await themeState(page)).toEqual({ theme: 'dark', source: 'telegram', stored: null });
    expect(await cssVar(page, '--tg-bg')).toBe('#101010');

    await page.getByTestId('mini-theme-light').click();
    expect(await themeState(page)).toEqual({ theme: 'light', source: '', stored: 'light' });
    // The Telegram inline colours are removed, so they cannot leak into an explicit theme.
    expect(await cssVar(page, '--tg-bg')).toBe('');

    await page.reload();
    await expect(page.getByTestId('mini-home')).toBeVisible();
    expect(await themeState(page)).toEqual({ theme: 'light', source: '', stored: 'light' });

    await page.getByTestId('mini-theme-system').click();
    expect(await themeState(page)).toEqual({ theme: 'dark', source: 'telegram', stored: 'system' });

    // Telegram announces a theme change; «System» must repaint immediately.
    await page.evaluate(() => {
      const wa = (window as unknown as {
        Telegram: { WebApp: { colorScheme: string; themeParams: Record<string, string> } };
      }).Telegram.WebApp;
      wa.colorScheme = 'light';
      wa.themeParams.bg_color = '#fafafa';
      wa.themeParams.text_color = '#111111';
      (window as unknown as { __tgThemeChange?: () => void }).__tgThemeChange?.();
    });
    expect((await themeState(page)).theme).toBe('light');
    expect(await cssVar(page, '--tg-bg')).toBe('#fafafa');

    // An explicit choice must survive the same event.
    await page.getByTestId('mini-theme-dark').click();
    await page.evaluate(() => (window as unknown as { __tgThemeChange?: () => void }).__tgThemeChange?.());
    expect(await themeState(page)).toEqual({ theme: 'dark', source: '', stored: 'dark' });
    expect(errors).toEqual([]);
  });

  test('with the Telegram MainButton there is no second primary action', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(String(err)));
    const st = state();
    await openMini(page, st, { mainButton: true });
    await page.getByTestId('mini-new').click();
    await expect(page.getByTestId('mini-wizard')).toBeVisible();
    await expect(page.getByTestId('mini-step-1')).toBeVisible();

    // The exact defect the brief names: two identical primary buttons.
    await expect(page.getByTestId('mini-next')).toHaveCount(0);
    await expect(page.getByTestId('mini-publish')).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => (window as unknown as { __miniMainText?: string }).__miniMainText))
      .toBe('Next');

    // One tap on the real MainButton advances the wizard.
    await page.evaluate(() => (window as unknown as { __miniMain?: () => void }).__miniMain?.());
    await expect(page.getByTestId('mini-step-2')).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('without MainButton the page draws exactly one Next and it works', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(String(err)));
    const st = state();
    await openMini(page, st, { mainButton: false });
    await page.getByTestId('mini-new').click();
    await expect(page.getByTestId('mini-step-1')).toBeVisible();

    await expect(page.getByTestId('mini-next')).toHaveCount(1);
    await expect(page.getByTestId('mini-next')).toHaveText('Next');
    await page.getByTestId('mini-next').click();
    await expect(page.getByTestId('mini-step-2')).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('upload keeps the file on refusal and retries it exactly once', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(String(err)));
    const st = state();
    await openMini(page, st);
    await page.getByTestId('mini-nav-materials').click();
    await expect(page.getByTestId('mini-materials')).toBeVisible();
    await expect(page.getByTestId('mini-upload')).toBeVisible();
    await expect(page.getByTestId('mini-upload-group-g-1')).toBeChecked();

    await page.getByTestId('mini-upload-file').setInputFiles({
      name: 'book.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n%%EOF\n'),
    });
    await expect(page.getByTestId('mini-upload-file-name')).toContainText('book.pdf');
    await page.getByTestId('mini-upload-title').fill('Round-up 4');
    await page.getByTestId('mini-upload-start').click();

    await expect(page.getByTestId('mini-upload-error'))
      .toHaveText('This file type is not supported. Upload a PDF, a document, an image, audio or video.');
    // The file was not thrown away: the teacher can retry without picking it again.
    await expect(page.getByTestId('mini-upload-file-name')).toContainText('book.pdf');
    await expect(page.getByTestId('mini-upload-start')).toHaveText('Retry upload');

    // A double tap must still send one request; the second call sees the same file.
    await page.evaluate(() => {
      const button = document.querySelector('[data-testid="mini-upload-start"]') as HTMLButtonElement | null;
      button?.click();
      button?.click();
    });
    await expect(page.getByTestId('mini-upload-done')).toContainText('was added to the library');
    expect(st.uploadCalls).toBe(2);
    // The new library row is fetched from the server, not appended optimistically.
    await expect(page.getByTestId('mini-library-m-9')).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('connect: pending → connected, health from Bot API, group appears, limit is a sentence', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(String(err)));
    const st = state();
    await openMini(page, st);
    await page.getByTestId('mini-nav-groups').click();
    await expect(page.getByTestId('mini-groups')).toBeVisible();
    await expect(page.getByTestId('mini-group-health')).toHaveAttribute('data-health', 'ok');

    await page.getByTestId('mini-connect-start').click();
    await expect(page.getByTestId('mini-connect-code-value')).toHaveText('ABC123');
    await expect(page.getByTestId('mini-connect-steps')).toContainText(`/bind ABC123`);
    await expect(page.getByTestId('mini-connect-open-bot')).toHaveAttribute('href', `https://t.me/${BOT}`);
    await expect(page.getByTestId('mini-connect-waiting')).toBeVisible();

    // The first answer is «pending»; only the second may say «connected».
    await expect(page.getByTestId('mini-connect-done')).toContainText('Grade 8B', { timeout: 15_000 });
    await expect(page.getByTestId('mini-connect-done')).toContainText('The bot’s rights were checked: all good.');
    expect(st.connectPolls).toBeGreaterThanOrEqual(2);
    // The group reached the list from a fresh bootstrap, i.e. from server data.
    await expect(page.getByTestId('mini-group-row-g-2')).toBeVisible();

    st.connectLimit = true;
    await page.getByTestId('mini-connect-start').click();
    await expect(page.getByTestId('mini-connect').getByRole('alert'))
      .toHaveText('The group limit has been reached.');
    expect(errors).toEqual([]);
  });

  test('AI failure keeps the text, offers a plain version, never retries silently', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(String(err)));
    const st = state();
    await openMini(page, st);
    await page.getByTestId('mini-new').click();
    await expect(page.getByTestId('mini-step-1')).toBeVisible();

    // MainButton is the single primary action; it moves the wizard screen by screen.
    await page.evaluate(() => (window as unknown as { __miniMain?: () => void }).__miniMain?.());
    await expect(page.getByTestId('mini-step-2')).toBeVisible();
    await page.evaluate(() => (window as unknown as { __miniMain?: () => void }).__miniMain?.());
    await expect(page.getByTestId('mini-step-3')).toBeVisible();
    await page.evaluate(() => (window as unknown as { __miniMain?: () => void }).__miniMain?.());
    await expect(page.getByTestId('mini-step-4')).toBeVisible();

    await expect(page.getByTestId('mini-ai-status')).toContainText('AI is connected on the server');
    const textarea = page.getByTestId('mini-text');
    await expect(textarea).toHaveValue('My draft text');

    await page.getByTestId('mini-format-ai').click();
    await expect(page.getByTestId('mini-ai-fallback')).toBeVisible();
    // The request failed — the teacher's text is exactly as it was.
    await expect(textarea).toHaveValue('My draft text');
    await expect(page.getByTestId('mini-ai-fallback')).toContainText('Plain unit 4 text.');
    expect(st.formatCalls).toBe(1);
    await page.waitForTimeout(1_500);
    expect(st.formatCalls).toBe(1);

    await page.getByTestId('mini-ai-use-fallback').click();
    await expect(textarea).toHaveValue('Plain unit 4 text.');
    await expect(page.getByTestId('mini-ai-restore')).toHaveCount(1);
    await page.getByTestId('mini-ai-restore').click();
    await expect(textarea).toHaveValue('My draft text');
    expect(errors).toEqual([]);
  });
});
