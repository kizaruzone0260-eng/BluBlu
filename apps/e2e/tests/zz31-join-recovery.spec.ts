/**
 * Восстановление после тупика на странице приглашения (задача 2026-10-26).
 *
 * Исходная жалоба: ученик открыл одноразовую ссылку, ввёл существующую почту — и увидел
 * «Не удалось создать аккаунт. Если вы уже регистрировались, войдите или попросите учителя
 * сбросить пароль». Войти было нечем (форма входа пустая и не связана с приглашением), а
 * сбросить пароль учитель не мог: ученика не было в списке класса.
 *
 * Здесь проверяется весь путь в настоящем браузере, а не только ответы API:
 *  1) новый ученик регистрируется по ссылке и попадает ровно в приглашённый класс;
 *  2) занятая почта — это вход: кнопка переносит почту в форму, неверный пароль не тратит
 *     ссылку, верный — добавляет в класс;
 *  3) повторная ссылка для уже состоящего ученика не плодит членство;
 *  4) учитель, вошедший в браузере, видит объяснение и кнопку «войти учеником»; выход не
 *     теряет приглашение, токен не появляется в адресе;
 *  5) учитель добавляет существующего ученика по почте в свой класс, после чего обычный сброс
 *     пароля работает: временный пароль, обязательная смена, вход с новым;
 *  6) ошибка приглашения переводится на ru/en/uz и не показывает сырых ключей.
 *
 * Все данные создаются теми же эндпоинтами, что и в продукте, с уникальными именами на прогон:
 * база `.e2edata` переживает запуски, поэтому `Date.now()` здесь обязателен.
 */
import { test, expect, request as pw, type BrowserContext, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { BASE, loginUi, stack } from './boardFixtures';

/** POLICY_VERSION не входит в зависимости e2e-пакета — читаем из источника, как zz14. */
function policyVersion(): string {
  const src = readFileSync(new URL('../../../packages/shared/src/constants.ts', import.meta.url), 'utf8');
  const hit = /POLICY_VERSION\s*=\s*'([^']+)'/.exec(src);
  if (!hit?.[1]) throw new Error('POLICY_VERSION not found');
  return hit[1];
}

interface Link { id: string; url: string }
interface Klass { id: string; name: string }

test.describe.serial('приглашение: выход из тупика (2026-10-26)', () => {
  let api: BrowserContext;
  let token = '';
  const stamp = Date.now();
  const existingPassword = 'Secret1234';
  const existingEmail = `join-existing-${stamp}@e2e.io`;
  const studentName = 'Existing Student';

  let clsNew: Klass;
  let linkNew: Link;
  let clsExisting: Klass;
  let linkExisting: Link;
  let linkAgain: Link;
  let clsSwitch: Klass;
  let linkSwitch: Link;
  let clsAdd: Klass;

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

  const tokenOf = (link: Link) => link.url.split('#')[1] ?? '';

  /**
   * Ученик видит на странице класса материалы, а не карточку участников (она учительская).
   * Поэтому «попал в класс» проверяется заголовком класса, а состав — тем же API, которым
   * пользуется карточка учителя: это и есть источник истины для списка.
   */
  async function openClass(page: Page, classId: string, name: string): Promise<void> {
    await expect(page).toHaveURL((u) => u.pathname === `/classes/${classId}`, { timeout: 20_000 });
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(name, { timeout: 20_000 });
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

    clsNew = await makeClass('E2E Join new');
    linkNew = await makeLink(clsNew.id);

    clsExisting = await makeClass('E2E Join existing');
    linkExisting = await makeLink(clsExisting.id);
    linkAgain = await makeLink(clsExisting.id);

    clsSwitch = await makeClass('E2E Join switch');
    linkSwitch = await makeLink(clsSwitch.id);

    clsAdd = await makeClass('E2E Add and reset');

    // существующий ученик с известным паролем; регистрируется обычным путём по ссылке
    const seed = await makeClass('E2E Join seed');
    const seedLink = await makeLink(seed.id);
    const reg = await api.post('/api/invitations/register', {
      data: {
        token: tokenOf(seedLink), firstName: 'Existing', lastName: 'Student',
        email: existingEmail, password: existingPassword,
      },
    });
    expect(reg.status(), reg.status() === 200 ? '' : await reg.text()).toBe(200);
    const studentToken = (await reg.json()).accessToken as string;
    // та же вторая половина, что делает экран регистрации: иначе логин упрётся в согласие
    const acc = await api.post('/api/me/accept-policy', {
      headers: { authorization: `Bearer ${studentToken}` }, data: { version: policyVersion() },
    });
    expect(acc.status(), acc.status() === 200 ? '' : await acc.text()).toBe(200);
  });

  test.afterAll(async () => { await api?.dispose(); });

  test('новый ученик регистрируется по ссылке и попадает именно в приглашённый класс', async ({ page }) => {
    const email = `join-new-${stamp}@e2e.io`;
    await page.goto(linkNew.url);

    // класс назван ДО формы; токена в адресе уже нет
    await expect(page.getByTestId('join-class')).toContainText(clsNew.name, { timeout: 20_000 });
    expect(new URL(page.url()).hash, 'фрагмент вычищен до формы').toBe('');
    expect(page.url()).not.toContain(tokenOf(linkNew));

    await page.getByTestId('join-first').fill('New');
    await page.getByTestId('join-last').fill('Pupil');
    await page.getByTestId('join-email').fill(email);
    await page.getByTestId('join-password').fill('Secret1234');
    await page.getByTestId('join-consent').check();
    await page.getByTestId('join-register').click();

    await expect(page.getByTestId('join-done-text')).toContainText(clsNew.name, { timeout: 25_000 });
    await openClass(page, clsNew.id, clsNew.name);
    const members = await roster(clsNew.id);
    const joined = members.filter((m) => m.email === email);
    expect(joined, 'ровно одна строка ученика в списке класса').toHaveLength(1);
    expect(joined[0]!.name).toBe('New Pupil');

    // ссылка одноразовая: второй заход — уже использована, и токен снова не в адресе
    await page.goto(linkNew.url);
    await expect(page.getByTestId('join-broken')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('auth-error')).toContainText(/использована|already been used|ishlatilgan/i);
    expect(page.url()).not.toContain(tokenOf(linkNew));
  });

  test('занятая почта — это вход: неверный пароль не тратит ссылку', async ({ page }) => {
    await page.goto(linkExisting.url);
    await expect(page.getByTestId('join-class')).toContainText(clsExisting.name, { timeout: 20_000 });

    await page.getByTestId('join-first').fill('Existing');
    await page.getByTestId('join-last').fill('Student');
    await page.getByTestId('join-email').fill(existingEmail);
    await page.getByTestId('join-password').fill('Whatever123');
    await page.getByTestId('join-consent').check();
    await page.getByTestId('join-register').click();

    // это не «не удалось создать аккаунт», а «аккаунт есть — войдите» с готовой кнопкой
    await expect(page.getByTestId('auth-error')).toContainText(/уже существует|already exists|mavjud/i, { timeout: 20_000 });
    await expect(page.getByTestId('join-error-signin')).toBeVisible();
    await page.getByTestId('join-error-signin').click();

    await expect(page.getByTestId('join-signin-form')).toBeVisible();
    await expect(page.getByTestId('join-login-email'), 'почта перенесена в форму входа').toHaveValue(existingEmail);

    // неверный пароль: ошибка на месте, приглашение и форма никуда не делись
    await page.getByTestId('join-login-password').fill('WrongPass123');
    await page.getByTestId('join-signin').click();
    await expect(page.getByTestId('auth-error')).toContainText(/неверн|wrong|noto'g'ri/i, { timeout: 20_000 });
    await expect(page.getByTestId('join-signin-form')).toBeVisible();
    expect(new URL(page.url()).pathname).toBe('/join');
    expect(new URL(page.url()).hash).toBe('');

    // верный пароль — тот же токен доводит вход до класса, аккаунт не создаётся заново
    await page.getByTestId('join-login-password').fill(existingPassword);
    await page.getByTestId('join-signin').click();
    await expect(page.getByTestId('join-done-text')).toContainText(clsExisting.name, { timeout: 25_000 });
    await openClass(page, clsExisting.id, clsExisting.name);
    const members = await roster(clsExisting.id);
    expect(members.filter((m) => m.email === existingEmail)).toHaveLength(1);
    expect(members.some((m) => m.name === studentName), 'имя ученика в списке').toBe(true);
  });

  test('уже состоящий ученик по второй ссылке не получает второе членство', async ({ page }) => {
    await loginUi(page, existingEmail, existingPassword);
    await page.goto(linkAgain.url);
    await expect(page.getByTestId('join-continue'), 'приглашение видно вошедшему').toBeVisible({ timeout: 20_000 });
    await page.getByTestId('join-continue').click();

    await expect(page.getByTestId('join-done-text')).toContainText(clsExisting.name, { timeout: 25_000 });
    await openClass(page, clsExisting.id, clsExisting.name);
    const members = await roster(clsExisting.id);
    expect(members.filter((m) => m.email === existingEmail)).toHaveLength(1);
  });

  test('учитель на ученической ссылке пересаживается, приглашение переживает выход', async ({ page }) => {
    await loginUi(page, stack.teacherEmail, stack.teacherPassword);
    await page.goto(linkSwitch.url);

    await expect(page.getByTestId('join-teacher-note')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('join-switch'), 'у учителя есть явная кнопка, а не тупик').toBeVisible();
    expect(new URL(page.url()).pathname).toBe('/join');
    expect(page.url()).not.toContain(tokenOf(linkSwitch));

    await page.getByTestId('join-switch').click();

    // выход из учительской сессии не уводит на /login и не теряет токен: форма на месте
    await expect(page.getByTestId('join-signin-form')).toBeVisible({ timeout: 25_000 });
    await expect(page).toHaveURL((u) => u.pathname === '/join' && u.hash === '');
    await expect(page.getByTestId('home-title')).toHaveCount(0);
    const html = await page.content();
    expect(html, 'токен не лежит в разметке').not.toContain(tokenOf(linkSwitch));

    await page.getByTestId('join-login-email').fill(existingEmail);
    await page.getByTestId('join-login-password').fill(existingPassword);
    await page.getByTestId('join-signin').click();

    await expect(page.getByTestId('join-done-text')).toContainText(clsSwitch.name, { timeout: 25_000 });
    await openClass(page, clsSwitch.id, clsSwitch.name);
    const members = await roster(clsSwitch.id);
    expect(members.some((m) => m.email === existingEmail)).toBe(true);
    expect(members.some((m) => m.email === stack.teacherEmail), 'учитель не стал учеником').toBe(false);
  });

  test('учитель добавляет существующего ученика по почте, и сброс пароля возвращает вход', async ({ page, browser }) => {
    await loginUi(page, stack.teacherEmail, stack.teacherPassword);
    await page.goto(`/classes/${clsAdd.id}`);
    await expect(page.getByTestId('add-existing-form')).toBeVisible({ timeout: 20_000 });

    // до добавления ученика в списке нет — значит, и сброса для него нет
    const before = page.getByTestId('class-members').locator('tbody tr').filter({ hasText: existingEmail });
    await expect(before).toHaveCount(0);

    const box = page.getByTestId('add-existing');
    await page.getByTestId('add-existing-email').fill(`ghost-${stamp}@e2e.io`);
    await page.getByTestId('add-existing-submit').click();
    await expect(box.getByTestId('auth-error')).toContainText(/нет|not found|topilmadi/i, { timeout: 20_000 });

    // учителя в ученики не добавляют — это отдельный переводимый отказ
    await page.getByTestId('add-existing-email').fill(stack.teacherEmail);
    await page.getByTestId('add-existing-submit').click();
    await expect(box.getByTestId('auth-error')).toContainText(/учител|teacher|o'qituvchi/i, { timeout: 20_000 });

    await page.getByTestId('add-existing-email').fill(existingEmail.toUpperCase());
    await page.getByTestId('add-existing-submit').click();
    await expect(page.getByTestId('add-existing-done')).toContainText(studentName, { timeout: 20_000 });

    const row = page.getByTestId('class-members').locator('tbody tr').filter({ hasText: existingEmail });
    await expect(row).toBeVisible();
    await row.getByTestId('member-reset-pw').click();
    const temp = (await row.getByTestId('member-temp-pw').textContent({ timeout: 20_000 }))?.trim() ?? '';
    expect(temp.length, 'сервер выдал временный пароль').toBeGreaterThanOrEqual(10);

    // ученик входит временным паролем и обязан сменить его, прежде чем увидеть приложение
    const ctx = await browser.newContext({ baseURL: BASE });
    const sp = await ctx.newPage();
    await sp.goto('/login');
    await sp.getByTestId('email').fill(existingEmail);
    await sp.getByTestId('password').fill(temp);
    await sp.getByTestId('login-submit').click();
    await expect(sp.getByTestId('password-gate')).toBeVisible({ timeout: 25_000 });

    await sp.getByTestId('cp-current').fill(temp);
    await sp.getByTestId('cp-new').fill('FreshSecret2026');
    await sp.getByTestId('cp-confirm').fill('FreshSecret2026');
    await sp.getByTestId('cp-submit').click();
    await expect(sp.getByTestId('home-title')).toBeVisible({ timeout: 25_000 });
    await ctx.close();

    // и старый/временный пароль больше не пускает
    const replay = await browser.newContext({ baseURL: BASE });
    const rp = await replay.newPage();
    await rp.goto('/login');
    await rp.getByTestId('email').fill(existingEmail);
    await rp.getByTestId('password').fill(temp);
    await rp.getByTestId('login-submit').click();
    await expect(rp.getByTestId('auth-error')).toBeVisible({ timeout: 20_000 });
    await replay.close();
  });

  test('ошибка приглашения переводится на ru/en/uz и не показывает сырых ключей', async ({ browser }) => {
    const invalid = 'a'.repeat(32);
    const cases = [
      { locale: 'ru', title: 'Приглашение в класс', message: 'Ссылка приглашения не распознана' },
      { locale: 'en', title: 'Class invitation', message: 'This invitation link is not recognised' },
      { locale: 'uz', title: 'Sinfga taklif', message: 'Taklif havolasi tanilmadi' },
    ];
    for (const c of cases) {
      const ctx = await browser.newContext({ baseURL: BASE });
      // язык выбирает человек на этом устройстве — ровно тот же ключ, что пишет LangDropdown
      await ctx.addInitScript((l) => { try { localStorage.setItem('klass_locale', l); } catch { /* none */ } }, c.locale);
      const p = await ctx.newPage();
      await p.goto(`/join#${invalid}`);
      await expect(p.getByTestId('join-broken')).toBeVisible({ timeout: 20_000 });
      await expect(p.getByRole('heading', { level: 1 })).toHaveText(c.title);
      await expect(p.getByTestId('auth-error')).toContainText(c.message);
      const text = await p.getByTestId('join-broken').innerText();
      expect(text, `${c.locale}: сырые ключи`).not.toMatch(/(?:join|auth)\.[a-zA-Z]/);
      expect(p.url(), `${c.locale}: токен не остался в адресе`).not.toContain(invalid);
      await ctx.close();
    }
  });
});
