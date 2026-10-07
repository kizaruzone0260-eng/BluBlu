/**
 * Task 6 (part 3 follow-up) — the rich-text boot crash, reproduced deterministically.
 *
 * What the app does: `@tiptap/react` builds the editor inside a `useState` initialiser
 * (during RENDER) and arms a 1 ms `setTimeout` that destroys it unless the component has
 * mounted by then (`EditorInstanceManager.scheduleDestroy`). Mounting happens in a React
 * PASSIVE effect, flushed in a later task delivered over a MessagePort. When that task
 * lands more than ~1 ms after the render — a loaded machine, a long task, another process
 * eating the CPU — the editor is destroyed while this render still holds it. `@tiptap/core`
 * nulls the schema in `destroy()` (`this.extensionManager = null; this.schema = null;`), so
 * the next thing our component does — the controlled-content sync effect calling
 * `editor.getHTML()` → `DOMSerializer.fromSchema(null)` — throws
 * `TypeError: Cannot read properties of null (reading 'cached')`. That throw happens inside
 * `ErrorBoundary`, so the user gets the permanent 500 screen and can only reload. This is
 * the crash that turned the scheduled-post e2e spec red on a loaded box (trace:
 * `apps/trace-material/…/1-trace.trace`, console entry with exactly that message and a
 * `RichText-*.js` frame), and it can hit the material form and the notes editor for a real
 * teacher.
 *
 * The test forces the timing instead of waiting for it: every MessagePort delivery is
 * delayed past the 1 ms timer, so the destroyed-editor window happens on EVERY mount.
 * Before the guard it is red (500 screen + the TypeError); after it the editor mounts, the
 * typing round-trip works and no such error is reported.
 */
import { test, expect, type Browser, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

function readStack() {
  for (let i = 0; i < 80; i++) {
    try {
      return JSON.parse(readFileSync(path.join(process.cwd(), '.stack.json'), 'utf8')) as {
        port: number; teacherEmail: string; teacherPassword: string;
      };
    } catch {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
    }
  }
  throw new Error('.stack.json never appeared');
}
const stack = readStack();
const BASE = `http://127.0.0.1:${stack.port}`;

/** Later than tiptap's 1 ms scheduled destruction, small enough to keep the app usable. */
const SCHEDULER_DELAY_MS = 8;

/** The crash this spec exists for — ProseMirror reading `schema.cached` on a destroyed editor. */
const TIPTAP_CRASH = /Cannot read properties of null \(reading 'cached'\)/;

async function apiLogin(): Promise<string> {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: stack.teacherEmail, password: stack.teacherPassword }),
  });
  if (!r.ok) throw new Error(`teacher api login ${r.status}`);
  return String(((await r.json()) as { accessToken: string }).accessToken);
}

/**
 * A page whose React passive-effect flush always loses tiptap's 1 ms race. Everything the
 * page reports is collected: a boundary error reaches `console.error` in dev and a rethrow
 * in the prod bundle, so the page installs its own collectors next to Playwright's, and the
 * screen assertion stays the primary one.
 */
async function slowFlushPage(browser: Browser, errors: string[]): Promise<Page> {
  const ctx = await browser.newContext();
  await ctx.addInitScript((delay) => {
    const w = window as unknown as { __errs?: string[] };
    w.__errs = [];
    const origError = console.error.bind(console);
    console.error = (...args: unknown[]) => {
      w.__errs?.push(args.map((a) => (a instanceof Error ? `${a.message} :: ${a.stack ?? ''}` : String(a))).join(' '));
      origError(...args);
    };
    addEventListener('error', (e) => { w.__errs?.push(`${e.message} @ ${e.filename}:${e.lineno}`); });
    addEventListener('unhandledrejection', (e) => {
      w.__errs?.push(`rejection: ${String((e as PromiseRejectionEvent).reason)}`);
    });

    const proto = (window as unknown as Record<string, { prototype: { postMessage: Function } } | undefined>).MessagePort;
    if (!proto) return;
    const orig = proto.prototype.postMessage;
    proto.prototype.postMessage = function patched(this: unknown, ...args: unknown[]): void {
      setTimeout(() => { orig.apply(this, args as []); }, delay);
    };
  }, SCHEDULER_DELAY_MS);
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  return page;
}

/** Merge what the page itself reported into the shared list; returns a short printable form. */
async function collect(page: Page, errors: string[]): Promise<string> {
  const inPage = await page.evaluate(
    () => (window as unknown as { __errs?: string[] }).__errs ?? [],
  );
  for (const e of inPage) if (!errors.includes(e)) errors.push(e);
  return JSON.stringify(errors.filter((e) => !/Failed to load resource.*(401|403)/.test(e)).slice(0, 8));
}

const crashes = (errors: string[]): string[] => errors.filter((e) => TIPTAP_CRASH.test(e));

async function loginViaUI(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByTestId('email').fill(stack.teacherEmail);
  await page.getByTestId('password').fill(stack.teacherPassword);
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('home-title')).toBeVisible({ timeout: 30_000 });
  await expectCollector(page);
}

/**
 * The collectors and the MessagePort patch are installed by the SAME init script, so this
 * also proves the patch is in force on the document under test — without it the "no crash
 * logged" assertion would pass vacuously.
 */
async function expectCollector(page: Page): Promise<void> {
  expect(await page.evaluate(() => Array.isArray((window as unknown as { __errs?: unknown }).__errs)),
    'the in-page error collector (and with it the scheduler delay) must be installed').toBe(true);
}

/** A slow-flush page with the teacher already logged in through the UI. */
async function openLoggedPage(browser: Browser, errors: string[]): Promise<Page> {
  const page = await slowFlushPage(browser, errors);
  await loginViaUI(page);
  return page;
}

test.describe.serial('rich text survives the destroyed-editor window (task 6)', () => {
  let classId = '';

  test('setup: a class for the material route', async () => {
    const tok = await apiLogin();
    const res = await fetch(`${BASE}/api/classes`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` },
      body: JSON.stringify({ name: `E2E RichText ${Date.now()}`, description: '', color: '#0ea5a5' }),
    });
    expect(res.ok, `class create ${res.status}`).toBe(true);
    classId = String(((await res.json()) as { id: string }).id);
    expect(classId).toBeTruthy();
  });

  test('material form: the editor is alive, typing works, no 500 screen', async ({ browser }) => {
    test.setTimeout(150_000);
    const errors: string[] = [];
    const page = await openLoggedPage(browser, errors);
    try {
      expect(classId, 'setup must have created the class').toBeTruthy();
      await page.goto(`/classes/${classId}/material/new`);
      await collect(page, errors);

      // The crash used to replace the whole app with the boundary, so the page itself is the
      // assertion and it is checked before any locator that could pass by accident.
      await expect(page.getByTestId('material-h1'),
        `the material form must render, not the error screen — ${await collect(page, errors)}`)
        .toBeVisible({ timeout: 30_000 });
      await expect(page.getByRole('heading', { name: '500' })).toHaveCount(0);

      // …and the editor really mounted: that instance is the one the effect used to touch dead
      await expect(page.locator('.tiptap'), `the editor must mount — ${await collect(page, errors)}`)
        .toBeVisible({ timeout: 30_000 });

      // Typing is the same racy path: onUpdate → parent setState → the controlled-content
      // effect calls editor.getHTML() on the instance this render holds.
      await page.locator('.tiptap').click();
      await page.keyboard.type('Проверка редактора');
      await expect(page.locator('.tiptap')).toContainText('Проверка редактора');
      await page.getByTestId('rt-bold').click();
      await page.keyboard.type(' жирный');
      await expect(page.locator('.tiptap')).toContainText('жирный');

      // The rest of the form still works — the boundary would have eaten it all.
      await page.getByTestId('material-title').fill('Пост после краша');

      await collect(page, errors);
      expect(crashes(errors), `no tiptap destroyed-editor crash — ${await collect(page, errors)}`)
        .toHaveLength(0);
    } finally {
      await page.context().close();
    }
  });

  test('notes editor: same guard on the other call site', async ({ browser }) => {
    test.setTimeout(150_000);
    const errors: string[] = [];
    const page = await openLoggedPage(browser, errors);
    try {
      await page.goto('/notes');
      await expect(page.getByTestId('notes-add'),
        `the notes page must render, not the error screen — ${await collect(page, errors)}`)
        .toBeVisible({ timeout: 30_000 });
      await expect(page.getByRole('heading', { name: '500' })).toHaveCount(0);

      await page.getByTestId('notes-add').click();
      await expect(page.locator('.tiptap'), `the notes editor must mount — ${await collect(page, errors)}`)
        .toBeVisible({ timeout: 30_000 });
      await page.locator('.tiptap').click();
      await page.keyboard.type('Заметка на боевом шве');
      await expect(page.locator('.tiptap')).toContainText('Заметка на боевом шве');

      await collect(page, errors);
      expect(crashes(errors), `no tiptap destroyed-editor crash — ${await collect(page, errors)}`)
        .toHaveLength(0);
    } finally {
      await page.context().close();
    }
  });
});
