/**
 * История приглашений за отдельной кнопкой (задача 2026-10-24, часть B).
 *
 * Что здесь доказывается и почему именно так:
 *  • на экране класса записей НЕ видно, пока учитель не нажал кнопку — это и есть требование
 *    «no large history table on the main class screen»;
 *  • окно открывают и закрывают, и закрытое окно не оставляет записей в DOM;
 *  • видны ОБА вида приглашений (ссылка и прежний код) со статусом, подписью и временем расхода;
 *  • активное приглашение отзывается прямо из окна;
 *  • пустой класс даёт понятную пустоту, а не голую таблицу;
 *  • интерфейс не показывает сырые ключи локализации.
 *
 * RTC здесь не нужен: только страница класса. Данные создаются теми же эндпоинтами, чем
 * пользуется сам экран, — чтобы спек не зависел от порядка прогонов и от чужих классов.
 *
 * Вход — в КАЖДОМ тесте. Playwright выдаёт новый контекст на тест (куки и localStorage не
 * переносятся), а `/classes/<id>` без сессии — это редирект на «Вход»: тест, который этого не
 * учитывает, ждёт кнопку `add-student` на экране логина и падает с «element(s) not found»
 * (именно так первый прогон и споткнулся).
 */
import { test, expect, request as pw } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { BASE, loginUi } from './boardFixtures';

/** `.stack.json` появляется на полсекунды позже health-check'а — читаем терпеливо, как flow.spec. */
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

// тот же приём, что в flow.spec.ts: весь набор идёт через один адрес, и 300/мин иногда
// успевают накрыть логин → 429 → пустой токен → падение ниже без внятной причины
async function apiLogin(api: any): Promise<string> {
  for (let i = 0; i < 5; i++) {
    const r = await api.post('/api/auth/login', { data: { email: stack.teacherEmail, password: stack.teacherPassword } });
    if (r.status() === 200) {
      const tok = (await r.json()).accessToken as string;
      if (tok) return tok;
    }
    await new Promise((res) => setTimeout(res, 12_000));
  }
  throw new Error('teacher api login failed after retries (rate limit?)');
}

test.describe.serial('invitation history behind a button', () => {
  let classId = '';
  let linkId = '';
  let codeId = '';

  /**
   * Вход + страница класса одним шагом. Без входа `/classes/<id>` отдаёт экран «Вход», и любой
   * локатор внутри страницы класса висит до таймаута с «element(s) not found».
   */
  async function openClass(page: import('@playwright/test').Page, id?: string): Promise<void> {
    await loginUi(page, stack.teacherEmail, stack.teacherPassword);
    await page.goto(`/classes/${id ?? classId}`);
    await expect(page.getByTestId('add-student')).toBeVisible({ timeout: 20_000 });
  }

  test('teacher: fresh class with one link and one code, both through the real endpoints', async () => {
    const api = await pw.newContext({ baseURL: BASE });
    const token = await apiLogin(api);
    const cls = await (await api.post('/api/classes', {
      headers: { authorization: `Bearer ${token}` }, data: { name: `E2E История ${Date.now()}` },
    })).json();
    classId = cls.id as string;
    expect(classId).toBeTruthy();

    const link = await api.post(`/api/classes/${classId}/invites/link`, {
      headers: { authorization: `Bearer ${token}` }, data: { label: 'Азиза', ttlDays: 7 },
    });
    expect(link.status()).toBe(201);
    linkId = (await link.json()).id as string;

    const code = await api.post(`/api/classes/${classId}/invites`, {
      headers: { authorization: `Bearer ${token}` }, data: { ttlDays: 7 },
    });
    expect(code.status()).toBe(201);
    codeId = (await code.json()).id as string;
    await api.dispose();
  });

  test('the class screen shows a button, not the records', async ({ page }) => {
    await openClass(page);
    // записей на экране нет: ни одной строки истории и самого окна
    await expect(page.locator('[data-testid^="invite-record-"]')).toHaveCount(0);
    await expect(page.getByTestId('invite-history')).toHaveCount(0);
    await expect(page.getByTestId('invite-history-open')).toBeVisible();
  });

  test('the button opens the view, and both kinds of invitation are there with their facts', async ({ page }) => {
    await openClass(page);
    await page.getByTestId('invite-history-open').click();

    const dialog = page.getByTestId('invite-history');
    await expect(dialog).toBeVisible();
    // роль диалога и имя: закрытое состояние доступно с клавиатуры
    await expect(dialog).toHaveAttribute('role', 'dialog');
    await expect(dialog).toHaveAttribute('aria-modal', 'true');

    await expect(page.getByTestId(`invite-record-${linkId}`)).toBeVisible();
    await expect(page.getByTestId(`invite-record-${codeId}`)).toBeVisible();
    await expect(page.getByTestId(`invite-kind-${linkId}`)).toHaveText(/Ссылка|Link|Havola/);
    await expect(page.getByTestId(`invite-kind-${codeId}`)).toHaveText(/Код|Code|Kod/);
    await expect(page.getByTestId(`invite-label-${linkId}`)).toContainText('Азиза');
    // код создаётся без подписи — вместо пустой клетки обязан быть переводимый текст
    await expect(page.getByTestId(`invite-label-${codeId}`)).not.toHaveText('');
    await expect(page.getByTestId(`invite-status-${linkId}`)).toHaveText(/Активн|Active|Faol/);
    await expect(page.getByTestId(`invite-created-${linkId}`)).not.toBeEmpty();
    await expect(page.getByTestId(`invite-expires-${linkId}`)).not.toBeEmpty();
    await expect(page.getByTestId(`invite-used-by-${linkId}`)).toContainText(/не израсходовано|not redeemed|ishlatilmagan/);
    // и ни один токен/код наружу не уехал: в окне есть только идентификатор-разметка
    expect(await dialog.innerText()).not.toMatch(/[A-Za-z0-9_-]{32}/);

    // сырых ключей локализации быть не должно
    expect(await dialog.innerText()).not.toMatch(/classes\.invite/);

    // отзыв живёт только у активного
    await expect(page.getByTestId(`invite-revoke-${linkId}`)).toBeVisible();
  });

  test('revoke works from the view and the record stays readable', async ({ page }) => {
    await openClass(page);
    await page.getByTestId('invite-history-open').click();
    page.once('dialog', (d) => void d.accept());
    await page.getByTestId(`invite-revoke-${linkId}`).click();
    await expect(page.getByTestId(`invite-status-${linkId}`)).toHaveText(/Отозван|Revoked|Bekor/, { timeout: 15_000 });
    // отозванное запись не теряет и кнопку отзыва больше не предлагает
    await expect(page.getByTestId(`invite-record-${linkId}`)).toBeVisible();
    await expect(page.getByTestId(`invite-revoke-${linkId}`)).toHaveCount(0);
  });

  test('the view closes and leaves the class screen as it was', async ({ page }) => {
    await openClass(page);
    const open = page.getByTestId('invite-history-open');
    await open.click();
    await expect(page.getByTestId('invite-history')).toBeVisible();
    await page.getByTestId('invite-history-close').click();
    await expect(page.getByTestId('invite-history')).toHaveCount(0);
    await expect(page.locator('[data-testid^="invite-record-"]')).toHaveCount(0);
    // фокус возвращается на кнопку, которой окно открывали
    await expect(open).toBeFocused();
    // и снова открывается — закрытие не ломает запрос
    await open.click();
    await expect(page.getByTestId(`invite-record-${codeId}`)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('invite-history')).toHaveCount(0);
  });

  test('a class without invitations says so', async ({ page }) => {
    const api = await pw.newContext({ baseURL: BASE });
    const token = await apiLogin(api);
    const cls = await (await api.post('/api/classes', {
      headers: { authorization: `Bearer ${token}` }, data: { name: `E2E Пусто ${Date.now()}` },
    })).json();
    await api.dispose();

    await openClass(page, cls.id as string);
    await page.getByTestId('invite-history-open').click();
    await expect(page.getByTestId('invite-history-empty')).toBeVisible();
    await expect(page.locator('[data-testid^="invite-record-"]')).toHaveCount(0);
  });

  test('creating a link and a code from the card still works after the move', async ({ page }) => {
    await openClass(page);
    // ссылка
    await page.getByTestId('invite-link-label').fill('Бека');
    await page.getByTestId('create-invite-link').click();
    await expect(page.getByTestId('invite-link-box')).toBeVisible({ timeout: 15_000 });
    const url = (await page.getByTestId('invite-link-box').locator('.invite-url').innerText()).trim();
    expect(url).toMatch(/#([A-Za-z0-9_-]{32})$/);
    // предупреждение о личном сообщении обязано остаться в карточке, а не уехать в окно истории
    await expect(page.getByTestId('invite-link-warn')).toBeVisible();
    await page.getByTestId('invite-link-done').click();
    await expect(page.getByTestId('invite-link-box')).toHaveCount(0);
    // прежний путь — код
    await page.getByTestId('create-invite').click();
    await expect(page.getByTestId('invite-code')).toBeVisible({ timeout: 15_000 });
  });

  test('a phone-sized screen reaches the view too, and does not scroll sideways', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openClass(page);
    const overflow = await page.evaluate(() => ({
      doc: document.documentElement.scrollWidth, win: window.innerWidth,
    }));
    expect(overflow.doc, `горизонтального скролла быть не должно: ${JSON.stringify(overflow)}`)
      .toBeLessThanOrEqual(overflow.win + 1);
    await page.getByTestId('invite-history-open').click();
    await expect(page.getByTestId('invite-history')).toBeVisible();
    const inside = await page.getByTestId('invite-history').evaluate((el) => ({
      scrollW: el.scrollWidth, clientW: el.clientWidth,
    }));
    expect(inside.scrollW, `окно не должно резать содержимое: ${JSON.stringify(inside)}`)
      .toBeLessThanOrEqual(inside.clientW + 1);
    await expect(page.getByTestId(`invite-record-${codeId}`)).toBeVisible();
  });
});
