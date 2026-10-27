/**
 * Часть 1 (2026-10-13) — «после режима лекции».
 *
 * Матрица прав и «502 без записи состояния» живут на сервере
 * (`apps/api/test/integration/lecture-restore.test.ts`), арифметика разрешения — в
 * `apps/api/test/unit/floor-permission.test.ts`. Браузером проверяется ровно то, без чего нельзя:
 * что устройство, горевшее в МОМЕНТ включения лекции, включается само после выключения; что
 * выключивший себя во время лекции получает его обратно (это и есть симптом), а выключивший себя
 * ДО — нет; что пришедшему во время лекции не включается ничего; и что кнопка «Выключить» в тосте
 * работает.
 *
 * Почему именно так: при включении режима лекции LiveKit снимает уже опубликованные треки ученика
 * (`LocalTrackUnpublished`, замер 2026-10-13 — раньше в этом шапке было записано обратное). Право
 * возвращается сервером, устройство включает сам клиент, а «что горело до лекции» приходит с
 * сервера (`session.preLecture`): третий тест ниже держит кадры ученика запаздывающими именно
 * поэтому — раньше клиент снимал состояние по кадру и терял возврат, когда сигнал комнаты опережал
 * кадр.
 *
 * Как и в zz17: стороны одного урока говорят на разных языках (задача 1 работает как задумано),
 * поэтому подписи сопоставляются со всеми тремя наборами; без доступного медиа-сервера спек
 * self-skip, а `scripts/ci-no-skips.mjs` не даст такому пропуску притвориться зелёным.
 */
import { test, expect, request as pw, type Browser, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { loginUi, makeLink, makeLesson, registerStudent, stack, teacherToken, type Ctx } from './boardFixtures';
import { openMore } from './controlBar';

const BASE = `http://127.0.0.1:${stack.port}`;
const STUDENT_PW = 'Secret1234';
type Lesson = { lesson: Record<string, string> };
const BUNDLES = (['ru', 'uz', 'en'] as const).map((lng) => JSON.parse(
  readFileSync(new URL(`../../../packages/shared/src/locales/${lng}.json`, import.meta.url), 'utf8'),
) as Lesson);
/** подпись так, как её напишет любой из трёх языков (учитель ru, ученик без выбора — en) */
function anyLoc(...keys: string[]): RegExp {
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const forms = keys.flatMap((k) => BUNDLES.map((b) => b.lesson[k] ?? ''));
  return new RegExp(forms.filter(Boolean).map(esc).join('|'));
}

async function livekitReachable(ws: string): Promise<boolean> {
  if (!ws) return false;
  try {
    const u = new URL(ws);
    await fetch(`${u.protocol === 'wss:' ? 'https' : 'http'}://${u.host}/rtc/v1`, { signal: AbortSignal.timeout(5_000) });
    return true;
  } catch { return false; }
}

test.describe('after lecture mode: devices come back (part 1)', () => {
  let api: Ctx;
  let token = '';
  let classId = '';
  let sessionId = '';
  let aEmail = '';
  let bEmail = '';
  let cEmail = '';

  test.beforeAll(async ({ browser }) => {
    api = await pw.newContext({ baseURL: BASE });
    token = await teacherToken(api);
    const lesson = await makeLesson(api, token, 'Лекция');
    classId = lesson.classId; sessionId = lesson.sessionId;
    const stamp = Date.now();
    aEmail = `lrA${stamp}@x.io`; bEmail = `lrB${stamp}@x.io`; cEmail = `lrC${stamp}@x.io`;
    /*
     * Ссылка-приглашение одноразовая (она списывается первым удачным входом), поэтому на каждого
     * ученика — своя. Прежняя версия файла регистрировала троих по одному ВОСЬМИЗНАЧНОМУ КОДУ
     * класса и падала на втором — тот же закон одноразовости, только код с 2026-10-27 выведен из
     * продукта, и выпускать приходится ссылки (`POST /api/classes/:id/invites` теперь 410).
     */
    const links = [lesson.linkUrl];
    for (let i = 0; i < 2; i++) {
      const r = await makeLink(api, token, classId);
      links.push(r.url);
    }
    for (const [[email, name], link] of [[[aEmail, 'Анна'], links[0]], [[bEmail, 'Борис'], links[1]], [[cEmail, 'Вера'], links[2]]] as const) {
      const p = await (await browser.newContext()).newPage();
      await registerStudent(p, link, name, email);
      await p.context().close();
    }
  });

  test.afterAll(async () => {
    /*
     * Закрытие комнаты: завершаем урок, чтобы LiveKit-комната освободилась. Локально это облачный
     * проект (участники считаются к лимиту), а `ctx.close()` браузера сам по себе не гарантирует
     * мгновенного выхода из комнаты — серверный kick выталкивает участников явно. Best-effort:
     * `/end` не требует медиа-сервера и не должен ронять afterAll, если урок уже закрыт.
     */
    try { await api?.post(`/api/lessons/${sessionId}/end`, { headers: { authorization: `Bearer ${token}` } }); } catch { /* уже закрыт */ }
    await api?.dispose();
  });

  /**
   * Вход в комнату по-настоящему: фейковые устройства, «Проверить устройства», «Войти».
   * Один и тот же путь и для учителя, и для ученика — различие только в пароле.
   */
  async function joinRoom(browser: Browser, email: string, password: string, wsDelay = 0) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    /*
     * Ретранслятор ставится только там, где кадр ученика держат запаздывающим: маршрут
     * `/lecture-mode` отзывает публикацию в комнате ДО того, как шлёт наш кадр, и без задержки
     * живой прогон не доказал бы, что возврат не зависит от того, что пришло раньше.
     */
    if (wsDelay > 0) {
      await page.routeWebSocket('**/api/ws/lesson/**', (route) => {
        const server = route.connectToServer();
        server.onMessage((raw) => {
          const text = typeof raw === 'string' ? raw : raw.toString('utf8');
          let type = '';
          try { type = String((JSON.parse(text) as { type?: string }).type ?? ''); } catch { /* не наш кадр */ }
          if (type === 'lectureMode' || type === 'lecture_off') {
            setTimeout(() => route.send(text), wsDelay);
            return;
          }
          route.send(text);
        });
      });
    }
    await loginUi(page, email, password);
    await page.goto(`/lesson?classId=${classId}`);
    const join = await api.post(`/api/lessons/${sessionId}/join`, { headers: { authorization: `Bearer ${token}` } });
    expect(join.status(), 'урок этого класса обязан открываться для его участников').toBe(200);
    const wsUrl = String((await join.json()).wsUrl as string);
    test.skip(!(await livekitReachable(wsUrl)),
      `LiveKit at ${wsUrl} недоступен: возврат устройств проверяется только в живой комнате`);
    await page.getByTestId('check-devices').click();
    await expect(page.getByTestId('join-lesson')).toBeEnabled({ timeout: 30_000 });
    await page.getByTestId('join-lesson').click();
    await expect(page.getByTestId('mic-toggle')).toBeVisible({ timeout: 30_000 });
    // гонка входа: экран проверки устройств обязан исчезнуть, иначе клики ниже уйдут не туда
    await expect(page.getByTestId('device-check')).toHaveCount(0, { timeout: 60_000 });
    return { ctx, page };
  }

  const teacher = (browser: Browser) => joinRoom(browser, stack.teacherEmail, stack.teacherPassword);
  const student = (browser: Browser, email: string, wsDelay = 0) => joinRoom(browser, email, STUDENT_PW, wsDelay);

  const micOn = (page: Page) => page.getByTestId('mic-toggle').getAttribute('aria-pressed');
  // кнопка камеры в панели называется camera-toggle (mic — mic-toggle); первая версия файла
  // искала cam-toggle и висела на ожидании элемента, которого в разметке нет
  const camOn = (page: Page) => page.getByTestId('camera-toggle').getAttribute('aria-pressed');
  /*
   * getAttribute возвращает Promise, а `expect(promise)` ничего не ждёт — первая версия файла
   * спотыкалась именно об это (`Received: Promise {}`). Для состояний панели — только poll.
   */
  const isMic = (page: Page, want: string, why = '') =>
    expect.poll(() => micOn(page), { timeout: 30_000, message: why || undefined }).toBe(want);
  const isCam = (page: Page, want: string, why = '') =>
    expect.poll(() => camOn(page), { timeout: 30_000, message: why || undefined }).toBe(want);
  /** свой тайл с кадром: трек опубликован, а не «кнопка нажата» */
  const selfPublishesVideo = (page: Page) => page.evaluate(() => [...document.querySelectorAll('.videos video')]
    .some((v) => v.closest('[data-local="1"]') && v.videoWidth > 0));
  /*
   * Только опросом: `aria-pressed` становится true в момент публикации, а `videoWidth` у локального
   * тайла появляется следующим кадром. Однокритичная проверка (`expect(await …)`) ловила этот
   * промежуток и падала «Expected true / Received false» на 1 прогоне из ~8 (замер 2026-10-13).
   */
  const publishesVideo = (page: Page, why: string) =>
    expect.poll(() => selfPublishesVideo(page), { timeout: 30_000, message: why }).toBe(true);

  /**
   * Переключатель возврата — по умолчанию включён; выключить его можно только здесь.
   *
   * После подтверждения меню «Ещё» закрыто (панель ловит pointerdown вне себя — см.
   * LessonBar), поэтому состояние кнопки проверяется после повторного открытия меню: сама
   * проверка при этом та же, что и в zz2/zz18.
   */
  async function lectureOn(page: Page, restore: boolean) {
    await openMore(page);
    await page.getByTestId('lecture-mode').click();
    const dialog = page.getByTestId('lecture-confirm');
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    const box = page.getByTestId('lecture-restore');
    expect(await box.isChecked(), 'переключатель возврата по умолчанию включён').toBe(true);
    if (!restore) await box.uncheck();
    await page.getByTestId('lecture-confirm-ok').click();
    await expect(dialog).toHaveCount(0);
    // состояние проверяем сервером и баннером ученика: сама кнопка живёт в меню «Ещё»,
    // а подтверждение вне этого меню его закрывает (aria-checked кнопки проверяют zz2 и zz18)
    await expect.poll(async () => {
      const r = await api.get(`/api/lessons/active?classId=${classId}`, { headers: { authorization: `Bearer ${token}` } });
      return (await r.json()).session.lectureMode;
    }, { timeout: 20_000 }).toBe(true);
  }
  async function lectureOff(page: Page) {
    await openMore(page);
    await page.getByTestId('lecture-mode').click();
    await expect.poll(async () => {
      const r = await api.get(`/api/lessons/active?classId=${classId}`, { headers: { authorization: `Bearer ${token}` } });
      return (await r.json()).session.lectureMode;
    }, { timeout: 20_000 }).toBe(false);
  }

  test('what burned at the moment of the lecture is what comes back', async ({ browser }) => {
    const t = await teacher(browser);
    const a = await student(browser, aEmail);   // микрофон и камера горят
    const b = await student(browser, bEmail);   // выключит себя САМ до лекции

    // «горело до лекции» обязано быть фактом теста, а не догадкой о дефолтах: включаем явно то,
    // что потом собираемся получить обратно, и проверяем, что включилось
    if (await micOn(a.page) !== 'true') await a.page.getByTestId('mic-toggle').click();
    if (await camOn(a.page) !== 'true') await a.page.getByTestId('camera-toggle').click();
    await isMic(a.page, 'true', 'у Анны микрофон включён до лекции');
    await isCam(a.page, 'true', 'у Анны камера включена до лекции');
    await publishesVideo(a.page, 'камера Анны публикуется');
    await b.page.getByTestId('mic-toggle').click();
    await isMic(b.page, 'false', 'Борис выключил себя сам ДО лекции');

    await lectureOn(t.page, true);
    // Вера приходит уже во время лекции: ей возвращать нечего
    const c = await student(browser, cEmail);
    await isMic(c.page, 'false', 'пришедшая во время лекции молчит');
    // Анна замолкает уже при лекции — это и есть тот случай, который не возвращался
    await a.page.getByTestId('mic-toggle').click();
    await isMic(a.page, 'false', 'Анна выключилась во время лекции');

    await lectureOff(t.page);

    await isMic(a.page, 'true', 'микрофон, горевший в момент включения лекции, обязан включиться сам');
    await isCam(a.page, 'true', 'камера тоже возвращается');
    await publishesVideo(a.page, 'камера вернулась по-настоящему, с кадром');
    await isMic(b.page, 'false', 'выключивший себя ДО лекции остаётся выключенным');
    await isMic(c.page, 'false', 'пришедшему во время лекции ничего не включается');

    const toast = a.page.getByTestId('lesson-toast');
    await expect(toast).toBeVisible();
    expect(await toast.innerText()).toMatch(anyLoc('lectureRestoredMic', 'lectureRestoredBoth'));
    await a.page.getByTestId('lesson-toast-action').click();
    await isMic(a.page, 'false', 'кнопка «Выключить» в тосте обязана работать');

    /*
     * Доступность самого подтверждения проверяется здесь, а не отдельным спеком: диалог живёт
     * только на панели урока, а панель — только в комнате. Отдельным тестом он превратился бы в
     * вечный «skipped» (в CI гейт `ci-no-skips` как раз за такие пропуска и роняет прогон).
     */
    await openMore(t.page);
    await t.page.getByTestId('lecture-mode').click();
    const dialog = t.page.getByTestId('lecture-confirm');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('heading')).toBeVisible();
    expect((await t.page.getByTestId('lecture-restore-row').boundingBox())?.height ?? 0,
      'строка переключателя — не меньше 44 px').toBeGreaterThanOrEqual(44);
    const { AxeBuilder } = await import('@axe-core/playwright');
    const res = await new AxeBuilder({ page: t.page }).include('.modal').analyze();
    expect(res.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious')).toEqual([]);
    await t.page.getByTestId('lecture-confirm-cancel').click();
    await expect(dialog).toHaveCount(0);

    for (const v of [t, a, b, c]) await v.ctx.close();
  });

  test('with the switch off nothing is turned on, and the choice survives a reload', async ({ browser }) => {
    const t = await teacher(browser);
    const a = await student(browser, aEmail);
    if (await micOn(a.page) !== 'true') await a.page.getByTestId('mic-toggle').click();
    await isMic(a.page, 'true', 'микрофон Анны включён до лекции');

    await lectureOn(t.page, false);
    await a.page.getByTestId('mic-toggle').click();
    await isMic(a.page, 'false');

    // решение учителя лежит на сессии: его видит и тот, кто перезагрузил страницу посреди лекции
    await a.page.reload();
    // перезагрузка — это заново пройденный вход (экран проверки устройств и «Войти»), иначе
    // следующая проверка смотрит на страницу, которая ещё не в комнате
    await a.page.getByTestId('check-devices').click();
    await expect(a.page.getByTestId('join-lesson')).toBeEnabled({ timeout: 30_000 });
    await a.page.getByTestId('join-lesson').click();
    await expect(a.page.getByTestId('mic-toggle')).toBeVisible({ timeout: 30_000 });
    await expect(a.page.getByTestId('device-check')).toHaveCount(0, { timeout: 60_000 });
    await isMic(a.page, 'false', 'перезаходивший во время лекции остаётся выключенным');
    const st = await api.get(`/api/lessons/active?classId=${classId}`, { headers: { authorization: `Bearer ${token}` } });
    expect((await st.json()).session.lectureRestore, 'lectureRestore переживает перезагрузку').toBe(false);

    await lectureOff(t.page);
    await isMic(a.page, 'false', 'переключатель выключен — никто сам не включается');
    await expect(a.page.getByTestId('lesson-toast')).toHaveCount(0);
    await expect(a.page.getByTestId('lesson-toast-action')).toHaveCount(0);

    for (const v of [t, a]) await v.ctx.close();
  });

  /**
   * Порядок прихода событий НЕ должен влиять на результат.
   *
   * Маршрут `/lecture-mode` сначала отзывает публикацию в комнате (RoomService), и только потом
   * шлёт наш кадр `lectureMode`. Когда и комната, и API живут на 127.0.0.1 (CI), отзыв успевает
   * дойти до браузера РАНЬШЕ кадра. Спек держит кадры ученика запаздывающими на 8 с — то есть
   * лекция успевает и начаться, и кончиться, пока до ученика доходит сначала кадр включения, а
   * потом выключения. На этом порядке этот спек и ловил два дефекта подряд (2026-10-13):
   *  1) выключение лекции падало в 502, если у одного из участников комната отвалилась ровно
   *     посреди обхода списка (`isParticipantGone`);
   *  2) возврат молча не работал, если ученик шёл за снимком по нашему кадру: к моменту опоздавшего
   *     кадра сервер карту уже стёр (снимок теперь берётся по событию комнаты).
   * Клиент включает устройство по событию возврата права, поэтому здесь проверяется, что обе
   * задержки (отзыв и возврат) не ломают результат, а события комнаты идут своим чередом.
   *
   * ТЕГ @unstable (2026-10-16). Прогон 38844444987: `возврат не зависит от того, что пришло
   * раньше — кадр или отзыв`, ожидание `micOn === 'true'` не дождалось за 30 с. Причина не
   * установлена, и это НЕ правка «подождать дольше»: в том же прогоне LiveKit ответил
   * `MutePublishedTrack muted:false → 412 "remote unmute not enabled"`, то есть сервер по
   * построению не может включить трек сам и полагается на клиента, а здесь порядок arrival'ов
   * намеренно перевёрнут восьмисекундной задержкой кадров. Воспроизвести это локально нельзя
   * (браузерные и RTC-спеки на этой машине не запускаются), менять продукт по одному красному
   * логу — править вслепую. Ручная проверка шагами 1–4 в docs/MANUAL_QA.md; джоб `e2e-unstable`
   * исполняет этот спек на настоящем LiveKit (сервис добавлен туда же), тег не означает «не
   * запускается».
   */
  test('the restore does not depend on whether the room or our socket speaks first @unstable', async ({ browser }) => {
    const t = await teacher(browser);
    const a = await student(browser, aEmail, 8_000);
    if (await micOn(a.page) !== 'true') await a.page.getByTestId('mic-toggle').click();
    if (await camOn(a.page) !== 'true') await a.page.getByTestId('camera-toggle').click();
    await isMic(a.page, 'true', 'микрофон Анны включён до лекции');
    await isCam(a.page, 'true', 'камера Анны включена до лекции');

    await lectureOn(t.page, true);
    // кадры ученика запаздывают на 8 с: за это время комната уже успевает отозвать публикацию
    await lectureOff(t.page);
    await isMic(a.page, 'true', 'возврат не зависит от того, что пришло раньше — кадр или отзыв');
    await isCam(a.page, 'true', 'камера возвращается так же');

    for (const v of [t, a]) await v.ctx.close();
  });

});
