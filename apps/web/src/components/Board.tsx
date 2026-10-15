import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { Excalidraw, exportToBlob } from '@excalidraw/excalidraw';
import '@excalidraw/excalidraw/index.css';
import { useTranslation } from 'react-i18next';
import { api, getToken, wsTicket } from '../lib/api';
import { usePopover } from '../lib/popover';
import { useAuth } from '../App';

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
            elements?: RawEl[]; title?: string; titles?: Record<number, string>;
            code?: string; max?: number; maxElements?: number; maxBytes?: number;
          };
          if (msg.type === 'init') {
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
            mergeIncoming(msg.elements ?? []);
          } else if (msg.type === 'current') {
            // the server sends this to every socket now — the teacher who switched included,
            // which is what keeps a board's screen from showing the previous board's ink
            setCurrentPage(msg.page ?? 1);
            if (msg.title !== undefined) setTitles((cur) => ({ ...cur, [msg.page ?? 1]: msg.title as string }));
            sentRef.current.clear();
            replaceScene(msg.elements ?? []);
          } else if (msg.type === 'pages') {
            setPages(msg.pages ?? [1]);
            if (msg.titles) setTitles(msg.titles);
            setCurrentPage(msg.page ?? msg.current ?? msg.pages?.[0] ?? 1);
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
  }

  function onChange(elements: readonly RawEl[]) {
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
            <span className="board-status">
              {canDraw
                ? <span className="board-draw-badge" data-testid="board-draw-badge">✏️ {t('lesson.boardYouCanDraw')}</span>
                : <span className="muted" data-testid="board-readonly">👁 {t('lesson.readonly')}</span>}
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
      <div style={{ height }} className="board-frame">
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
          onChange={(elements) => onChange(elements as unknown as RawEl[])}
          initialData={{ elements: [], appState: { viewModeEnabled: !canDraw, showWelcomeScreen: false }, scrollToContent: false }}
        />
      </div>
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
