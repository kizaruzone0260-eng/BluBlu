/**
 * Аккаунт ученика создаёт учитель (2026-10-27, часть A).
 *
 * Постановка: экран класса больше не даёт учителю восьмизначный код (способ выведен из продукта,
 * `POST /api/classes/:id/invites` и `/api/auth/register` отвечают 410), зато внутри карточки
 * «Добавить ученика» появился первый способ — завести аккаунт самому: имя, фамилия, почта и
 * ВРЕМЕННЫЙ пароль, который набирает учитель. Здесь доказывается вся цепочка в настоящем браузере:
 *
 *  1) карточка открыта, все поля формы на месте, а кнопки «создать код» нет ни в DOM, ни на
 *     сервере (410 + переводимая причина) — создать код учителю нечем;
 *  2) несовпадение двух вводов отклоняется НА ЭТОМ ЖЕ экране (`sc-mismatch`) и ничего не создаёт;
 *  3) временный пароль, который не проходит политику, тоже не создаёт аккаунт, а переводимый
 *     отказ того же правила смотрим на выжившем экране регистрации `/join` (см. комментарий в
 *     том тесте: форма учителя блокирует такой пароль до запроса, и экрана с текстом у неё нет);
 *  4) удачное создание: `sc-done`, ученик мгновенно в списке класса, поля пароля обнулены;
 *  5) аккаунт от учителя НЕ пускает в приложение, пока ученик не сменит пароль: вход временным
 *     паролем → (сначала согласие с документами: его никто за ученика не ставил) → `password-gate`
 *     → `cp-*` → Home, а сам временный пароль больше не действует;
 *  6) занятая почта: `sc-taken`, НИЧЕЙ пароль не изменён (доказано входом прежним паролем) и
 *     экран сам предлагает добавить найденный аккаунт — `add-existing-match` → подтверждение →
 *     `add-existing-done`;
 *  7) на любом из отказов наружу не торчат технические testid `auth-error-code`/`auth-error-copy`
 *     (владелец убрал идентификатор запроса с экрана 2026-10-27: под красной строкой он выглядел
 *     как часть поломки).
 *
 * Порядок тестов — serial: они идут по одной и той же странице класса, и каждый следующий опирается
 * на данные, которые создал предыдущий. База e2e-стека переживает запуски, поэтому все адреса и
 * имена уникальны на прогон (`stamp`).
 */
import { test, expect, request as pw, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { BASE, loginUi, stack, type Ctx } from './boardFixtures';

/** POLICY_VERSION не входит в зависимости e2e-пакета — читаем из источника, как zz14/zz31. */
function policyVersion(): string {
  const src = readFileSync(new URL('../../../packages/shared/src/constants.ts', import.meta.url), 'utf8');
  const hit = /POLICY_VERSION\s*=\s*'([^']+)'/.exec(src);
  if (!hit?.[1]) throw new Error('POLICY_VERSION not found');
  return hit[1];
}

const PW = {
  /** временный пароль, который набирает учитель (политику проходит: ≥10, буквы, без пробелов) */
  temp: 'Vremen2026parol',
  /** свой пароль ученика после обязательной смены */
  fresh: 'FreshSecret2026',
  /** из списка распространённых (`COMMON_PASSWORDS`) и длиной ровно 10 → отказ политики */
  weak: 'password12',
  /** настоящий пароль уже существующего ученика (его обязуются НЕ трогать) */
  existing: 'Ishuiu2026parol',
  /** пароль, который учитель пытается поставить занятой почте: если бы он применился — тест увидит */
  attempted: 'Chuzhoi2026parol',
};

interface Klass { id: string; name: string }

test.describe.serial('аккаунт ученика создаёт учитель (часть A)', () => {
  let api: Ctx;
  let token = '';
  const stamp = Date.now();
  let clsMain: Klass;
  let clsOther: Klass;
  const createdEmail = `tc-created-${stamp}@e2e.io`;
  const takenEmail = `tc-taken-${stamp}@e2e.io`;
  const takenName = 'Taken Student';

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
    throw new Error('учитель не вошёл через API (лимит запросов?)');
  }

  async function makeClass(name: string): Promise<Klass> {
    const r = await api.post('/api/classes', {
      headers: { authorization: `Bearer ${token}` }, data: { name: `${name} ${stamp}` },
    });
    expect(r.status(), r.status() === 201 ? '' : await r.text()).toBe(201);
    return await r.json() as Klass;
  }

  /** ссылка-приглашение: адрес целиком плюс токен из фрагмента */
  async function makeLink(classId: string): Promise<{ url: string; token: string }> {
    const r = await api.post(`/api/classes/${classId}/invites/link`, {
      headers: { authorization: `Bearer ${token}` }, data: {},
    });
    expect(r.status(), r.status() === 201 ? '' : await r.text()).toBe(201);
    const url = String((await r.json()).url as string);
    return { url, token: new URL(url, BASE).hash.slice(1) };
  }

  async function roster(classId: string): Promise<{ userId: string; name: string; email: string }[]> {
    const r = await api.get(`/api/classes/${classId}/members`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(r.status(), r.status() === 200 ? '' : await r.text()).toBe(200);
    return await r.json() as { userId: string; name: string; email: string }[];
  }

  /** страница класса учителя: без входа сюда попадает экран «Вход», и любой локатор висит */
  async function openClassPage(page: Page, id = clsMain.id): Promise<void> {
    await loginUi(page, stack.teacherEmail, stack.teacherPassword);
    await page.goto(`/classes/${id}`);
    await expect(page.getByTestId('add-student')).toBeVisible({ timeout: 20_000 });
  }

  /**
   * Отказ обязан остаться ОДНОЙ переводимой строкой. `auth-error-code` и `auth-error-copy` — те
   * самые testid, с которыми экран показывал идентификатор запроса и кнопку «копировать»; с
   * 2026-10-27 их в приложении нет, и ни один путь отказа не имеет права их вернуть.
   */
  async function expectNoRawRequestEcho(page: Page, where: string): Promise<void> {
    await expect(page.getByTestId('auth-error-code'), `${where}: кода запроса на экране нет`)
      .toHaveCount(0);
    await expect(page.getByTestId('auth-error-copy'), `${where}: кнопки копирования нет`)
      .toHaveCount(0);
  }

  /** вход в отдельном «устройстве»: возвращает, чем закончился вход */
  async function signIn(browser: Browser, email: string, password: string): Promise<{ page: Page; ctx: BrowserContext }> {
    const ctx = await browser.newContext({ baseURL: BASE });
    const page = await ctx.newPage();
    await page.goto('/login');
    await page.getByTestId('email').fill(email);
    await page.getByTestId('password').fill(password);
    await page.getByTestId('login-submit').click();
    return { page, ctx };
  }

  test.beforeAll(async () => {
    api = await pw.newContext({ baseURL: BASE });
    token = await apiLogin();
    clsMain = await makeClass('E2E Часть A — класс');
    clsOther = await makeClass('E2E Часть A — чужой класс');

    // существующий активный ученик: заведён обычным путём по ссылке, НО не в clsMain — иначе
    // «добавить существующего» нечего подтверждать, и проверка занятой почты теряет смысл
    const seed = await makeLink(clsOther.id);
    const reg = await api.post('/api/invitations/register', {
      data: {
        token: seed.token, firstName: 'Taken', lastName: 'Student',
        email: takenEmail, password: PW.existing,
      },
    });
    expect(reg.status(), reg.status() === 200 ? '' : await reg.text()).toBe(200);
    const studentToken = String((await reg.json()).accessToken as string);
    // вторая половинка экрана регистрации: без принятия документов вход упрётся в калитку условий
    const acc = await api.post('/api/me/accept-policy', {
      headers: { authorization: `Bearer ${studentToken}` }, data: { version: policyVersion() },
    });
    expect(acc.status(), acc.status() === 200 ? '' : await acc.text()).toBe(200);
  });

  test.afterAll(async () => { await api?.dispose(); });

  test('карточка «Добавить ученика»: форма создания есть, кнопки «создать код» — нет', async ({ page }) => {
    await openClassPage(page);
    const card = page.getByTestId('add-student');
    await expect(card).toBeVisible();
    // три способа, и первый — создание аккаунта учителем
    await expect(page.getByTestId('student-create')).toBeVisible();
    await expect(page.getByTestId('add-existing')).toBeVisible();
    await expect(page.getByTestId('invite-link-section')).toBeVisible();
    for (const id of ['sc-first', 'sc-last', 'sc-email', 'sc-password', 'sc-password2', 'sc-submit']) {
      await expect(card.getByTestId(id), `поле ${id} обязано быть на месте`).toHaveCount(1);
    }
    // учить НЕЧЕМ создавать код: кнопки нет, блока с кодом нет, прежний адрес отвечает 410
    await expect(page.getByTestId('create-invite'), 'кнопки «создать код» больше нет').toHaveCount(0);
    await expect(page.getByTestId('invite-code'), 'кода на экране класса нет').toHaveCount(0);
    const retired = await api.post(`/api/classes/${clsMain.id}/invites`, {
      headers: { authorization: `Bearer ${token}` }, data: {},
    });
    expect(retired.status(), 'маршрут выпуска кода выведен, а не удалён: 410').toBe(410);
    expect(String((await retired.json()).error), 'причина переводимая').toBe('enrollmentRetired');
  });

  test('несовпадение и негодный временный пароль ничего не создают', async ({ page }) => {
    await openClassPage(page);
    const box = page.getByTestId('student-create');
    const mail = `tc-mismatch-${stamp}@e2e.io`;

    // 1) два разных ввода: экран обязан сказать это сразу, до запроса
    await page.getByTestId('sc-first').fill('Проверка');
    await page.getByTestId('sc-last').fill('Несовпадение');
    await page.getByTestId('sc-email').fill(mail);
    await page.getByTestId('sc-password').fill(PW.temp);
    await page.getByTestId('sc-password2').fill(`${PW.temp}X`);
    await expect(box.getByTestId('sc-mismatch'), 'подсказка о несовпадении').toBeVisible();
    await page.getByTestId('sc-submit').click();
    await expect(box.getByTestId('sc-done'), 'аккаунт не создан').toHaveCount(0);
    expect((await roster(clsMain.id)).some((m) => m.email === mail), 'строки ученика нет').toBe(false);

    // 2) пароль из списка распространённых: та же `passwordPolicy`, и она стоит ДО отправки,
    // поэтому на этой форме отказа не видно (сообщение смотрим на `/join` ниже) — но аккаунта
    // появиться не должно ни в каком виде
    await page.getByTestId('sc-mismatch').waitFor({ state: 'detached' }).catch(() => undefined);
    await page.getByTestId('sc-password').fill(PW.weak);
    await page.getByTestId('sc-password2').fill(PW.weak);
    await expect(box.getByTestId('sc-mismatch'), 'пароли совпали — подсказки о несовпадении нет')
      .toHaveCount(0);
    await page.getByTestId('sc-submit').click();
    await expect(box.getByTestId('sc-done'), 'слабый пароль не создал аккаунт').toHaveCount(0);
    expect((await roster(clsMain.id)).some((m) => m.email === mail), 'строки ученика нет').toBe(false);
  });

  test('создание: `sc-done`, ученик сразу в списке, поля пароля очищены', async ({ page }) => {
    await openClassPage(page);
    const box = page.getByTestId('student-create');
    await page.getByTestId('sc-first').fill('Готов');
    await page.getByTestId('sc-last').fill('Создан');
    await page.getByTestId('sc-email').fill(createdEmail);
    await page.getByTestId('sc-password').fill(PW.temp);
    await page.getByTestId('sc-password2').fill(PW.temp);
    await page.getByTestId('sc-submit').click();

    await expect(box.getByTestId('sc-done'), 'создание подтверждено именем ученика')
      .toContainText('Готов Создан', { timeout: 20_000 });
    // список обновляется тем же запросом, которым живёт карточка учителя
    const row = page.getByTestId('class-members').locator('tbody tr').filter({ hasText: createdEmail });
    await expect(row, 'ученик виден в списке сразу').toBeVisible({ timeout: 20_000 });
    // членство есть и на сервере — это источник истины для списка
    expect((await roster(clsMain.id)).filter((m) => m.email === createdEmail)).toHaveLength(1);
    // пароль не имеет права оставаться в полях: он уже передан ученику, а форма живёт на экране
    await expect(page.getByTestId('sc-password')).toHaveValue('');
    await expect(page.getByTestId('sc-password2')).toHaveValue('');
    await expectNoRawRequestEcho(page, 'после удачного создания');
  });

  test('временный пароль пускает только через смену: `password-gate` → `cp-*` → Home', async ({ browser }) => {
    const first = await signIn(browser, createdEmail, PW.temp);
    /*
     * Аккаунт создал учитель, поэтому коробка «я прочитал и принимаю» над этим аккаунтом никто
     * не нажимал, и первым в списке калиток стоит согласие с документами (`App.tsx`:
     * policy → name → password). Это часть постановки «ученик получает почту и пароль», а не
     * помеха: принимаем ровно так, как делает живой человек, и только после этого смотрим, что
     * дальше приложение запирает смена пароля.
     */
    await expect(first.page.getByTestId('policy-gate'), 'аккаунт от учителя сначала принимает документы')
      .toBeVisible({ timeout: 25_000 });
    await first.page.getByTestId('gate-accept').click();
    await expect(first.page.getByTestId('password-gate'), 'приложение заперто до смены пароля')
      .toBeVisible({ timeout: 25_000 });
    await expect(first.page.getByTestId('home-title')).toHaveCount(0);

    await first.page.getByTestId('cp-current').fill(PW.temp);
    await first.page.getByTestId('cp-new').fill(PW.fresh);
    await first.page.getByTestId('cp-confirm').fill(PW.fresh);
    await first.page.getByTestId('cp-submit').click();
    await expect(first.page.getByTestId('home-title'), 'смена разблокировала приложение')
      .toBeVisible({ timeout: 25_000 });
    await first.ctx.close();

    // прежний временный пароль больше не действует — даже как пароль ученика этого класса
    const replay = await signIn(browser, createdEmail, PW.temp);
    await expect(replay.page.getByTestId('auth-error'), 'временный пароль отклонён')
      .toBeVisible({ timeout: 20_000 });
    await expect(replay.page.getByTestId('home-title')).toHaveCount(0);
    await expectNoRawRequestEcho(replay.page, 'вход старым временным паролем');
    await replay.ctx.close();

    // а новый работает и ведёт прямо в приложение (калитки больше нет)
    const after = await signIn(browser, createdEmail, PW.fresh);
    await expect(after.page.getByTestId('home-title')).toBeVisible({ timeout: 25_000 });
    await expect(after.page.getByTestId('password-gate')).toHaveCount(0);
    await after.ctx.close();
  });

  test('занятая почта: `sc-taken`, чужой пароль не тронут, и предложение добавить существующего', async ({ page, browser }) => {
    await openClassPage(page);
    const box = page.getByTestId('student-create');
    await page.getByTestId('sc-first').fill('Чужой');
    await page.getByTestId('sc-last').fill('Ученик');
    await page.getByTestId('sc-email').fill(takenEmail);
    await page.getByTestId('sc-password').fill(PW.attempted);
    await page.getByTestId('sc-password2').fill(PW.attempted);
    await page.getByTestId('sc-submit').click();

    await expect(box.getByTestId('sc-taken'), 'экран говорит, что аккаунт уже есть')
      .toBeVisible({ timeout: 20_000 });
    await expect(box.getByTestId('sc-taken'))
      .toContainText(/уже существует|already exists|mavjud/i);
    await expect(box.getByTestId('sc-done'), 'ничего не создано').toHaveCount(0);

    // и отказ наружу — ОДНА переводимая строка без технических идентификаторов. Именно эта:
    // у экрана учителя свой текст (`sc-taken`), а ученическая формулировка `auth.emailTaken`
    // («войдите этой почтой — попадёте в класс») под формой создания не дублируется — две фразы
    // об одном отказе человек прочитал бы как две разные проблемы
    await expect(box.getByTestId('auth-error'), 'второй строки об том же отказе нет').toHaveCount(0);
    await expect(page.getByTestId('sc-taken')).toHaveCount(1);
    await expectNoRawRequestEcho(page, 'отказ занятой почты в форме создания');

    // найденный аккаунт показан ДО подтверждения: имя, почта и класс, куда он попадёт
    const match = page.getByTestId('add-existing-match');
    await expect(match, 'экран сам предложил добавить существующего').toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('add-existing-match-name')).toHaveText(takenName);
    await expect(page.getByTestId('add-existing-match-email')).toHaveText(takenEmail);
    await expect(page.getByTestId('add-existing-match-class')).toHaveText(clsMain.name);

    // ничей пароль НЕ изменён: прежний пароль ученика по-прежнему ведёт в приложение,
    // а попытка учителя поставить свой (`PW.attempted`) не прошла бы даже сбросом
    const stillOurs = await signIn(browser, takenEmail, PW.existing);
    await expect(stillOurs.page.getByTestId('home-title'), 'прежний пароль работает')
      .toBeVisible({ timeout: 25_000 });
    await stillOurs.ctx.close();
    const notThisOne = await signIn(browser, takenEmail, PW.attempted);
    await expect(notThisOne.page.getByTestId('auth-error'), 'набранный учителем пароль не применён')
      .toBeVisible({ timeout: 20_000 });
    await notThisOne.ctx.close();

    // подтверждение — тот же путь, что и у ручного поиска: членство, без нового аккаунта
    await page.getByTestId('add-existing-confirm').click();
    await expect(page.getByTestId('add-existing-done')).toContainText(takenName, { timeout: 20_000 });
    const members = (await roster(clsMain.id)).filter((m) => m.email === takenEmail);
    expect(members, 'ровно одна строка: аккаунт добавлен, а не заведён заново').toHaveLength(1);
  });

  test('тот же отказ политики на выжившем экране регистрации переводимый', async ({ browser }) => {
    /*
     * Правило пароля ОДНО (`passwordPolicy` из @klass/shared), но формы применяют его в разных
     * местах: форма учителя (`student-create`) блокирует отправку ДО запроса и потому текста не
     * показывает, а экран регистрации по ссылке (`/join`) отвечает переводимой строкой
     * (`auth.passwordTooWeak`). Здесь проверяется именно перевод — на выжившем пути, чтобы
     * требование «слабый пароль отклоняется с переводом» не осталось без утверждения.
     */
    const link = await makeLink(clsOther.id);
    const mail = `tc-weak-${stamp}@e2e.io`;
    const ctx = await browser.newContext({ baseURL: BASE });
    const page = await ctx.newPage();
    await page.goto(`/join#${link.token}`);
    await expect(page.getByTestId('join-first')).toBeVisible({ timeout: 20_000 });
    await page.getByTestId('join-first').fill('Слабый');
    await page.getByTestId('join-last').fill('Пароль');
    await page.getByTestId('join-email').fill(mail);
    await page.getByTestId('join-password').fill(PW.weak);
    await page.getByTestId('join-consent').check();
    await page.getByTestId('join-register').click();

    await expect(page.getByTestId('auth-error'), 'отказ политики назван по-человечески')
      .toContainText(/слишком простой|too weak|juda sodda/i, { timeout: 20_000 });
    await expect(page.getByTestId('join-done-text'), 'аккаунт не создан').toHaveCount(0);
    await expectNoRawRequestEcho(page, 'отказ слабого пароля на /join');
    expect((await roster(clsOther.id)).some((m) => m.email === mail), 'ученика в классе нет').toBe(false);
    await ctx.close();
  });
});
