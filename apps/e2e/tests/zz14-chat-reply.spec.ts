/**
 * Task 2 (2026-10-08) — answering a message in the class chat.
 *
 * Two real browsers, the real REST + WebSocket path: what a quote looks like when it arrives,
 * what happens to it when the original is edited or deleted, and whether clicking it lands on
 * the original — including the case where the original is not on the loaded page yet.
 *
 * The seeding loop is paced (the server allows 5 messages per 10 s per user), which is why the
 * "jump to an unloaded message" test is the slow one; it is also the only test that loads an
 * EARLIER page of history, so it checks the order the pages are stacked in.
 */
import { test, expect, request as pw } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { BASE, loginUi, m, stack, type Ctx } from './boardFixtures';

/**
 * POLICY_VERSION lives in @klass/shared, which this package does not depend on — so the fixture
 * reads the constant from its source instead of hard-coding a date that would rot. The registration
 * screen accepts the policies in a second call (Join.tsx → acceptPolicy), and an account that
 * never accepted them is held at the consent gate: without this the student login below would
 * sit on that gate and never show Home.
 */
function policyVersion(): string {
  const src = readFileSync(new URL('../../../packages/shared/src/constants.ts', import.meta.url), 'utf8');
  const hit = /POLICY_VERSION\s*=\s*'([^']+)'/.exec(src);
  if (!hit?.[1]) throw new Error('POLICY_VERSION not found in packages/shared/src/constants.ts');
  return hit[1];
}

test.describe('chat replies (task 2)', () => {
  let api: Ctx = null as unknown as Ctx;
  let token = '';

  test.beforeAll(async () => {
    api = await pw.newContext({ baseURL: BASE });
    const l = await api.post('/api/auth/login', { data: { email: stack.teacherEmail, password: stack.teacherPassword } });
    expect(l.status(), `teacher login ${l.status()}`).toBe(200);
    token = String((await l.json()).accessToken as string);
  });
  test.afterAll(async () => { await api?.dispose(); });

  /**
   * Класс + ссылка-приглашение + зарегистрированный по ней ученик — всё через API, где возможно.
   *
   * Приём в класс по восьмизначному коду выведен из продукта 2026-10-27 (`POST
   * /api/classes/:id/invites` и `/api/auth/register` отвечают 410), поэтому аккаунт заводится
   * одноразовой ссылкой: `POST /api/classes/:id/invites/link` отдаёт адрес, токен — во фрагменте,
   * а `POST /api/invitations/register` создаёт аккаунт, добавляет в класс и расходует ссылку
   * одним ходом. Ответ даёт тот же `accessToken`, что давала прежняя регистрация.
   */
  async function room(name: string, studentFirst: string) {
    const cls = await (await api.post('/api/classes', {
      headers: { authorization: `Bearer ${token}` },
      data: { name: `${name} ${Date.now()}`, description: '', color: '#0ea5a5' },
    })).json();
    const classId = String((cls as { id: string }).id);
    const inv = await (await api.post(`/api/classes/${classId}/invites/link`, {
      headers: { authorization: `Bearer ${token}` }, data: {},
    })).json();
    const linkToken = new URL(String((inv as { url: string }).url), BASE).hash.slice(1);
    expect(linkToken, 'ссылка обязана нести токен во фрагменте').not.toBe('');
    const email = `e2rep${Date.now()}@x.io`;
    const reg = await api.post('/api/invitations/register', {
      data: { token: linkToken, firstName: studentFirst, lastName: 'Тест', email, password: 'Secret1234' },
    });
    expect(reg.ok(), 'the student registered').toBe(true);
    const studentToken = String((await reg.json()).accessToken as string);
    // the same second call the register page makes — otherwise the account is stuck at the
    // consent gate and loginUi never reaches Home (measured: 300 s timeout on the login step)
    const acc = await api.post('/api/me/accept-policy', {
      headers: { authorization: `Bearer ${studentToken}` }, data: { version: policyVersion() },
    });
    expect(acc.status(), `the student accepted policy ${policyVersion()}`).toBe(200);
    return { classId, email, studentToken };
  }

  const postMsg = (tok: string, classId: string, text: string, replyToId?: string) =>
    api.post(`/api/classes/${classId}/chat/messages`, {
      headers: { authorization: `Bearer ${tok}` },
      data: { text, ...(replyToId ? { replyToId } : {}) },
    });

  /**
   * The UI language is synced from the persisted profile (App.tsx), and other suites and the
   * screenshot scripts PATCH that profile — so a localized string is matched in all three
   * languages instead of being assumed. Same reasoning as zz13's aria-label check.
   */
  const DELETED_RE = /Сообщение удалено|Message deleted|Xabar o‘chirilgan/;

  test('a reply shows the quote, follows an edit of the original, and says so in realtime', async ({ browser }) => {
    test.setTimeout(300_000);
    const { classId, email } = await room('E2E чат ответ', 'Ответчик');
    const ctxT = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const pT = await ctxT.newPage();
    await loginUi(pT, stack.teacherEmail, stack.teacherPassword);
    const ctxS = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const pS = await ctxS.newPage();
    await loginUi(pS, email, 'Secret1234');

    await pT.goto(`/chat/${classId}`);
    await expect(pT.getByTestId('chat-input')).toBeVisible({ timeout: 20_000 });
    await pS.goto(`/chat/${classId}`);
    await expect(pS.getByTestId('chat-input')).toBeVisible({ timeout: 20_000 });

    // the teacher asks something; the student answers it from the ⋯ menu
    await pT.getByTestId('chat-input').fill('Контрольная в пятницу, глава 4');
    await pT.getByTestId('chat-send').click();
    await expect(pT.getByTestId('chat-msg')).toHaveCount(1, { timeout: 15_000 });
    await expect(pS.getByTestId('chat-msg')).toHaveCount(1, { timeout: 15_000 });

    await pS.getByTestId('chat-more').click();
    await expect(pS.getByTestId('chat-act-reply')).toBeVisible();
    // the menu opened for a member who may only ANSWER: the item-7 audience of the other actions
    // is unchanged (the server never accepted a foreign delete either — this keeps the UI honest)
    await expect(pS.getByTestId('chat-act-copy'), 'copy stays with the author and the teacher').toHaveCount(0);
    await expect(pS.getByTestId('chat-act-del'), 'delete stays with the author and the teacher').toHaveCount(0);
    // the teacher's display name is whatever the persisted profile carries (the embedded PG data
    // dir survives a stack restart, and other suites PATCH it), so it is read, not assumed
    const teacherName = await pS.locator('[data-testid=chat-msg]').first()
      .locator('.chat-msg-head strong').innerText();
    await pS.getByTestId('chat-act-reply').click();
    await expect(pS.getByTestId('chat-reply-bar')).toBeVisible();
    await expect(pS.getByTestId('chat-reply-author')).toHaveText(teacherName);
    await expect(pS.getByTestId('chat-reply-snippet')).toHaveText('Контрольная в пятницу, глава 4');
    // the draft keeps its focus — answering must not make the user click again
    expect(await pS.evaluate(() => document.activeElement?.id)).toBe('chat-input');

    await pS.getByTestId('chat-input').fill('А страница 88 тоже?');
    await pS.getByTestId('chat-send').click();
    const quote = pS.locator('[data-testid=chat-msg]:has([data-testid=chat-quote])');
    await expect(quote).toHaveCount(1, { timeout: 15_000 });
    await expect(quote.getByTestId('chat-quote')).toContainText('Контрольная в пятницу, глава 4');
    // the teacher sees the same quote in realtime, without reloading
    await expect(pT.locator('[data-testid=chat-quote]')).toHaveCount(1, { timeout: 15_000 });
    await expect(pT.locator('[data-testid=chat-quote]')).toContainText(teacherName);

    // the snippet is the CURRENT text: editing the original changes every quote of it
    await pT.getByTestId('chat-msg').first().hover();
    await pT.getByTestId('chat-more').first().click();
    await pT.getByTestId('chat-act-edit').click();
    await pT.getByTestId('chat-edit-input').fill('Контрольная в пятницу, глава 5');
    await pT.getByTestId('chat-edit-save').click();
    await expect(pS.locator('[data-testid=chat-quote]')).toContainText('глава 5', { timeout: 15_000 });
    m('quote after the edit', await pS.locator('[data-testid=chat-quote]').innerText());

    // deleting the original turns the quote into «Сообщение удалено» — the answer survives
    pT.on('dialog', (d) => void d.accept());
    await pT.getByTestId('chat-msg').first().hover();
    await pT.locator('[data-testid=chat-more]').first().click();
    await pT.getByTestId('chat-act-del').click();
    await expect(pT.locator('[data-testid=chat-quote]')).toContainText(DELETED_RE, { timeout: 15_000 });
    await expect(pS.locator('[data-testid=chat-quote]')).toContainText(DELETED_RE, { timeout: 15_000 });
    await expect(pS.getByTestId('chat-msg'), 'the answer itself is still there').toHaveCount(1);
    await expect(pS.locator('[data-testid=chat-quote] .chat-quote-text'),
      'nothing of the deleted text is kept').toHaveCount(0);

    await ctxT.close(); await ctxS.close();
  });

  test('a swipe answers, Esc cancels, and the XSS payload stays text in the quote', async ({ browser }) => {
    test.setTimeout(300_000);
    const { classId, email } = await room('E2E чат свайп', 'Свайпер');
    const ctxT = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
    const pT = await ctxT.newPage();
    await loginUi(pT, stack.teacherEmail, stack.teacherPassword);
    await pT.goto(`/chat/${classId}`);
    await expect(pT.getByTestId('chat-input')).toBeVisible({ timeout: 20_000 });
    await pT.getByTestId('chat-input').fill('<img src=x onerror=alert(1)> кто на дежурство?');
    await pT.getByTestId('chat-send').click();
    await expect(pT.getByTestId('chat-msg')).toHaveCount(1);

    const ctxS = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
    const pS = await ctxS.newPage();
    await loginUi(pS, email, 'Secret1234');
    await pS.goto(`/chat/${classId}`);
    await expect(pS.getByTestId('chat-msg')).toHaveCount(1, { timeout: 20_000 });

    // the payload is text, never a node — in the message AND in the quote of it
    const html = await pS.getByTestId('chat-text').innerHTML();
    m('message html', html.slice(0, 120));
    expect(html, 'no img element was created').not.toContain('<img');
    expect(html).toContain('&lt;img');

    // a right swipe (synthetic touch pointer events — a real finger is the manual check)
    await pS.evaluate(() => {
      const el = document.querySelector('[data-testid=chat-text]')!;
      const r = el.getBoundingClientRect();
      const at = { bubbles: true, pointerId: 7, pointerType: 'touch', isPrimary: true };
      el.dispatchEvent(new PointerEvent('pointerdown', { ...at, clientX: r.left + 8, clientY: r.top + 8 }));
      el.dispatchEvent(new PointerEvent('pointermove', { ...at, clientX: r.left + 70, clientY: r.top + 12 }));
      el.dispatchEvent(new PointerEvent('pointerup', { ...at, clientX: r.left + 70, clientY: r.top + 12 }));
    });
    await expect(pS.getByTestId('chat-reply-bar')).toBeVisible({ timeout: 5_000 });
    await pS.getByTestId('chat-input').fill('я!');
    await pS.getByTestId('chat-send').click();
    await expect(pS.locator('[data-testid=chat-quote]')).toHaveCount(1, { timeout: 15_000 });
    const qHtml = await pS.locator('[data-testid=chat-quote]').innerHTML();
    expect(qHtml, 'the quote is escaped too').not.toContain('<img');
    expect(qHtml).toContain('&lt;img');

    // Esc cancels a pending answer without touching the draft or the focus
    await pS.getByTestId('chat-input').fill('черновик');
    await pS.getByTestId('chat-more').first().click();
    await pS.getByTestId('chat-act-reply').click();
    await expect(pS.getByTestId('chat-reply-bar')).toBeVisible();
    await pS.getByTestId('chat-input').press('Escape');
    await expect(pS.getByTestId('chat-reply-bar')).toHaveCount(0);
    expect(await pS.getByTestId('chat-input').inputValue(), 'the draft survived').toBe('черновик');
    expect(await pS.evaluate(() => document.activeElement?.id)).toBe('chat-input');

    await ctxT.close(); await ctxS.close();
  });

  test('clicking a quote jumps to an original that is not loaded yet', async ({ browser }) => {
    test.setTimeout(420_000);
    const { classId, studentToken } = await room('E2E чат цитата', 'Историк');
    /*
     * 1 original + 32 later messages ⇒ the original falls off the first page of 30.
     * The limiter is 5 messages / 10 s PER USER and it is shared with the whole file (workers: 1,
     * so tests 1–2 posted as this same teacher seconds ago — measured: 429 on the 6th message).
     * Settle one window first, then keep each sender at 2 messages per window.
     */
    const settle = (ms = 11_000) => new Promise((r) => setTimeout(r, ms));
    await settle();
    const orig = await postMsg(token, classId, 'САМОЕ ПЕРВОЕ: принести линейку');
    expect(orig.status(), `the original posted: ${JSON.stringify(await orig.json())}`).toBe(201);
    const origId = String((await orig.json()).id);
    for (let i = 0; i < 32; i++) {
      if (i % 4 === 3) await settle();
      const r = i % 2 === 0
        ? await postMsg(token, classId, `сообщение ${i}`)
        : await postMsg(studentToken, classId, `ученик ${i}`);
      expect(r.status(), `message ${i}: ${JSON.stringify(await r.json())}`).toBe(201);
    }
    const rep = await postMsg(studentToken, classId, 'а линейка нужна?', origId);
    expect(rep.status()).toBe(201);
    expect((await rep.json()).replyTo.snippet, 'the server knew the original').toBe('САМОЕ ПЕРВОЕ: принести линейку');

    const ctxS = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const pS = await ctxS.newPage();
    await loginUi(pS, stack.teacherEmail, stack.teacherPassword);
    await pS.goto(`/chat/${classId}`);
    await expect(pS.getByTestId('chat-msg')).toHaveCount(30, { timeout: 20_000 });
    const quote = pS.locator('[data-testid=chat-quote]').first();
    await expect(quote).toContainText('САМОЕ ПЕРВОЕ: принести линейку');
    // the original itself is NOT on screen yet
    await expect(pS.locator(`#chat-msg-${origId}`)).toHaveCount(0);

    await quote.click();
    await expect(pS.locator(`#chat-msg-${origId}`), 'the earlier page was loaded').toBeVisible({ timeout: 20_000 });
    await expect(pS.locator(`#chat-msg-${origId}`)).toHaveClass(/chat-flash/, 'and it is highlighted');
    // chronological order after loading an earlier page: the first rendered message is the oldest
    const order = await pS.locator('[data-testid=chat-msg] [data-testid=chat-text]').allInnerTexts();
    m('thread order after the jump', { first: order[0], last: order[order.length - 1], count: order.length });
    expect(order[0], 'the oldest loaded message comes first').toContain('линейку');
    expect(order.length, '30 + the one earlier page + the answer').toBeGreaterThanOrEqual(31);
    // the highlight fades by itself
    await expect(pS.locator(`#chat-msg-${origId}`)).not.toHaveClass(/chat-flash/, { timeout: 5_000 });
    await ctxS.close();
  });
});
