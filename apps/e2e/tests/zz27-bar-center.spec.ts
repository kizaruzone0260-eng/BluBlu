/**
 * Часть D (2026-10-17): нижняя панель урока — по центру КОНТЕЙНЕРА СЦЕНЫ, а не окна.
 *
 * Дефект: полоса была `position: fixed; left: 0; right: 0`, то есть её центр совпадал с центром
 * ОКНА, а видео и доска сдвинуты вправо боковой панелью приложения и правой панелью урока.
 * Здесь измеряется ровно то, что обещано: |центр панели − центр сцены| ≤ 2 px при ширинах
 * 1024 / 1280 / 1440 / 1920, при развёрнутой и свёрнутой боковой панели и при открытой и закрытой
 * правой панели.
 *
 * Отрицательный контроль против пустой проверки: в конфигурации «боковая развёрнута + правая
 * открыта» сцена НЕ должна совпадать с центром окна — иначе утверждение про 2 px проходило бы и
 * при прежнем центрировании по окну.
 *
 * Нужна живая комната: панель урока (`[data-testid=lesson-bar]`) появляется только когда
 * `connected`. WebRTC-тест, в CI у job `e2e` есть контейнер LiveKit; локально не запускается.
 *
 * Что этим спеком НЕ проверяется (честно): показ экрана и полноэкранный режим. Пояс считается по
 * прямоугольнику `.lesson-main`, а он от содержимого сцены не зависит; для полноэкранного режима
 * код отдельно пишет центр окна. Проверить это можно только руками — шаги в docs/MANUAL_QA.md.
 */
import { expect, test, request as pw, type Page } from '@playwright/test';
import { BASE, loginUi, m, stack, teacherToken, type Ctx } from './boardFixtures';
import { barClick, openTab, wakeBar } from './controlBar';

/** ширина пояса сцены и центра панели/сцены в координатах окна */
async function centers(page: Page) {
  await wakeBar(page);
  return page.evaluate(() => {
    const bar = document.querySelector<HTMLElement>('[data-testid=lesson-bar]');
    const main = document.querySelector<HTMLElement>('.lesson-main');
    if (!bar || !main) return null;
    const b = bar.getBoundingClientRect();
    const s = main.getBoundingClientRect();
    return {
      bar: b.x + b.width / 2,
      stage: s.x + s.width / 2,
      window: window.innerWidth / 2,
      stageLeft: Math.round(s.left),
      stageRight: Math.round(s.right),
      barW: Math.round(b.width),
      innerW: window.innerWidth,
    };
  });
}

async function setSidebar(page: Page, collapsed: boolean) {
  const isCollapsed = () => page.locator('[data-testid=sidebar]').evaluate((el) => el.classList.contains('collapsed'));
  if ((await isCollapsed()) === collapsed) return;
  await page.getByTestId('sidebar-collapse').click();
  await expect.poll(() => isCollapsed(), { timeout: 10_000 }).toBe(collapsed);
}

/** правая панель урока: участники — одним и тем же пунктом полосы открываются и закрываются */
async function setRightPanel(page: Page, open: boolean) {
  const panel = page.getByTestId('peers-panel');
  const isOpen = async () => await panel.isVisible().catch(() => false);
  if (await isOpen() === open) return;
  if (open) await openTab(page, 'people');
  else await barClick(page, 'participants-toggle');
  await expect.poll(isOpen, { timeout: 15_000, message: `правая панель не ${open ? 'открылась' : 'закрылась'}` })
    .toBe(open);
}

test.describe('панель урока по центру сцены (часть D)', () => {
  let api: Ctx;
  let token = '';
  let classId = '';
  let sessionId = '';

  test.beforeAll(async () => {
    api = await pw.newContext({ baseURL: BASE });
    token = await teacherToken(api);
    const H = { authorization: `Bearer ${token}` };
    const cls = await (await api.post('/api/classes', {
      headers: H, data: { name: `Панель по центру ${Date.now()}`, description: '', color: '#0ea5a5' },
    })).json();
    classId = cls.id as string;
    const s = await (await api.post('/api/lessons/start', { headers: H, data: { classId } })).json();
    sessionId = s.id as string;
  });

  test.afterAll(async () => {
    if (api && token && sessionId) {
      await api.post(`/api/lessons/${sessionId}/end`, { headers: { authorization: `Bearer ${token}` }, data: {} })
        .catch(() => undefined);
    }
    await api?.dispose();
  });

  test('четыре ширины × боковая панель × правая панель', async ({ browser }) => {
    test.setTimeout(420_000);
    const ctx = await browser.newContext({
      baseURL: BASE, permissions: ['camera', 'microphone'], viewport: { width: 1280, height: 900 },
    });
    const page = await ctx.newPage();
    await loginUi(page, stack.teacherEmail, stack.teacherPassword);
    await page.goto(`/lesson?classId=${classId}`);
    await page.getByTestId('check-devices').click();
    await expect(page.getByTestId('join-lesson')).toBeEnabled({ timeout: 40_000 });
    await page.getByTestId('join-lesson').click();
    await expect(page.getByTestId('lesson-bar')).toBeVisible({ timeout: 40_000 });
    await expect(page.locator('.lesson-main')).toBeVisible();

    const rows: { w: number; side: string; panel: string; delta: number; stageOffWindow: number }[] = [];
    for (const width of [1024, 1280, 1440, 1920]) {
      await page.setViewportSize({ width, height: 900 });
      for (const collapsed of [false, true]) {
        await setSidebar(page, collapsed);
        for (const panelOpen of [true, false]) {
          await setRightPanel(page, panelOpen);
          const c = await centers(page);
          expect(c, `нет полосы или сцены при ${width}px`).not.toBeNull();
          const got = c!;
          const delta = Math.abs(got.bar - got.stage);
          const stageOffWindow = Math.abs(got.stage - got.window);
          rows.push({ w: width, side: collapsed ? 'свёрнута' : 'развёрнута', panel: panelOpen ? 'открыта' : 'закрыта',
            delta: Math.round(delta * 100) / 100, stageOffWindow: Math.round(stageOffWindow) });
          // полоса обязана оставаться на экране (центр сдвинулся — края тоже надо смотреть)
          expect(got.bar - got.barW / 2, `левый край полосы ушёл за экран (${width})`).toBeGreaterThanOrEqual(-1);
          expect(got.bar + got.barW / 2, `правый край полосы ушёл за экран (${width})`)
            .toBeLessThanOrEqual(got.innerW + 1);
          // что полоса не перекрывает контент урока — держит zz18 (прямоугольники + слот высоты);
          // здесь проверяется именно центрирование, и ширина пояса фиксируется числом
          if (!collapsed && panelOpen && width <= 1280) {
            // тот самый отрицательный контроль: сцена тут НЕ в центре окна, значит проверка не пустая
            expect(stageOffWindow, `сцена совпала с центром окна — проверка ${width}px ничего не доказывает`)
              .toBeGreaterThan(20);
          }
          expect(delta, `центр полосы не совпал с центром сцены: ${width}px, боковая ${collapsed}, панель ${panelOpen}`)
            .toBeLessThanOrEqual(2);
        }
      }
    }
    m('D центры полосы и сцены', rows);
    expect(rows, 'замер собран по всем конфигурациям').toHaveLength(16);

    await ctx.close();
  });
});
