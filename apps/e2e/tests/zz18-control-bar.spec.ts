/**
 * Задача 2026-10-10, часть 1 — нижняя панель управления уроком по образцу Zoom/Meet.
 *
 * Проверяется ровно то, что обещано в списке дел, и проверяется физически: два настоящих
 * участника в комнате LiveKit, настоящие нажатия, настоящее состояние публикации.
 *
 *   1. микрофон и камера кнопками панели (состояние читается из aria-pressed — так его читает
 *      скринридер, а не из эмодзи в тексте кнопки);
 *   2. выбор устройства из меню у стрелки — выпадающих списков на основном экране больше нет;
 *   3. поднятая рука и «дать слово» — из правой панели, комментарий — из её же вкладки;
 *   4. режим лекции — из «Ещё»;
 *   5. выход: у ученика «Выйти», у учителя «Выйти (урок продолжается)» и «Завершить для всех»
 *      с подтверждением;
 *   6. автоскрытие панели в полноэкранном режиме и возврат по движению мыши;
 *   7. количество видимых кнопок: не больше 8 + выход на десктопе, 5 на телефоне;
 *   8. горячие клавиши и их молчание, когда фокус в поле ввода.
 *
 * Спеки, проверявшие те же кнопки в старом месте (zz2, zz13, zz16, zz17), обновлены только в
 * шагах навигации — открытия панели и меню; сами утверждения не ослаблены.
 */
import { test, expect, request as pw, type Browser, type Page, type Request } from '@playwright/test';
import { AxeBuilder } from '@axe-core/playwright';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { barClick, openMore, openTab, visibleButtons, wakeBar } from './controlBar';

function readStack() {
  for (let i = 0; i < 90; i++) {
    try {
      return JSON.parse(readFileSync(path.join(process.cwd(), '.stack.json'), 'utf8')) as {
        port: number; teacherEmail: string; teacherPassword: string;
      };
    } catch { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1_000); }
  }
  throw new Error('.stack.json never appeared');
}
const stack = readStack();
const BASE = `http://127.0.0.1:${stack.port}`;
const STUDENT_PW = 'Secret1234';

async function livekitReachable(wsUrl: string): Promise<boolean> {
  try {
    const u = new URL(wsUrl);
    await fetch(`${u.protocol === 'wss:' ? 'https' : 'http'}://${u.host}/rtc/v1`, { signal: AbortSignal.timeout(5_000) });
    return true;
  } catch { return false; }
}

/** этот спек читает стек сам (см. readStack), поэтому и логирование замера своё */
const m = (label: string, value: unknown) => console.log(`MEASURE ${label} ${JSON.stringify(value)}`);

/*
 * Тот же прицел, что у zz6-a11y: WCAG 2 A/AA + 2.1, и падаем только на critical/serious.
 * color-contrast включён с 2026-10-28 (аудит, пункт 13): токены исправлены, и оба спека
 * обязаны видеть контраст одинаково — иначе «зелёный» снова ничего не значит.
 */
async function expectAccessible(page: Page, name: string) {
  const res = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const bad = res.violations
    .filter((v) => v.impact === 'critical' || v.impact === 'serious')
    .map((v) => ({
      screen: name, id: v.id, impact: v.impact, n: v.nodes.length, first: v.nodes[0]?.target,
      // у color-contrast в data лежат fg/bg/ratio/font — без них падение нечем разбирать
      detail: v.nodes[0]?.any.map((c) => c.data) ?? [],
    }));
  if (bad.length) console.log('A11Y NEW BAR:', JSON.stringify(bad, null, 2));
  expect(bad, `axe critical/serious on ${name}`).toEqual([]);
}

async function loginUi(page: Page, email: string, password: string) {
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.goto('/login');
    await page.getByTestId('email').fill(email);
    await page.getByTestId('password').fill(password);
    await page.getByTestId('login-submit').click();
    const ok = await page.getByTestId('home-title').waitFor({ timeout: 10_000 }).then(() => true).catch(() => false);
    if (ok) return;
    await page.waitForTimeout(20_000);
  }
  throw new Error('login failed after retries (rate limit?)');
}

/**
 * Ученик регистрируется сам по одноразовой ссылке. Экран `/register` с полем кода класса выведен
 * из продукта 2026-10-27 (`POST /api/classes/:id/invites` отвечает 410), и это тот путь, который
 * даёт ученика БЕЗ калитки смены пароля: пароль он выбрал сам.
 */
async function registerStudent(page: Page, linkUrl: string, email: string) {
  const token = linkUrl.split('#')[1] ?? '';
  await page.goto(`/join#${token}`);
  await expect(page.getByTestId('join-first')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('join-first').fill('Панель');
  await page.getByTestId('join-last').fill('Тест');
  await page.getByTestId('join-email').fill(email);
  await page.getByTestId('join-password').fill(STUDENT_PW);
  await page.getByTestId('join-consent').check();
  await page.getByTestId('join-register').click();
  await expect(page.getByTestId('join-done-text')).toBeVisible({ timeout: 20_000 });
  await expect(page).toHaveURL(/\/classes\//, { timeout: 20_000 });
  await page.goto('/');
  await expect(page.getByTestId('home-title')).toBeVisible({ timeout: 20_000 });
}

let api: Awaited<ReturnType<typeof pw.newContext>> | null = null;
let token = '';
let classId = '';
let sessionId = '';
let studentLink = '';
const studentEmail = `bar${Date.now()}@x.io`;
let studentReady: Promise<void> | null = null;

test.beforeAll(async () => {
  api = await pw.newContext({ baseURL: BASE });
  const l = await api.post('/api/auth/login', { data: { email: stack.teacherEmail, password: stack.teacherPassword } });
  token = (await l.json()).accessToken as string;
  const H = { authorization: `Bearer ${token}` };
  const cls = await (await api.post('/api/classes', { headers: H, data: { name: `E2E панель ${Date.now()}`, description: '', color: '#0ea5a5' } })).json();
  classId = cls.id as string;
  const s = await (await api.post('/api/lessons/start', { headers: H, data: { classId } })).json();
  sessionId = s.id as string;
  const link = await api.post(`/api/classes/${classId}/invites/link`, { headers: H, data: {} });
  expect(link.status(), `учитель обязан уметь выпускать ссылку: ${link.status()}`).toBe(201);
  studentLink = String((await link.json()).url as string);
});

test.afterAll(async () => {
  if (api && token) {
    await api.post(`/api/lessons/${sessionId}/end`, { headers: { authorization: `Bearer ${token}` }, data: {} }).catch(() => undefined);
  }
  await api?.dispose();
});

/** аккаунт ученика создаётся один раз, тем браузером, который уже есть у теста */
async function ensureStudent(browser: Browser) {
  if (!studentReady) {
    studentReady = (async () => {
      const ctx = await browser.newContext({ baseURL: BASE });
      const page = await ctx.newPage();
      await registerStudent(page, studentLink, studentEmail);
      await ctx.close();
    })();
  }
  await studentReady;
}

async function joinRoom(browser: Browser, who: 'teacher' | 'student') {
  const ctx = await browser.newContext({
    baseURL: BASE, permissions: ['camera', 'microphone'], viewport: { width: 1280, height: 900 },
  });
  const page = await ctx.newPage();
  await loginUi(page, who === 'teacher' ? stack.teacherEmail : studentEmail,
    who === 'teacher' ? stack.teacherPassword : STUDENT_PW);
  await page.goto(`/lesson?classId=${classId}`);
  await page.getByTestId('check-devices').click();
  await expect(page.getByTestId('join-lesson')).toBeEnabled({ timeout: 30_000 });
  await page.getByTestId('join-lesson').click();
  await expect(page.getByTestId('lesson-bar')).toBeVisible({ timeout: 30_000 });
  return { ctx, page };
}

/** урок этого файла надо заново запустить, если предыдущий тест его завершил */
async function ensureLesson() {
  const st = await api!.get(`/api/lessons/active?classId=${classId}`, { headers: { authorization: `Bearer ${token}` } });
  const live = (await st.json())?.session?.id as string | undefined;
  if (live) { sessionId = live; return; }
  const s = await (await api!.post('/api/lessons/start', {
    headers: { authorization: `Bearer ${token}` }, data: { classId },
  })).json();
  sessionId = s.id as string;
}

const roomUrl = async () => {
  const join = await api!.post(`/api/lessons/${sessionId}/join`, { headers: { authorization: `Bearer ${token}` } });
  return String((await join.json()).wsUrl as string);
};

test.describe('панель управления уроком (часть 1, 2026-10-10)', () => {
  test('микрофон, камера, устройства, рука, слово, комментарий и лекция — всё из новой панели', async ({ browser }) => {
    test.setTimeout(420_000);
    await ensureLesson();
    const wsUrl = await roomUrl();
    test.skip(!(await livekitReachable(wsUrl)), 'нужен живой LiveKit — это тест на настоящие публикации');
    await ensureStudent(browser);

    const t = await joinRoom(browser, 'teacher');
    const s = await joinRoom(browser, 'student');

    // ученик виден учителю: и плиткой, и строкой в панели «Участники»
    await expect(async () => {
      const n = await t.page.evaluate(() => document.querySelectorAll('[data-local="0"] video').length);
      expect(n).toBeGreaterThan(0);
    }).toPass({ timeout: 45_000 });
    await openTab(t.page, 'people');
    await expect(t.page.locator('.peer-row')).toHaveCount(1);

    // микрофон: выключить и включить кнопкой панели
    await expect(s.page.getByTestId('mic-toggle')).toHaveAttribute('aria-pressed', 'true');
    await barClick(s.page, 'mic-toggle');
    await expect(s.page.getByTestId('mic-toggle')).toHaveAttribute('aria-pressed', 'false', { timeout: 15_000 });
    await barClick(s.page, 'mic-toggle');
    await expect(s.page.getByTestId('mic-toggle')).toHaveAttribute('aria-pressed', 'true', { timeout: 15_000 });

    // камера
    await expect(s.page.getByTestId('camera-toggle')).toHaveAttribute('aria-pressed', 'true');
    await barClick(s.page, 'camera-toggle');
    await expect(s.page.getByTestId('camera-toggle')).toHaveAttribute('aria-pressed', 'false', { timeout: 15_000 });
    await barClick(s.page, 'camera-toggle');
    await expect(s.page.getByTestId('camera-toggle')).toHaveAttribute('aria-pressed', 'true', { timeout: 15_000 });

    // выбор устройства из меню у стрелки: список закрыт по выборе, состояние выбранного видно
    await barClick(s.page, 'mic-toggle-menu');
    await expect(s.page.getByTestId('mic-menu')).toBeVisible();
    await expect(s.page.getByTestId('mic-pick-default')).toHaveAttribute('aria-checked', 'true');
    await s.page.getByTestId('mic-pick-default').click();
    await expect(s.page.getByTestId('mic-menu')).toHaveCount(0);

    // рука ученика и «дать слово» учителем
    await barClick(s.page, 'raise-hand');
    await expect(s.page.getByTestId('raise-hand')).toHaveAttribute('aria-pressed', 'true');
    await openTab(t.page, 'people');
    const row = t.page.locator('[data-testid^="hand-row-"]').filter({ hasText: 'Панель' });
    await expect(row).toBeVisible({ timeout: 20_000 });
    await row.locator('[data-testid^="hand-grant-"]').click();
    await expect(s.page.getByTestId('floor-banner')).toBeVisible({ timeout: 20_000 });

    // комментарий из вкладки «Комментарии»
    await openTab(s.page, 'comments');
    await s.page.getByTestId('comments-input').fill('а можно пример');
    await s.page.getByTestId('comments-send').click();
    await openTab(t.page, 'comments');
    await expect(t.page.getByTestId('comments-list')).toContainText('а можно пример', { timeout: 20_000 });

    // режим лекции из «Ещё» и баннер у ученика
    await openMore(t.page);
    await t.page.getByTestId('lecture-mode').click();
    // частью 1 (2026-10-13) включение лекции стало требовать подтверждения (там же переключатель
    // «вернуть устройства после»). Утверждения ниже не изменены — добавлен только клик, который
    // теперь обязателен, потому что таков интерфейс.
    await t.page.getByTestId('lecture-confirm-ok').click();
    // подтверждение лежит вне меню «Ещё», а панель закрывает меню на pointerdown вне себя —
    // поэтому состояние кнопки снова проверяется после повторного открытия (проверка та же)
    await openMore(t.page);
    await expect(t.page.getByTestId('lecture-mode')).toHaveAttribute('aria-checked', 'true');
    await expect(s.page.getByTestId('banner-lecture')).toBeVisible({ timeout: 20_000 });
    /*
     * Меню «Ещё» после переключений остаётся открытым (это список настроек, а не одноразовая
     * команда), поэтому дальше — Escape. Заодно это проверка заявленного поведения: Escape закрывает
     * меню панели, и без него следующее нажатие на «⋯» меню бы ЗАКРЫЛО, а не открыло.
     */
    await t.page.keyboard.press('Escape');
    await expect(t.page.getByTestId('more-menu')).toHaveCount(0);

    // автоскрытие: полноэкранный режим убирает панель, движение мыши возвращает
    await t.page.getByTestId('board-toggle').click();
    await expect(t.page.getByTestId('lesson-stage')).toBeVisible({ timeout: 20_000 });
    await openMore(t.page);
    await t.page.getByTestId('fullscreen-btn').click();
    await expect(t.page.getByTestId('lesson-bar')).toHaveAttribute('data-hidden', '1', { timeout: 10_000 });
    await wakeBar(t.page);
    await expect(t.page.getByTestId('lesson-bar')).toHaveAttribute('data-hidden', '0');

    await t.ctx.close();
    await s.ctx.close();
  });

  test('выход: ученик уходит, учитель «Выйти (урок продолжается)», «Завершить для всех» — с подтверждением', async ({ browser }) => {
    test.setTimeout(300_000);
    await ensureLesson();
    const wsUrl = await roomUrl();
    test.skip(!(await livekitReachable(wsUrl)), 'нужен живой LiveKit');
    await ensureStudent(browser);

    const t = await joinRoom(browser, 'teacher');
    const s = await joinRoom(browser, 'student');

    // ученик: красная кнопка выводит из комнаты, урок не трогает
    await barClick(s.page, 'leave-btn');
    await expect(s.page.getByTestId('join-lesson')).toBeVisible({ timeout: 20_000 });
    const afterStudent = await api!.get(`/api/lessons/active?classId=${classId}`, { headers: { authorization: `Bearer ${token}` } });
    expect((await afterStudent.json())?.session?.id).toBe(sessionId);

    // учитель: меню выхода без подтверждения = «Выйти (урок продолжается)»
    await barClick(t.page, 'leave-btn');
    await expect(t.page.getByTestId('leave-menu')).toBeVisible();
    await t.page.getByTestId('leave-keep').click();
    await expect(t.page.getByTestId('join-lesson')).toBeVisible({ timeout: 20_000 });
    const afterTeacher = await api!.get(`/api/lessons/active?classId=${classId}`, { headers: { authorization: `Bearer ${token}` } });
    expect((await afterTeacher.json())?.session?.id).toBe(sessionId);

    // и только «Завершить для всех» со подтверждением заканчивает урок
    await t.page.getByTestId('check-devices').click();
    await t.page.getByTestId('join-lesson').click();
    await barClick(t.page, 'leave-btn');
    await t.page.getByTestId('end-for-all').click();
    await expect(t.page.getByTestId('end-confirm')).toBeVisible();
    /*
     * Отмена оставляет меню открытым: кнопка «⏹» снова видна, и повторный клик по ней — это
     * второй шаг подтверждения, а не новый заход в меню. Клик по `leave-btn` здесь был бы ошибкой
     * самой проверки: кнопка панели переключает своё меню, поэтому второе нажатие закрыл бы его.
     */
    await t.page.getByTestId('end-cancel').click();
    await expect(t.page.getByTestId('end-for-all')).toBeVisible();
    const stillOpen = await api!.get(`/api/lessons/active?classId=${classId}`, { headers: { authorization: `Bearer ${token}` } });
    expect((await stillOpen.json())?.session?.id).toBe(sessionId);
    await t.page.getByTestId('end-for-all').click();
    await expect(t.page.getByTestId('end-for-all-confirm')).toBeVisible();
    await t.page.getByTestId('end-for-all-confirm').click();
    await expect(async () => {
      const st = await api!.get(`/api/lessons/active?classId=${classId}`, { headers: { authorization: `Bearer ${token}` } });
      expect((await st.json()).session).toBeNull();
    }).toPass({ timeout: 30_000 });

    await t.ctx.close();
    await s.ctx.close();
  });

  /*
   * Задача 2026-10-11, п.5: «выбор устройства и включённость запоминаются между уроками».
   * До этого шага требование проверялось только по коду — тест физический: тот же контекст
   * браузера (значит тот же localStorage), реальный выход из комнаты и новый вход в неё.
   * Ключи читаются ровно те, что пишет Lesson.tsx: blublu.camDevice и blublu.camWanted.
   */
  test('выключенная перед выходом камера остаётся выключенной и на следующем входе', async ({ browser }) => {
    test.setTimeout(420_000);
    await ensureLesson();
    const wsUrl = await roomUrl();
    test.skip(!(await livekitReachable(wsUrl)), 'нужен живой LiveKit — это тест на настоящие публикации');
    await ensureStudent(browser);

    const ctx = await browser.newContext({
      baseURL: BASE, permissions: ['camera', 'microphone'], viewport: { width: 1280, height: 900 },
    });
    const page = await ctx.newPage();
    await loginUi(page, studentEmail, STUDENT_PW);
    await page.goto(`/lesson?classId=${classId}`);
    await page.getByTestId('check-devices').click();
    await expect(page.getByTestId('join-lesson')).toBeEnabled({ timeout: 30_000 });
    await page.getByTestId('join-lesson').click();
    await expect(page.getByTestId('lesson-bar')).toBeVisible({ timeout: 30_000 });
    /*
     * Гонка, которую нашёл именно этот тест: полоса управления появляется сразу, а экран
     * проверки устройств живёт, пока `connected` не стал истиной, — то есть несколько секунд обе
     * поверхности отдают одинаковые `cam-pick-*`. Это не поломка интерфейса (экран проверки
     * во время подключения и должен быть виден), но тест обязан ждать настоящего входа, иначе
     * клик по «своей» камере попадает в чужой список.
     */
    await expect(page.getByTestId('device-check')).toHaveCount(0, { timeout: 60_000 });

    // 1) выбор камеры из стрелки кнопки → запоминается deviceId
    await barClick(page, 'camera-toggle-menu');
    await expect(page.getByTestId('cam-menu')).toBeVisible();
    const ids = await page.locator('[data-testid^="cam-pick-"]')
      .evaluateAll((els) => els.map((e) => (e.getAttribute('data-testid') ?? '').replace('cam-pick-', '')));
    const picked = ids.find((x) => x && x !== 'default') ?? '';
    m('cam rows', ids);
    expect(picked, `в списке камер нет настоящего устройства, только ${JSON.stringify(ids)}`).not.toBe('');
    await page.getByTestId(`cam-pick-${picked}`).click();
    await expect(page.getByTestId('cam-menu')).toHaveCount(0);
    expect(await page.evaluate(() => localStorage.getItem('blublu.camDevice'))).toBe(picked);

    // 2) выключенная камера → флаг «хотел выключенной»
    await expect(page.getByTestId('camera-toggle')).toHaveAttribute('aria-pressed', 'true', { timeout: 30_000 });
    await barClick(page, 'camera-toggle');
    await expect(page.getByTestId('camera-toggle')).toHaveAttribute('aria-pressed', 'false', { timeout: 15_000 });
    expect(await page.evaluate(() => localStorage.getItem('blublu.camWanted'))).toBe('0');

    // 3) выход и новый вход тем же контекстом: камера снова выключена, выбор тот же
    await barClick(page, 'leave-btn');
    await expect(page.getByTestId('device-check')).toBeVisible({ timeout: 30_000 });
    if (!(await page.getByTestId('join-lesson').isEnabled())) {
      await page.getByTestId('check-devices').click();
      await expect(page.getByTestId('join-lesson')).toBeEnabled({ timeout: 30_000 });
    }
    await page.getByTestId('join-lesson').click();
    await expect(page.getByTestId('lesson-bar')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('device-check')).toHaveCount(0, { timeout: 60_000 });
    await expect(page.getByTestId('camera-toggle')).toHaveAttribute('aria-pressed', 'false', { timeout: 15_000 });
    const own = page.locator('[data-local="1"] video');
    if (await own.count()) expect(await own.evaluate((v) => v.videoWidth)).toBe(0);
    await barClick(page, 'camera-toggle-menu');
    await expect(page.getByTestId(`cam-pick-${picked}`)).toHaveAttribute('aria-checked', 'true');
    await page.keyboard.press('Escape');

    // микрофон тест не трогает: он остался включённым, и это ровно то, что обещано —
    // запоминается каждый переключатель отдельно
    await expect(page.getByTestId('mic-toggle')).toHaveAttribute('aria-pressed', 'true', { timeout: 15_000 });
    await ctx.close();
  });
  test('без комнаты: количество кнопок, хоткеи и их молчание в поле ввода', async ({ browser }) => {
    test.setTimeout(180_000);
    await ensureLesson();
    await ensureStudent(browser);
    const ctx = await browser.newContext({ baseURL: BASE, viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    await loginUi(page, stack.teacherEmail, stack.teacherPassword);
    await page.goto(`/lesson?classId=${classId}`);
    await expect(page.getByTestId('lesson-bar')).toBeVisible({ timeout: 20_000 });

    // десктоп: не больше 8 кнопок + выход справа (выход в счётчик не входит)
    const desk = await visibleButtons(page);
    const counted = desk.filter((id) => id !== 'leave-btn' && !id.endsWith('-menu') && id !== 'lesson-bar' && !id.endsWith('-badge'));
    expect(counted.length).toBeLessThanOrEqual(8);
    expect(counted).toEqual(expect.arrayContaining(['mic-toggle', 'camera-toggle', 'share-toggle', 'raise-hand',
      'board-toggle', 'comments-open', 'participants-toggle', 'more-btn']));
    expect(desk).toContain('leave-btn');

    /*
     * п.7 задачи: панель не перекрывает контент и не сдвигает его. Проверка геометрическая: у
     * панели есть свой блок в потоке (.bar-slot), поэтому её прямоугольник не должен пересекаться
     * с прямоугольником контента урока, а контент обязан заканчиваться ровно над ней.
     */
    const rects = await page.evaluate(() => {
      const main = document.querySelector('.lesson-main')?.getBoundingClientRect();
      const bar = document.querySelector('.lesson-bar')?.getBoundingClientRect();
      const slot = document.querySelector('.bar-slot')?.getBoundingClientRect();
      return {
        mainBottom: Math.round(main?.bottom ?? -1), barTop: Math.round(bar?.top ?? -1),
        overlap: main && bar
          ? Math.max(0, Math.min(main.bottom, bar.bottom) - Math.max(main.top, bar.top))
            * Math.max(0, Math.min(main.right, bar.right) - Math.max(main.left, bar.left))
          : -1,
        slotH: Math.round(slot?.height ?? 0), barH: Math.round(bar?.height ?? 0),
      };
    });
    m('bar geometry', rects);
    expect(rects.mainBottom, 'контент урока на месте').toBeGreaterThan(0);
    expect(rects.barTop, 'панель на месте').toBeGreaterThan(0);
    expect(rects.overlap, 'ни одного пикселя пересечения панели с контентом').toBe(0);
    expect(rects.mainBottom, 'контент заканчивается над панелью').toBeLessThanOrEqual(rects.barTop);
    expect(rects.slotH, 'высота зарезервирована — автоскрытие не дёргает раскладку')
      .toBeGreaterThanOrEqual(rects.barH);

    /*
     * axe по новому интерфейсу (п.8 задачи: «без critical и serious»): сначала закрытая панель,
     * потом открытое меню «Ещё» — именно в меню живут role=menu/menuitem/menuitemradio, и проверка
     * закрытой панели их не увидела бы.
     */
    await expectAccessible(page, 'lesson bar (collapsed)');
    await openMore(page);
    await expectAccessible(page, 'lesson bar (more menu open)');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('more-menu')).toHaveCount(0);

    // списки устройств убраны с основного экрана: их нет в DOM, пока не открыто меню
    await expect(page.locator('select[data-testid="cam-select"], select[data-testid="mic-select"]')).toHaveCount(0);

    /*
     * Часть 2 задачи (измерено lesson-perf.mjs): закрытая панель комментариев больше не должна
     * опрашивать сервер. Прежний фоновый опрос раз в 20 с давал 16 обращений на двух клиентов
     * за прогон ≈123 с — и сам же обнулял счётчик, потому что GET отмечает прочтение на сервере.
     */
    const commentReqs: string[] = [];
    const watch = (rq: Request) => { if (/\/api\/lessons\/[^/]+\/comments/.test(rq.url())) commentReqs.push(rq.url()); };
    page.on('request', watch);
    await page.waitForTimeout(30_000);
    page.off('request', watch);
    m('closed-panel comment requests / 30s', commentReqs.length);
    expect(commentReqs.length, 'за 30 с с закрытой панелью — ни одного запроса комментариев').toBe(0);

    /*
     * Подписи кнопок обязаны быть КОРОТКИМИ и включаться там, где для них есть место. Числа сняты
     * этим же прогоном: при окне 1024 px доступная ширина полосы — 758 px (266 px съедает боковое
     * меню), а восемь кнопок с подписями занимают 832 px. Значит на 1024…1279 px полоса остаётся
     * иконками, а подписи появляются с 1280 px. Ниже проверяется именно это: ни одной кнопки за
     * правым краем и предсказуемое состояние подписей.
     */
    const captionW = (p: Page) => p.evaluate(() => {
      const el = document.querySelector('[data-testid="mic-toggle"] .bar-lbl');
      return el ? Math.round(el.getBoundingClientRect().width) : -1;
    });
    expect(await captionW(page), 'на 1280 px подпись видна').toBeGreaterThan(0);
    for (const width of [1024, 1280]) {
      await page.setViewportSize({ width, height: width === 1024 ? 800 : 900 });
      await wakeBar(page);
      const fit = await page.evaluate(() => {
        const bar = document.querySelector('.lesson-bar') as HTMLElement | null;
        if (!bar) return null;
        const r = bar.getBoundingClientRect();
        const overflowing = Array.from(bar.querySelectorAll<HTMLElement>('.bar-btn, .bar-split'))
          .filter((b) => b.offsetParent !== null)
          .map((b) => Math.round(b.getBoundingClientRect().right))
          .filter((x) => x > window.innerWidth);
        const lbl = document.querySelector('[data-testid="mic-toggle"] .bar-lbl');
        return {
          barW: Math.round(r.width), viewport: window.innerWidth, overflowing,
          caption: lbl ? Math.round(lbl.getBoundingClientRect().width) : -1,
        };
      });
      m(`bar fits at ${width}`, fit);
      expect(fit, `панель измерена на ${width} px`).not.toBeNull();
      expect(fit!.overflowing, `ни одна кнопка не вылезает за правый край на ${width} px`).toEqual([]);
      expect(fit!.barW, `ширина полосы на ${width} px не больше экрана`).toBeLessThanOrEqual(fit!.viewport);
      const cap = await captionW(page);
      if (width >= 1280) expect(cap, 'с 1280 px подпись видна').toBeGreaterThan(0);
      else expect(cap, `до 1280 px полоса остаётся иконками (${width} px)`).toBe(0);
    }
    await page.setViewportSize({ width: 1280, height: 900 });

    // горячие клавиши открывают и закрывают панели
    await page.keyboard.press('KeyC');
    await expect(page.getByTestId('comments-panel')).toBeVisible();
    await page.keyboard.press('KeyC');
    await expect(page.getByTestId('comments-panel')).toHaveCount(0);
    await page.keyboard.press('KeyP');
    await expect(page.getByTestId('peers-panel')).toBeVisible();
    await page.keyboard.press('KeyP');
    await expect(page.getByTestId('peers-panel')).toHaveCount(0);

    // в поле ввода горячая клавиша — это буква, а не команда
    await openTab(page, 'comments');
    await page.getByTestId('comments-input').click();
    await page.keyboard.type('mcph');
    await expect(page.getByTestId('comments-input')).toHaveValue('mcph');
    await expect(page.getByTestId('peers-panel')).toHaveCount(0);

    // экран проверки устройств: предпросмотр, уровень микрофона и три списка
    await page.getByTestId('check-devices').click();
    await expect(page.getByTestId('preview-video')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('mic-meter')).toBeVisible();
    await expect(page.getByTestId('cam-list')).toBeVisible();
    await expect(page.getByTestId('mic-list')).toBeVisible();
    expect(await page.getByTestId('mic-list').getAttribute('role')).toBe('radiogroup');

    await ctx.close();

    // телефон: 5 кнопок, показ экрана и участники — внутри «Ещё»
    const mctx = await browser.newContext({ baseURL: BASE, viewport: { width: 390, height: 844 } });
    const mpage = await mctx.newPage();
    await loginUi(mpage, stack.teacherEmail, stack.teacherPassword);
    await mpage.goto(`/lesson?classId=${classId}`);
    await expect(mpage.getByTestId('lesson-bar')).toBeVisible({ timeout: 20_000 });
    const mob = await visibleButtons(mpage);
    const mobCounted = mob.filter((id) => id !== 'leave-btn' && !id.endsWith('-menu') && id !== 'lesson-bar' && !id.endsWith('-badge'));
    expect(mobCounted).toHaveLength(5);
    expect(mobCounted).toEqual(expect.arrayContaining(['mic-toggle', 'camera-toggle', 'raise-hand', 'comments-open', 'more-btn']));
    expect(mob).not.toContain('share-toggle');
    expect(mob).not.toContain('participants-toggle');
    expect(mob).not.toContain('board-toggle');
    /*
     * На телефоне под панелью lives нижнее меню приложения (`.tabbar`, position: fixed, z-index 50).
     * Скриншот 390 px это и показал: полоса урока прилипала к низу экрана и исчезала ПОД меню, то
     * есть человек вообще не видел управления. Проверяем геометрически: панель целиком над меню и
     * при этом в кадре без прокрутки.
     */
    const stack2 = await mpage.evaluate(() => {
      const bar = document.querySelector('.lesson-bar')?.getBoundingClientRect();
      const tabs = document.querySelector('.tabbar')?.getBoundingClientRect();
      return {
        barBottom: Math.round(bar?.bottom ?? -1), barTop: Math.round(bar?.top ?? -1),
        tabsTop: Math.round(tabs?.top ?? -1), viewport: window.innerHeight,
        inView: !!bar && bar.top >= 0 && bar.bottom <= window.innerHeight,
      };
    });
    m('mobile bar stack', stack2);
    expect(stack2.tabsTop, 'нижнее меню на месте').toBeGreaterThan(0);
    expect(stack2.inView, 'панель в кадре без прокрутки').toBe(true);
    expect(stack2.barBottom, 'панель не залезает под нижнее меню').toBeLessThanOrEqual(stack2.tabsTop);
    await openMore(mpage);
    await expect(mpage.getByTestId('more-share')).toBeVisible();
    await expect(mpage.getByTestId('more-participants')).toBeVisible();
    await expect(mpage.getByTestId('more-board')).toBeVisible();
    await expect(mpage.getByTestId('hotkeys-list')).toContainText('M');
    await expectAccessible(mpage, 'lesson bar mobile (more menu open)');
    await mctx.close();
  });
});
