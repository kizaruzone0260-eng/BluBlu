/**
 * zz24 — гонка контролируемого редактора (2026-10-15).
 *
 * Что проверяется. RichText и редактор заметок отдают родителю html КАЖДЫМ символом, родитель
 * перерисовывается и возвращает значение в тот же документ. Если эх приходит позже, чем документ
 * ушёл вперёд (быстрая печать + отложенный рендер), обратная запись возвращает документ НАЗАД —
 * часть набранного теряется или встаёт не в том порядке. Для учителя это потерянный текст: на
 * слабом телефоне окно эха больше, чем в среднем, а не меньше.
 *
 * Почему тест, а не наблюдение. Случай в CI (красный zz10: «Проверка редактораирныйж») поймать
 * на быстрой машине нельзя — мы проверили: за 9 прогонов с приборкой в сборке условие
 * «родитель вернул значение короче документа» не наступило ни разу. Поэтому гонка создаётся
 * искусственно: React планирует пассивные эффекты доставкой через MessagePort, сценарий задерживает
 * КАЖДУЮ доставку на 60 мс — эх родителя гарантированно прилетает в середину печати (в том самом
 * красном прогоне zz10 печатал 7 символов за 23 мс). Плюс отдельный прогон с замедлением CPU в 4
 * раза — так выглядит телефон, а не CI-раннер.
 *
 * Проверки: 60 символов со скоростью 1 мс на символ, переключение жирного и курсива посередине;
 * результат в редакторе и результат на сервере совпадают с набранным побуквенно. Третий тест —
 * смена заметки: последние символы обязаны сохраниться в ТОЙ заметке, где печатали, а не в той,
 * которую открыли сразу после.
 */
import { test, expect, request as pw, type Browser, type Page } from '@playwright/test';
import { BASE, loginUi, stack, teacherToken, type Ctx } from './boardFixtures';

/** Задержка пассивных эффектов React = задержка эха родителя (мс). */
const ECHO_DELAY_MS = 60;
const P1 = 'альфа bravo 0123456789';
const P2 = 'чарли delta 9876543210';
const P3 = 'echo foxtrot 42 юю';
const ALL = P1 + P2 + P3;

/** Без пробелов: их редактор вправе схлопнуть на границе форматирования — порядок букв важнее. */
const norm = (s: string | null | undefined) => (s ?? '').replace(/[\s\u00a0]+/g, '');
const strip = (html: string) => html.replace(/<[^>]*>/g, '');

/** Страница с отложенным эхом родителя; опционально — замедление CPU (телефон). */
async function racePage(browser: Browser, cpuRate = 1): Promise<Page> {
  const ctx = await browser.newContext();
  await ctx.addInitScript((delay) => {
    const proto = (window as unknown as Record<string, { prototype: { postMessage: Function } } | undefined>).MessagePort;
    if (!proto) return;
    const orig = proto.prototype.postMessage;
    proto.prototype.postMessage = function patched(this: unknown, ...args: unknown[]): void {
      setTimeout(() => { orig.apply(this, args as []); }, delay);
    };
  }, ECHO_DELAY_MS);
  const page = await ctx.newPage();
  if (cpuRate > 1) {
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpuRate });
  }
  await loginUi(page, stack.teacherEmail, stack.teacherPassword);
  return page;
}

/** Тот же набор символов, что делал красный zz10: печать → формат → печать → формат → печать. */
async function typeRace(page: Page): Promise<void> {
  await page.locator('.tiptap').click();
  await page.keyboard.type(P1, { delay: 1 });
  await page.getByTestId('rt-bold').click();
  await page.keyboard.type(' ' + P2, { delay: 1 });
  await page.getByTestId('rt-italic').click();
  await page.keyboard.type(' ' + P3, { delay: 1 });
}

test.describe('гонка контролируемого редактора (2026-10-15)', () => {
  let api: Ctx;
  let token = '';
  let classId = '';

  test.beforeAll(async () => {
    api = await pw.newContext({ baseURL: BASE });
    token = await teacherToken(api);
    const res = await api.post('/api/classes', {
      headers: { authorization: `Bearer ${token}` },
      data: { name: `Richtext race ${Date.now()}`, description: '', color: '#0ea5a5' },
    });
    expect(res.status(), 'класс обязан создаться').toBe(201);
    classId = String((await res.json()).id);
  });

  test.afterAll(async () => { await api?.dispose(); });

  test('форма материала: 60 символов с форматами доходят до сервера целыми', async ({ browser }) => {
    test.setTimeout(180_000);
    const page = await racePage(browser);
    try {
      await page.goto(`/classes/${classId}/material/new`);
      await expect(page.getByTestId('material-h1')).toBeVisible({ timeout: 30_000 });
      await typeRace(page);

      // 1) сам редактор: ни одного потерянного или переставленного символа
      expect(norm(await page.locator('.tiptap').textContent()),
        'текст в редакторе обязан совпасть с набранным побуквенно').toBe(norm(ALL));

      // 2) сервер: то же значение должно уйти в POST и лечь в описание
      await page.getByTestId('material-title').fill('Гонка чернил');
      await page.getByTestId('material-publish').click();
      await page.waitForURL(/\/classes\//, { timeout: 30_000 });
      const feed = await api.get(`/api/classes/${classId}/feed`, { headers: { authorization: `Bearer ${token}` } });
      expect(feed.status(), 'лента обязана отдаться').toBe(200);
      const items = (await feed.json()) as { title: string; body: string }[];
      const row = items.find((p) => p.title === 'Гонка чернил');
      expect(row, 'опубликованный материал обязан быть в ленте').toBeTruthy();
      expect(norm(strip(row!.body)),
        'сохранённое описание обязано совпасть с набранным побуквенно').toBe(norm(ALL));
    } finally { await page.context().close(); }
  });

  test('телефон (CPU ×4): тот же набор символов доходит целым', async ({ browser }) => {
    test.setTimeout(240_000);
    const page = await racePage(browser, 4);
    try {
      await page.goto(`/classes/${classId}/material/new`);
      await expect(page.getByTestId('material-h1')).toBeVisible({ timeout: 60_000 });
      await typeRace(page);
      expect(norm(await page.locator('.tiptap').textContent()),
        'под замедлением CPU текст обязан остаться целым').toBe(norm(ALL));
      await page.getByTestId('material-title').fill('Гонка чернил ×4');
      await page.getByTestId('material-publish').click();
      await page.waitForURL(/\/classes\//, { timeout: 60_000 });
    } finally { await page.context().close(); }
  });

  test('заметки: последние символы сохраняются в той заметке, где печатали', async ({ browser }) => {
    test.setTimeout(180_000);
    // два готовых текста, чтобы было на что переключаться
    const tag = `гонка${Date.now()}`;
    const A = `Гонка A ${tag}`;
    const B = `Гонка B ${tag}`;
    const ids: Record<string, string> = {};
    for (const title of [A, B]) {
      const res = await api.post('/api/notes', {
        headers: { authorization: `Bearer ${token}` },
        data: { title, body: `<p>${title}</p>`, classId: null, eventId: null },
      });
      expect(res.status(), `заметка «${title}» обязана создаться`).toBe(201);
      ids[title] = String((await res.json()).id);
    }

    const page = await racePage(browser);
    try {
      await page.goto('/notes');
      const noteA = page.getByTestId('note-item').filter({ hasText: A });
      await expect(noteA).toBeVisible({ timeout: 30_000 });
      await noteA.click();
      await expect(page.locator('.tiptap')).toBeVisible();
      await typeRace(page);
      // и сразу — другая заметка: дебаунс редактора и автосейв ещё не отработали.
      // ЖДЁМ именно запись на сервер (PATCH), иначе проверка успеет прочитать заметки до
      // автосейва и пропустила бы то, что последние символы ушли не туда.
      const saved = page.waitForResponse((r) => r.url().includes('/api/notes/')
        && r.request().method() === 'PATCH', { timeout: 30_000 });
      await page.getByTestId('note-item').filter({ hasText: B }).click();
      await expect(page.getByTestId('note-title')).toHaveValue(B, { timeout: 30_000 });
      expect((await saved).status(), 'автосейв обязан дойти до сервера').toBe(200);

      const rows = await api.get('/api/notes', { headers: { authorization: `Bearer ${token}` } });
      expect(rows.status(), 'список заметок обязан отдаться').toBe(200);
      const list = (await rows.json()) as { id: string; body: string }[];
      const a = list.find((n) => n.id === ids[A])!;
      const b = list.find((n) => n.id === ids[B])!;
      // в A был свой текст — напечатанное обязано лечь ПОСЛЕ него, целиком и в порядке
      expect(norm(strip(a.body)), 'заметка A обязана получить напечатанный текст целиком')
        .toContain(norm(ALL));
      const bText = norm(strip(b.body));
      expect(bText, 'в заметку B не должен перелиться текст из A').not.toContain(norm(ALL));
      expect(bText, 'заметка B обязана остаться собой').toContain(norm(B));
    } finally { await page.context().close(); }
  });
});
