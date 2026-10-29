/**
 * Возврат ученика и сброс пароля (задача 2026-10-28).
 *
 * Три дефекта, найденные локальным воспроизведением, и их проверка в настоящем браузере:
 *  1) после «почта уже занята» экран показывал ДВЕ одинаковые ссылки «уже есть аккаунт? войти» —
 *     человек не понимал, какая из них настоящая;
 *  2) перезагрузка на шаге входа теряла приглашение: токен жил только в памяти страницы, и
 *     действующая ссылка превращалась в «Приглашение не найдено»;
 *  3) после обязательной смены временного пароля `/join` возвращался со старой ошибкой и ждал
 *     ручного «Войти в класс», хотя человек уже вошёл.
 *
 * Здесь же проверяется цикл из постановки: ученика удалили из класса → новая одноразовая ссылка
 * → вход тем же аккаунтом → ровно одна строка членства, без второго аккаунта. И новая карточка
 * временного пароля: показывается один раз, копируется, скрывается.
 */
import { test, expect, request as pw, type BrowserContext } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { BASE, loginUi, stack } from './boardFixtures';

/** POLICY_VERSION не входит в зависимости e2e-пакета — читаем из источника, как zz31. */
function policyVersion(): string {
  const src = readFileSync(new URL('../../../packages/shared/src/constants.ts', import.meta.url), 'utf8');
  const hit = /POLICY_VERSION\s*=\s*'([^']+)'/.exec(src);
  if (!hit?.[1]) throw new Error('POLICY_VERSION not found');
  return hit[1];
}

interface Link { id: string; url: string }
interface Klass { id: string; name: string }

test.describe.serial('возврат ученика и сброс пароля (2026-10-28)', () => {
  let api: BrowserContext;
  let token = '';
  const stamp = Date.now();
  const email = `rejoin-${stamp}@e2e.io`;
  const password = 'Secret1234';
  const changedPassword = 'FreshSecret2026';

  let clsRejoin: Klass;
  let linkBeforeRemove: Link;
  let linkAfterRemove: Link;
  let clsGate: Klass;
  let linkGate: Link;
  let studentId = '';

  async function apiLogin(): Promise<string> {
    for (let i = 0; i < 5; i++) {
      const r = await api.post('/api/auth/login', {
        data: { email: stack.teacherEmail, password: stack.teacherPassword },
      });
      if (r.status() === 200) {
        const t = (await r.json()).accessToken as string;
        if (t) return t;
      }
      await new Promise((res) => setTimeout(res, 12_000));
    }
    throw new Error('teacher api login failed (rate limit?)');
  }

  async function makeClass(name: string): Promise<Klass> {
    const r = await api.post('/api/classes', {
      headers: { authorization: `Bearer ${token}` }, data: { name: `${name} ${stamp}` },
    });
    expect(r.status(), r.status() === 201 ? '' : await r.text()).toBe(201);
    return await r.json() as Klass;
  }

  async function makeLink(classId: string): Promise<Link> {
    const r = await api.post(`/api/classes/${classId}/invites/link`, {
      headers: { authorization: `Bearer ${token}` }, data: {},
    });
    expect(r.status(), r.status() === 201 ? '' : await r.text()).toBe(201);
    return await r.json() as Link;
  }

  async function roster(classId: string): Promise<{ userId: string; name: string; email: string }[]> {
    const r = await api.get(`/api/classes/${classId}/members`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(r.status(), r.status() === 200 ? '' : await r.text()).toBe(200);
    return await r.json() as { userId: string; name: string; email: string }[];
  }

  test.beforeAll(async () => {
    api = await pw.newContext({ baseURL: BASE });
    token = await apiLogin();

    // класс, из которого ученик будет удалён, и ссылка, по которой он туда попал
    clsRejoin = await makeClass('E2E Rejoin');
    linkBeforeRemove = await makeLink(clsRejoin.id);
    const reg = await api.post('/api/invitations/register', {
      data: {
        token: (linkBeforeRemove.url.split('#')[1] ?? ''),
        firstName: 'Re', lastName: 'Join', email, password,
      },
    });
    expect(reg.status(), reg.status() === 200 ? '' : await reg.text()).toBe(200);
    const studentToken = (await reg.json()).accessToken as string;
    const acc = await api.post('/api/me/accept-policy', {
      headers: { authorization: `Bearer ${studentToken}` }, data: { version: policyVersion() },
    });
    expect(acc.status(), acc.status() === 200 ? '' : await acc.text()).toBe(200);
    const me = await api.get('/api/me', { headers: { authorization: `Bearer ${studentToken}` } });
    expect(me.status(), me.status() === 200 ? '' : await me.text()).toBe(200);
    studentId = (await me.json()).id as string;

    // учитель удаляет ученика: аккаунт остаётся, членство — нет
    const del = await api.delete(`/api/classes/${clsRejoin.id}/members/${studentId}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(del.status(), del.status() === 200 ? '' : await del.text()).toBe(200);
    expect((await roster(clsRejoin.id)).filter((m) => m.email === email), 'ученик удалён').toHaveLength(0);

    // новая ссылка — тот же человек должен вернуться тем же аккаунтом
    linkAfterRemove = await makeLink(clsRejoin.id);

    // отдельный класс для проверки «смена временного пароля → автоматический вход по ссылке»
    clsGate = await makeClass('E2E Gate');
    linkGate = await makeLink(clsGate.id);
  });

  test.afterAll(async () => { await api?.dispose(); });

  test('удалённый ученик возвращается по новой ссылке; одна кнопка входа и перезагрузка не теряют приглашение', async ({ page }) => {
    await page.goto(linkAfterRemove.url);
    await expect(page.getByTestId('join-class')).toContainText(clsRejoin.name, { timeout: 20_000 });

    // пытается зарегистрироваться той же почтой — это не ошибка регистрации, это вход
    await page.getByTestId('join-first').fill('Re');
    await page.getByTestId('join-last').fill('Join');
    await page.getByTestId('join-email').fill(email);
    await page.getByTestId('join-password').fill('Whatever123');
    await page.getByTestId('join-consent').check();
    await page.getByTestId('join-register').click();

    await expect(page.getByTestId('auth-error')).toContainText(/уже существует|already exists|mavjud/i, { timeout: 20_000 });
    // дефект 1: подсказка и нижняя ссылка были одинаковыми; остаётся ровно один вход
    await expect(page.getByTestId('join-error-signin')).toBeVisible();
    await expect(page.getByTestId('join-to-signin'), 'второй одинаковой ссылки нет').toHaveCount(0);

    // дефект 2: приглашение и форма входа переживают перезагрузку вкладки
    await page.reload();
    await expect(page.getByTestId('join-class')).toContainText(clsRejoin.name, { timeout: 20_000 });
    await expect(page.getByTestId('join-broken')).toHaveCount(0);
    expect(new URL(page.url()).hash, 'токен снова не остался в адресе').toBe('');
    expect(page.url()).not.toContain(linkAfterRemove.url.split('#')[1] ?? '');

    // после перезагрузки снимок формы потерян, но путь входа один и он на месте
    await page.getByTestId('join-to-signin').click();
    await expect(page.getByTestId('join-signin-form')).toBeVisible();
    await page.getByTestId('join-login-email').fill(email);
    await page.getByTestId('join-login-password').fill(password);
    await page.getByTestId('join-signin').click();

    await expect(page.getByTestId('join-done-text')).toContainText(clsRejoin.name, { timeout: 25_000 });
    await expect(page).toHaveURL((u) => u.pathname === `/classes/${clsRejoin.id}`, { timeout: 20_000 });
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(clsRejoin.name, { timeout: 20_000 });

    const members = await roster(clsRejoin.id);
    expect(members.filter((m) => m.email === email), 'ровно одна строка членства').toHaveLength(1);
  });

  test('временный пароль: обязательная смена и автоматический вход по ссылке', async ({ browser }) => {
    // сброс делает учитель своего класса; временный пароль возвращается один раз
    const reset = await api.post(`/api/classes/${clsRejoin.id}/members/${studentId}/reset-password`, {
      headers: { authorization: `Bearer ${token}` }, data: {},
    });
    expect(reset.status(), reset.status() === 200 ? '' : await reset.text()).toBe(200);
    const temp = (await reset.json()).tempPassword as string;
    expect(temp.length).toBeGreaterThanOrEqual(10);

    const ctx = await browser.newContext({ baseURL: BASE });
    const sp = await ctx.newPage();
    await sp.goto(linkGate.url);
    await expect(sp.getByTestId('join-class')).toContainText(clsGate.name, { timeout: 20_000 });
    await sp.getByTestId('join-to-signin').click();
    await sp.getByTestId('join-login-email').fill(email);
    await sp.getByTestId('join-login-password').fill(temp);
    await sp.getByTestId('join-signin').click();

    // сервер не пускает в класс, пока временный пароль в силе — это тот самый гейт
    await expect(sp.getByTestId('password-gate')).toBeVisible({ timeout: 25_000 });
    await sp.getByTestId('cp-current').fill(temp);
    await sp.getByTestId('cp-new').fill(changedPassword);
    await sp.getByTestId('cp-confirm').fill(changedPassword);
    await sp.getByTestId('cp-submit').click();

    // дефект 3: после смены пароля членство доводится само — без ручного «Войти в класс»
    await expect(sp.getByTestId('join-done-text'), 'автоматический вход после смены пароля').toContainText(clsGate.name, { timeout: 30_000 });
    await expect(sp).toHaveURL((u) => u.pathname === `/classes/${clsGate.id}`, { timeout: 20_000 });
    await expect(sp.getByRole('heading', { level: 1 })).toHaveText(clsGate.name, { timeout: 20_000 });
    await ctx.close();

    const members = await roster(clsGate.id);
    expect(members.filter((m) => m.email === email)).toHaveLength(1);
  });

  test('карточка временного пароля: предупреждение, копирование и скрытие', async ({ page }) => {
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await loginUi(page, stack.teacherEmail, stack.teacherPassword);
    await page.goto(`/classes/${clsRejoin.id}`);
    await expect(page.getByTestId('class-members')).toBeVisible({ timeout: 20_000 });

    const row = page.getByTestId('class-members').locator('tbody tr').filter({ hasText: email });
    await expect(row).toHaveCount(1);
    await row.getByTestId('member-reset-pw').click();

    const box = row.getByTestId('member-temp-pw-box');
    await expect(box).toBeVisible({ timeout: 20_000 });
    await expect(box.getByTestId('member-temp-pw-hint')).toContainText(/один раз|once|bir marta/i);
    const shown = (await box.getByTestId('member-temp-pw').textContent())?.trim() ?? '';
    expect(shown.length).toBeGreaterThanOrEqual(10);

    await box.getByTestId('member-temp-pw-copy').click();
    await expect(box.getByTestId('member-temp-pw-copy')).toHaveText(/Скопировано|Copied|Nusxalandi/i);
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    expect(clip, 'в буфере ровно пароль, а не вся карточка').toBe(shown);

    await box.getByTestId('member-temp-pw-done').click();
    await expect(row.getByTestId('member-temp-pw-box')).toHaveCount(0);
  });
});
