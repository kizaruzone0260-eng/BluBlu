/**
 * Task 1 (2026-10-08) — demonstrating a screen in the lesson, with two real participants.
 *
 * RTC part: like zz-camera / zz2-moderation / zz4-layout this file needs a reachable LiveKit
 * (LIVEKIT_* in the environment) and self-skips without it, so CI reports it as skipped and the
 * ALWAYS-running coverage of the same decisions lives in
 * apps/api/test/unit/stage-model.test.ts (screen > board > layout, the switch, the strip, zoom).
 *
 * The fake presentation: livekit-client 2.22.3 calls `navigator.mediaDevices.getDisplayMedia`
 * directly (dist/livekit-client.esm.mjs, createLocalScreenTracks), so replacing that one function
 * in the page with a `canvas.captureStream()` source gives a genuine screen-share track: LiveKit
 * publishes it, the SFU routes it, and the other participant subscribes to real video frames.
 * Nothing about the app's own code path is stubbed.
 */
import { test, expect, request as pw } from '@playwright/test';
import { barClick } from './controlBar';
import {
  BASE, loginUi, m, stack, urlHost, type Ctx,
} from './boardFixtures';

async function livekitReachable(wsUrl: string): Promise<boolean> {
  try {
    const u = new URL(wsUrl);
    await fetch(`${u.protocol === 'wss:' ? 'https' : 'http'}://${u.host}/rtc/v1`, { signal: AbortSignal.timeout(5_000) });
    return true;
  } catch { return false; }
}

async function joinWithCam(page: import('@playwright/test').Page, classId: string) {
  await page.goto(`/lesson?classId=${classId}`);
  await page.getByTestId('check-devices').click();
  await expect(page.getByTestId('join-lesson')).toBeEnabled({ timeout: 20_000 });
  await page.getByTestId('join-lesson').click();
  await expect(async () => {
    const dims = await page.evaluate(() => [...document.querySelectorAll('video')].map((v) => [v.videoWidth, v.clientWidth]));
    expect(dims.some((d) => d[0] > 0 && d[1] > 0)).toBeTruthy();
  }).toPass({ timeout: 30_000 });
}

/** A canvas painted with a moving slide, handed to LiveKit as if the user picked it. */
async function fakeScreenShare(ctx: import('@playwright/test').BrowserContext) {
  await ctx.addInitScript(() => {
    const md = navigator.mediaDevices;
    Object.defineProperty(md, 'getDisplayMedia', {
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
            g.fillStyle = '#0b3d91'; g.fillRect(40, 40, 620, 140);
            g.fillStyle = '#ffffff'; g.font = '54px sans-serif';
            g.fillText(`BLUBLU SLIDE ${n}`, 70, 130);
          }
          requestAnimationFrame(paint);
        };
        paint();
        return c.captureStream(10);
      },
    });
  });
}

/** The size of the picture inside the main window vs a strip tile — what adaptiveStream reads. */
async function stageVsStrip(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const area = (el: Element | null) => {
      if (!el) return 0;
      const r = el.getBoundingClientRect();
      return Math.round(r.width * r.height);
    };
    const stage = document.querySelector('.screen-stage video') ?? document.querySelector('.stage-main video');
    const strip = document.querySelector('.stage-strip video');
    const lesson = document.querySelector('.lesson-stage');
    return {
      stage: area(stage), strip: area(strip), lesson: area(lesson),
      stageW: (stage as HTMLVideoElement | null)?.clientWidth ?? 0,
      stageH: (stage as HTMLVideoElement | null)?.clientHeight ?? 0,
    };
  });
}

test.describe('screen demonstration in the lesson (task 1, real RTC)', () => {
  let api: Ctx = null as unknown as Ctx;
  let token = '';

  test.beforeAll(async () => {
    api = await pw.newContext({ baseURL: BASE });
    for (let attempt = 0; attempt < 3 && !token; attempt++) {
      const l = await api.post('/api/auth/login', { data: { email: stack.teacherEmail, password: stack.teacherPassword } });
      if (l.status() === 429) { await new Promise((r) => setTimeout(r, 20_000)); continue; }
      token = String((await l.json()).accessToken as string);
    }
    expect(token).toBeTruthy();
  });
  test.afterAll(async () => { await api?.dispose(); });

  /** class + live lesson + a registered student, with the reachability gate applied. */
  async function room(name: string) {
    const H = { authorization: `Bearer ${token}` };
    const cls = await (await api.post('/api/classes', {
      headers: H, data: { name: `${name} ${Date.now()}`, description: '', color: '#0ea5a5' },
    })).json();
    const classId = String((cls as { id: string }).id);
    const start = await api.post('/api/lessons/start', { headers: H, data: { classId } });
    expect(start.status()).toBe(201);
    const session = await start.json();
    // wsUrl comes from the JOIN response (withRoom() does not carry it), same as zz4-layout
    const joinR = await api.post(`/api/lessons/${String((session as { id: string }).id)}/join`, { headers: H });
    const wsUrl = String((await joinR.json()).wsUrl as string);
    const joinable = await livekitReachable(wsUrl);
    if (!joinable) {
      test.skip(true, 'LiveKit is not reachable — this file needs LIVEKIT_* in the env (CI skips it; the stage logic itself is unit-tested)');
      return null;
    }
    const inv = await (await api.post(`/api/classes/${classId}/invites`, { headers: H, data: {} })).json();
    return { classId, sessionId: String((session as { id: string }).id), inviteCode: String((inv as { code: string }).code) };
  }

  async function twoParticipants(browser: import('@playwright/test').Browser, room: { classId: string; sessionId: string; inviteCode: string }, share: boolean) {
    const ctxT = await browser.newContext({ permissions: ['camera', 'microphone'], viewport: { width: 1280, height: 800 } });
    if (share) await fakeScreenShare(ctxT);
    const pT = await ctxT.newPage();
    await loginUi(pT, stack.teacherEmail, stack.teacherPassword);
    await joinWithCam(pT, room.classId);

    const ctxS = await browser.newContext({ permissions: ['camera', 'microphone'], viewport: { width: 1280, height: 800 } });
    const pS = await ctxS.newPage();
    await pS.goto('/register');
    await pS.getByTestId('reg-code').fill(room.inviteCode);
    await pS.getByTestId('reg-email').fill(`e2scr${Date.now()}@x.io`);
    await pS.getByTestId('reg-password').fill('Secret1234');
    await pS.getByTestId('register-step1').click();
    await pS.getByTestId('reg-first').fill('Экран');
    await pS.getByTestId('reg-last').fill('Тест');
    await pS.getByTestId('reg-consent').check();
    await pS.getByTestId('register-submit').click();
    await expect(pS.getByTestId('home-title')).toBeVisible({ timeout: 25_000 });
    await joinWithCam(pS, room.classId);

    const H = { authorization: `Bearer ${token}` };
    /**
     * Every test gets its own lesson, and each lesson is a LiveKit room: leaving them open made
     * later tests of this file fail to publish (measured: `screenShareFailed` on the 3rd and 4th
     * test of a run while the 1st passed). So the room is ended, not just abandoned.
     */
    const finish = async () => {
      await api.post(`/api/lessons/${room.sessionId}/end`, { headers: H }).catch(() => undefined);
      await ctxT.close(); await ctxS.close();
    };
    return { ctxT, ctxS, pT, pS, finish };
  }

  /**
   * A failed publish must say WHY, and a transient one must not fail the run: on this machine the
   * first click sometimes gets "Could not start screen sharing" from LiveKit while the very next
   * click works, so the helper retries (a real teacher clicks again) and reports every attempt.
   */
  async function expectShared(pT: import('@playwright/test').Page) {
    const banner = pT.getByTestId('share-banner');
    // the room-level error paragraph (cam/mic errors carry their own data-testids)
    const err = pT.locator('p.error:not([data-testid])');
    const tried: string[] = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      if (await banner.isVisible().catch(() => false)) return;
      // not failed yet? then it is still in flight — wait for whichever comes first
      const raced = await Promise.race([
        banner.waitFor({ state: 'visible', timeout: 25_000 }).then(() => 'up').catch(() => ''),
        err.first().waitFor({ state: 'visible', timeout: 25_000 }).then(() => 'err').catch(() => ''),
      ]);
      if (raced === 'up') return;
      tried.push(await err.first().innerText().catch(() => '(no message)'));
      // the share is off again (the publish failed), so this click is a fresh start, not a toggle
      await barClick(pT, 'share-toggle').catch(() => undefined);
    }
    throw new Error(`the screen share did not start after 3 attempts: ${tried.join(' | ')}`);
  }

  /** Where the stop button, the floating camera and the stage actually are — for layout bugs. */
  async function geometry(pT: import('@playwright/test').Page) {
    return pT.evaluate(() => {
      /*
       * Задача 2026-10-10: страница урока теперь оканчивается нижней панелью управления, которая
       * резервирует свои 76 px в потоке (`.bar-slot`) — из-за этого документ стал выше вьюпорта, и
       * кнопка «Остановить» после кликов по предпросмотру могла остаться за верхней кромкой экрана.
       * Проверка «над кнопкой ничего не висит» имеет смысл там, где человек её реально видит,
       * поэтому кнопку сначала заводим в центр экрана; координаты и elementFromPoint берутся уже
       * после этого, то есть замер соответствует клику мышью.
       */
      document.querySelector('[data-testid=share-stop]')?.scrollIntoView({ block: 'center' });
      const box = (sel: string) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)];
      };
      const stop = document.querySelector('[data-testid=share-stop]')?.getBoundingClientRect();
      const hit = stop ? document.elementFromPoint(stop.x + stop.width / 2, stop.y + stop.height / 2) : null;
      return {
        stop: box('[data-testid=share-stop]'), pipBar: box('[data-testid=pip-bar]'),
        stage: box('.lesson-stage'), preview: box('[data-testid=share-preview]'),
        tools: box('[data-testid=screen-tools]'),
        // what would actually receive the click at the button's centre
        hitTest: hit ? `${hit.tagName}.${hit.className}` : null,
      };
    });
  }

  test('the shared screen becomes the main window for BOTH, with the expand tools', async ({ browser }) => {
    test.setTimeout(300_000);
    const room1 = await room('E2E экран главный');
    if (!room1) return;
    const { pT, pS, finish } = await twoParticipants(browser, room1, true);
    try {
      // the student is in a grid before anybody shares: the screen is NOT a small tile yet
      await expect(pS.getByTestId('video-grid')).toBeVisible();
      await expect(pS.getByTestId('screen-stage')).toHaveCount(0);

      const hosts = new Set<string>();
      pT.on('request', (r) => hosts.add(urlHost(r.url())));

      await barClick(pT, 'share-toggle');
      await expectShared(pT);
      await expect(pT.getByTestId('screen-stage')).toBeVisible({ timeout: 20_000 });
      // the presenter's own screen owns the main window too (task: «у показывающего тоже»)
      await expect(pT.getByTestId('screen-you')).toBeVisible();
      // …and the student gets the same window with real frames in it
      await expect(pS.getByTestId('screen-stage')).toBeVisible({ timeout: 30_000 });
      await expect(async () => {
        const dims = await pS.evaluate(() => {
          const v = document.querySelector('.screen-stage video');
          return v ? [v.videoWidth, v.videoHeight, v.clientWidth] : [0, 0, 0];
        });
        m('student screen video [videoWidth,videoHeight,clientWidth]', dims);
        expect(dims[0], 'real frames arrived over RTC').toBeGreaterThan(0);
        expect(dims[2], 'and it is rendered big').toBeGreaterThan(400);
      }).toPass({ timeout: 40_000 });

      // the tools a plain tile never had
      await expect(pS.getByTestId('screen-tools')).toBeVisible();
      for (const id of ['screen-full', 'screen-window', 'screen-fit', 'screen-zoom-in', 'screen-zoom-out']) {
        await expect(pS.getByTestId(id), `the viewer gets ${id}`).toBeVisible();
      }
      // aria-labels exist and are localized, whichever language the seeded teacher's profile
      // carries (the embedded PG data dir survives a stack restart, so the language is not ours
      // to assume — the ru/uz/en parity itself is enforced by apps/api/test/unit/locale-keys)
      const label = await pS.getByTestId('screen-full').getAttribute('aria-label');
      m('screen-full aria-label', label);
      expect(label, 'the buttons carry a real aria-label').toBeTruthy();
      expect(['На весь экран', 'Full screen', 'To‘liq ekran'], 'and it is one of the three languages')
        .toContain(label);
      expect(label, 'never a raw i18n key').not.toBe('lesson.screenFull');
      expect(label, 'never a raw i18n key').not.toContain('screenFull');

      // cameras left the main window: the student's own camera floats, the teacher's is in the strip
      await expect(pS.getByTestId('pip-local')).toBeVisible();
      await expect(pS.getByTestId('stage-strip')).toBeVisible();
      const sizes = await stageVsStrip(pS);
      m('main window vs strip tile (px²)', sizes);
      expect(sizes.stage, 'the screen owns most of the stage').toBeGreaterThan(sizes.lesson * 0.5);
      expect(sizes.stage, 'and is far bigger than a strip tile — that is what adaptiveStream reads')
        .toBeGreaterThan(sizes.strip * 3);

      // nothing reached a third party: only our own origin (LiveKit's wss is not an HTTP request)
      const foreign = [...hosts].filter((h) => h && !h.includes('127.0.0.1') && !h.startsWith('wss://') && !h.includes('livekit'));
      m('http hosts contacted by the presenter', [...hosts]);
      expect(foreign, 'no new third-party origin appears while sharing').toEqual([]);
    } finally { await finish(); }
  });

  test('fullscreen by button and by double-click, Esc leaves it; windowed mode works without the API', async ({ browser }) => {
    test.setTimeout(300_000);
    const room2 = await room('E2E экран фуллскрин');
    if (!room2) return;
    const { pT, pS, finish } = await twoParticipants(browser, room2, true);
    try {
      await barClick(pT, 'share-toggle');
      await expectShared(pT);
      await expect(pS.getByTestId('screen-stage')).toBeVisible({ timeout: 30_000 });

      const isFull = (page: import('@playwright/test').Page) =>
        page.evaluate(() => Boolean(document.fullscreenElement));

      await pS.getByTestId('screen-full').click();
      await expect.poll(() => isFull(pS), 'the stage itself, not the bare <video>, goes fullscreen')
        .toBe(true);
      const fullEl = await pS.evaluate(() => document.fullscreenElement?.className ?? '');
      m('fullscreenElement class', fullEl);
      expect(fullEl, 'the fullscreen container is the screen stage').toContain('screen-stage');
      // the room controls stay reachable on top of the picture
      await expect(pS.getByTestId('screen-overlay')).toBeVisible();
      for (const id of ['ov-mic', 'ov-cam', 'ov-strip', 'ov-leave']) {
        await expect(pS.getByTestId(id), `${id} stays available in fullscreen`).toBeVisible();
      }
      await pS.keyboard.press('Escape');
      await expect.poll(() => isFull(pS), 'Esc leaves fullscreen').toBe(false);

      // double-click toggles it as well
      await pS.getByTestId('screen-picture').dblclick();
      await expect.poll(() => isFull(pS), 'double-click enters fullscreen').toBe(true);
      await pS.getByTestId('screen-picture').dblclick();
      await expect.poll(() => isFull(pS), 'double-click again leaves it').toBe(false);

      // «Развернуть в окне» — the path for browsers without the Fullscreen API
      await pS.getByTestId('screen-window').click();
      await expect(pS.getByTestId('screen-stage')).toHaveClass(/screen-windowed/);
      const box = await pS.getByTestId('screen-stage').boundingBox();
      const vp = pS.viewportSize()!;
      m('windowed stage box', { w: box?.width, h: box?.height, vp: [vp.width, vp.height] });
      expect(box!.width, 'the windowed stage covers the viewport').toBeGreaterThanOrEqual(vp.width - 2);
      await pS.getByTestId('screen-exit').click();
      await expect(pS.getByTestId('screen-stage')).not.toHaveClass(/screen-windowed/);
    } finally { await finish(); }
  });

  test('zoom in/out and fit/fill change the picture, and stopping the share restores the layout', async ({ browser }) => {
    test.setTimeout(300_000);
    const room3 = await room('E2E экран масштаб');
    if (!room3) return;
    const { pT, pS, finish } = await twoParticipants(browser, room3, true);
    try {
      await barClick(pT, 'share-toggle');
      await expectShared(pT);
      await expect(pS.getByTestId('screen-stage')).toBeVisible({ timeout: 30_000 });

      expect(await pS.getByTestId('screen-stage').getAttribute('data-zoom')).toBe('1.00');
      await pS.getByTestId('screen-zoom-in').click();
      await pS.getByTestId('screen-zoom-in').click();
      const zoomed = Number(await pS.getByTestId('screen-stage').getAttribute('data-zoom'));
      m('zoom after two +', zoomed);
      expect(zoomed).toBeGreaterThan(1.5);
      const transform = await pS.getByTestId('screen-picture').evaluate((el) => getComputedStyle(el).transform);
      expect(transform, 'the picture is actually scaled').not.toBe('none');
      await expect(pS.getByTestId('screen-zoom-reset')).toBeVisible();
      await pS.getByTestId('screen-zoom-reset').click();
      expect(await pS.getByTestId('screen-stage').getAttribute('data-zoom')).toBe('1.00');
      await pS.getByTestId('screen-zoom-out').click();
      expect(await pS.getByTestId('screen-stage').getAttribute('data-zoom'),
        'zoom out never goes below the fitted picture').toBe('1.00');

      await pS.getByTestId('screen-fit').click();
      expect(await pS.getByTestId('screen-stage').getAttribute('data-fit')).toBe('cover');
      const fit = await pS.getByTestId('screen-picture').locator('video').evaluate((el) => getComputedStyle(el).objectFit);
      expect(fit).toBe('cover');
      await pS.getByTestId('screen-fit').click();
      expect(await pS.getByTestId('screen-stage').getAttribute('data-fit')).toBe('contain');

      // the presenter sees the plaque and a collapsed preview that opens
      await expect(pT.getByTestId('share-preview')).toHaveClass(/preview-min/);
      await pT.getByTestId('share-preview-toggle').click();
      await expect(pT.locator('[data-testid=share-preview] video')).toBeVisible({ timeout: 10_000 });
      await expect(pT.getByTestId('share-preview')).not.toHaveClass(/preview-min/);

      // stopping returns BOTH to the previous layout. The plaque is checked first: a collapsed
      // stage let the floating camera cover «Остановить» (measured 2026-10-08), so the button has
      // to be the element that actually receives the click, and the stage has to be a stage.
      const geo = await geometry(pT);
      m('stop-button geometry', geo);
      expect(geo.hitTest, 'nothing floats over the presenter’s stop button').toContain('BUTTON');
      expect(geo.stage![3], 'the stage keeps a real height for the shared picture').toBeGreaterThan(300);
      await pT.getByTestId('share-stop').click();
      await expect(pT.getByTestId('screen-stage')).toHaveCount(0, { timeout: 20_000 });
      await expect(pT.getByTestId('share-banner')).toHaveCount(0);
      await expect(pS.getByTestId('screen-stage')).toHaveCount(0, { timeout: 20_000 });
      await expect(pS.getByTestId('video-grid')).toBeVisible({ timeout: 20_000 });
    } finally { await finish(); }
  });

  test('screen beats the board, and the «Экран | Доска» switch keeps the board reachable', async ({ browser }) => {
    test.setTimeout(300_000);
    const room4 = await room('E2E экран против доски');
    if (!room4) return;
    const { pT, pS, finish } = await twoParticipants(browser, room4, true);
    try {
      await barClick(pT, 'share-toggle');
      await expectShared(pT);
      await expect(pS.getByTestId('screen-stage')).toBeVisible({ timeout: 30_000 });

      // the teacher opens the board WHILE sharing: the screen still owns the window, and the
      // switch appears for everybody (the board is shared state, the choice of what to look at is local)
      await barClick(pT, 'board-toggle');
      await expect(pT.getByTestId('stage-switch')).toBeVisible({ timeout: 15_000 });
      await expect(pT.getByTestId('screen-stage')).toBeVisible();
      await expect(pS.getByTestId('stage-switch')).toBeVisible({ timeout: 15_000 });

      await pS.getByTestId('stage-switch-board').click();
      await expect(pS.getByTestId('board')).toBeVisible({ timeout: 15_000 });
      await expect(pS.getByTestId('screen-stage')).toHaveCount(0);
      // the shared screen did not disappear: it moved to the strip
      await expect(pS.getByTestId('stage-strip').locator('[data-screen="1"]')).toBeVisible();

      await pS.getByTestId('stage-switch-screen').click();
      await expect(pS.getByTestId('screen-stage')).toBeVisible({ timeout: 15_000 });
      // the teacher's own view is untouched by the student's choice
      await expect(pT.getByTestId('screen-stage')).toBeVisible();
    } finally { await finish(); }
  });
});
