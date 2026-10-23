import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { usePopover } from '../lib/popover';

/**
 * Единая нижняя панель управления уроком (задача 2026-10-10, образец Zoom/Meet).
 *
 * Файл намеренно презентационный: всё состояние и все сетевые вызовы живут в `Lesson.tsx`, здесь
 * только разметка, доступные имена и поведение меню. Это даёт два свойства:
 *  • панель ничего не решает сама — права по-прежнему проверяет сервер;
 *  • автоскрытие, состояния и меню проверяются без LiveKit и без базы.
 *
 * Закреплено в разметке:
 *  • 8 кнопок на десктопе + красная «Выйти» справа; на телефоне — 5 (показ экрана, участники и
 *    доска уезжают в «Ещё»);
 *  • подписи включаются с 1280 px, до этого полоса остаётся иконками — на 1024 px для восьми
 *    подписей не хватает места (числа в комментарии styles.css и в проверке zz18);
 *  • выключенные микрофон и камера — красные с перечёркнутым значком; активные показ экрана,
 *    поднятая рука и открытая панель — подсвечены (`bar-active`);
 *  • у каждого действия есть `aria-label`, у кнопок полосы — `aria-pressed`, у пунктов меню —
 *    `role=menuitem`/`menuitemradio`/`menuitemcheckbox` с `aria-checked` (у `menuitem` состояния
 *    `pressed` нет — это поймала проверка axe);
 *  • меню закрываются по Escape и кликом вне панели; пока открыто меню или курсор над панелью,
 *    автоскрытие не срабатывает.
 */

export interface BarState {
  connected: boolean;
  micOn: boolean; camOn: boolean; screenOn: boolean; handRaised: boolean; boardOpen: boolean;
  commentsOpen: boolean; participantsOpen: boolean; unread: number; peers: number; hands: number;
  isTeacher: boolean; lectureMode: boolean; videoPaused: boolean; selfHidden: boolean;
  fullscreen: boolean; layout: string;
  /**
   * Шаг B1 (2026-10-16): что умеет ЭТОТ браузер. `false` значит не «кнопка неактивна сейчас»,
   * а «кнопка никогда не сработает» — её не видно, а вместо неё стоит объяснение.
   */
  canScreen: boolean; canFullscreen: boolean;
  /**
   * Часть C (2026-10-23): окно показа поверх других программ. `canPip` — что ЭТОТ браузер умеет
   * `documentPictureInPicture`; `pipOpen` — открыто ли окно сейчас (кнопка тогда «вернуть», а не
   * «вынести»). При `canPip: false` кнопки нет: вместо неё объяснение в плашке показа.
   */
  canPip: boolean; pipOpen: boolean;
}

export interface BarActions {
  mic: () => void; cam: () => void; share: () => void; hand: () => void; board: () => void;
  comments: () => void; participants: () => void;
  layout: (l: 'auto' | 'gallery' | 'stage' | 'teacher') => void;
  lecture: () => void; devices: () => void; hideSelf: () => void;
  stopVideo: () => void; fullscreenToggle: () => void; leave: () => void; endForAll: () => void;
  pickCam: (deviceId: string) => void; pickMic: (deviceId: string) => void;
  /** часть A (шаг A4): «новая заметка» — переход через роутер, адрес считает родитель */
  note: () => void;
  /** часть C (2026-10-23): вынести показ экрана в окно поверх других программ / вернуть его */
  pip: () => void;
}

export interface BarDevices {
  cams: { deviceId: string; label: string }[];
  mics: { deviceId: string; label: string }[];
  savedCam: string; savedMic: string;
}

type Menu = '' | 'mic' | 'cam' | 'more' | 'leave';

export default function LessonBar({ state, actions, devices }: {
  state: BarState; actions: BarActions; devices: BarDevices;
}) {
  const { t } = useTranslation();
  const [menu, setMenu] = useState<Menu>('');
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [awake, setAwake] = useState(true);
  const [overBar, setOverBar] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Автоскрытие: полноэкранный режим и собственный показ экрана прячут панель, любое движение
  // мыши или касание возвращает её.
  const mustHide = state.fullscreen || state.screenOn;
  useEffect(() => {
    const wake = () => {
      setAwake(true);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setAwake(false), 3_000);
    };
    wake();
    window.addEventListener('pointermove', wake);
    window.addEventListener('pointerdown', wake);
    window.addEventListener('touchstart', wake);
    return () => {
      window.clearTimeout(timer.current);
      window.removeEventListener('pointermove', wake);
      window.removeEventListener('pointerdown', wake);
      window.removeEventListener('touchstart', wake);
    };
  }, []);
  const hidden = mustHide && !awake && !overBar && menu === '';

  /*
   * Меню полосы управления (устройства, «Ещё», «Выйти») живёт на общем механизме размещения
   * (`lib/popover`): раньше оно крепилось к кнопке чистым CSS (`bottom: 100%`, `left: 50%` +
   * translateX), и на узком экране меню крайней кнопки свешивалось за границу вьюпорта, а в низком
   * окне упиралось в верхний край. Здесь то же самое, что и у остальных меню: кламп к краям,
   * внутренняя прокрутка, Escape и клик снаружи.
   */
  const [barAnchor, setBarAnchor] = useState<HTMLElement | null>(null);
  const close = () => { setMenu(''); setConfirmEnd(false); };
  const barPop = usePopover({ open: menu !== '', anchor: barAnchor, align: 'center', onClose: close });
  const toggle = (m: Menu, el: HTMLElement) => {
    setConfirmEnd(false);
    setBarAnchor(el);
    setMenu((cur) => (cur === m ? '' : m));
  };

  /**
   * Кнопка с иконкой и подписью (подпись — от 1024 px), state=aria-pressed.
   * `cap` — КОРОТКАЯ подпись под иконкой: полное имя действия живёт в aria-label/title (его
   * произносит скринридер и показывает тултип), а на полосе помещается короткое. Без этого восемь
   * подписанных кнопок на 1024 px расползаются за край экрана («Демонстрация экрана» + «Поднять
   * руку» + «Открыть доску» — это больше ширины полосы).
   */
  const btn = (label: string, pressed: boolean, onClick: () => void, testid: string, icon: string,
    opts: { off?: boolean; danger?: boolean; disabled?: boolean; hint?: string; cap?: string } = {}) => (
    <button
      type="button"
      className={`bar-btn${opts.off ? ' bar-off' : ''}${pressed && !opts.off ? ' bar-active' : ''}${opts.danger ? ' bar-leave' : ''}`}
      data-testid={testid}
      aria-label={label}
      aria-pressed={pressed}
      title={opts.hint ? `${label} — ${opts.hint}` : label}
      disabled={opts.disabled}
      onClick={onClick}
    >
      <span className="bar-ico" aria-hidden="true">{icon}</span>
      <span className="bar-lbl">{opts.cap ?? label}</span>
    </button>
  );

  /**
   * Микрофон/камера: кнопка состояния + стрелка выбора устройства (списки ушли с экрана).
   * Выключенное состояние показано перечёркнутым значком и красным (`bar-off`) — как было в старом
   * интерфейсе, где `🔇`/`🚫` были частью текста кнопки: на этом состоянии держатся тесты
   * zz17 и zz-camera, и именно его видит человек, у которого сервер не публику трек.
   */
  const split = (kind: 'mic' | 'cam', label: string, on: boolean, icon: string, testid: string,
    onToggle: () => void) => (
    <span className="bar-split">
      {btn(label, on, onToggle, testid, on ? icon : kind === 'mic' ? '🔇' : '🚫',
        { off: !on, disabled: !state.connected })}
      <button
        type="button" className="bar-arrow"
        data-testid={`${testid}-menu`}
        aria-label={kind === 'mic' ? t('lesson.pickMic') : t('lesson.pickCam')}
        aria-haspopup="menu" aria-expanded={menu === kind}
        title={kind === 'mic' ? t('lesson.pickMic') : t('lesson.pickCam')}
        onClick={(e) => toggle(kind, e.currentTarget)}
      >▾</button>
    </span>
  );

  const deviceRows = (kind: 'cam' | 'mic') => {
    const list = kind === 'cam' ? devices.cams : devices.mics;
    const saved = kind === 'cam' ? devices.savedCam : devices.savedMic;
    const pick = kind === 'cam' ? actions.pickCam : actions.pickMic;
    const title = kind === 'cam' ? t('lesson.toggleCamera') : t('lesson.toggleMic');
    return (
      <div className="device-list" role="menu">
        <button type="button" className="device-item" role="menuitemradio" aria-checked={!saved}
          data-testid={`${kind}-pick-default`} onClick={() => { close(); pick(''); }}>{t('lesson.deviceDefault')}</button>
        {list.map((d, i) => (
          <button key={d.deviceId || i} type="button" className="device-item" role="menuitemradio"
            aria-checked={d.deviceId === saved} data-testid={`${kind}-pick-${d.deviceId || i}`}
            onClick={() => { close(); pick(d.deviceId); }}>
            {d.label || `${title} ${i + 1}`}
          </button>
        ))}
        {list.length === 0 && <p className="bar-hint" role="presentation">{t('lesson.devicesHint')}</p>}
        <div className="bar-sep" role="separator" />
        <button type="button" className="bar-item" role="menuitem" data-testid={`${kind}-settings`}
          onClick={() => { close(); actions.devices(); }}>⚙ {t('lesson.deviceSettings')}</button>
      </div>
    );
  };

  return (
    <div className="bar-slot">
      {/* пояс сцены: он центрирует полосу по .lesson-main, поэтому у самой полосы transform нет */}
      <div className="bar-band">
        <div
          ref={rootRef}
          className={`lesson-bar${hidden ? ' bar-hidden' : ''}`}
          role="toolbar"
          aria-label={t('lesson.barAria')}
          data-testid="lesson-bar"
          data-popover-chrome
          data-hidden={hidden ? '1' : '0'}
          onMouseEnter={() => setOverBar(true)}
          onMouseLeave={() => setOverBar(false)}
        >
          {split('mic', t('lesson.toggleMic'), state.micOn, '🎙', 'mic-toggle', () => actions.mic())}
          {split('cam', t('lesson.toggleCamera'), state.camOn, '📹', 'camera-toggle', () => actions.cam())}

          {/* показ экрана: на телефоне — внутри «Ещё» */}
          <span className="bar-desk">
            {btn(state.screenOn ? t('lesson.shareStop') : t('lesson.shareScreen'), state.screenOn,
              () => actions.share(), 'share-toggle', '🖥',
              { disabled: !state.connected, cap: state.screenOn ? t('lesson.capStopShare') : t('lesson.capShare') })}
          </span>

          {btn(state.handRaised ? t('lesson.lowerHand') : t('lesson.raiseHand'), state.handRaised,
            () => actions.hand(), 'raise-hand', '✋', { cap: t('lesson.capHand') })}
          {/* доска: на телефоне уезжает в «Ещё» — там не больше пяти кнопок (задача 2026-10-10) */}
          <span className="bar-desk">
            {btn(state.boardOpen ? t('lesson.boardClose') : t('lesson.boardOpen'), state.boardOpen,
              () => actions.board(), 'board-toggle', '🧑‍🏫', { cap: t('lesson.capBoard') })}
          </span>
          <span className="bar-rel">
            {btn(t('lesson.commentsTitle'), state.commentsOpen, () => actions.comments(), 'comments-open', '💬',
              { cap: t('lesson.capComments') })}
            {state.unread > 0 && !state.commentsOpen && (
              <span className="bar-badge" data-testid="comments-unread" aria-hidden="true">{state.unread > 99 ? '99+' : state.unread}</span>
            )}
          </span>

          {/* участники: на телефоне — внутри «Ещё» */}
          <span className="bar-desk">
            <button
              type="button" className={`bar-btn${state.participantsOpen ? ' bar-active' : ''}`}
              data-testid="participants-toggle"
              aria-label={`${t('lesson.peersTitle')} · ${state.peers}`}
              aria-pressed={state.participantsOpen} title={t('lesson.peersTitle')}
              onClick={() => actions.participants()}
            >
              <span className="bar-ico" aria-hidden="true">👥</span>
              <span className="bar-lbl">{t('lesson.peersTitle')}</span>
              {state.hands > 0 && (
                <span className="bar-badge" data-testid="participants-badge" aria-hidden="true">{state.hands}</span>
              )}
            </button>
          </span>

          <span className="bar-rel">
            <button
              type="button" className={`bar-btn${menu === 'more' ? ' bar-active' : ''}`}
              data-testid="more-btn" aria-label={t('lesson.more')} aria-haspopup="menu"
              aria-expanded={menu === 'more'} title={t('lesson.more')} onClick={(e) => toggle('more', e.currentTarget)}
            >
              <span className="bar-ico" aria-hidden="true">⋯</span>
              <span className="bar-lbl">{t('lesson.more')}</span>
            </button>
          </span>

          {state.isTeacher ? (
            <button
              type="button" className="bar-btn bar-leave" data-testid="leave-btn"
              aria-label={t('lesson.leave')} title={t('lesson.leave')}
              aria-haspopup="menu" aria-expanded={menu === 'leave'}
              onClick={(e) => toggle('leave', e.currentTarget)}
            >
              <span className="bar-ico" aria-hidden="true">📴</span>
              <span className="bar-lbl">{t('lesson.leave')}</span>
            </button>
          ) : (
            <button
              type="button" className="bar-btn bar-leave" data-testid="leave-btn"
              aria-label={t('lesson.leave')} title={t('lesson.leave')} onClick={() => actions.leave()}
            >
              <span className="bar-ico" aria-hidden="true">📴</span>
              <span className="bar-lbl">{t('lesson.leave')}</span>
            </button>
          )}

          {menu === 'mic' && (
            <div className="bar-menu" role="group" aria-label={t('lesson.pickMic')} data-testid="mic-menu"
              ref={barPop.ref} style={barPop.style}>
              <div className="bar-menu-title">🎙 {t('lesson.pickMic')}</div>
              {deviceRows('mic')}
            </div>
          )}
          {menu === 'cam' && (
            <div className="bar-menu" role="group" aria-label={t('lesson.pickCam')} data-testid="cam-menu"
              ref={barPop.ref} style={barPop.style}>
              <div className="bar-menu-title">📹 {t('lesson.pickCam')}</div>
              {deviceRows('cam')}
            </div>
          )}
          {menu === 'leave' && (
            <div className="bar-menu" role="menu" aria-label={t('lesson.more')} data-testid="leave-menu"
              ref={barPop.ref} style={barPop.style}>
              <button type="button" className="bar-item" role="menuitem" data-testid="leave-keep"
                onClick={() => { close(); actions.leave(); }}>
                📴 {t('lesson.leaveKeep')}
              </button>
              {!confirmEnd ? (
                <button type="button" className="bar-item bar-danger" role="menuitem" data-testid="end-for-all"
                  onClick={() => setConfirmEnd(true)}>
                  ⏹ {t('lesson.endForAll')}
                </button>
              ) : (
                <div className="panel-section" data-testid="end-confirm">
                  <p className="bar-hint" role="presentation">{t('lesson.endForAllConfirm')}</p>
                  <div className="row">
                    <button type="button" className="bar-item bar-danger" role="menuitem" data-testid="end-for-all-confirm"
                      onClick={() => { close(); actions.endForAll(); }}>
                      {t('lesson.confirm')}
                    </button>
                    <button type="button" className="bar-item" role="menuitem" data-testid="end-cancel" onClick={() => setConfirmEnd(false)}>
                      ✕ {t('common.cancel')}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
          {menu === 'more' && (
            <div className="bar-menu" role="menu" aria-label={t('lesson.more')} data-testid="more-menu"
              ref={barPop.ref} style={barPop.style}>
              <div className="bar-menu-title" role="presentation">📱 {t('lesson.layout')}</div>
              {([
                ['auto', t('lesson.layoutAuto')], ['gallery', t('lesson.layoutGrid')],
                ['stage', t('lesson.layoutSidebar')], ['teacher', t('lesson.layoutSpotlight')],
              ] as const).map(([value, label]) => (
                <button key={value} type="button" className="bar-item" role="menuitemradio"
                  aria-checked={state.layout === value} data-testid={`layout-${value}`}
                  onClick={() => actions.layout(value)}>
                  {label}
                </button>
              ))}
              <div className="bar-sep" role="separator" />
              {/* на телефоне сюда переезжают показ экрана и список участников */}
              {/*
                axe (2026-10-11) поймала `aria-allowed-attr`: у `menuitem` нет состояния `pressed`.
                Двухпозиционный пункт меню — это menuitemcheckbox + aria-checked (так же сделаны
                «Доска», режим лекции и полноэкранный режим), поэтому показ экрана переехал на них.
              */}
              {state.canScreen ? (
                <button type="button" className="bar-item bar-mob" role="menuitemcheckbox" aria-checked={state.screenOn}
                  data-testid="more-share" disabled={!state.connected}
                  onClick={() => { close(); actions.share(); }}>
                  🖥 {state.screenOn ? t('lesson.shareStop') : t('lesson.shareScreen')}
                </button>
              ) : (
                /* шаг B1: на мобильном Safari `getDisplayMedia` нет — вместо мёртвой кнопки строка,
                     объясняющая, почему показа экрана нет. Кнопка, которая «никогда не жмётся»,
                     читается как сломанный урок. */
                <p className="bar-hint bar-mob" role="note" data-testid="cap-no-screen">{t('lesson.capNoScreen')}</p>
              )}
              <button type="button" className="bar-item bar-mob" role="menuitem" data-testid="more-participants"
                onClick={() => { close(); actions.participants(); }}>
                👥 {t('lesson.peersTitle')} · {state.peers}
              </button>
              {/* часть C: окно показа поверх других программ — только там, где браузер это умеет,
                  и только когда показ уже идёт (иначе выносить нечего) */}
              {state.canPip && state.screenOn && (
                <button type="button" className="bar-item" role="menuitemcheckbox" aria-checked={state.pipOpen}
                  data-testid="more-pip" onClick={() => { close(); actions.pip(); }}>
                  ⧉ {t('lesson.sharePipOpen')}
                </button>
              )}
              <button type="button" className="bar-item bar-mob" role="menuitemcheckbox" aria-checked={state.boardOpen}
                data-testid="more-board"
                onClick={() => { close(); actions.board(); }}>
                🧑‍🏫 {state.boardOpen ? t('lesson.boardClose') : t('lesson.boardOpen')}
              </button>
              {state.isTeacher && (
                <button type="button" className="bar-item" role="menuitemcheckbox" aria-checked={state.lectureMode}
                  data-testid="lecture-mode" onClick={() => actions.lecture()}>
                  🎓 {state.lectureMode ? t('lesson.lectureOn') : t('lesson.lectureMode')}
                </button>
              )}
              {/* часть A (шаг A4): переход через роутер, а не `<a href>` — документальная перезагрузка
                  обрывала урок, теперь она и вовсе не нужна */}
              <button type="button" className="bar-item" role="menuitem" data-testid="lesson-new-note"
                onClick={() => { close(); actions.note(); }}>📝 {t('home.newNote')}</button>
              {state.canFullscreen && (
                <button type="button" className="bar-item" role="menuitemcheckbox" aria-checked={state.fullscreen}
                  data-testid="fullscreen-btn" disabled={!state.connected}
                  onClick={() => { close(); actions.fullscreenToggle(); }}>
                  ⛶ {t('lesson.boardFull')}
                </button>
              )}
              <button type="button" className="bar-item" role="menuitemcheckbox" aria-checked={state.selfHidden}
                data-testid="hide-self" disabled={!state.connected}
                onClick={() => { close(); actions.hideSelf(); }}>
                🙈 {t('lesson.pipHide')}
              </button>
              <button type="button" className="bar-item" role="menuitemcheckbox" aria-checked={state.videoPaused}
                data-testid="stop-video" title={t('lesson.stopVideoHint')} disabled={!state.connected}
                onClick={() => { close(); actions.stopVideo(); }}>
                ⏸ {state.videoPaused ? t('lesson.resumeVideo') : t('lesson.stopVideo')}
              </button>
              <button type="button" className="bar-item" role="menuitem" data-testid="more-devices"
                onClick={() => { close(); actions.devices(); }}>
                ⚙ {t('lesson.deviceSettings')}
              </button>
              <div className="bar-sep" role="separator" />
              <div className="bar-menu-title" role="presentation">⌨ {t('lesson.hotkeys')}</div>
              <p className="bar-hint" role="presentation" data-testid="hotkeys-list">{t('lesson.hotkeysList')}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
