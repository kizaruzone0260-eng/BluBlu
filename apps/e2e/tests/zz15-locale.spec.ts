/**
 * Language default + persistence (task 1, 2026-10-09).
 *
 * Written to reproduce the reported symptom and to pin the cause in facts:
 *  - `users.locale` defaults to 'ru' (apps/api/src/db/schema.ts:39) and the registration INSERT
 *    never sends a locale (apps/api/src/services/auth.ts:53-60), so every account row says 'ru';
 *  - the language picked on the sign-in / register screens is localStorage-only — App.tsx renders
 *    `<LangDropdown me={null} />`, and Nav.tsx:48-58 PATCHes the profile only when `me` exists;
 *  - App.tsx:77 then applies the profile language UNCONDITIONALLY after login and after every
 *    session restore → the user's own choice is overwritten with Russian;
 *  - i18n.ts:17 has no browser detection and defaults to 'ru', and index.html:2 hard-codes
 *    `<html lang="ru">`, which nothing ever updates.
 *
 * Target behaviour (the task): English for a visitor who never chose anything, and
 * profile > localStorage > 'en', where the profile only counts when the user really picked a
 * language (locale_explicit). Every test says below which part of that it pins down.
 */
import { test, expect, request as pw } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { BASE, m, stack, type Ctx } from './boardFixtures';

const LOCALES = ['ru', 'uz', 'en'] as const;
type Loc = typeof LOCALES[number];
const NATIVE: Record<Loc, string> = { ru: 'Русский', uz: 'Oʻzbekcha', en: 'English' };

/** the real translation files, so a test can say «this screen is English» without hard-coding prose */
function bundle(lng: Loc): { home: { title: string }; common: { login: string; save: string }; auth: { profile: string } } {
  return JSON.parse(readFileSync(new URL(`../../../packages/shared/src/locales/${lng}.json`, import.meta.url), 'utf8'));
}
/** which language a visible string is written in (checked against three independent keys) */
function which(text: string): Loc | 'unknown' {
  const t = text.trim();
  for (const lng of LOCALES) {
    const b = bundle(lng);
    if (t === b.home.title || t === b.common.login || t === b.auth.profile) return lng;
  }
  return 'unknown';
}

/** POLICY_VERSION lives in @klass/shared, which this package does not depend on — read it, do not copy it */
function policyVersion(): string {
  const src = readFileSync(new URL('../../../packages/shared/src/constants.ts', import.meta.url), 'utf8');
  const hit = /POLICY_VERSION\s*=\s*'([^']+)'/.exec(src);
  if (!hit?.[1]) throw new Error('POLICY_VERSION not found in packages/shared/src/constants.ts');
  return hit[1];
}

async function pickLanguage(page: import('@playwright/test').Page, lng: Loc) {
  // the trigger's aria-label is itself translated, so it is located by its stable container
  await page.locator('.lang-wrap button').first().click();
  await page.locator('.lang-menu button', { hasText: NATIVE[lng] }).first().click();
}
async function uiLang(page: import('@playwright/test').Page): Promise<{ visible: Loc | 'unknown'; htmlLang: string | null }> {
  const title = await page.getByTestId('home-title').innerText();
  return { visible: which(title), htmlLang: await page.evaluate(() => document.documentElement.lang || null) };
}
async function signIn(page: import('@playwright/test').Page, email: string, password: string) {
  await page.goto('/login');
  await page.getByTestId('email').fill(email);
  await page.getByTestId('password').fill(password);
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('home-title')).toBeVisible({ timeout: 25_000 });
}
async function signOut(page: import('@playwright/test').Page) {
  // «Выйти со всех устройств» asks first (Profile.tsx: signOutEverywhere → confirm)
  page.once('dialog', (d) => void d.accept());
  // without this the helper either passes or hangs with no clue which of the two calls failed
  page.on('response', (r) => {
    if (r.url().includes('/api/auth/')) m('auth call', `${r.request().method()} ${r.url().replace(/^https?:\/\/[^/]+/, '')} → ${r.status()}`);
  });
  await page.goto('/profile');
  await page.getByTestId('logout-all').click();
  await expect(page.getByTestId('email')).toBeVisible({ timeout: 25_000 });
}

test.describe('language default and persistence (task 1)', () => {
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

  /** the seeded teacher's profile, so a test that changes the language can put it back */
  const original = { name: '', locale: 'ru', tz: 'Asia/Tashkent' };
  test.beforeEach(async () => {
    const me = await (await api.get('/api/me', { headers: { authorization: `Bearer ${token}` } })).json();
    original.name = String((me as { name: string }).name);
    original.locale = String((me as { locale: string }).locale);
    original.tz = String((me as { tz: string }).tz);
  });
  test.afterEach(async () => {
    await api.patch('/api/me/profile', { headers: { authorization: `Bearer ${token}` }, data: { ...original } });
  });

  /** a class + an invite, so a test can register a student through the real UI */
  async function invite() {
    const cls = await (await api.post('/api/classes', {
      headers: { authorization: `Bearer ${token}` },
      data: { name: `E2E язык ${Date.now()}`, description: '', color: '#0ea5a5' },
    })).json();
    const inv = await (await api.post(`/api/classes/${(cls as { id: string }).id}/invites`, {
      headers: { authorization: `Bearer ${token}` }, data: {},
    })).json();
    return String((inv as { code: string }).code);
  }

  /**
   * A brand-new student account: `locale` is the product default and `locale_explicit` is false,
   * i.e. nobody has chosen anything. Tests 2 and 4 need exactly that starting point — the shared
   * teacher's profile carries a chosen language (other tests set it), and by the rules of this
   * task an explicit profile WINS over the device, which would make the premise false.
   */
  const PW = 'Secret1234';
  async function freshStudent(): Promise<string> {
    const mail = `langs${Date.now()}@x.io`;
    const reg = await api.post('/api/auth/register', {
      data: { firstName: 'Новый', lastName: 'Ученик', email: mail, password: PW, code: await invite() },
    });
    expect(reg.ok(), 'the student registered').toBe(true);
    const tok = String((await reg.json()).accessToken as string);
    // the register PAGE accepts the policies in a second call; without it the app shows the gate
    const acc = await api.post('/api/me/accept-policy', {
      headers: { authorization: `Bearer ${tok}` }, data: { version: policyVersion() },
    });
    expect(acc.status(), `policy ${policyVersion()}`).toBe(200);
    return mail;
  }

  test('a visitor whose browser is Russian and who never chose a language sees English', async ({ browser }) => {
    const ctx = await browser.newContext({ locale: 'ru-RU' });
    const page = await ctx.newPage();
    await page.goto('/login');
    const label = await page.getByTestId('login-submit').innerText();
    m('login button, ru browser, no stored choice', { button: label, detected: which(label) });
    expect(which(label), 'the sign-in screen is English by default').toBe('en');
    expect(await page.evaluate(() => document.documentElement.lang), 'and <html lang> agrees').toBe('en');
    await ctx.close();
  });

  test('a language picked on the sign-in screen survives the login', async ({ browser }) => {
    const mail = await freshStudent();
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto('/login');
    await pickLanguage(page, 'uz');
    expect(which(await page.getByTestId('login-submit').innerText()),
      'the switch works before login').toBe('uz');
    await signIn(page, mail, PW);
    const after = await uiLang(page);
    m('after login with uz picked on the sign-in screen', after);
    expect(after.visible, 'a profile nobody chose must not override the user\'s choice').toBe('uz');
    expect(after.htmlLang, 'and <html lang> must follow').toBe('uz');
    // the carry-over must have reached the account, not just this browser
    const relog = await api.post('/api/auth/login', { data: { email: mail, password: PW } });
    const u = (await relog.json()) as { user: { locale: string; localeExplicit: boolean } };
    m('the account after the carry-over', u.user);
    expect(u.user.locale, 'the device choice was written into the profile').toBe('uz');
    expect(u.user.localeExplicit, 'and recorded as a real choice').toBe(true);
    await ctx.close();
  });

  test('the choice survives a reload, a logout+login and a second device', async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    try {
      await signIn(page, stack.teacherEmail, stack.teacherPassword);
      await pickLanguage(page, 'en');
      await expect(page.getByTestId('home-title')).toHaveText(bundle('en').home.title);
      // 1) reload — same device, same jar
      await page.reload();
      expect((await uiLang(page)).visible, 'a reload must not change the language').toBe('en');
      // 2) logout and sign in again in the same browser
      await signOut(page);
      await signIn(page, stack.teacherEmail, stack.teacherPassword);
      expect((await uiLang(page)).visible, 'logout + login must not change the language').toBe('en');
      // 3) ANOTHER device: empty localStorage, so only the account can answer. Choosing a
      //    language is an explicit act, so it must have been carried into the profile.
      const ctx2 = await browser.newContext();
      const p2 = await ctx2.newPage();
      await signIn(p2, stack.teacherEmail, stack.teacherPassword);
      const fresh = await uiLang(p2);
      m('second device, empty localStorage', fresh);
      expect(fresh.visible, 'an explicit choice belongs to the account, not to one browser').toBe('en');
      await ctx2.close();
    } finally {
      await ctx.close();
    }
  });

  test('registration keeps the language chosen before signing up', async ({ browser }) => {
    const code = await invite();
    const email = `lang${Date.now()}@x.io`;
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    try {
      await page.goto('/register');
      await pickLanguage(page, 'uz');
      await page.getByTestId('reg-code').fill(code);
      await page.getByTestId('reg-email').fill(email);
      await page.getByTestId('reg-password').fill('Secret1234');
      await page.getByTestId('register-step1').click();
      await page.getByTestId('reg-first').fill('Лингва');
      await page.getByTestId('reg-last').fill('Тест');
      await page.getByTestId('reg-consent').check();
      await page.getByTestId('register-submit').click();
      await expect(page.getByTestId('home-title')).toBeVisible({ timeout: 25_000 });
      const justRegistered = await uiLang(page);
      m('right after registration', justRegistered);
      expect(justRegistered.visible, 'the pre-registration choice must land in the new account').toBe('uz');
      // and on another device, where only the profile is left
      const ctx2 = await browser.newContext();
      const p2 = await ctx2.newPage();
      await signIn(p2, email, 'Secret1234');
      const elsewhere = await uiLang(p2);
      m('the same account on a clean device', elsewhere);
      expect(elsewhere.visible, 'registration wrote the chosen language into the profile').toBe('uz');
      await ctx2.close();
    } finally {
      await ctx.close();
    }
  });

  test('the sidebar switch and the profile page agree', async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    try {
      await signIn(page, stack.teacherEmail, stack.teacherPassword);
      await pickLanguage(page, 'ru');
      await expect(page.getByTestId('home-title')).toHaveText(bundle('ru').home.title);
      await page.goto('/profile');
      expect(await page.locator('#profile-locale').inputValue(),
        'the profile select shows what the sidebar just set').toBe('ru');
      await page.selectOption('#profile-locale', 'en');
      await page.getByTestId('profile-save').click();
      // saving stays on /profile — the page itself must be English now, and the sidebar caption
      // is the other half of the same state
      await expect(page.locator('h1')).toHaveText(bundle('en').auth.profile, { timeout: 20_000 });
      expect(which(await page.locator('h1').innerText()), 'the profile page switched at once').toBe('en');
      expect(await page.locator('.lang-wrap button').first().innerText(),
        'the sidebar caption follows the profile').toContain('EN');
    } finally {
      await ctx.close();
    }
  });
});
