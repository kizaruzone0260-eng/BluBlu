import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { Excalidraw, exportToBlob } from '@excalidraw/excalidraw';
import '@excalidraw/excalidraw/index.css';
import { useTranslation } from 'react-i18next';
import { api, getToken, wsTicket } from '../lib/api';
import { usePopover } from '../lib/popover';
import { useAuth } from '../App';
import {
  STYLES_PANEL_MIN_FRAME, boardStylesRole, excalidrawMobileChrome, resolveStylesPanel,
  stylesPanelKey, stylesPanelLabels, stylesPanelStored,
} from '@klass/shared';

/**
 * Task 2: the PDF dialog — and with it `pdf-lib` and the export code — is loaded only when
 * the teacher opens it, so neither is reachable from the lesson chunk, let alone the entry one.
 */
const BoardExportDialog = lazy(() => import('./BoardExportDialog'));

type Api = NonNullable<Parameters<NonNullable<React.ComponentProps<typeof Excalidraw>['excalidrawAPI']>>[0]>;

interface RawEl { id: string; version: number; versionNonce: number; isDeleted?: boolean; [k: string]: unknown }

/** Task 1г: the same cap the server enforces (routes/board.ts MAX_BOARD_PAGES). */
const MAX_BOARDS = 20;

/**
 * §3.7 whiteboard: рисует учитель, и — если он разрешил — конкретные ученики (часть 3). Право
 * проверяет СЕРВЕР на каждом сообщении, поэтому здесь `canDraw` отвечает только за то, покажется
 * ли человеку полотно доступным для рисования и какой снимок ему приедет (чужие элементы в нём
 * помечены `locked`, и Excalidraw не даёт их ни выделить, ни стереть).
 *
 * Изменения отправляются дельтами (id/version/versionNonce) с троттлингом ~30 мс.
 *
 * Board pages (task 1): the strip of tabs is our own, not Excalidraw's — a page is a
 * `whiteboards (session_id, page_no)` row on the server, the label lives in its `title` column,
 * and every page verb (create / rename / duplicate / delete / switch) goes over the board WS,
 * where the teacher gate already dropped anything that is not the owning teacher.
 */
export default function Board({ sessionId, classId, height = '60vh', peerNames }: {
  sessionId: string; classId?: string; height?: string; peerNames?: Record<string, string>;
}) {
  const { t } = useTranslation();
  const { me } = useAuth();
  const [canEdit, setCanEdit] = useState(false);
  /** часть 3: рисовать может и разрешённый ученик; `canEdit` при этом остаётся про учителя */
  const [canDraw, setCanDraw] = useState(false);
  const [pages, setPages] = useState<number[]>([1]);
  const [titles, setTitles] = useState<Record<number, string>>({});
  const [current, setCurrentPage] = useState(1);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [menuFor, setMenuFor] = useState<number | null>(null);
  const [renaming, setRenaming] = useState<{ page: number; value: string } | null>(null);
  const [confirmDel, setConfirmDel] = useState<number | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  /** часть 3: чьи рисунки лежат на доске — учительская кнопка «Удалить рисунки ученика» */
  const [drawnBy, setDrawnBy] = useState<Record<string, number> | null>(null);
  const [purgeOpen, setPurgeOpen] = useState(false);
  /**
   * Часть 3 (метка чернил): чей рисунок приехал и ещё НЕ виден учителю. Плашка живёт ПОВЕРХ
   * полотна (`.board-chip`, position: absolute), потому что любое сообщение над рамкой сдвигало
   * бы холст — за этим следит проверка геометрии в zz20.
   */
  const [inkChip, setInkChip] = useState<{ userId: string; ids: string[] } | null>(null);
  // какие элементы уже лежат на полотне: приехавший id вне этого списка — новый штрих
  const knownRef = useRef<Set<string>>(new Set());
  /**
   * Право учителя внутри того же замыкания, что обрабатывает сообщения. Обработчик создаётся
   * ОДИН раз (эффект зависит от `sessionId`/`me`), поэтому `canEdit` из состояния он видел бы
   * навсегда замершим на `false` — и метка не появилась бы ни при каком рисунке.
   */
  const canEditRef = useRef(false);
  const wsRef = useRef<WebSocket | null>(null);
  const apiRef = useRef<Api | null>(null);
  const sentRef = useRef<Map<string, { version: number; versionNonce: number }>>(new Map());
  const lastSentRef = useRef(0);

  useEffect(() => {
    const token = getToken();
    if (!token || !me) return;
    let ws: WebSocket | null = null;
    let disposed = false;
    let retryTimer: number | undefined;
    let attempt = 0;
    const connect = async () => {
      if (disposed) return;
      try {
        const ticket = await wsTicket(sessionId); // one-time ticket — fresh on every reconnect
        if (disposed) return;
        ws = new WebSocket(`ws${location.protocol === 'https:' ? 's' : ''}://${location.host}/api/ws/board/${sessionId}?ticket=${encodeURIComponent(ticket)}`);
        wsRef.current = ws;
        ws.onopen = () => { attempt = 0; };
        ws.onmessage = (ev) => {
          const msg = JSON.parse(ev.data as string) as {
            type: string; canEdit?: boolean; canDraw?: boolean; page?: number; current?: number; pages?: number[];
            by?: string; elements?: RawEl[]; title?: string; titles?: Record<number, string>;
            code?: string; max?: number; maxElements?: number; maxBytes?: number;
          };
          if (msg.type === 'init') {
            setInkChip(null);
            canEditRef.current = !!msg.canEdit;
            setCanEdit(!!msg.canEdit);
            setCanDraw(!!msg.canDraw);
            setPages(msg.pages ?? [1]);
            setTitles(msg.titles ?? {});
            setCurrentPage(msg.page ?? 1);
            sentRef.current.clear();
            replaceScene(msg.elements ?? []);
          } else if (msg.type === 'perms') {
            // часть 3: учитель выдал или отозвал право рисовать, не перекладывая страницу
            setCanDraw(!!msg.canDraw);
            if (!msg.canDraw) setNotice(t('lesson.boardNoPermission'));
          } else if (msg.type === 'edits') {
            // метку зовём только по чужим КАДРАМ: 'current' и 'pages' — это вся доска
            // (учитель переключил вкладку, ученик подключился позже), и на каждое такое
            // сообщение плашка «нарисовал(а), показать» вспыхивала бы зря
            if (msg.by && msg.by !== me?.id) {
              const fresh = (msg.elements ?? []).filter((e) => !knownRef.current.has(e.id));
              mergeIncoming(msg.elements ?? []);
              noteIncomingInk(msg.by, fresh);
            } else {
              mergeIncoming(msg.elements ?? []);
            }
          } else if (msg.type === 'current') {
            // the server sends this to every socket now — the teacher who switched included,
            // which is what keeps a board's screen from showing the previous board's ink
            setCurrentPage(msg.page ?? 1);
            setInkChip(null);
            if (msg.title !== undefined) setTitles((cur) => ({ ...cur, [msg.page ?? 1]: msg.title as string }));
            sentRef.current.clear();
            replaceScene(msg.elements ?? []);
          } else if (msg.type === 'pages') {
            setPages(msg.pages ?? [1]);
            if (msg.titles) setTitles(msg.titles);
            setCurrentPage(msg.page ?? msg.current ?? msg.pages?.[0] ?? 1);
            setInkChip(null);
            sentRef.current.clear();
            // an empty array is a real instruction here: the new board has no ink to show
            if (Array.isArray(msg.elements)) replaceScene(msg.elements);
          } else if (msg.type === 'titles') {
            setTitles(msg.titles ?? {});
          } else if (msg.type === 'notice' && msg.code) {
            // Часть 3: у каждого отказа своя причина и своя подсказка. «boardForeign» — это
            // «ты тронул чужой рисунок, сервер его вернул», «boardStudentLimit» — потолок
            // элементов/байтов на ученика, «boardNoPermission» — отзыв прямо во время рисования.
            const MB = 1024 * 1024;
            setNotice(
              msg.code === 'boardLimit' ? t('lesson.boardLimit', { max: msg.max ?? MAX_BOARDS })
                : msg.code === 'boardForeign' ? t('lesson.boardForeign')
                : msg.code === 'boardStudentLimit'
                  ? t('lesson.boardStudentLimit', {
                    max: msg.maxElements ?? 300, mb: Math.round((msg.maxBytes ?? MB) / MB),
                  })
                  : msg.code === 'boardSceneLimit'
                    ? t('lesson.boardSceneLimit', { mb: Math.round((msg.maxBytes ?? 2_000_000) / MB) })
                  : msg.code === 'boardNoPermission' ? t('lesson.boardNoPermission')
                  : msg.code === 'boardTooFast' ? t('lesson.boardTooFast')
                  : msg.code === 'boardNothingToPurge' ? t('lesson.boardPurgeNone')
                  : t('lesson.boardLastPage'));
          }
        };
        ws.onclose = (ev) => {
          if (disposed) return;
          if (ev.code === 4404) return; // session gone — lesson status WS clears the page
          attempt++; // dropped connection (render restart, wifi blip, expired ticket) → reconnect
          retryTimer = window.setTimeout(() => void connect(), Math.min(1000 * 2 ** (attempt - 1), 10_000));
        };
      } catch {
        if (!disposed) {
          attempt++;
          retryTimer = window.setTimeout(() => void connect(), Math.min(1000 * 2 ** (attempt - 1), 10_000));
        }
      }
    };
    void connect();
    return () => { disposed = true; window.clearTimeout(retryTimer); ws?.close(); };
  }, [sessionId, me]); // eslint-disable-line react-hooks/exhaustive-deps

  function replaceScene(elements: RawEl[]) {
    knownRef.current = new Set(elements.map((e) => e.id));
    apiRef.current?.updateScene({ elements: elements as never });
  }

  // the active tab is kept in view — the strip scrolls horizontally at 390 px (task 1б)
  const tabsRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = tabsRef.current?.querySelector<HTMLElement>(`[data-testid="board-tab-${current}"]`);
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [current, pages.length]);

  /*
   * Оба меню доски живут на общем механизме размещения (`lib/popover`): целиком во вьюпорте,
   * переворот вверх, когда снизу не помещается, внутренняя прокрутка в низком окне, закрытие по
   * Escape и по клику снаружи.
   *
   * `.board-tab-pop` — `position: fixed`, то есть координаты считаются от окна: наивное
   * `top: 100%` у меню purge означало «высота экрана от верхнего края», и список «Анна Тест · 1»
   * всегда рождался за нижним краем — до него нельзя было дотянуться ни мышью, ни тестом
   * (это и поймал zz20). Полоска вкладок прокручивается горизонтально на 390 px, поэтому меню
   * обязано оставаться ПРИВЯЗАННОЙ К ВКЛАДКЕ: уехала вкладка из полоски — закрывается и меню
   * (разбор скриншотов 2026-10-08). Сама прокрутка меню не закрывает: клик по наполовину видимой
   * вкладке заставляет браузер докрутить её, и закрытие захлопнуло бы меню в тот же миг.
   */
  const [tabAnchor, setTabAnchor] = useState<HTMLElement | null>(null);
  const tabPop = usePopover({ open: menuFor !== null, anchor: tabAnchor, onClose: () => setMenuFor(null) });
  const [purgeAnchor, setPurgeAnchor] = useState<HTMLElement | null>(null);
  const purgePop = usePopover({ open: purgeOpen, anchor: purgeAnchor, onClose: () => setPurgeOpen(false) });

  useEffect(() => {
    if (menuFor === null || !tabAnchor) return;
    const leaveStrip = () => {
      const strip = tabsRef.current;
      if (!strip) return;
      const r = tabAnchor.getBoundingClientRect();
      const box = strip.getBoundingClientRect();
      if (r.right < box.left || r.left > box.right) setMenuFor(null);
    };
    window.addEventListener('scroll', leaveStrip, true);
    return () => window.removeEventListener('scroll', leaveStrip, true);
  }, [menuFor, tabAnchor]);

  function openMenu(page: number, anchor: HTMLElement) {
    setTabAnchor(anchor);
    setMenuFor(page);
  }

  function mergeIncoming(incoming: RawEl[]) {
    const a = apiRef.current;
    if (!a) return;
    const byId = new Map<string, RawEl>((a.getSceneElements() as unknown as RawEl[]).map((e) => [e.id, e]));
    let changed = false;
    for (const el of incoming) {
      const cur = byId.get(el.id);
      if (!cur || el.version > cur.version || (el.version === cur.version && el.versionNonce > cur.versionNonce)) {
        if (el.isDeleted) byId.delete(el.id);
        else byId.set(el.id, el);
        changed = true;
      }
    }
    if (changed) a.updateScene({ elements: [...byId.values()] as never });
    for (const el of incoming) knownRef.current.add(el.id);
  }

  function onChange(
    elements: readonly RawEl[],
    appState?: {
      activeTool: { type: string };
      selectedElementIds: Record<string, boolean>;
    },
  ) {
    /*
     * Наблюдение за полотном в мобильной раскладке (правка 2026-10-24). Две причины, по которым
     * `onChange` вообще что-то здесь смотрит:
     *  • переключателя нижнего бара нет, пока нечего форматировать (активен рисующий инструмент
     *    либо есть выделение). Как только он появляется, наше «открыто» надо наконец применить;
     *  • наоборот, когда полотна хватает, примирение ничего не нажимает и состояние человека
     *    остаётся прежним.
     *
     * ПОЧЕМУ ЗДЕСЬ НЕТ `setState`. Библиотека вызывает `onChange` из своего `componentDidUpdate`
     * (`dist/dev/index.js:30535-30538` установленной 0.18.1) — то есть в фазе коммита React и на
     * каждый рендер полотна. Поднятое оттуда состояние перерисовывает родителя, родитель
     * перерисовывает полотно, полотно зовёт `onChange` снова: цикл замыкается до «Maximum update
     * depth exceeded» (React #185 — именно так упал прогон 40062924647, страница урока вставала на
     * экран 500). Поэтому отсюда наружу уходит только `reconcileMenu()`, и то микрозадачей, и
     * только когда наблюдение правда изменилось. Обратное зеркало «полотно → наше состояние»
     * сознательно убрано: собственный переключатель библиотеки скрыт нашим CSS (styles.css), так
     * что читать его решение больше не у кого, а `openMenu: "shape"` без панели в DOM — это
     * остаточное значение, которое не имеет права открывать панель заново.
     */
    if (canDraw && mobileChrome && appState) {
      const tool = appState.activeTool?.type;
      const draws = !!tool && !['selection', 'eraser', 'hand', 'laser', 'custom'].includes(tool);
      const can = draws || Object.keys(appState.selectedElementIds ?? {}).length > 0;
      if (menuCanShowRef.current !== can) {
        menuCanShowRef.current = can;
        queueMicrotask(reconcileMenu);
      }
    }
    if (!canDraw) return;
    const now = Date.now();
    if (now - lastSentRef.current < 30) return; // §3.7 throttle ≈30 ms
    lastSentRef.current = now;
    const changed: RawEl[] = [];
    for (const el of elements) {
      const prev = sentRef.current.get(el.id);
      if (!prev || prev.version !== el.version || prev.versionNonce !== el.versionNonce) {
        changed.push(el);
        sentRef.current.set(el.id, { version: el.version, versionNonce: el.versionNonce });
      }
    }
    if (changed.length && wsRef.current?.readyState === 1) {
      wsRef.current.send(JSON.stringify({ type: 'edits', page: current, elements: changed }));
    }
  }

  const send = (msg: Record<string, unknown>) => {
    if (wsRef.current?.readyState === 1) wsRef.current.send(JSON.stringify(msg));
  };

  /*
   * Часть A (2026-10-23, правка 2026-10-24): панель стилей перекрывает полотно, поэтому её показом
   * решает ОДНО наше состояние — `stylesOpen`.
   *
   * Почему ОДНО, а не два. Excalidraw рисует панель форматирования в двух разных узлах и сам
   * выбирает узел по размеру своего контейнера (`excalidrawMobileChrome`, см. shared):
   *  • десктоп — `.selected-shape-actions` слева сверху: узел создаётся библиотекой, а прячет или
   *    показывает его наш CSS по `data-styles` на рамке;
   *  • мобильная — `.App-mobile-menu` в нижнем баре: узла в DOM НЕТ, пока библиотека держит
   *    `appState.openMenu !== 'shape'`, то есть пока не нажата её собственная кнопка.
   * Прежний код умел только первое, и на ноутбуке 1280×720 (полотно ~925×432 px — это уже
   * мобильная раскладка) нажатие «Стили» прятало узел, которого не существовало: отсюда и
   * «кнопка работает ненадёжно».
   *
   * Почему не пропсы. У установленной 0.18.1 (проверено по `dist/types/excalidraw/types.d.ts`)
   * в `UIOptions` есть только `canvasActions`, `tools` и `dockedSidebarBreakpoint` — записи про
   * панель стилей нет. А в `ExcalidrawImperativeAPI` (там же, строки 604-635) есть `getAppState`,
   * но НЕТ `setAppState`: снаружи нельзя ни прочитать, ни тем более записать `openMenu` иначе как
   * тем же жестом, которым он вообще меняется, — нажатием кнопки нижнего бара. Поэтому состояние
   * держим у себя, наружу его отражает эффект-примиритель, а обратно — `onChange`. Тест
   * `excalidraw-styles-panel.test.ts` падает, если библиотека потеряет эти классы.
   *
   * Сцены это не касается: `openMenu` — часть appState, не элементов, значит мутации в комнату на
   * переключение панели уйти не может (проверяет zz30 геометрией полотна).
   */
  const stylesRole = boardStylesRole(me?.role);
  const [stylesOpen, setStylesOpen] = useState(false);
  /** Зеркало состояния для колбэков, которые React не пересоздаёт на каждый рендер. */
  const stylesOpenRef = useRef(stylesOpen);
  stylesOpenRef.current = stylesOpen;
  /** «Есть что форматировать» по последнему слову полотна: нужно, чтобы поймать появление переключателя. */
  const menuCanShowRef = useRef(false);
  /** Размер РАМКИ доски в пикселях (0 — ещё не померена): решает и место для панели, и раскладку полотна. */
  const [frameBox, setFrameBox] = useState({ w: 0, h: 0 });
  /** В мобильной ли раскладке сейчас Excalidraw — то есть создаётся ли панель полем `openMenu`. */
  const mobileChrome = excalidrawMobileChrome(frameBox.w, frameBox.h);
  const stylesBtnRef = useRef<HTMLButtonElement | null>(null);
  const frameRef = useRef<HTMLDivElement | null>(null);

  /**
   * Примирение с мобильной раскладкой: там панель — дочерний узел нижнего бара, и появляется он
   * только при `appState.openMenu === 'shape'`. Записать это поле снаружи нечем (у императивного
   * API 0.18.1 есть `getAppState`, но нет `setAppState`), поэтому остаётся ровно тот же жест,
   * которым пользуется человек: нажатие кнопки `aria-label="Edit"` в нижнем баре. Рядом в этом же
   * ряду стоят `duplicate` и `delete`, и промах по ним удалил бы ученический рисунок, поэтому
   * ищем строго по метке, а не «первую кнопку».
   *
   * Функция идемпотентна: если полотно уже показывает ровно то, что решает наше состояние, она
   * ничего не нажимает — из-за этого её можно звать и из эффекта, и из наблюдения за canvas.
   * Вызывать её разрешено ТОЛЬКО вне фазы рендера/коммита React (см. `onChange`).
   */
  function reconcileMenu(): void {
    if (!mobileChrome || !canDraw) return;
    const api = apiRef.current;
    if (!api) return;
    let shown = false;
    try { shown = api.getAppState().openMenu === 'shape'; } catch { return; }
    if (shown === stylesOpenRef.current) return;
    frameRef.current?.querySelector<HTMLElement>(
      '.App-bottom-bar .App-toolbar-content button[aria-label="Edit"]',
    )?.click();
  }

  /** Приватный режим умеет отказывать и на чтение, и на запись — это не повод ронять доску. */
  const readStoredStyles = (): string | null => {
    try { return localStorage.getItem(stylesPanelKey(stylesRole)); } catch { return null; }
  };
  const writeStoredStyles = (open: boolean) => {
    try { localStorage.setItem(stylesPanelKey(stylesRole), stylesPanelStored(open)); } catch { /* память недоступна */ }
  };

  /**
   * Нажатие человека: меняет ровно одно наше состояние и ровно один ключ в localStorage.
   * Ни `apiRef`, ни `updateScene`, ни `send(…)` — панели нет в сцене, значит и мутации в комнату
   * на этот клик уйти не может (проверяет zz30 вместе с геометрией полотна). Полотно в мобильной
   * раскладке подстраивается отдельным эффектом-примирителем ниже, а не этим кликом.
   */
  function toggleStyles() {
    const next = !stylesOpen;
    setStylesOpen(next);
    writeStoredStyles(next);
  }

  /*
   * Размер рамки меряем сами (правка 2026-10-24). Раньше сравнивались `window.innerWidth` и
   * порог 1280 px, хотя полотно живёт внутри `.container { max-width: 960px }`: рамка доски
   * такой ширины не достигает никогда, поэтому на ноутбуке 1366 px правило отвечало «места
   * хватает», а панель ложилась почти на весь холст. Наблюдаем за тем же элементом, который
   * панель и перекрывает, — и по ширине, и по высоте: высота нужна, чтобы отличить десктопную
   * раскладку Excalidraw от мобильной (у той свои пороги, см. excalidrawMobileChrome).
   */
  useEffect(() => {
    const el = frameRef.current;
    if (!el || typeof window === 'undefined') return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      // новый объект на каждый кадр resize = лишний рендер; сравниваем и возвращаем prev, если не изменилось
      setFrameBox((prev) => (prev.w === r.width && prev.h === r.height ? prev : { w: r.width, h: r.height }));
    };
    measure();
    if (typeof window.ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const ro = new window.ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /*
   * Два правила, которые больше не спорят за одно состояние:
   *  • память читается ОДИН раз на роль (смена роли — это момент, когда становится известно,
   *    чей именно выбор смотреть);
   *  • нехватка места умеет только ЗАКРЫТЬ панель. Обратно она её не открывает: разворот окна
   *    или поворот планшета не имеют права возвращать панель, которую учитель закрыл сам.
   * Сохранённый выбор при этом не перезаписывается — на широком экране после перезагрузки
   * панель вернётся такой, её оставили.
   */
  useEffect(() => {
    setStylesOpen(resolveStylesPanel({
      width: frameRef.current?.clientWidth ?? 0,
      stored: readStoredStyles(),
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stylesRole]);

  useEffect(() => {
    if (frameBox.w > 0 && frameBox.w < STYLES_PANEL_MIN_FRAME) setStylesOpen(false);
  }, [frameBox.w]);

  /*
   * Единственный вызов примирения из фазы React: после нажатия «Стили», после закрытия по Esc,
   * после того как рамка переехала из одной раскладки в другую. `reconcileMenu` объявлена в теле
   * компонента намеренно — она читает свежие ref-ы, поэтому зависимость от неё в списке ниже
   * сознательно опущена.
   */
  useEffect(() => {
    reconcileMenu();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mobileChrome, stylesOpen, canDraw]);

  /**
   * Esc закрывает панель. Фокус возвращается на кнопку ТОЛЬКО если он был внутри панели: иначе
   * клавиатура полотна (V, P, E, Ctrl+Z) осталась бы на холсте и продолжала работать, что и
   * требует проверка. Никакого `preventDefault` — Excalidraw обрабатывает Esc сам.
   */
  function onBoardKeyDown(e: React.KeyboardEvent) {
    if (e.key !== 'Escape' || !stylesOpen) return;
    const panel = e.currentTarget.querySelector('.selected-shape-actions, .App-mobile-menu');
    const focusWasInside = !!panel && panel.contains(document.activeElement);
    setStylesOpen(false);
    writeStoredStyles(false);
    if (focusWasInside) stylesBtnRef.current?.focus();
  }

  /** task 4: the ONLY canvas action we expose — teacher clears the current board.
   * Elements are soft-deleted so the WS delta sync propagates the wipe to all. */
  function clearPage() {
    const a = apiRef.current;
    if (!a || !canEdit) return;
    if (!window.confirm(t('lesson.boardClearConfirm'))) return;
    // Two things have to happen for a clear to reach the room, and neither is automatic:
    //  - the VERSION must move. mergeElements() on the server (services/board.ts) and
    //    mergeIncoming() here both keep the element with the higher version, so an
    //    `isDeleted: true` flag on an unchanged version is dropped as stale;
    //  - the wipe must be SENT. Excalidraw drops soft-deleted elements from the scene it hands
    //    back to onChange(), and onChange only reports elements that are still there — a vanished
    //    element is never diffed, so the delta watcher would silently send nothing.
    // Before this, «Очистить» emptied the teacher's canvas and the drawing came back on reload
    // (the e2e test «clearing the last board really wipes it» fails without both lines).
    const wiped = (a.getSceneElements() as unknown as RawEl[]).map((e) => ({
      ...e,
      isDeleted: true,
      version: (e.version ?? 0) + 1,
      versionNonce: (Math.random() * 2 ** 31) | 0,
    }));
    a.updateScene({ elements: wiped as never });
    for (const e of wiped) sentRef.current.set(e.id, { version: e.version, versionNonce: e.versionNonce });
    if (wiped.length) send({ type: 'edits', page: current, elements: wiped });
  }

  /**
   * Часть 3: чьи рисунки лежат на этой доске. Список запрашивается в момент, когда учитель открыл
   * меню, а не подписывается на каждую правку: счётчики нужны один раз на действие, и вешать на
   * каждый кадр HTTP-запрос значило бы удвоить трафик урока.
   */
  async function loadDrawnBy() {
    try {
      const res = await api<{ byAuthor: Record<string, number> }>(`/api/lessons/${sessionId}/board/authors`);
      setDrawnBy(res.byAuthor ?? {});
    } catch {
      setDrawnBy({});
    }
  }

  /**
   * Метка «<имя> нарисовал(а), показать»: учитель получает чужие кадры и, если ни один из них
   * не попал в видимую область его полотна, предлагает перейти к рисунку. Свои правки метку не
   * зовут (их сервер и не рассылает отправителю, но `by` сверяется и здесь), чужая СТРАНИЦА
   * целиком — тоже (см. 'edits' выше).
   */
  function noteIncomingInk(by: string, incoming: RawEl[] | null) {
    if (!canEditRef.current || !incoming?.length) return;
    const outside = incoming.filter((e) => !inView(e)).map((e) => e.id);
    if (outside.length) setInkChip({ userId: by, ids: outside });
  }

  /**
   * Попадает ли элемент в видимую область полотна учителя. Координаты Excalidraw:
   * `viewport = (scene + scroll) * zoom`, то есть левому верхнему углу окна соответствует
   * сцена `(-scrollX, -scrollY)`, а её размер — это размер холста, делённый на zoom.
   */
  function inView(el: RawEl): boolean {
    const a = apiRef.current;
    if (!a) return true;
    const st = a.getAppState();
    const e = el as RawEl & { x?: number; y?: number; width?: number; height?: number; isDeleted?: boolean };
    if (e.isDeleted || typeof e.x !== 'number' || typeof e.y !== 'number') return true;
    const z = st.zoom?.value || 1;
    if (!st.width || !st.height) return true;          // полотно ещё не измерено — не поднимаем метку
    const vx = -st.scrollX; const vy = -st.scrollY;
    const vw = st.width / z; const vh = st.height / z;
    const w = e.width ?? 0; const h = e.height ?? 0;
    return !(e.x + w < vx || e.x > vx + vw || e.y! + h < vy || e.y! > vy + vh);
  }

  /** По тапу — прокрутить и отмасштабировать полотно к рисунку ученика, и снять метку. */
  function showInk() {
    const a = apiRef.current;
    const chip = inkChip;
    setInkChip(null);
    if (!a || !chip) return;
    const els = (a.getSceneElements() as unknown as RawEl[]).filter((e) => chip.ids.includes(e.id));
    if (!els.length) return;
    try {
      a.scrollToContent(els as never, { fitToContent: true, animate: true });
    } catch { /* элемент уже стёрли — метка просто снялась */ }
  }

  /** Удалить рисунки одного ученика (сервер снимает их мягко и рассылает всем). */
  function purgeStudent(userId: string) {
    setPurgeOpen(false);
    setNotice('');
    send({ type: 'purge', userId });
    void loadDrawnBy();
  }

  /** The localized default label of a board; a teacher's own name always wins. */
  const label = (page: number) => {
    const own = titles[page];
    if (own && own.trim()) return own;
    const idx = pages.indexOf(page);
    return t('lesson.boardNamed', { n: idx >= 0 ? idx + 1 : page });
  };

  function commitRename() {
    if (!renaming) return;
    // the server sanitizes too (flatten, collapse, 40 chars) — this only keeps the UI honest
    const title = renaming.value.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);
    send({ type: 'rename', page: renaming.page, title });
    setRenaming(null);
  }

  async function publishAs(kind: 'png' | 'svg') {
    const a = apiRef.current;
    if (!a) return;
    try {
      const blob = await exportToBlob({
        elements: a.getSceneElements(),
        appState: { exportBackground: true, viewBackgroundColor: '#ffffff', exportWithDarkMode: false } as never,
        files: a.getFiles(),
        mimeType: kind === 'png' ? 'image/png' : 'image/svg+xml',
      });
      const dataUrl = await new Promise<string>((res, rej) => {
        const fr = new FileReader();
        fr.onload = () => res(String(fr.result));
        fr.onerror = () => rej(new Error('export failed'));
        fr.readAsDataURL(blob);
      });
      await api(`/api/lessons/${sessionId}/board/publish`, {
        method: 'POST', body: JSON.stringify({ dataUrl, kind, title: label(current) }),
      });
    } catch (e) {
      setError(String((e as Error).message));
    }
  }

  /**
   * Кнопка «Стили» — одна на обе ветки шапки (учитель и разрешённый ученик): цвет и толщину
   * выбирают и те и другие, а без этой кнопки при закрытой панели до них было бы не добраться.
   *
   * Открытая панель показывает на этой же кнопке крестик: своего «крестика» внутри контейнера
   * Excalidraw нам поставить некуда (DOM панели библиотечный, и слота в него нет), а закрывать
   * панель чем-то надо не только Esc. Кнопка остаётся той же самой — тот же `aria-pressed`, тот же
   * фокус, никаких новых слоёв над полотном.
   *
   * КНОПКА РЕНДЕРИТСЯ ВСЕГДА, а при `!canDraw` просто выключена. Это не косметика: появление
   * нового объекта в строке шапки поднимало её на 10,25 px ровно в момент, когда учитель выдавал
   * право рисовать, и полотно уезжало вниз — это измеряет блокирующий спек zz20 («выдача права не
   * сдвигает полотно», допуск 2 px, прогон 39993977646). Место зарезервировано в обеих состояниях,
   * поэтому сдвиг нулевой, а причина «почему не жмётся» читается в подсказке.
   */
  const stylesLabels = stylesPanelLabels(stylesOpen);
  const stylesButton = (
    <button type="button" className="secondary board-styles-toggle" style={{ marginTop: 0 }}
      ref={stylesBtnRef} data-testid="board-styles-toggle" disabled={!canDraw}
      aria-pressed={stylesOpen} aria-expanded={stylesOpen} aria-label={t(stylesLabels.aria)}
      title={canDraw ? t(stylesLabels.hint) : t('lesson.boardNoPermission')} onClick={toggleStyles}>
      <span className="board-styles-glyph" aria-hidden="true">{stylesOpen ? '✕' : '🎨'}</span>
      {t('lesson.boardStyles')}
    </button>
  );

  return (
    <div className="card" data-testid="board">
      <div className="row">
        <h2 style={{ margin: 0 }}>{t('lesson.board')}</h2>
        {canEdit ? (
          <>
            <div className="board-tabs" data-testid="board-tabs" role="group" ref={tabsRef}
              aria-label={t('lesson.boardsAria')}>
              {pages.map((p) => (
                /*
                 * axe поймал это новой проверкой нижней панели урока (2026-10-11), и поймал по делу:
                 * полоска была `role=tablist`, а каждая вкладка — `role=tab`-КОНТЕЙНЕРОМ, внутри
                 * которого жили кнопка имени и кнопка меню. Получалось то `nested-interactive`
                 * (интерактивное внутри интерактивного), то `aria-required-children` (у tablist
                 * теперь дочка — обёртка, а не tab). Настоящих ARIA-табов здесь и не было: у вкладки
                 * нет aria-controls, потому что полотно рисует Excalidraw. Поэтому полоска — group,
                 * вкладка — обычная кнопка с aria-current, а её меню остаётся role=menu рядом.
                 * Клики, data-testid, подписи и стили не менялись (проверяет zz11).
                 */
                <div key={p} className={`board-tab${p === current ? ' active' : ''}`} data-testid={`board-tab-${p}`}>
                  {renaming?.page === p ? (
                    <input data-testid="board-rename-input" autoFocus maxLength={40} value={renaming.value}
                      aria-label={t('lesson.boardRenameAria')}
                      onChange={(e) => setRenaming({ page: p, value: e.target.value })}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') { e.preventDefault(); commitRename(); }
                        if (e.key === 'Escape') setRenaming(null);
                      }}
                      onBlur={() => commitRename()} />
                  ) : (
                    <button type="button" aria-current={p === current ? 'true' : undefined}
                      className="board-tab-name" onClick={() => send({ type: 'switch', page: p })}
                      title={label(p)}>
                      {label(p)}
                    </button>
                  )}
                  <button type="button" className="board-tab-menu" data-testid={`board-menu-${p}`}
                    aria-haspopup="menu" aria-expanded={menuFor === p}
                    aria-label={t('lesson.boardTabMenu', { name: label(p) })}
                    onClick={(e) => {
                      if (menuFor === p) { setMenuFor(null); return; }
                      openMenu(p, e.currentTarget);
                      setNotice('');
                    }}>⋯</button>
                  {menuFor === p && (
                    <div className="board-tab-pop" role="menu" data-testid={`board-pop-${p}`} ref={tabPop.ref} style={tabPop.style}>
                      <button type="button" role="menuitem" data-testid="board-rename"
                        onClick={() => { setRenaming({ page: p, value: titles[p] ?? '' }); setMenuFor(null); }}>
                        {t('lesson.boardRename')}
                      </button>
                      <button type="button" role="menuitem" data-testid="board-duplicate"
                        onClick={() => { send({ type: 'duplicate', page: p }); setMenuFor(null); }}>
                        {t('lesson.boardDuplicate')}
                      </button>
                      {pages.length > 1 ? (
                        <button type="button" role="menuitem" className="danger" data-testid="board-delete"
                          onClick={() => { setConfirmDel(p); setMenuFor(null); }}>
                          {t('lesson.boardDelete')}
                        </button>
                      ) : (
                        <button type="button" role="menuitem" data-testid="board-delete" disabled
                          title={t('lesson.boardLastPage')}>
                          {t('lesson.boardDelete')}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
            <button type="button" className="secondary" style={{ marginTop: 0 }} data-testid="board-new"
              disabled={pages.length >= MAX_BOARDS}
              title={pages.length >= MAX_BOARDS ? t('lesson.boardLimit', { max: MAX_BOARDS }) : ''}
              onClick={() => send({ type: 'newpage' })}>
              + {t('lesson.boardNew')}
            </button>
            {stylesButton}
            <div className="spacer" />
            <button className="secondary" style={{ marginTop: 0 }} data-testid="board-clear" onClick={clearPage}>
              🗑 {t('lesson.boardClear')}
            </button>
            {/* часть 3: «Удалить рисунки ученика» — учительское действие, список по нажатию */}
            <div className="board-purge" style={{ position: 'relative' }}>
              <button type="button" className="secondary" style={{ marginTop: 0 }} data-testid="board-purge-btn"
                aria-haspopup="menu" aria-expanded={purgeOpen}
                title={t('lesson.boardPurgeHint')}
                onClick={(e) => {
                  const on = !purgeOpen;
                  setPurgeOpen(false);
                  setNotice('');
                  if (on) { setPurgeAnchor(e.currentTarget); setPurgeOpen(true); void loadDrawnBy(); }
                }}>
                🧹 {t('lesson.boardPurge')}
              </button>
              {purgeOpen && (
                <div className="board-tab-pop" role="menu" data-testid="board-purge-pop"
                  ref={purgePop.ref} style={purgePop.style}>
                  {drawnBy === null && <span className="muted">…</span>}
                  {drawnBy !== null
                    && !Object.entries(drawnBy).some(([id, n]) => n > 0 && id !== me?.id) && (
                    <span className="muted" data-testid="board-purge-none">{t('lesson.boardPurgeNone')}</span>
                  )}
                  {drawnBy !== null && Object.entries(drawnBy)
                    .filter(([id, n]) => n > 0 && id !== me?.id)
                    .map(([id, n]) => (
                      <button key={id} type="button" role="menuitem" className="danger"
                        data-testid={`board-purge-${id.slice(0, 8)}`} onClick={() => purgeStudent(id)}>
                        {peerNames?.[id] ?? id.slice(0, 8)} · {n}
                      </button>
                    ))}
                </div>
              )}
            </div>
            {/* task 2д: PDF is the teacher's button — students never get it */}
            {classId && (
              <button className="secondary" style={{ marginTop: 0 }} data-testid="board-pdf"
                onClick={() => setExportOpen(true)}>
                📄 {t('lesson.boardPdf')}
              </button>
            )}
            <button className="secondary" style={{ marginTop: 0 }} data-testid="board-publish-png"
              title={t('lesson.publishPngHint')} onClick={() => void publishAs('png')}>
              {t('lesson.publishPng')}
            </button>
            <button className="secondary" style={{ marginTop: 0 }} data-testid="board-publish-svg"
              title={t('lesson.publishSvgHint')} onClick={() => void publishAs('svg')}>
              {t('lesson.publishSvg')}
            </button>
          </>
        ) : (
          <>
            <span className="board-current" data-testid="board-current-name">{label(current)}</span>
            {/*
              Часть 3: разрешённый ученик видит, что ему можно, а не догадывается по курсору.
              Обе состояния лежат в одной ячейке фиксированной высоты: без неё «pill» с
              отступами выше обычного текста, и строка шапки растягивалась ровно в тот момент,
              когда учитель выдавал право, — полотно уезжало на несколько пикселей вниз.
            */}
            {/*
              Часть 3: разрешённый ученик видит, что ему можно, а не догадывается по курсору.
              Обе состояния лежат в одной ячейке фиксированной высоты: без неё «pill» с
              отступами выше обычного текста, и строка шапки растягивалась ровно в тот момент,
              когда учитель выдавал право, — полотно уезжало на несколько пикселей вниз.

              Кнопка «Стили» живёт В ЭТОЙ ЖЕ ячейке (часть A, 2026-10-23). В первом варианте она
              стояла рядом, и выдача права поднимала строку на 10,25 px — ровно на разницу между
              высотой pill-ячейки и высотой кнопки; это поймал блокирующий спек zz20 («выдача
              права не сдвигает полотно», прогон 39993977646). Ячейка теперь одна на оба
              состояния, и её высота не зависит от того, есть ли кнопка.
            */}
            <span className="board-status">
              {canDraw
                ? <span className="board-draw-badge" data-testid="board-draw-badge">✏️ {t('lesson.boardYouCanDraw')}</span>
                : <span className="muted" data-testid="board-readonly">👁 {t('lesson.readonly')}</span>}
              {stylesButton}
            </span>
          </>
        )}
      </div>
      {confirmDel !== null && (
        <div className="board-confirm" data-testid="board-delete-confirm" role="alertdialog"
          aria-label={t('lesson.boardDeleteConfirm', { name: label(confirmDel) })}>
          <span>{t('lesson.boardDeleteConfirm', { name: label(confirmDel) })}</span>
          <button type="button" className="danger" data-testid="board-delete-yes"
            onClick={() => { send({ type: 'delpage', page: confirmDel }); setConfirmDel(null); }}>
            {t('common.delete')}
          </button>
          <button type="button" className="secondary" data-testid="board-delete-no" onClick={() => setConfirmDel(null)}>
            {t('common.cancel')}
          </button>
        </div>
      )}
      {/*
        Ячейка сообщения всегда на месте, пустая или нет: раньше подсказка («это чужой рисунок»,
        «нет разрешения») появлялась и исчезала НАД полотном и сдвигала его вниз/вверх на свою
        высоту, то есть каждый отказ отбрасывал холст под курсором.
      */}
      <div className="board-msg">
        {notice && <p className="muted" data-testid="board-notice">{notice}</p>}
        {error && <p className="error">{error}</p>}
      </div>
      {/*
        `data-styles` — единственный переключатель панели стилей (см. CSS-правило в styles.css),
        `onKeyDown` — Esc. Новый дочерний элемент при этом не появляется: слушатель висит на том же
        div, внутри которого рисует Excalidraw.
      */}
      <div ref={frameRef} style={{ height }} className="board-frame" data-styles={stylesOpen ? 'open' : 'closed'}
        onKeyDown={onBoardKeyDown}>
        <Excalidraw
          viewModeEnabled={!canDraw}
          zenModeEnabled={!canDraw}
          gridModeEnabled={false}
          // task 4: strip everything the lesson UI does not need — no Open/Save/
          // Export dialog, no theme switch, no library, no image tool (v1.1).
          UIOptions={{
            canvasActions: {
              changeViewBackgroundColor: false,
              clearCanvas: false,
              loadScene: false,
              saveToActiveFile: false,
              toggleTheme: false,
              saveAsImage: false,
              export: false,
            },
            tools: { image: false },
          }}
          excalidrawAPI={(a) => { apiRef.current = a; }}
          onChange={(elements, appState) => onChange(elements as unknown as RawEl[], appState)}
          initialData={{ elements: [], appState: { viewModeEnabled: !canDraw, showWelcomeScreen: false }, scrollToContent: false }}
        />
      </div>
      {inkChip && canEdit && (
        <button type="button" className="board-chip" data-testid="board-ink-chip" onClick={showInk}>
          ✏️ {t('lesson.boardInk', { name: peerNames?.[inkChip.userId] ?? inkChip.userId.slice(0, 8) })}
        </button>
      )}
      {exportOpen && classId && (
        <Suspense fallback={null}>
          <BoardExportDialog
            sessionId={sessionId} classId={classId} current={current}
            liveElements={() => (apiRef.current?.getSceneElements() as unknown as RawEl[]) ?? null}
            onClose={() => setExportOpen(false)}
          />
        </Suspense>
      )}
    </div>
  );
}
