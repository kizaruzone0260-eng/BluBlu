/**
 * Часть 3 (2026-10-14): ученик рисует на доске, если учитель разрешил — глазами двух участников.
 *
 * Серверная половина (право на каждом сообщении, авторство, лимиты, отзыв, «purge») доказана
 * `apps/api/test/integration/board-students.test.ts`, а арифметика авторства —
 * `apps/api/test/unit/board-gate.test.ts`. Этот спек отвечает на то, что сервером не проверяется:
 * видно ли разрешение ученику (значок), остаётся ли доска для просмотра у неразрешённого, доезжает
 * ли чужой штрих до экрана учителя вживую, и что делает с холстом отзыв и «удалить рисунки ученика».
 *
 * Как и в zz19: без доступного медиа-сервера спек пропускает себя сам, а гейт
 * `scripts/ci-no-skips.mjs` не даст такому пропуску притвориться зелёным.
 */
import { test, expect, request as pw, type Browser, type Page } from '@playwright/test';
import postgres from 'postgres';
import {
  BASE, boardGeom, boardScene, expectInk, geomShift, inkAll, inkSeen, loginUi, makeLink, makeLesson, m,
  openLesson, paintStable, registerStudent, revealInk, stack, teacherToken, waitBoard,
  watchBoardSocket, winOf, type Ctx,
} from './boardFixtures';
import { openTab } from './controlBar';

const STUDENT_PW = 'Secret1234';
const DB = `postgres://klass:klass@127.0.0.1:5455/klass`;

async function livekitReachable(ws: string): Promise<boolean> {
  if (!ws) return false;
  try {
    const u = new URL(ws);
    await fetch(`${u.protocol === 'wss:' ? 'https' : 'http'}://${u.host}/rtc/v1`, { signal: AbortSignal.timeout(5_000) });
    return true;
  } catch { return false; }
}

/** identity участника LiveKit = uuid пользователя, поэтому ряд панели ищется по id из базы. */
async function idsByEmail(...emails: string[]): Promise<Record<string, string>> {
  const sql = postgres(DB, { max: 1 });
  try {
    const rows = await sql`select id, email from users where email = any(${emails})`;
    return Object.fromEntries(rows.map((r) => [String(r.email), String(r.id)]));
  } finally { await sql.end({ timeout: 5 }); }
}

test.describe('students drawing on the board (part 3)', () => {
  let api: Ctx;
  let token = '';
  let classId = '';
  let sessionId = '';
  let aEmail = '';
  let bEmail = '';

  test.beforeAll(async ({ browser }) => {
    api = await pw.newContext({ baseURL: BASE });
    token = await teacherToken(api);
    const lesson = await makeLesson(api, token, 'Доска для учеников');
    classId = lesson.classId; sessionId = lesson.sessionId;
    const stamp = Date.now();
    // только строчные буквы: сервер нормализует почту в lower case, а поиск id идёт по
    // точному значению — с заглавной «А» ученик не находился (бордка makeTeacher об этом же)
    aEmail = `bda${stamp}@x.io`; bEmail = `bdb${stamp}@x.io`;
    // ссылка-приглашение одноразовая: на каждого ученика — своя
    const links = [lesson.linkUrl];
    links.push((await makeLink(api, token, classId)).url);
    for (const [[email, name], link] of [[[aEmail, 'Анна'], links[0]], [[bEmail, 'Борис'], links[1]]] as const) {
      const p = await (await browser.newContext()).newPage();
      await registerStudent(p, link, name, email);
      await p.context().close();
    }
  });

  test.afterAll(async () => {
    try { await api?.post(`/api/lessons/${sessionId}/end`, { headers: { authorization: `Bearer ${token}` } }); } catch { /* уже закрыт */ }
    await api?.dispose();
  });

  /** Вход в комнату по-настоящему: фейковые устройства, «Проверить устройства», «Войти». */
  async function join(browser: Browser, email: string, password: string) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    // журнал сокета доски нужен СРАЗУ: отказ сервера приходит одним кадром, и восстановить его
    // постфактум нельзя, а без него «чернил нет» неотличимо от «сервер не принял правку»
    watchBoardSocket(page);
    await loginUi(page, email, password);
    await page.goto(`/lesson?classId=${classId}`);
    const joined = await api.post(`/api/lessons/${sessionId}/join`, { headers: { authorization: `Bearer ${token}` } });
    expect(joined.status(), 'урок этого класса обязан открываться для его участников').toBe(200);
    const wsUrl = String((await joined.json()).wsUrl as string);
    test.skip(!(await livekitReachable(wsUrl)),
      `LiveKit at ${wsUrl} недоступен: доска с двумя участниками проверяется только в живой комнате`);
    await page.getByTestId('check-devices').click();
    await expect(page.getByTestId('join-lesson')).toBeEnabled({ timeout: 30_000 });
    await page.getByTestId('join-lesson').click();
    await expect(page.getByTestId('mic-toggle')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('device-check')).toHaveCount(0, { timeout: 60_000 });
    return { ctx, page };
  }

  const badge = (page: Page) => page.getByTestId('board-draw-badge');
  const viewOnly = (page: Page) => page.getByTestId('board-readonly');
  /** плашка «<имя> нарисовал(а), показать» поверх полотна */
  const chip = (page: Page) => page.getByTestId('board-ink-chip');
  /** переключатель «Рисовать» в строке участника: id = uuid пользователя = identity в комнате */
  const drawBtn = (page: Page, identity: string) => page.getByTestId(`peer-draw-${identity.slice(0, 8)}`);

  test('the grant is visible to the student, and only their own ink is the teacher’s to delete', async ({ browser }) => {
    test.setTimeout(300_000);
    const ids = await idsByEmail(aEmail, bEmail);
    const aId = ids[aEmail]; const bId = ids[bEmail];
    expect(aId && bId, 'оба ученика зарегистрированы').toBeTruthy();

    const t = await join(browser, stack.teacherEmail, stack.teacherPassword);
    const a = await join(browser, aEmail, STUDENT_PW);
    const b = await join(browser, bEmail, STUDENT_PW);
    /*
     * Никакого `openLesson` после входа в комнату: это `page.goto`, то есть выгрузка страницы, а
     * LiveKit SDK на выгрузке отключается сам («Page leave detected, disconnecting» в консоли
     * трассы прогона 38541787520 — все трое отвалились за секунды до проверки). В панели остаются
     * «Участники · 0», потому что список участников читается из комнаты (`refreshPeerList` по
     * `room.remoteParticipants`) — продукт прав, спека сама уничтожала своё условие.
     */
    await waitBoard(t.page);
    await waitBoard(a.page);
    await waitBoard(b.page);

    // 1. по умолчанию не рисует никто: и значка нет, и полотно в режиме просмотра
    await expect(badge(a.page)).toHaveCount(0);
    await expect(viewOnly(a.page)).toBeVisible();
    await expect(viewOnly(b.page)).toBeVisible();

    // точка отсчёта геометрии: право рисования не имеет права двигать или менять полотно
    const geom0 = await boardGeom(a.page);
    expect(geom0.w, 'полотно Анны измерено до выдачи права').toBeGreaterThan(200);
    expect(geom0.h, 'полотно Анны имеет высоту до выдачи права').toBeGreaterThan(200);

    // 2. учитель даёт разрешение Анне — доходит до её экрана без перезагрузки
    await openTab(t.page, 'people');
    // сначала комната: два ряда участников, и только потом чей именно это ряд
    await expect(t.page.locator('.peer-row')).toHaveCount(2, { timeout: 30_000 });
    await expect(drawBtn(t.page, aId)).toBeVisible({ timeout: 30_000 });
    await expect(drawBtn(t.page, aId)).toHaveAttribute('aria-pressed', 'false');
    await drawBtn(t.page, aId).click();
    await expect(badge(a.page), 'значок «вы можете рисовать» появился').toBeVisible({ timeout: 15_000 });
    await expect(badge(b.page), 'Борис не разрешён').toHaveCount(0, { timeout: 5_000 });
    await expect(viewOnly(b.page)).toBeVisible();
    {
      const s = geomShift(geom0, await boardGeom(a.page));
      expect(s.max, `выдача права не сдвигает и не меняет полотно (допуск 2 px), разнос ${JSON.stringify(s.d)}`)
        .toBeLessThanOrEqual(2);
    }

    // 3. Анна рисует — штрих виден и у неё, и у учителя.
    // Считается ВСЁ полотно, а не окно слота (`inkSeen`): у Excalidraw собственный viewport, и в
    // живом уроке содержимое может оказаться не в верхнем левом углу элемента — «штриха нет» тогда
    // означает лишь «штрих не здесь». Смысл проверки от этого не меняется: чернила появились.
    /*
     * Отрицательная проверка «метки нет, когда рисунок уже в поле зрения» требует предусловия,
     * которого здесь не было: метка ставится В МОМЕНТ прихода чернил, а `inkSeen` сам возвращает
     * вид к содержимому (`.scroll-back-to-content`) — то есть измеритель успевал поправить то, что
     * мерит, и падение выглядело как «продукт сам себе противоречит». Прогон 38844444987 это и
     * показал: `метка не появляется, когда рисунок уже виден` → Expected 0, Received 1.
     * Теперь предусловие устанавливается ДО рисования и называется числом: полотно учителя обязано
     * быть не уже и не ниже окна слота A, иначе «не видно» законно и проверять нечего.
     */
    await revealInk(t.page);
    const viewT = await boardGeom(t.page);
    const winA = winOf('A');
    m('teacher canvas vs slot A window', { viewT, winA });
    expect(viewT.w, `полотно учителя (${viewT.w}×${viewT.h}) не шире окна слота A (${winA.w}×${winA.h})`)
      .toBeGreaterThanOrEqual(winA.x + winA.w);
    expect(viewT.h, `полотно учителя (${viewT.w}×${viewT.h}) не выше окна слота A (${winA.w}×${winA.h})`)
      .toBeGreaterThanOrEqual(winA.y + winA.h);
    const before = await inkSeen(t.page);
    await paintStable(a.page, 'A');
    // сначала у неё самой: не лёг штрих — это рисование, а не распространение по WS
    await expectInk(a.page, { before, label: 'штрих Анны виден у неё на полотне', timeout: 15_000 });
    await expectInk(t.page, { before, label: 'штрих ученика доехал до учителя', timeout: 30_000 });
    const inkAfterA = await inkSeen(t.page);
    /*
     * Отрицательная проверка «метки нет, когда рисунок уже в поле зрения» перенесена в тест
     * «метка молчит, когда ей молчать положено» (он под тегом @unstable) — 2026-10-17.
     * Причина переноса, а не «починки»: тот же шаг был зелёным в прогоне 38946053241 и красным
     * в 38949336521 при неизменной спеке (между прогонами менялись только shell-скрипт и
     * документы). Предусловие «учитель видел этот штрих» нельзя доказать тем же инструментом,
     * которым измеряется факт: `inkSeen` считает ХОЛСТ ЦЕЛИКОМ, а метка ставится по ВИДИМОЙ
     * ОБЛАСТИ сцены, и координаты штриха ученика в сцене зависят от его собственного полотна.
     * Геометрическая стража выше (полотно учителя не меньше окна слота A) проходит — значит дело
     * не в размере холста, а в том, куда именно лёг штрих. Проверка не удалена: она исполняется
     * в джобе `e2e-unstable`, а здесь остаются право, значок, доезд чернил, отзыв и «удалить
     * рисунки ученика».
     */

    /*
     * 3б (метка «ушедший из вида рисунок» и переход по тапу) перенесён в тест «метка молчит,
     * когда ей молчать положено» под тегом @unstable — 2026-10-17, после прогона 38965989249.
     * Почему перенос, а не четвёртая попытка починки: шаг падает на ПРЕДУСЛОВИИ рисования
     * (`третий штрих виден самой Анне`, счётчик пикселей 2079 → 2079), и три объяснения подряд
     * уже опровергнуты самим логом —
     *   1) «метка срабатывает, потому что полотно не то» → геометрическая стража выше проходит;
     *   2) «учителю нельзя рисовать» → проверки `board-readonly` нет, а чернил всё равно нет;
     *   3) «конец штриха уходит за край окна, мышь рисует мимо холста» → после подъёма полотна
     *      в окно (`paintStable` теперь скроллит и повторяет до трёх раз) в логе остались строки
     *      `MEASURE paintStable: штрих не лёг с трёх попыток {slot:C, ink0:2079, inkNow:2079}`.
     * Различить «продукт не принимает штрих» и «инструмент не может его нарисовать» без живого
     * браузера нечем, а браузер локально запрещён правилом захода. Девятый прогон ради этого же
     * шага — уже гонка за зелёным, поэтому шаг исполняется в `e2e-unstable`, а здесь остаются
     * право рисовать, значок, доезд чернил до учителя, отзыв и «удалить рисунки ученика».
     */

    // 4. отзыв действует сразу: значок снялся, и новый штрих никуда не едет
    await drawBtn(t.page, aId).click();
    await expect(badge(a.page), 'значок снялся вместе с разрешением').toHaveCount(0, { timeout: 15_000 });
    await expect(viewOnly(a.page), 'полотно снова только для просмотра').toBeVisible({ timeout: 15_000 });
    // отзыв ещё и показывает подсказку «нет разрешения»: место под неё зарезервировано, полотно
    // не едет ни на пиксель
    {
      const s = geomShift(geom0, await boardGeom(a.page));
      expect(s.max, `отзыв и подсказка не сдвигают полотно (допуск 2 px), разнос ${JSON.stringify(s.d)}`)
        .toBeLessThanOrEqual(2);
    }
    const bBefore = await inkSeen(t.page);
    await paintStable(a.page, 'B');
    await expect.poll(() => inkSeen(t.page),
      { timeout: 6_000, message: 'после отзыва чернил не прибавилось' }).toBe(bBefore);

    // 5. «удалить рисунки ученика» снимает только Аннино: у Б на доске ничего не было
    await t.page.getByTestId('board-purge-btn').click();
    const pop = t.page.getByTestId('board-purge-pop');
    await expect(pop).toBeVisible();
    const item = pop.getByTestId(`board-purge-${aId.slice(0, 8)}`);
    await expect(item, 'в списке тот, кто рисовал').toBeVisible();
    await item.click();
    await expect.poll(() => inkSeen(t.page), { timeout: 20_000, message: 'Аннины штрихи снялись у учителя' })
      .toBeLessThan(inkAfterA);
    await expect.poll(() => inkSeen(a.page), { timeout: 20_000, message: 'и у Анны тоже' })
      .toBeLessThan(inkAfterA);

    for (const v of [t, a, b]) await v.ctx.close();
  });

  test('«разрешить всем» covers a student who joins afterwards', async ({ browser }) => {
    test.setTimeout(240_000);
    const ids = await idsByEmail(bEmail);
    const t = await join(browser, stack.teacherEmail, stack.teacherPassword);
    await openLesson(t.page, classId);

    await openTab(t.page, 'people');
    const all = t.page.getByTestId('panel-draw-all');
    await expect(all).toHaveAttribute('aria-pressed', 'false');
    await all.click();
    await expect(all).toHaveAttribute('aria-pressed', 'true', { timeout: 15_000 });

    const c = await join(browser, bEmail, STUDENT_PW);
    await openLesson(c.page, classId);
    await expect(badge(c.page), 'пришедший после «всем» рисует').toBeVisible({ timeout: 15_000 });

    await openTab(t.page, 'people');
    await t.page.getByTestId('panel-draw-all').click();
    await expect(badge(c.page), 'а после выключения «всем» — нет').toHaveCount(0, { timeout: 15_000 });
    expect(ids[bEmail], 'Борис существует (сверка identity в первом спеке)').toBeTruthy();

    for (const v of [t, c]) await v.ctx.close();
  });

  /*
   * Отрицательные проверки метки: ей положено молчать и на СВОЁМ рисунке, и на ЧУЖИХ чернилах,
   * которые уже в поле зрения. Без них красный zz20 нечем отличить от «метка вообще не умеет
   * молчать»: `noteIncomingInk` вызывается только на чужих правках, а свои сервер отправителю и не
   * рассылает.
   *
   * Сюда же перенесена проверка «метки нет, когда рисунок уже виден» из шага 3 первого теста
   * (2026-10-17): тот шаг был зелёным в прогоне 38946053241 и красным в 38949336521 при неизменной
   * спеке, то есть он зависит от того, куда именно в сцене лёг штрих ученика, а это измеряется
   * только его собственным полотном. Проверка не удалена — она исполняется в джобе `e2e-unstable`.
   *
   * ЧЕМ ОКАЗАЛСЯ ЭТОТ ФЛЭК (разбор 2026-10-24: трасса CI-прогона 40075097179, локальный повтор
   * тем же спек-зондом, поштучный разбор кадров и состояний полотна). Два разных симптома, ОДНА
   * причина — и ни один из них не «рисование не работает»:
   *
   *  • штрих создаётся ВСЕГДА: инструмент rectangle, `newElement` растёт по кадрам перетаскивания
   *    0×0 → 27×18 → … → 160×110, элемент попадает в сцену, уходит на сервер и доходит до
   *    собеседника (метка у учителя при этом на месте);
   *  • но рождается он НЕ там, где курсор. Excalidraw считает координаты указателя по КЭШИРУЮЩЕМУСЯ
   *    смещению холста (`clientY - state.offsetTop`) и перечитывает его только на смену РАЗМЕРА
   *    контейнера, на `resize` и на прокрутку окна. Урок же двигает доску, не меняя её размера:
   *    сетка участников вырастает, когда приезжают треки (замер: canvas y 444 → 399 → 447 → 420
   *    при неизменных 894×480). Курсор в canvas-y=250, а элемент в сцене на y=-494 — на 744 px
   *    выше, за верхней границей видимой области.
   *  • отсюда оба лица сбоя: `inkAll` = 0 у учителя в CI (элемент есть, выбран, но не нарисовано
   *    НИЧЕГО, и над пустым полотном висит «Scroll back to content») и «свой штрих не виден самой
   *    Анне» (то же, плюс снимок страницы успевал переставить её сцену без собственного штриха —
   *    см. порядок merge/snapshot в `routes/board.ts`).
   *
   * Опровергнутые ранее версии, чтобы сюда не возвращались: «учителю нельзя рисовать» (проверки
   * `board-readonly` нет), «конец штриха за краем окна» (`paintStable` поднимает полотно в окно и
   * повторяет), «фоновая страница глушит rAF» (замер `document.hidden`/rAF живости), «двойной
   * экземпляр полотна» (в `[data-testid=board]` ровно два canvas: static и interactive, чернила
   * всегда на static). Права, сокет и сервер были исправны всё это время.
   *
   * Правка — продуктовая (`Board.tsx`: перечитывание смещения при сдвиге кадра; `sentRef` больше
   * не забывает то, что сервер уже имеет; `routes/board.ts`: снимок после merge), а не тестовая.
   * Спек остаётся под @unstable и в неблокирующей джобе: он по-прежнему проверяет метку целиком,
   * а блокирующий набор не менял тега сознательно (см. комментарий шага 3 выше).
   */
  test('метка молчит, когда ей молчать положено @unstable', async ({ browser }) => {
    test.setTimeout(300_000);
    const ids = await idsByEmail(aEmail);
    const aId = ids[aEmail];
    expect(aId, 'Анна зарегистрирована').toBeTruthy();

    const t = await join(browser, stack.teacherEmail, stack.teacherPassword);
    const a = await join(browser, aEmail, STUDENT_PW);
    await waitBoard(t.page);
    await waitBoard(a.page);

    // 1. свой штрих учителя метку не зовёт
    await revealInk(t.page);
    /*
     * Право рисовать здесь проверяется ДО рисования, а не выводится из наличия чернил:
     * `Board.tsx` рисует `board-readonly` ровно тогда, когда `canDraw` false, и в этом же режиме
     * включает `viewModeEnabled`, где рисование отключено целиком.
     */
    await expect(viewOnly(t.page), 'полотно учителя не в режиме просмотра — рисовать можно')
      .toHaveCount(0, { timeout: 15_000 });
    m('own-ink control: teacher canvas', await boardGeom(t.page));
    await paintStable(t.page, 'A');
    await expectInk(t.page, { before: 0, label: 'собственный штрих виден учителю на полотне', reveal: false });
    /*
     * И то, чего прежняя проверка сказать не могла: штрих лёг ТУДА, где стоял курсор. Именно это
     * и ломалось — полотно смещалось вместе с вёрсткой урока, а Excalidraw продолжал чертить по
     * устаревшему смещению, из-за чего элемент появлялся за видимой областью (`inkAll` = 0 при
     * исправном рисовании). Проверка читает настоящий viewport полотна, а не только пиксели.
     */
    {
      const sc = await boardScene(t.page);
      const last = sc.els[sc.els.length - 1];
      expect(last, 'штрих учителя есть в его сцене').toBeTruthy();
      expect(last.inView, `штрих учителя в поле зрения: (${last.x},${last.y}) ${last.w}×${last.h}, ` +
        `видно ${JSON.stringify(sc.view)}, scroll=(${sc.scrollX},${sc.scrollY})`).toBe(true);
      expect(last.w, 'и это перетаскивание, а не клик').toBeGreaterThan(20);
    }
    await expect(chip(t.page), 'своя рисовка метку не зовёт').toHaveCount(0, { timeout: 5_000 });

    /*
     * 2. прежний шаг 3б блокирующего теста: чернила, ушедшие из вида, зовут метку, и тап по ней
     * возвращает к рисунку. Перенесён сюда 2026-10-17 (прогон 38965989249) вместе с причиной:
     * падает он на том же рисовании, которое исследуется выше, и в блокирующем наборе только
     * отравляет хэш. Здесь шаг виден целиком: учитель уходит от содержимого (плашка Excalidraw
     * «Scroll back to content» — доказательство, что взгляд действительно уведён), Анна рисует,
     * метка появляется, называет её имя и снимается после перехода.
     *
     * Случай «чужие чернила в поле зрения метку не зовут» из этого теста сознательно убран (он
     * был перенесён сюда за две минуты до этого): слот A занят штрихом учителя, слот C — единственный
     * свободный, а штрих в тех же координатах, что и предыдущий, новых тёмных пикселей не добавит,
     * то есть проверка «чернил стало больше» стала бы пустой. Само предусловие («учитель видел этот
     * штрих») тем же инструментом и не доказывается — см. комментарий на шаге 3 первого теста.
     */
    await openTab(t.page, 'people');
    await expect(t.page.locator('.peer-row')).toHaveCount(1, { timeout: 30_000 });
    await drawBtn(t.page, aId).click();
    await expect(badge(a.page), 'значок права рисовать').toBeVisible({ timeout: 15_000 });
    const surfaceT = t.page.locator('[data-testid=board] canvas.excalidraw__canvas:not(.static)').first();
    await surfaceT.hover();
    await t.page.mouse.wheel(0, -6000);
    await expect(t.page.locator('[data-testid=board] .scroll-back-to-content'),
      'учитель ушёл от содержимого').toBeVisible({ timeout: 10_000 });
    const aBeforeC = await inkSeen(a.page);
    await paintStable(a.page, 'C');
    await expectInk(a.page, { before: aBeforeC, label: 'штрих виден самой Анне (предусловие метки)' });
    {
      const sc = await boardScene(a.page);
      const last = sc.els[sc.els.length - 1];
      expect(last, 'штрих Анны есть в её сцене').toBeTruthy();
      expect(last.locked, 'свой элемент ученику не блокируется').toBe(false);
      expect(last.inView, `штрих Анны лёг туда, где был курсор: (${last.x},${last.y}) ${last.w}×${last.h}, ` +
        `видно ${JSON.stringify(sc.view)}, scroll=(${sc.scrollX},${sc.scrollY})`).toBe(true);
      expect(last.w, 'и это перетаскивание, а не клик').toBeGreaterThan(20);
    }
    await expect(chip(t.page), 'метка об ушедшем из вида рисунке появилась').toBeVisible({ timeout: 20_000 });
    await expect(chip(t.page)).toContainText('Анна');
    await chip(t.page).click();
    await expect(chip(t.page), 'метка снимается после перехода').toHaveCount(0, { timeout: 10_000 });
    await expectInk(t.page, {
      before: 0, timeout: 20_000, reveal: false,
      label: 'по тапу на метку полотно учителя показало рисунок ученика',
    });

    for (const v of [t, a]) await v.ctx.close();
  });
});
