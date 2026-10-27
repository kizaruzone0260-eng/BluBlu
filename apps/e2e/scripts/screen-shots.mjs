/**
 * Screen-demonstration screenshots for docs/screenshots (task 1.5, 2026-10-08).
 *
 *   node apps/e2e/scripts/screen-shots.mjs        (from the repo root, LIVEKIT_* in the env)
 *
 * One teacher + one student, a fake getDisplayMedia (a painted canvas) in the teacher's context,
 * then every combination of locale × theme × width shoots three states:
 *   screen-stage-<locale>-<width>-<theme>.png      what a viewer sees: the picture + its tools
 *   screen-presenter-<locale>-<width>-<theme>.png  the plaque, the stop button, the preview
 *   screen-switch-<locale>-<width>-<theme>.png     «Экран | Доска» with the board picked
 * plus four fullscreen shots (ru/en × 390/1280, light):
 *   screen-full-<locale>-<width>-<theme>.png
 *
 * The RTC part is skipped with a clear message when LiveKit is not reachable. Never prints
 * secrets; the class name is a fixture, the accounts are the seeded test ones.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const outDir = path.join(root, 'docs', 'screenshots');
const PORT = 3123;
const BASE = `http://127.0.0.1:${PORT}`;

if (!fs.existsSync(path.join(root, 'apps', 'web', 'dist', 'index.html'))) {
  console.error('screen-shots: apps/web/dist is missing — run `pnpm --filter @klass/web build` first');
  process.exit(1);
}
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

const stack = spawn('node', ['scripts/e2e-stack.mjs'], {
  cwd: path.join(root, 'apps/e2e'), stdio: ['ignore', 'inherit', 'inherit'], env: process.env,
});
const credsFile = path.join(root, 'apps/e2e/.stack.json');
const nap = (ms) => new Promise((r) => setTimeout(r, ms));
let shuttingDown = false;
async function bye(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  try { stack.kill(); } catch { /* gone */ }
  process.exit(code);
}
process.on('SIGINT', () => void bye(0));
// a throw in the shooting loop must not leave the stack holding port 3123 for the next run
process.on('uncaughtException', (e) => { console.error('screen-shots failed:', e?.message ?? e); void bye(1); });
process.on('unhandledRejection', (e) => { console.error('screen-shots failed:', e?.message ?? e); void bye(1); });

// .stack.json appears only after migrations + seeding, while /api/health/live answers earlier
let creds = null;
for (let i = 0; i < 120; i++) {
  await nap(1000);
  if (fs.existsSync(credsFile)) { creds = JSON.parse(fs.readFileSync(credsFile, 'utf8')); break; }
}
if (!creds) { console.error('screen-shots: the stack never came up'); await bye(1); }

const api = async (tok, method, p, body) => {
  const r = await fetch(`${BASE}${p}`, {
    method,
    headers: { authorization: `Bearer ${tok}`, ...(method === 'GET' ? {} : { 'content-type': 'application/json' }) },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  });
  return { status: r.status, json: await r.json().catch(() => null) };
};
const TT = (await (await fetch(`${BASE}/api/auth/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: creds.teacherEmail, password: creds.teacherPassword }),
})).json()).accessToken;

const classes = (await api(TT, 'GET', '/api/classes')).json;
let cls = classes.find((c) => c.name === '7B — screen shots');
if (!cls) cls = (await api(TT, 'POST', '/api/classes', { name: '7B — screen shots', description: '', color: '#0ea5a5' })).json;
// a lesson left live by an earlier (killed) run would hand this one its room — end it first
const live = (await api(TT, 'GET', `/api/lessons/active?classId=${cls.id}`)).json?.session;
if (live?.id) await api(TT, 'POST', `/api/lessons/${live.id}/end`, {});
const session = (await api(TT, 'POST', '/api/lessons/start', { classId: cls.id })).json;
const wsUrl = (await api(TT, 'POST', `/api/lessons/${session.id}/join`, {})).json?.wsUrl;
try {
  const u = new URL(wsUrl);
  await fetch(`${u.protocol === 'wss:' ? 'https' : 'http'}://${u.host}/rtc/v1`, { signal: AbortSignal.timeout(5_000) });
} catch {
  console.error('screen-shots: LiveKit is not reachable from this machine — the RTC screenshots need it');
  await bye(1);
}

const stuEmail = 'screenshots@x.io';
const stuPass = 'ShotPass123';
let ST = (await (await fetch(`${BASE}/api/auth/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: stuEmail, password: stuPass }),
})).json().catch(() => ({})))?.accessToken;
if (!ST) {
  // аккаунт ученика заводится ОДНОРАЗОВОЙ ССЫЛКОЙ: приём по коду класса выведен из продукта
  // 2026-10-27, и `POST /api/classes/:id/invites` с `/api/auth/register` отвечают 410
  const link = (await api(TT, 'POST', `/api/classes/${cls.id}/invites/link`, { ttlDays: 30 })).json;
  ST = (await (await fetch(`${BASE}/api/invitations/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      token: String(link?.url ?? '').split('#')[1] ?? '',
      firstName: 'Демонстрация', lastName: 'Тест', email: stuEmail, password: stuPass,
    }),
  })).json().catch(() => ({})))?.accessToken;
}

const browser = await chromium.launch({
  channel: 'msedge',
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
});

/** the same fake source the e2e spec uses: a canvas painted with a moving slide */
const FAKE_SHARE = () => {
  Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', {
    configurable: true, writable: true,
    value: async () => {
      const c = document.createElement('canvas');
      c.width = 1280; c.height = 720;
      const g = c.getContext('2d');
      let n = 0;
      const paint = () => {
        n += 1;
        if (g) {
          g.fillStyle = '#ffffff'; g.fillRect(0, 0, 1280, 720);
          g.fillStyle = '#0b3d91'; g.fillRect(40, 40, 700, 150);
          g.fillStyle = '#ffffff'; g.font = '52px sans-serif';
          g.fillText(`Формула E = mc²  ·  слайд ${n}`, 70, 135);
          g.fillStyle = '#111'; g.font = '30px sans-serif';
          g.fillText('мелкий текст для проверки масштаба: 1 2 3 4 5 6 7 8 9', 70, 260);
        }
        requestAnimationFrame(paint);
      };
      paint();
      return c.captureStream(10);
    },
  });
};

async function login(page, email, password) {
  await page.goto(`${BASE}/login`);
  await page.getByTestId('email').fill(email);
  await page.getByTestId('password').fill(password);
  await page.getByTestId('login-submit').click();
  const ok = await page.getByTestId('home-title').waitFor({ timeout: 20_000 }).then(() => true).catch(() => false);
  if (!ok) {
    // without this the script dies with a bare TimeoutError and no clue
    console.log('login failed for', email, '→ url', page.url(),
      '| body:', (await page.locator('body').innerText().catch(() => '?')).slice(0, 200).replace(/\s+/g, ' '));
    throw new Error('the login did not reach Home');
  }
}
const ctxT = await browser.newContext({ permissions: ['camera', 'microphone'], viewport: { width: 1280, height: 900 } });
await ctxT.addInitScript(FAKE_SHARE);
const pT = await ctxT.newPage();
await login(pT, creds.teacherEmail, creds.teacherPassword);
const ctxS = await browser.newContext({ permissions: ['camera', 'microphone'], viewport: { width: 1280, height: 900 } });
const pS = await ctxS.newPage();
await login(pS, stuEmail, stuPass);

async function join(page) {
  await page.goto(`${BASE}/lesson?classId=${cls.id}`);
  await page.getByTestId('check-devices').click();
  await page.getByTestId('join-lesson').waitFor({ state: 'visible', timeout: 30_000 });
  await page.getByTestId('join-lesson').click();
  await page.waitForTimeout(2_500);
}
async function share() {
  /*
   * The same transient the zz13 spec documents: LiveKit sometimes answers "Could not start screen
   * sharing" on the first click and succeeds on the next. A retry here, not a failed 40-shot run.
   * The retry only ever clicks AFTER a visible failure — a publish takes seconds, and clicking
   * while one is still in flight toggles the share back off (that is what cost run 7 of 2026-10-08
   * forty screenshots: four "attempts", four "(no message)", because the share was off again).
   */
  const banner = pT.getByTestId('share-banner');
  const err = pT.locator('p.error:not([data-testid])').first();
  const tried = [];
  const settled = async () => {
    await pS.getByTestId('screen-stage').waitFor({ state: 'visible', timeout: 30_000 });
    await waitForFrame(pS, 'the student stage after the share started');
  };
  await pT.getByTestId('share-toggle').click();
  for (let attempt = 0; attempt < 3; attempt++) {
    // only the banner is waited for: a failed publish leaves its error paragraph in the DOM even
    // after a successful retry (toggleShare never clears it), so an error race would fire on the
    // stale message and report a share that actually works
    const up = await banner.waitFor({ state: 'visible', timeout: 25_000 })
      .then(() => true).catch(() => false);
    if (up) { await settled(); return; }
    tried.push(await err.innerText().catch(() => '(no message)'));
    await pT.getByTestId('share-toggle').click();
  }
  throw new Error(`the share did not start after 3 attempts: ${tried.join(' | ')}`);
}
async function shot(name, loc, width, theme) {
  await pS.screenshot({ path: path.join(outDir, `${name}-${loc}-${width}-${theme}.png`) });
  console.log('shot', `${name}-${loc}-${width}-${theme}.png`);
}
/**
 * A viewport resize makes LiveKit re-subscribe: the first run of 2026-10-08 caught one shot with
 * a black stage (the <video> was there, its first frame was not). Wait for real pixels instead of
 * a fixed pause, and say so if they never arrive rather than shipping a black picture quietly.
 */
async function waitForFrame(page, label) {
  const ok = await page.waitForFunction(() => {
    const vs = [...document.querySelectorAll('.screen-stage video, [data-testid=share-preview] video')];
    return vs.length > 0 && vs.every((v) => v.videoWidth > 0 && v.readyState >= 2);
  }, null, { timeout: 30_000 }).then(() => true).catch(() => false);
  if (!ok) console.log('WARN: no decoded frame in', label);
}

let count = 0;
for (const locale of ['ru', 'uz', 'en']) {
  for (const [page, tok] of [[pT, TT], [pS, ST]]) {
    await page.evaluate((lng) => localStorage.setItem('klass_locale', lng), locale);
    await api(tok, 'PATCH', '/api/me/profile', { name: tok === TT ? 'Teacher' : 'Демонстрация', locale, tz: 'Asia/Tashkent' });
  }
  for (const theme of ['light', 'dark']) {
    await pT.evaluate((th) => localStorage.setItem('klass_theme', th), theme);
    await pS.evaluate((th) => localStorage.setItem('klass_theme', th), theme);
    await join(pT); await join(pS);
    await share();
    for (const width of [390, 1280]) {
      await pT.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await pS.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await pS.waitForTimeout(700);
      await waitForFrame(pS, `screen-stage ${locale}/${width}/${theme}`);
      await waitForFrame(pT, `presenter stage ${locale}/${width}/${theme}`);

      await shot('screen-stage', locale, width, theme); count++;
      await pT.bringToFront();
      await pT.getByTestId('share-preview-toggle').click();          // expand the self preview
      await pT.waitForTimeout(700);
      await waitForFrame(pT, `screen-presenter ${locale}/${width}/${theme}`);
      await pT.screenshot({ path: path.join(outDir, `screen-presenter-${locale}-${width}-${theme}.png`) });
      console.log('shot', `screen-presenter-${locale}-${width}-${theme}.png`); count++;
      await pT.getByTestId('share-preview-toggle').click();

      // the board joins the stage: the switch appears, and the board is what the viewer picked
      await pT.getByTestId('board-toggle').click();
      await pT.waitForTimeout(900);
      await pS.getByTestId('stage-switch-board').click();
      await pS.waitForTimeout(1_200);
      await shot('screen-switch', locale, width, theme); count++;
      await pS.getByTestId('stage-switch-screen').click();
      await pS.waitForTimeout(600);
      await pT.getByTestId('board-toggle').click();                   // close the board again
      await pT.waitForTimeout(600);

      if (theme === 'light' && (locale === 'ru' || locale === 'en')) {
        await pS.bringToFront();
        await pS.getByTestId('screen-full').click();
        await pS.waitForTimeout(900);
        await waitForFrame(pS, `screen-full ${locale}/${width}`);
        await shot('screen-full', locale, width, 'light'); count++;
        await pS.keyboard.press('Escape');
        await pS.waitForTimeout(600);
      }
      await pS.bringToFront();
    }
    await pT.getByTestId('share-stop').click();
    await pT.waitForTimeout(800);
  }
}

await api(TT, 'POST', `/api/lessons/${session.id}/end`, {});
await browser.close();
console.log(`screen-shots done (${count} png)`);
await bye(0);
