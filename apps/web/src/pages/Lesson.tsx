import { lazy, memo, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Room, RoomEvent, Track, VideoPresets, type Track as LkTrack } from 'livekit-client';
import { api, getToken, wsTicket } from '../lib/api';
import { useAuth } from '../App';
import NotesDrawer from '../components/NotesDrawer';
import { useCommentFrames, useCommentUnread } from '../components/LessonComments';
import { useHandFrames, useHands } from '../components/LessonHands';
import LessonBar, { type BarActions, type BarDevices, type BarState } from '../components/LessonBar';
import type { PanelTab } from '../components/LessonPanel';
import { DeviceSettings, speakerPickSupported, useMicMeter } from '../components/DeviceSettings';
import { cameraAttempts, microphoneAttempts, isRetryableMediaError, mediaErrorKey, pickStageContent, stageSwitchVisible, stripKeys } from '@klass/shared';
import ScreenStage from '../components/ScreenStage';

/*
 * Часть 2 задачи 2026-10-10 (измерено, а не «на глаз»): и Excalidraw, и панель вкладок жили в
 * чанке страницы урока, поэтому человек, который открыл урок, скачивал холст всегда — 1 180,2 kB
 * (384,2 kB gzip) одним куском. После разделения чанк урока — 62,1 kB (17,4 kB gzip), холст —
 * отдельные 1 132,4 kB, панель — 3,8 kB (числа из `vite build`, таблица в docs/PERFORMANCE.md,
 * там же — как проверить их на боевом проде). Доска грузится, когда её действительно рендерим,
 * панель — когда её открывают. Fallback держит ту же высоту, чтобы приход чанка не дёргал
 * раскладку (то же требование «панель не сдвигает контент»).
 */
const Board = lazy(() => import('../components/Board'));
const LessonPanelLazy = lazy(() => import('../components/LessonPanel'));
const CommentsPanelLazy = lazy(() => import('../components/LessonComments').then((m) => ({ default: m.CommentsPanel })));

interface Session {
  id: string; classId: string; eventId: string | null; roomName: string;
  startedAt: string; endedAt: string | null; lectureMode: boolean; muteAll: boolean;
  /** часть 1: решение учителя возвращать устройства учеников после лекции (живёт на сессии) */
  lectureRestore: boolean;
  /**
   * часть 1: СЕРВЕРНЫЙ снимок «что горело до лекции» — только для спрашивающего. Сервер пишет его
   * при включении лекции, читая список участников до отзыва публикации; наружу отдаётся запись
   * этого identity, поэтому перезагрузка страницы посреди лекции снимок не теряет.
   */
  preLecture: { mic: boolean; cam: boolean } | null;
  layout: 'auto' | 'gallery' | 'stage' | 'teacher'; boardOpen: boolean; wsUrl: string;
  /** task 2: who may write comments in this lesson */
  commentsMode: 'on' | 'off' | 'slow';
}

interface PeerView {
  identity: string; name: string; micOn: boolean; camOn: boolean; screenOn: boolean;
}

interface Tile {
  key: string; kind: 'video' | 'audio'; name: string; local: boolean; screen: boolean;
  sid: string;
}

const LS_CAM = 'blublu.camDevice';
const LS_MIC = 'blublu.micDevice';
const LS_SPK = 'blublu.speakerDevice';
const LS_PIP = 'blublu.pip'; // task B: remembered floating-camera position + flags
/**
 * Задача 2026-10-10: «запомнить выбор и включённость между уроками». Это не право и не
 * ограничение — это то, что человек оставил для себя: пришли на следующий урок с выключенной
 * камерой, если так ушли с прошлого. Ключа нет ⇒ прежнее поведение (публиковать и микрофон, и
 * камеру), поэтому первая сессия ничем не отличается от вчерашней.
 */
const LS_WANTED_CAM = 'blublu.camWanted';
const LS_WANTED_MIC = 'blublu.micWanted';
/**
 * Часть 1: отказ комнаты опубликовать трек (`livekit-client` проверяет право локально, по своей
 * копии `permissions`, и поднимает `PublishTrackError` со statusCode 403). Отличает «ещё не
 * пустила» от «браузер не даёт устройство» — второму повторяют подсказка другого рода.
 */
const blockedByRights = (e: unknown) => {
  const err = e as { message?: string; statusCode?: number };
  return /insufficient permissions/i.test(err.message ?? '') || err.statusCode === 403;
};
/** часть 1: служебный errKey «комната ещё не пустила» — не ошибка устройства, текста человеку нет */
const NO_RIGHTS = 'lectureNoRights';
/**
 * Часть 1: сколько ждём возврата права публиковать после лекции.
 *
 * Это потолок для случая, когда событие `ParticipantPermissionsChanged` потеряно, а не описание
 * нормальной задержки комнаты: задержка измеряется в CI-прогоне zz19 (комната и API там стоят на
 * 127.0.0.1, без сетевых пауз), и если она оказывается единицами секунд, запас здесь — просто
 * страховка. Если по истечении права так и не пришли, ученик получает внятное сообщение, а не
 * молчание.
 */
const RIGHTS_WAIT_MS = 5_000;

const readFlag = (key: string, dflt: boolean): boolean => {
  try {
    const v = localStorage.getItem(key);
    return v === null ? dflt : v === '1';
  } catch { return dflt; }
};
const writeFlag = (key: string, on: boolean) => {
  try { localStorage.setItem(key, on ? '1' : '0'); } catch { /* приватный режим — просто не запомним */ }
};

// livekit-client keeps its capture-option types internal — derive them from the
// method signatures so the constraint chain below type-checks without casts to any
type CamOpts = NonNullable<Parameters<Room['localParticipant']['setCameraEnabled']>[1]>;
type MicOpts = NonNullable<Parameters<Room['localParticipant']['setMicrophoneEnabled']>[1]>;
/**
 * Same trick for the screen: deriving the type from the method signature proves at compile time
 * which getDisplayMedia options this livekit-client version forwards (2.22.3 does carry
 * selfBrowserSurface / surfaceSwitching / systemAudio / contentHint — checked in
 * dist/src/room/track/options.d.ts and screenCaptureToDisplayMediaStreamOptions).
 */
type ShareOpts = NonNullable<Parameters<Room['localParticipant']['setScreenShareEnabled']>[1]>;
/** setSubscribed есть у RemoteTrackPublication в 2.22.3 (dist/src/room/track/RemoteTrackPublication.d.ts). */
type Subscribable = { setSubscribed?: (subscribed: boolean) => Promise<void> };
/** switchActiveDevice(kind, deviceId, exact) есть у Room в 2.22.3 (dist/src/room/Room.d.ts:228). */
type SpeakerSwitch = { switchActiveDevice?: (kind: string, deviceId: string, exact?: boolean) => Promise<boolean> };

/** LiveKit/RTCException name → localized sentence with the browser's reason appended. */
function useMediaErrorText() {
  const { t } = useTranslation();
  return (key: string, e: unknown) => {
    const base = t(`lesson.${key}`, { defaultValue: t('common.errorGeneric') });
    const detail = (e as { message?: string })?.message ?? '';
    return key.endsWith('Unavailable') && detail ? `${base}: ${detail}` : base;
  };
}

function VideoTileBase({ tile, track, big = false, hideName = false }: {
  tile: Tile; track?: LkTrack; big?: boolean;
  /** the screen stage paints its own caption band, so the tile must not add a second one */
  hideName?: boolean;
}) {
  const { t } = useTranslation();
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    const el = tile.kind === 'video' ? videoRef.current : audioRef.current;
    if (!el || !track) return;
    track.attach(el);
    return () => { track.detach(el); };
  }, [track, tile.key, tile.kind]);
  return (
    <div className={big ? 'video-tile tile-big' : 'video-tile'} data-testid={tile.local ? 'tile-local' : 'tile-peer'}
      data-local={tile.local ? '1' : '0'} data-screen={tile.screen ? '1' : undefined}
      // remote audio must NOT take a grid slot — it plays silently in the background
      style={tile.kind === 'audio' ? { display: 'none' } : undefined}>
      {!hideName && <div className="muted">{tile.name}{tile.screen ? ` · ${t('lesson.stageScreen')}` : ''}</div>}
      {tile.kind === 'video'
        ? <video ref={videoRef} autoPlay playsInline muted={tile.local} />
        : <audio ref={audioRef} autoPlay />}
    </div>
  );
}

/**
 * Часть 2: тайл мемоизирован. Без этого каждая смена состояния страницы (счётчик непрочитанных,
 * тост, раскладка) перерисовывала все <video>, а `track.attach(el)` привязан к ref'у и при
 * перемонтировании тайла отдирал и снова вешал медиаэлемент.
 */
const VideoTile = memo(VideoTileBase);

export default function Lesson() {
  const { t } = useTranslation();
  const mediaErrorText = useMediaErrorText();
  const { me } = useAuth();
  const qc = useQueryClient();
  const [params] = useSearchParams();
  const eventId = params.get('eventId') ?? undefined;
  const classIdParam = params.get('classId') ?? undefined;

  const [session, setSession] = useState<Session | null>(null);
  const [connected, setConnected] = useState(false);
  const [peers, setPeers] = useState<PeerView[]>([]);
  const [error, setError] = useState('');
  const [layout, setLayout] = useState<Session['layout']>('auto');
  const [lectureMode, setLectureMode] = useState(false);
  const [screenOn, setScreenOn] = useState(false);
  const [localCamOn, setLocalCamOn] = useState(false);
  const [localMicOn, setLocalMicOn] = useState(false);
  const [muteAll, setMuteAll] = useState(false); // task 3: teacher muted everyone
  // ── task B: Meet-style stage ──
  const [boardOpen, setBoardOpen] = useState(false); // shared: the board is the main window
  const [boardFull, setBoardFull] = useState(false); // local: browser fullscreen for the stage
  const [pinnedKey, setPinnedKey] = useState<string | null>(null); // local: click-to-pin
  const [activeSid, setActiveSid] = useState<string | null>(null); // auto: who is speaking
  // ── screen demonstration (task 1, 2026-10-08) ──
  // local: the viewer picked «Доска» in the Экран | Доска switch while a screen is live
  const [showBoardInstead, setShowBoardInstead] = useState(false);
  // local: the presenter's own preview window (collapsed by default, see 1.3)
  const [sharePreview, setSharePreview] = useState(false);
  // the shared surface turned out to be a browser tab/window → the mirror-corridor warning
  const [shareSurface, setShareSurface] = useState<'window' | 'browser' | 'monitor' | ''>('');
  // in fullscreen the participant strip can be hidden away
  const [stripOpen, setStripOpen] = useState(true);
  const [pip, setPip] = useState<{ x: number; y: number; min: boolean; hidden: boolean }>(
    () => { try { return { x: 12, y: 12, min: false, hidden: false, ...JSON.parse(localStorage.getItem(LS_PIP) || '{}') }; } catch { return { x: 12, y: 12, min: false, hidden: false }; } });
  const stageRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ x0: number; y0: number; px0: number; py0: number } | null>(null);
  const [toast, setToast] = useState('');
  const toastTimer = useRef<number | undefined>(undefined);
  /** Часть 1: у тоста возврата после лекции есть кнопка «Выключить». */
  const [toastAction, setToastAction] = useState<{ label: string; run: () => void } | null>(null);
  /*
   * Часть 1: идёт ли лекция с точки зрения этого клиента (кадр, опрос статуса или отнятое право).
   * Нужен один флаг: он и открывает эпизод, и гарантирует, что возврат случится ровно один раз.
   */
  const lectureEpisodeRef = useRef(false);
  /*
   * Часть 1: СВОЯ запись серверного снимка «что горело до лекции», кэшированная на время лекции.
   *
   * Значение пришЛО с сервера (`session.preLecture` при включении лекции: маршрут читает список
   * участников ДО отзыва публикации), поэтому порядок «сигнал комнаты или наш кадр» на него не
   * влияет — клиент просто помнит то, что ему сказали. Кэш нужен затем, что сервер СТИРАЕТ снимок
   * при выключении лекции: запрос статуса уже после `lecture_off` ничего не вернёт. Переживаем
   * перезагрузку так же: при входе статус (и кадр `started`) приносит тот же снимок, пока лекция
   * идёт.
   */
  const preLectureRef = useRef<{ mic: boolean; cam: boolean } | null>(null);
  /*
   * Часть 1: решение учителя о возврате, актуальное для ТЕКУЩЕго эпизода. Кадр `lectureMode`
   * несёт `restore` сам, и опрос статуса приносит `lectureRestore`; без этой памяти эффект,
   * закрывающий эпизод, читал `lectureRestore` из устаревшего `session` и снимал возврат
   * (замер 2026-10-13: при задержанных кадрах ученик получил `restore=false` от предыдущего
   * урока, а честный `restore=true` из кадра до эффекта уже не дошёл).
   */
  const lectureRestoreChoiceRef = useRef(true);
  /** часть 1: страховка на случай потерянного кадра `lecture_off` */
  const lectureOffSafetyRef = useRef<number | undefined>(undefined);
  /** часть 1: «выключить всех» на момент возврата (замыкание сокета устарело бы) */
  const muteAllRef = useRef(false);
  useEffect(() => { muteAllRef.current = muteAll; }, [muteAll]);
  const [lectureAsk, setLectureAsk] = useState<{ restore: boolean } | null>(null);
  const [camErr, setCamErr] = useState('');
  const [micErr, setMicErr] = useState('');
  const [sheetsOpen, setSheetsOpen] = useState(false);
  /*
   * Задача 2026-10-10: правая панель с вкладками «Участники» и «Комментарии». Одна открытая
   * панель и одна активная вкладка; кнопка панели управления переключает СВОЮ вкладку, поэтому
   * повторное нажатие закрывает её, а не открывает вторую.
   */
  const [panelOpen, setPanelOpen] = useState(false);
  const [panelTab, setPanelTab] = useState<PanelTab>('people');
  const commentsOpen = panelOpen && panelTab === 'comments';
  const participantsOpen = panelOpen && panelTab === 'people';
  const toggleTab = (tab: PanelTab) => {
    if (panelOpen && panelTab === tab) setPanelOpen(false);
    else { if (tab === 'comments') setBadge(0); setPanelTab(tab); setPanelOpen(true); }
  };
  /** лист настроек устройств из меню «Ещё» */
  const [devicesOpen, setDevicesOpen] = useState(false);
  /** входящее видео на паузе (экономия трафика) — применяется и к новым подпискам */
  const [videoPaused, setVideoPaused] = useState(false);
  const videoPausedRef = useRef(false);
  const [spkErr, setSpkErr] = useState('');
  /**
   * Task 2: the teacher keeps the transcript after the lesson ends. `session` goes away with the
   * lesson (the status query says "not running"), so the id of the lesson this page actually saw
   * is remembered — the server decides who may still read it (only the teacher of that class),
   * and a student's panel disappears with the lesson exactly as their access does.
   */
  const [lastSessionId, setLastSessionId] = useState<string | null>(null);
  useEffect(() => { if (session?.id) setLastSessionId(session.id); }, [session?.id]);
  const onCommentFrame = useCommentFrames(session?.id ?? null);
  /*
   * Task 2Б: the raise-hand queue. It is read while a lesson runs and simply stops existing when
   * the lesson ends — a hand is not a transcript, there is nothing to keep for the teacher.
   */
  const handsQ = useHands(session?.id ?? null, Boolean(session?.id));
  const onHandFrame = useHandFrames(session?.id ?? null);
  const myHand = handsQ.q.data?.mine ?? null;
  const hasFloor = Boolean(myHand?.grantedAt);
  /*
   * Счётчик на кнопке «Комментарии»: одно число при входе (useCommentUnread) + то, что пришло по
   * сокету, пока панель закрыта. Фоновый опрос здесь был бы вреден: GET отмечает прочтение на
   * сервере, так что счётчик сгорал сам, не дождавшись человека (см. LessonComments.tsx).
   */
  const unreadSeed = useCommentUnread(session?.id ?? null);
  const [badge, setBadge] = useState(0);
  // сид приходит одним запросом на урок; дальше его двигает только сокет
  useEffect(() => { setBadge(unreadSeed); }, [unreadSeed]);
  const unread = commentsOpen ? 0 : badge;
  /*
   * The socket effect closes over whatever `me` was when it ran, and after a hard reload the token
   * can be ready before the profile is. A stale `me` inside `onmessage` would then drop the
   * «вам дали слово» frame for the only person it matters to, so the id lives in a ref.
   */
  const meIdRef = useRef<string | null>(me?.id ?? null);
  const commentsOpenRef = useRef(false);
  useEffect(() => { commentsOpenRef.current = commentsOpen; }, [commentsOpen]);
  useEffect(() => { meIdRef.current = me?.id ?? null; }, [me?.id]);
  const [floorTakenNotice, setFloorTakenNotice] = useState(false);
  useEffect(() => {
    if (!floorTakenNotice) return;
    const t = window.setTimeout(() => setFloorTakenNotice(false), 8_000);
    return () => window.clearTimeout(t);
  }, [floorTakenNotice]);
  /*
   * «Дать слово» ends with the microphone ON in this browser, because LiveKit will not do it for
   * us: `mutePublishedTrack(muted: false)` answers 412 "remote unmute not enabled" (measured in
   * the CI run of 2026-10-10). The student raising the hand already asked to speak, so turning the
   * mic on at the grant is the answer to their own request — and the failure is shown, not
   * swallowed, because a silent no-op here would look like the floor did not arrive.
   */
  async function acceptFloor() {
    const room = roomRef.current;
    if (!room) return;
    if (room.localParticipant.isMicrophoneEnabled) return;
    try {
      await room.localParticipant.setMicrophoneEnabled(
        true, savedMic ? ({ deviceId: { exact: savedMic } } as MicOpts) : undefined);
      setMicErr('');
      refreshLocal(room);
    } catch (e: unknown) {
      try {
        await room.localParticipant.setMicrophoneEnabled(true);
        setMicErr('');
      } catch (e2: unknown) {
        setMicErr(mediaErrorText(mediaErrorKey(e2, 'microphone'), e2 ?? e));
      }
      refreshLocal(room);
    }
  }

  /**
   * Часть 1: право публиковать ещё не вернулось — ждём СОБЫТИЯ комнаты, а не повторяем попытку
   * по таймеру.
   *
   * `setMicrophoneEnabled(true)` без права не публикует трек (`hasPermissionsToPublish` →
   * «insufficient permissions», statusCode 403), и повтор по таймеру эту гонку не решает: ожидание
   * должно заканчиваться тем же сигналом, который его начал. Порог (`RIGHTS_WAIT_MS`) — страховка
   * от потерянного события, а не «сколько живёт этот браузер»: он численно проверяется в CI, где
   * комната и API стоят на 127.0.0.1 без сетевых задержек.
   */
  function waitCanPublish(room: Room, kind: 'microphone' | 'camera', timeoutMs = RIGHTS_WAIT_MS): Promise<boolean> {
    const allowed = () => {
      const p = room.localParticipant.permissions as { canPublish?: boolean; canPublishSources?: unknown[] } | undefined;
      // права ещё не пришли в информации о себе — это не запрет: ждать нечего
      if (!p) return true;
      if (p.canPublish === false) return false;
      const src = p.canPublishSources ?? [];
      if (src.length === 0) return true; // пустой список = «любые источники»
      // livekit-client отдаёт `canPublishSources` то числами протокола (CAMERA=1, MICROPHONE=2),
      // то строками своего перечисления ('camera', 'microphone') — зависим от версии пакета,
      // поэтому принимаем обе формы вместо одной угаданной
      const want = kind === 'microphone' ? [2, 'microphone'] : [1, 'camera'];
      return src.some((s) => want.includes(typeof s === 'number' ? s : String(s).toLowerCase()));
    };
    if (allowed()) return Promise.resolve(true);
    return new Promise((resolve) => {
      const finish = (v: boolean) => {
        window.clearTimeout(deadline);
        room.off(RoomEvent.ParticipantPermissionsChanged, onChange);
        resolve(v);
      };
      const onChange = () => { if (allowed()) finish(true); };
      const deadline = window.setTimeout(() => finish(false), timeoutMs);
      room.on(RoomEvent.ParticipantPermissionsChanged, onChange);
    });
  }

  /** часть 1: конец эпизода лекции; возвращает ровно один раз — кто бы о конце ни сообщил */
  function endLectureEpisode(restore: boolean) {
    if (!lectureEpisodeRef.current) return;
    lectureEpisodeRef.current = false;
    window.clearTimeout(lectureOffSafetyRef.current);
    void restoreAfterLecture(restore);
  }

  /**
   * Часть 1: запомнить СВОЮ запись серверного снимка, пока лекция идёт.
   *
   * Сервер пишет `lecture_pre_devices` при включении лекции и СТИРАЕТ его при выключении, поэтому
   * снимать «что горело» надо в момент лекции, а не по `lecture_off` (тогда в базе уже пусто).
   * Отдельный запрос нужен, чтобы не ждать опроса (в комнате он раз в 30 с — короткая лекция
   * уложится между двумя опросами, и снимок не успеет запомниться). Кадр `lectureMode on` — как раз
   * тот сигнал, что лекция началась; после него снимок на сервере точно записан.
   */
  async function rememberMySnapshot() {
    const query = eventId ? `eventId=${eventId}` : `classId=${classIdParam}`;
    try {
      const res = await api<{ session?: Session | null }>(`/api/lessons/active?${query}`);
      // только своя запись; сервер не отдал её (не-участник, конец лекции) — кэш остаётся пустым
      preLectureRef.current = res.session?.preLecture ?? null;
    } catch {
      /* отказ статуса — то же, что «сервер ничего не записал»: включать будет нечего */
    }
  }

  /** включает микрофон цепочкой «запомненное устройство → любое»; 'rights' — отказ из-за права */
  async function tryMic(room: Room): Promise<'on' | 'rights' | 'device'> {
    try {
      await room.localParticipant.setMicrophoneEnabled(
        true, savedMic ? ({ deviceId: { exact: savedMic } } as MicOpts) : undefined);
      setMicErr('');
      return 'on';
    } catch (e: unknown) {
      if (blockedByRights(e)) return 'rights';
      try {
        await room.localParticipant.setMicrophoneEnabled(true);
        setMicErr('');
        return 'on';
      } catch (e2: unknown) {
        if (blockedByRights(e2)) return 'rights';
        setMicErr(mediaErrorText(mediaErrorKey(e2, 'microphone'), e2 ?? e));
        return 'device';
      }
    }
  }

  /**
   * Часть 1: `lecture_off`. Сервер вернул ПРАВО публиковать (сам он этого сделать не может:
   * LiveKit отвечает 412 на удалённое включение), устройство включает ученик — и ровно то, что
   * у него горело до лекции. Пришедшему во время лекции снимать нечего, значит и включаться
   * не будет; отказ браузера (разрешение отозвано) — отдельная понятная подсказка, а не тишина.
   *
   * Порядок «сначала попытка, ждать только если не пустила комната» — из того, как устроен ответ
   * `lecture_off`: сервер возвращает права каждого ученика отдельным вызовом, а кадр шлёт после,
   * поэтому к моменту кадра право уже может быть и может опаздывать. Ожидание по событию — только
   * для второго случая; ждать его всегда — значит задерживать возврат тому, кому право уже пришло.
   */
  async function restoreAfterLecture(restore: boolean) {
    const want = preLectureRef.current;
    preLectureRef.current = null; // снимок одноразовый: сервер уже стёр свою копию при выключении
    const room = roomRef.current;
    if (!room || !want || !restore || isTeacher) return;
    const turnedOn: { mic: boolean; cam: boolean } = { mic: false, cam: false };
    let micNoRights = false;
    let camNoRights = false;
    /*
     * «Выключить всех» — решение учителя, которое действует и после лекции: ученик не может снять
     * себя с мьюта кнопкой (см. `toggleMicInRoom`), поэтому и возврат не включает ему микрофон.
     * Флаг про аудио — камера под ним не попадает.
     */
    if (want.mic && !muteAllRef.current) {
      let r = await tryMic(room);
      if (r === 'rights') r = (await waitCanPublish(room, 'microphone')) ? await tryMic(room) : 'rights';
      if (r === 'on') turnedOn.mic = true; else micNoRights = r === 'rights';
    }
    if (want.cam) {
      let cam = await enableCameraIn(room);
      if (cam.errKey && blockedByRights(cam.err)) {
        cam = (await waitCanPublish(room, 'camera')) ? await enableCameraIn(room) : { errKey: NO_RIGHTS, err: cam.err };
      }
      if (cam.errKey === NO_RIGHTS) camNoRights = true;
      else if (cam.errKey) setCamErr(mediaErrorText(cam.errKey, cam.err));
      else turnedOn.cam = true;
    }
    refreshLocal(room);
    const off = () => {
      const r = roomRef.current;
      if (!r) return;
      if (turnedOn.mic) void r.localParticipant.setMicrophoneEnabled(false).catch(() => undefined);
      if (turnedOn.cam) void r.localParticipant.setCameraEnabled(false).catch(() => undefined);
      writeFlag(LS_WANTED_MIC, false);
      refreshLocal(r);
      setToast(''); setToastAction(null);
    };
    const stop = { label: t('lesson.lectureRestoreOff'), run: off };
    if (turnedOn.mic && turnedOn.cam) showToast(t('lesson.lectureRestoredBoth'), stop);
    else if (turnedOn.mic) showToast(t('lesson.lectureRestoredMic'), stop);
    else if (turnedOn.cam) showToast(t('lesson.lectureRestoredCam'), stop);
    // право так и не вернулось: это не отказ браузера и не «нечего возвращать» — у случая есть
    // объяснение (медиа-сервер или связь с комнатой) и отдельная подсказка
    else if (micNoRights || camNoRights) showToast(t('lesson.lectureRestoreNoRights'));
    else if (want.mic || want.cam) showToast(t('lesson.lectureRestoreBlocked'));
  }

  const roomRef = useRef<Room | null>(null);

  // Part 4а: heartbeat that keeps the LiveKit join-token fresh during a long lesson.
  const tokenRefreshRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── tiles are React state, NOT imperative DOM: publish/subscribe events can
  // fire BEFORE `connected` renders the grid — with DOM insertion they were
  // silently dropped (the root cause of «камера нигде не показывается»).
  const [tiles, setTiles] = useState<Tile[]>([]);
  const tracksRef = useRef<Map<string, LkTrack>>(new Map());

  // ── preview (pre-join) + device selection ──────────────────────────────────
  const [previewChecked, setPreviewChecked] = useState(false);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewStream, setPreviewStream] = useState<MediaStream | null>(null);
  /** живой поток микрофона на экране проверки: без него нет индикатора уровня */
  const [micStream, setMicStream] = useState<MediaStream | null>(null);
  const previewVideoRef = useRef<HTMLVideoElement>(null);
  const [cams, setCams] = useState<MediaDeviceInfo[]>([]);
  const [mics, setMics] = useState<MediaDeviceInfo[]>([]);
  const [spks, setSpks] = useState<MediaDeviceInfo[]>([]);
  const [savedCam, setSavedCam] = useState<string>(() => localStorage.getItem(LS_CAM) ?? '');
  const [savedMic, setSavedMic] = useState<string>(() => localStorage.getItem(LS_MIC) ?? '');
  const [savedSpk, setSavedSpk] = useState<string>(() => localStorage.getItem(LS_SPK) ?? '');
  const canPickSpeaker = useMemo(() => speakerPickSupported(), []);
  const micLevel = useMicMeter(micStream);

  const isTeacher = me?.role === 'teacher';

  useEffect(() => {
    const el = previewVideoRef.current;
    if (el) el.srcObject = previewStream;
  }, [previewStream]);

  async function refreshDevices() {
    try {
      const list = await navigator.mediaDevices.enumerateDevices();
      /*
       * Измерено 2026-10-10 (`apps/e2e/scripts/probe-devices.mjs`, тот же Edge и те же флаги, что у
       * e2e-стека): в списке есть не только устройства, но и ярлык «устройство по умолчанию» с
       * deviceId === 'default' и подписью вида «Fake Default Audio Input». Это то же самое
       * «по умолчанию», которое меню и экран проверки рисуют отдельной строкой, поэтому дубль
       * убираем; пустой deviceId означает то же (его нельзя выбрать через exact). Остальные записи
       * остаются как есть — ничего не придумываем.
       */
      const pickable = (d: MediaDeviceInfo) => Boolean(d.deviceId) && d.deviceId !== 'default';
      setCams(list.filter((d) => d.kind === 'videoinput' && pickable(d)));
      setMics(list.filter((d) => d.kind === 'audioinput' && pickable(d)));
      setSpks(list.filter((d) => d.kind === 'audiooutput' && pickable(d)));
    } catch { /* enumeration needs permission — preview/join will retry */ }
  }

  useEffect(() => {
    const onChange = () => void refreshDevices();
    navigator.mediaDevices?.addEventListener?.('devicechange', onChange);
    return () => navigator.mediaDevices?.removeEventListener?.('devicechange', onChange);
  }, []);

  // resolve active session + subscribe to WS status
  const status = useQuery({
    queryKey: ['lesson-status', eventId, classIdParam],
    queryFn: () => api<{ session: Session | null }>(
      `/api/lessons/active?${eventId ? `eventId=${eventId}` : `classId=${classIdParam}`}`,
    ),
    enabled: !!eventId || !!classIdParam,
    /*
     * Пока человек НЕ в комнате, опрос — единственный способ узнать, что урок начался: сокета
     * ещё нет. Внутри комнаты «началось/кончилось/изменилось» приносит WebSocket, и опрос
     * остаётся только страховкой на случай его потери (замер apps/e2e/scripts/lesson-perf.mjs:
     * журнал API — 58 обращений к /api/lessons/active на двух клиентов за прогон ≈123 с;
     * окно одного клиента в комнате — 18 запросов в минуту вместо 2 после правки).
     */
    refetchInterval: connected ? 30_000 : 10_000,
  });

  useEffect(() => {
    setSession(status.data?.session ?? null);
    if (status.data?.session) {
      setLayout(status.data.session.layout);
      setMuteAll(status.data.session.muteAll); // restored on reload/reconnect
      setBoardOpen(status.data.session.boardOpen); // task B: the board survives a reload
      setLectureMode(status.data.session.lectureMode); // the comments banner shows before any RTC join
      // часть 1: опрос — второй источник того же решения учителя; он свеж по построению, раз
      // именно он сообщил про конец лекции
      lectureRestoreChoiceRef.current = status.data.session.lectureRestore;
      // часть 1: снимок живёт на сервере только во время лекции, поэтому запоминаем его из КАЖДОГО
      // статуса, где он есть (это и перезагрузка посреди лекции: входной запрос приносит снимок).
      // null не затираем ранее запомненное — сервер стирает снимок при выключении, а ученик ещё не
      // знал про конец.
      if (status.data.session.preLecture) preLectureRef.current = status.data.session.preLecture;
    }
  }, [status.data]);

  /*
   * Часть 1: эпизод лекции открывается и закрывается по ЛЮБОМУ источнику состояния — кадром сокета
   * или опросом статуса (страховка на случай потерянного кадра). Закрывая, эффект даёт 2.5 с кадру
   * `lecture_off`: он один знает точный флаг этого перехода и идёт первым, когда сокет жив.
   */
  useEffect(() => {
    if (isTeacher) return;
    if (lectureMode) { lectureEpisodeRef.current = true; return; }
    window.clearTimeout(lectureOffSafetyRef.current);
    lectureOffSafetyRef.current = window.setTimeout(
      () => endLectureEpisode(lectureRestoreChoiceRef.current), 2_500);
    return () => window.clearTimeout(lectureOffSafetyRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lectureMode, isTeacher]);

  useEffect(() => {
    const s = session;
    if (!s) return;
    let ws: WebSocket | null = null;
    let disposed = false;
    let retryTimer: number | undefined;
    let attempt = 0;
    const connect = async () => {
      if (disposed || !getToken()) return;
      try {
        const ticket = await wsTicket(s.id); // one-time ticket — always fresh on reconnect
        if (disposed) return;
        ws = new WebSocket(`ws${location.protocol === 'https:' ? 's' : ''}://${location.host}/api/ws/lesson/${s.id}?ticket=${encodeURIComponent(ticket)}`);
        ws.onopen = () => { attempt = 0; };
        ws.onmessage = (ev) => {
          const msg = JSON.parse(ev.data as string) as {
            type: string; session?: Session; layout?: Session['layout']; on?: boolean; userId?: string;
            /** часть 1: `restore` приходит в кадрах lectureMode и lecture_off */
            restore?: boolean;
            comment?: { authorId?: string };
          };
          if (msg.type === 'ended') { setSession(null); void leaveRoom(); }
          if (msg.type === 'layout' && msg.layout) setLayout(msg.layout);
          if (msg.type === 'board') setBoardOpen(!!msg.on); // task B: teacher opened/closed the board for all
          if (msg.type === 'lectureMode') {
            // часть 1: кадр несёт и решение о возврате: эпизод открывает эффект на `lectureMode`,
            // и у него должен быть тот же флаг, что у кадра, а не у старого `session`
            if (msg.restore !== undefined) lectureRestoreChoiceRef.current = msg.restore;
            setLectureMode(!!msg.on);
            // часть 1: начало лекции — единственный момент, когда снимок ещё живёт на сервере
            // (его сотрут при выключении), поэтому remembered сразу, не дожидаясь опроса раз в 30 с.
            if (msg.on && !isTeacher) void rememberMySnapshot();
          }
          if (msg.type === 'lecture_off') endLectureEpisode(msg.restore !== false);
          if (msg.type === 'muteAll') { setMuteAll(!!msg.on); applyMuteAll(!!msg.on); }
          // task 2: comments arrive on this same socket — the panel's query is the single source
          // for the mode, so the frame only has to invalidate it (see useCommentFrames)
          onCommentFrame(msg.type);
          if (msg.type === 'comment' && msg.comment?.authorId && msg.comment.authorId !== meIdRef.current
            && !commentsOpenRef.current) setBadge((n) => n + 1);
          // task 2Б: the hand queue rides the same socket for the same reason
          onHandFrame(msg.type);
          if (msg.type === 'handGranted' && msg.userId === meIdRef.current) void acceptFloor();
          if (msg.type === 'handRevoked' && msg.userId === meIdRef.current) setFloorTakenNotice(true);
          if (msg.type === 'started' && msg.session) { setSession(msg.session); setMuteAll(msg.session.muteAll); setBoardOpen(msg.session.boardOpen); setLectureMode(msg.session.lectureMode);
            // часть 1: переподключение посреди лекции — кадр `started` несёт и снимок этого ученика,
            // поэтому возврат работает и после перезагрузки его страницы (см. `preLectureRef`).
            if (msg.session.preLecture) preLectureRef.current = msg.session.preLecture;
          }
        };
        ws.onclose = (ev) => {
          if (disposed) return;
          if (ev.code === 4404) return; // session gone — the status query takes over
          attempt++; // 4401 (expired ticket), 1006 (dropped), render restarts → backoff + reconnect
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.id]);

  useEffect(() => () => {
    if (tokenRefreshRef.current) clearInterval(tokenRefreshRef.current);
    void roomRef.current?.disconnect();
  }, []);

  /** getUserMedia over the constraint chain: saved device → default → bare true. */
  async function gumCamera(deviceId: string): Promise<{ stream: MediaStream | null; errKey: string; err: unknown }> {
    let lastKey = '';
    let lastErr: unknown;
    for (const c of cameraAttempts(deviceId)) {
      try {
        return { stream: await navigator.mediaDevices.getUserMedia({ video: c === true ? true : c }), errKey: '', err: undefined };
      } catch (e: unknown) {
        lastKey = mediaErrorKey(e, 'camera');
        lastErr = e;
        if (!isRetryableMediaError((e as { name?: string })?.name)) break; // denied/busy: no point retrying
      }
    }
    return { stream: null, errKey: lastKey || 'camUnavailable', err: lastErr };
  }

  /** та же цепочка для микрофона, но поток остаётся живым — он питает индикатор уровня */
  async function openMicForCheck(deviceId: string): Promise<{ stream: MediaStream | null; errKey: string; err: unknown }> {
    let lastKey = '';
    let lastErr: unknown;
    for (const c of microphoneAttempts(deviceId)) {
      try {
        return { stream: await navigator.mediaDevices.getUserMedia({ audio: c === true ? true : c }), errKey: '', err: undefined };
      } catch (e: unknown) {
        lastKey = mediaErrorKey(e, 'microphone');
        lastErr = e;
        if (!isRetryableMediaError((e as { name?: string })?.name)) break;
      }
    }
    return { stream: null, errKey: lastKey || 'micUnavailable', err: lastErr };
  }

  function stopPreview() {
    previewStream?.getTracks().forEach((tr) => tr.stop());
    setPreviewStream(null);
    micStream?.getTracks().forEach((tr) => tr.stop());
    setMicStream(null);
  }

  async function loadPreview() {
    setPreviewBusy(true);
    setError('');
    setCamErr('');
    setMicErr('');
    // microphone: saved device → default (permission prompt lands here first)
    const mic = await openMicForCheck(savedMic);
    if (mic.stream) setMicStream(mic.stream);
    else setMicErr(mediaErrorText(mic.errKey, mic.err));
    // camera with a LIVE self-view (the button state below is the real stream state)
    const cam = await gumCamera(savedCam);
    if (cam.stream) setPreviewStream(cam.stream);
    else setCamErr(mediaErrorText(cam.errKey, cam.err));
    await refreshDevices();
    setPreviewChecked(true);
    setPreviewBusy(false);
  }

  async function togglePreviewCam() {
    if (previewStream) {
      previewStream.getTracks().forEach((tr) => tr.stop());
      setPreviewStream(null);
      setCamErr('');
      return;
    }
    const cam = await gumCamera(savedCam);
    if (cam.stream) { setPreviewStream(cam.stream); setCamErr(''); }
    else setCamErr(mediaErrorText(cam.errKey, cam.err));
  }

  function peerName(identity: string, name?: string) { return name || identity.slice(0, 8); }

  function refreshPeerList(room: Room) {
    const list: PeerView[] = [];
    for (const p of room.remoteParticipants.values()) {
      const pubs = p.getTrackPublications();
      list.push({
        identity: p.identity,
        name: peerName(p.identity, p.name),
        micOn: pubs.some((t2) => t2.kind === Track.Kind.Audio && t2.track !== undefined && !t2.isMuted),
        camOn: pubs.some((t2) => t2.kind === Track.Kind.Video && t2.track !== undefined && !t2.isMuted && t2.source !== Track.Source.ScreenShare),
        screenOn: pubs.some((t2) => t2.source === Track.Source.ScreenShare && t2.track !== undefined),
      });
    }
    setPeers(list);
  }

  /** local buttons reflect REAL publication state, derived from LiveKit events */
  function refreshLocal(room: Room) {
    const pubs = room.localParticipant.getTrackPublications();
    setLocalCamOn(pubs.some((p) => p.kind === Track.Kind.Video && p.source === Track.Source.Camera && p.track && !p.isMuted));
    setLocalMicOn(pubs.some((p) => p.kind === Track.Kind.Audio && p.source === Track.Source.Microphone && p.track && !p.isMuted));
    setScreenOn(pubs.some((p) => p.source === Track.Source.ScreenShare && p.track));
  }

  /**
   * Часть 1: право отозвано — значит лекция идёт, даже если наш кадр `lectureMode` ещё в дороге.
   *
   * Это единственное, что клиент выводит из событий комнаты: снимок устройств делает сервер (см.
   * `fetchMyPreLecture`), поэтому порядок «что дошло раньше — сигнал комнаты или кадр» на возврат
   * больше не влияет. Эпизод нужен, чтобы вернуть ровно один раз и только тому, кто лекцию
   * застал: пришедшему во время неё нечего возвращать (серверная карта его не знает).
   */
  function noteLectureStartedByRoom(room: Room) {
    if (isTeacher) return;
    const perm = room.localParticipant.permissions as { canPublish?: boolean } | undefined;
    if (perm?.canPublish === false) lectureEpisodeRef.current = true;
  }

  /**
   * Часть 1: тост может нести кнопку (возврат микрофона после лекции — «Выключить»).
   * С кнопкой он живёт дольше: 3.5 с нажатить нечего, и человек теряет управление устройством.
   */
  function showToast(msg: string, action?: { label: string; run: () => void }) {
    setToast(msg);
    setToastAction(action ?? null);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => { setToast(''); setToastAction(null); }, action ? 10_000 : 3_500);
  }

  /** students obey «mute everyone»: mic off when the teacher mutes, back when not */
  function applyMuteAll(on: boolean) {
    const room = roomRef.current;
    if (!room || isTeacher) return;
    if (on) {
      void room.localParticipant.setMicrophoneEnabled(false).then(() => refreshLocal(room)).catch(() => undefined);
    } else {
      void room.localParticipant.setMicrophoneEnabled(true).then(() => refreshLocal(room)).catch(() => undefined);
    }
  }

  async function toggleMuteAll() {
    const s = session;
    if (!s) return;
    const next = !muteAll;
    try {
      const r = await api<{ muted: number; students: number }>(`/api/lessons/${s.id}/mute`, {
        method: 'POST', body: JSON.stringify({ all: true, kind: 'audio', muted: next }),
      });
      setMuteAll(next);
      showToast(next ? t('lesson.mutedToast', { n: r.muted, m: r.students }) : t('lesson.unmutedToast'));
    } catch {
      setError('mediaServerUnavailable');
    }
  }

  async function muteOne(identity: string) {
    const s = session;
    if (!s) return;
    try {
      await api(`/api/lessons/${s.id}/mute`, { method: 'POST', body: JSON.stringify({ identity, kind: 'audio', muted: true }) });
    } catch {
      setError('mediaServerUnavailable');
    }
  }

  const addTile = (tile: Tile, track: LkTrack) => {
    tracksRef.current.set(tile.key, track);
    setTiles((prev) => (prev.some((x) => x.key === tile.key) ? prev : [...prev, tile]));
  };
  const removeTile = (key: string) => {
    tracksRef.current.delete(key);
    setTiles((prev) => prev.filter((x) => x.key !== key));
  };

  /**
   * «Остановить входящее видео»: каждая видеодорожка удалённого участника отписывается
   * (`publication.setSubscribed(false)`), звук и доска не трогаются. То же делает обработчик
   * TrackSubscribed для подписок, появившихся позже, — состояние живёт в ref, потому что
   * обработчики навешаны один раз на комнату.
   */
  function applyVideoPause(paused: boolean) {
    setVideoPaused(paused);
    videoPausedRef.current = paused;
    const room = roomRef.current;
    if (!room) return;
    for (const p of room.remoteParticipants.values()) {
      for (const pub of p.getTrackPublications()) {
        if (pub.kind !== Track.Kind.Video) continue;
        const sub = pub as unknown as Subscribable;
        if (typeof sub.setSubscribed === 'function') void sub.setSubscribed(!paused).catch(() => undefined);
      }
    }
  }

  /** Publish the camera through the constraint chain; returns '' or an error key. */
  async function enableCameraIn(room: Room): Promise<{ errKey: string; err: unknown }> {
    let lastKey = '';
    let lastErr: unknown;
    for (const c of cameraAttempts(localStorage.getItem(LS_CAM))) {
      try {
        await room.localParticipant.setCameraEnabled(true, c === true ? undefined : (c as CamOpts));
        return { errKey: '', err: undefined };
      } catch (e: unknown) {
        lastKey = mediaErrorKey(e, 'camera');
        lastErr = e;
        if (!isRetryableMediaError((e as { name?: string })?.name)) break;
      }
    }
    return { errKey: lastKey || 'camUnavailable', err: lastErr };
  }

  async function joinRoom() {
    const s = session;
    if (!s) return;
    setError('');
    stopPreview(); // release the preview streams so LiveKit can own the devices
    try {
      const { token, wsUrl } = await api<{ token: string; wsUrl: string }>(`/api/lessons/${s.id}/join`, { method: 'POST' });
      /*
       * Часть 2: качество по умолчанию. `adaptiveStream` и `dynacast` были; добавлен потолок
       * захвата 720p — без него браузер может отдать с камеры всё, что та умеет, а полоса
       * участников всё равно показывает картинку 140 px. Замер на фейковой камере этого не
       * видит (она отдаёт 640×480 независимо от запроса), поэтому числом не проверяется:
       * см. таблицу «до и после» в отчёте.
       */
      const room = new Room({
        adaptiveStream: true, dynacast: true,
        videoCaptureDefaults: { resolution: VideoPresets.h720.resolution },
      });
      roomRef.current = room;
      room.on(RoomEvent.TrackSubscribed, (track, pub, participant) => {
        addTile(
          { key: `${participant.sid}:${pub.trackSid}`, kind: track.kind === 'video' ? 'video' : 'audio', name: peerName(participant.identity, participant.name), local: false, screen: pub.source === Track.Source.ScreenShare, sid: participant.sid },
          track,
        );
        if (videoPausedRef.current && track.kind === 'video') {
          const sub = pub as unknown as Subscribable;
          if (typeof sub.setSubscribed === 'function') void sub.setSubscribed(false).catch(() => undefined);
        }
        refreshPeerList(room);
      });
      room.on(RoomEvent.TrackUnsubscribed, (_t, pub, participant) => removeTile(`${participant.sid}:${pub.trackSid}`));
      room.on(RoomEvent.TrackMuted, () => { refreshPeerList(room); refreshLocal(room); });
      room.on(RoomEvent.TrackUnmuted, () => { refreshPeerList(room); refreshLocal(room); });
      /*
       * Часть 1: отзыв публикации — это СИГНАЛ КОМНАТЫ, и он опережает наш кадр. Здесь он нужен
       * только затем, чтобы эпизод лекции открылся независимо от порядка событий (см.
       * `noteLectureStartedByRoom`).
       */
      room.on(RoomEvent.ParticipantPermissionsChanged, () => noteLectureStartedByRoom(room));
      room.on(RoomEvent.LocalTrackPublished, (pub) => {
        const track = pub.track;
        refreshLocal(room);
        if (!track) return;
        // local AUDIO is never attached — the speaker already hears themselves via
        // the physical microphone; re-playing it is the echo users reported.
        if (track.kind === 'audio') return;
        // what kind of surface the presenter actually picked (Chromium and Firefox report it;
        // Safari does not, and then the warning simply never appears — which is honest)
        if (pub.source === Track.Source.ScreenShare) {
          const st = (track.mediaStreamTrack?.getSettings?.() ?? {}) as { displaySurface?: string };
          const surface = st.displaySurface === 'browser' || st.displaySurface === 'window' || st.displaySurface === 'monitor'
            ? st.displaySurface : '';
          setShareSurface(surface);
          // collapsed by default (task: «по умолчанию свёрнут, разворачивается»); when the shared
          // surface is a browser tab the warning below explains why it stays collapsed
          setSharePreview(false);
        }
        addTile(
          // the '· Экран' suffix belongs to VideoTile (localized); a second one here measured
          // «Вы · screen · screen» in the 2026-10-08 screenshot review
          { key: `local:${pub.trackSid}`, kind: 'video', name: t('lesson.you'), local: true, screen: pub.source === Track.Source.ScreenShare, sid: room.localParticipant.sid },
          track,
        );
      });
      room.on(RoomEvent.LocalTrackUnpublished, (pub) => {
        if (pub.track?.kind === 'video') removeTile(`local:${pub.trackSid}`);
        refreshLocal(room);
      });
      room.on(RoomEvent.ParticipantConnected, () => refreshPeerList(room));
      room.on(RoomEvent.ParticipantDisconnected, () => refreshPeerList(room));
      // task B «auto»: the loudest remote voice owns the main window
      room.on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
        const top = speakers.find((sp) => sp.sid !== room.localParticipant.sid);
        setActiveSid(top?.sid ?? null);
      });
      room.on(RoomEvent.Disconnected, () => { setConnected(false); if (tokenRefreshRef.current) { clearInterval(tokenRefreshRef.current); tokenRefreshRef.current = null; } });
      // Part 4а: a lesson may run LONGER than the join-token TTL. The LiveKit SDK
      // heals this itself (the server pushes a `refreshToken` and reconnects with
      // it), but that only holds for servers that send the push. To be safe for
      // self-hosted LiveKit too, we re-mint a token from OUR backend on every
      // (re)connect AND on a proactive heartbeat, handing it to the room when the
      // client exposes updateToken(). A failure is swallowed: the SDK's own path
      // still carries the session. The production TTL is floored at 2 h, so a
      // 30-min heartbeat stays comfortably ahead of expiry.
      const rejoin = async () => {
        try {
          const { token: fresh } = await api<{ token: string }>(`/api/lessons/${s.id}/join`, { method: 'POST' });
          const r = roomRef.current;
          const up = r as unknown as { updateToken?: (t: string) => void } | null;
          if (r && typeof up?.updateToken === 'function') up.updateToken(fresh);
        } catch { /* ignore — the SDK's server-pushed refresh covers it */ }
      };
      room.on(RoomEvent.Reconnecting, () => { void rejoin(); });
      room.on(RoomEvent.Reconnected, () => { void rejoin(); });
      if (tokenRefreshRef.current) clearInterval(tokenRefreshRef.current);
      tokenRefreshRef.current = setInterval(() => { void rejoin(); }, 30 * 60_000);
      await room.connect(wsUrl, token);
      // запомнившийся динамик, если он есть и браузер это умеет
      if (savedSpk && canPickSpeaker) {
        const sw = room as unknown as SpeakerSwitch;
        if (typeof sw.switchActiveDevice === 'function') {
          try { await sw.switchActiveDevice('audiooutput', savedSpk, true); setSpkErr(''); }
          catch { setSpkErr(t('lesson.speakerUnsupported')); }
        }
      }
      // mic first (camera failures must not swallow the mic), then camera — each
      // with its own soft→minimal constraint chain and a visible error, never silent.
      // Task 3: a student joining while lecture mode or «mute everyone» is ON
      // starts muted — the banner explains why, the state came with the session.
      // Task 2Б: holding the floor is the one exception the teacher can hand out; LiveKit still
      // decides whether the publish is allowed, so trusting a stale queue here cannot open a mic
      // that the media server would refuse.
      const micBlocked = !isTeacher && !hasFloor && (lectureMode || s.lectureMode || muteAll || s.muteAll);
      const wantMic = readFlag(LS_WANTED_MIC, true);
      const wantCam = readFlag(LS_WANTED_CAM, true);
      let micKey = '';
      let micE: unknown;
      if (!micBlocked && wantMic) {
        for (const c of microphoneAttempts(localStorage.getItem(LS_MIC))) {
          try {
            await room.localParticipant.setMicrophoneEnabled(true, c === true ? undefined : (c as MicOpts));
            break;
          } catch (e: unknown) {
            micKey = mediaErrorKey(e, 'microphone');
            micE = e;
            if (!isRetryableMediaError((e as { name?: string })?.name)) break;
          }
        }
      }
      setMicErr(micKey ? mediaErrorText(micKey, micE) : '');
      if (wantCam) {
        const cam = await enableCameraIn(room);
        setCamErr(cam.errKey ? mediaErrorText(cam.errKey, cam.err) : '');
      } else setCamErr('');
      refreshPeerList(room);
      refreshLocal(room);
      void refreshDevices();
      setConnected(true);
    } catch (e: unknown) {
      const code = (e as { code?: string }).code;
      setError(code ? t(`lesson.${code}`, { defaultValue: t('common.errorGeneric') }) : String((e as Error).message));
    }
  }

  async function leaveRoom() {
    await roomRef.current?.disconnect().catch(() => undefined);
    roomRef.current = null;
    setConnected(false);
    setPeers([]);
    setTiles([]);
    tracksRef.current.clear();
    setLocalCamOn(false);
    setLocalMicOn(false);
    setScreenOn(false);
    setVideoPaused(false);
    setDevicesOpen(false);
  }

  /**
   * Task 1.3: start / stop demonstrating the screen.
   *
   * `selfBrowserSurface: 'exclude'` asks the browser not to offer THIS tab as a source — sharing
   * the page you are watching yourself in is the mirror corridor (you see your own tile seeing
   * your screen). livekit-client 2.22.3 forwards it, plus `surfaceSwitching` and `systemAudio`,
   * straight into getDisplayMedia (verified in dist/src/room/track/options.d.ts and
   * screenCaptureToDisplayMediaStreamOptions). Browsers that ignore the hint are covered by the
   * `displaySurface` check in LocalTrackPublished, which warns and keeps the preview off.
   * The screen audio is never attached locally (see LocalTrackPublished), so the presenter does
   * not hear their own system sound as an echo.
   */
  async function toggleShare() {
    const room = roomRef.current;
    if (!room) return;
    const on = !screenOn;
    const opts: ShareOpts = {
      audio: true, selfBrowserSurface: 'exclude', surfaceSwitching: 'include',
      systemAudio: 'include', contentHint: 'detail',
    };
    try {
      await room.localParticipant.setScreenShareEnabled(on, on ? opts : undefined);
      if (!on) { setShareSurface(''); setSharePreview(false); }
    } catch {
      // the key existed in all three locales but was shown RAW here (the render prints `error`
      // untranslated) — the same trap the join path avoids with t(`lesson.${code}`)
      setError(t('lesson.screenShareFailed'));
    }
  }

  async function toggleCameraInRoom() {
    const room = roomRef.current;
    if (!room) return;
    if (localCamOn) {
      await room.localParticipant.setCameraEnabled(false).catch(() => undefined);
      setCamErr('');
      writeFlag(LS_WANTED_CAM, false);
    } else {
      const cam = await enableCameraIn(room);
      setCamErr(cam.errKey ? mediaErrorText(cam.errKey, cam.err) : '');
      writeFlag(LS_WANTED_CAM, !cam.errKey);
    }
    refreshLocal(room);
  }

  async function toggleMicInRoom() {
    const room = roomRef.current;
    if (!room) return;
    // task 3: while the teacher muted everyone (or lecture mode is on) a student
    // can mute themselves but NOT talk over the class — the banners say why
    // task 2Б: «дать слово» is exactly the exception to that rule, and it arrives here as state
    // from the queue, which the socket keeps fresh
    if (!localMicOn && !isTeacher && !hasFloor && (muteAll || lectureMode)) return;
    if (localMicOn) {
      await room.localParticipant.setMicrophoneEnabled(false).catch(() => undefined);
      writeFlag(LS_WANTED_MIC, false);
    } else {
      try {
        await room.localParticipant.setMicrophoneEnabled(true, savedMic ? ({ deviceId: { exact: savedMic } } as MicOpts) : undefined);
        setMicErr('');
        writeFlag(LS_WANTED_MIC, true);
      } catch (e: unknown) {
        try {
          await room.localParticipant.setMicrophoneEnabled(true);
          setMicErr('');
          writeFlag(LS_WANTED_MIC, true);
        } catch (e2: unknown) {
          setMicErr(mediaErrorText(mediaErrorKey(e2, 'microphone'), e2 ?? e));
        }
      }
    }
    refreshLocal(room);
  }

  async function pickCamera(deviceId: string) {
    setSavedCam(deviceId);
    localStorage.setItem(LS_CAM, deviceId);
    const room = roomRef.current;
    if (room && connected) {
      if (localCamOn) await room.localParticipant.setCameraEnabled(false).catch(() => undefined);
      const cam = await enableCameraIn(room);
      setCamErr(cam.errKey ? mediaErrorText(cam.errKey, cam.err) : '');
      refreshLocal(room);
    } else if (previewChecked) {
      // на экране проверки смена камеры сразу видна в предпросмотре
      previewStream?.getTracks().forEach((tr) => tr.stop());
      const cam = await gumCamera(deviceId);
      if (cam.stream) { setPreviewStream(cam.stream); setCamErr(''); }
      else setCamErr(mediaErrorText(cam.errKey, cam.err));
    }
  }

  async function pickMicrophone(deviceId: string) {
    setSavedMic(deviceId);
    localStorage.setItem(LS_MIC, deviceId);
    const room = roomRef.current;
    if (room && connected) {
      if (localMicOn) await room.localParticipant.setMicrophoneEnabled(false).catch(() => undefined);
      try {
        await room.localParticipant.setMicrophoneEnabled(true, deviceId ? ({ deviceId: { exact: deviceId } } as MicOpts) : undefined);
        setMicErr('');
      } catch (e: unknown) {
        try { await room.localParticipant.setMicrophoneEnabled(true); setMicErr(''); }
        catch (e2: unknown) { setMicErr(mediaErrorText(mediaErrorKey(e2, 'microphone'), e2 ?? e)); }
      }
      refreshLocal(room);
    } else if (previewChecked) {
      // и здесь смена сразу слышна: индикатор уровня переезжает на новый поток
      micStream?.getTracks().forEach((tr) => tr.stop());
      const mic = await openMicForCheck(deviceId);
      if (mic.stream) { setMicStream(mic.stream); setMicErr(''); }
      else setMicErr(mediaErrorText(mic.errKey, mic.err));
    }
  }

  /** динамик: localStorage + `switchActiveDevice`; при отказе движка — понятная причина */
  async function pickSpeaker(deviceId: string) {
    setSavedSpk(deviceId);
    try { localStorage.setItem(LS_SPK, deviceId); } catch { /* приватный режим */ }
    const room = roomRef.current;
    if (!room || !deviceId) { setSpkErr(''); return; }
    const sw = room as unknown as SpeakerSwitch;
    if (typeof sw.switchActiveDevice !== 'function') { setSpkErr(t('lesson.speakerUnsupported')); return; }
    try { await sw.switchActiveDevice('audiooutput', deviceId, true); setSpkErr(''); }
    catch { setSpkErr(t('lesson.speakerUnsupported')); }
  }

  /** своя рука из панели управления: тот же REST, что был у отдельной кнопки */
  const handM = useMutation({
    mutationFn: () => api(`/api/lessons/${session?.id ?? ''}/hand`, { method: myHand ? 'DELETE' : 'POST' }),
    onSettled: () => handsQ.invalidate(),
  });

  const act = useMutation({
    mutationFn: (p: { path: string; body?: unknown; method?: string }) =>
      api(p.path, { method: p.method ?? 'POST', body: p.body ? JSON.stringify(p.body) : undefined }),
    onError: () => setError('mediaServerUnavailable'),
  });

  const startLesson = useMutation({
    mutationFn: () => api<Session>('/api/lessons/start', {
      method: 'POST', body: JSON.stringify({ classId: session?.classId ?? classIdParam, eventId }),
    }),
    onSuccess: (s) => { setSession({ ...s, wsUrl: '' }); void qc.invalidateQueries({ queryKey: ['lesson-status'] }); },
  });

  const gridClass = useMemo(() => `videos layout-${layout === 'auto' ? 'gallery' : layout}`, [layout]);

  // ── task B: the stage model ─────────────────────────────────────────────────
  // Which content owns the main window is decided by pickStageContent() in @klass/shared
  // (unit-tested in apps/api/test/unit/stage-model.test.ts): a screen share wins over the
  // board and over the teacher's layout choice, a pin wins over the screen, and with no
  // share in force the previous layout rules apply unchanged.
  const videoTiles = useMemo(() => tiles.filter((x) => x.kind === 'video'), [tiles]);
  const localTile = videoTiles.find((x) => x.local && !x.screen) ?? null;
  const teacherTile = videoTiles.find((x) => !x.local && !x.screen) ?? null;
  const screenTile = videoTiles.find((x) => x.screen) ?? null;
  const pinnedTile = pinnedKey ? videoTiles.find((x) => x.key === pinnedKey) ?? null : null;
  const speakerTile = activeSid ? videoTiles.find((x) => !x.local && x.sid === activeSid) ?? null : null;
  const personTile = videoTiles.find((x) => !x.local) ?? localTile;
  const content = pickStageContent({
    boardOpen, layout, hasScreen: Boolean(screenTile), hasPinned: Boolean(pinnedTile),
    hasSpeaker: Boolean(speakerTile), hasPerson: Boolean(personTile), showBoardInstead,
  });
  // the switch has nothing to switch back to once the share stops; the board's own
  // fullscreen must not survive the board leaving the stage
  useEffect(() => { if (!screenTile) setShowBoardInstead(false); }, [screenTile]);
  useEffect(() => { if (content !== 'board') setBoardFull(false); }, [content]);
  const stage = useMemo(() => {
    switch (content) {
      case 'board': return { kind: 'board' as const, tile: null as Tile | null };
      case 'screen': return { kind: 'tile' as const, tile: screenTile };
      case 'pinned': return { kind: 'tile' as const, tile: pinnedTile };
      case 'speaker': return { kind: 'tile' as const, tile: speakerTile };
      case 'spotlight': return { kind: 'tile' as const, tile: personTile };
      default: return { kind: 'grid' as const, tile: null as Tile | null };
    }
  }, [content, screenTile, pinnedTile, speakerTile, personTile]);

  const hasStage = stage.kind !== 'grid';
  const screenIsMain = content === 'screen';
  // when the board owns the stage, the teacher's camera floats for students too
  const teacherFloats = !isTeacher && stage.kind === 'board' && Boolean(teacherTile);
  const stripTiles = useMemo(() => {
    const keep = new Set(stripKeys(videoTiles, {
      stageKey: stage.tile?.key ?? null, hasStage, localCameraKey: localTile?.key ?? null,
      teacherFloats, teacherKey: teacherTile?.key ?? null,
    }));
    return videoTiles.filter((x) => keep.has(x.key));
  }, [videoTiles, stage.tile, hasStage, localTile, teacherFloats, teacherTile]);
  const STRIP_MAX = 6;
  const showSwitch = stageSwitchVisible({
    boardOpen, layout, hasScreen: Boolean(screenTile), hasPinned: false,
    hasSpeaker: false, hasPerson: true, showBoardInstead,
  }) && !pinnedTile;

  function toggleBoard() {
    const s = session;
    if (!s) return;
    const on = !boardOpen;
    setBoardOpen(on);
    if (!on) setBoardFull(false);
    act.mutate({ path: `/api/lessons/${s.id}/board`, body: { on } });
  }

  function toggleStageFull() {
    const el = stageRef.current;
    if (!el) return;
    if (document.fullscreenElement) { void document.exitFullscreen().catch(() => undefined); setBoardFull(false); }
    else { void el.requestFullscreen?.().catch(() => undefined); setBoardFull(true); }
  }
  useEffect(() => {
    const onFs = () => { if (!document.fullscreenElement) setBoardFull(false); };
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, []);

  // PiP drag: pointer capture, then snap to the nearest corner on release.
  // pip.x / pip.y are offsets from the RIGHT and BOTTOM edges (CSS right/bottom).
  const PIP_W = 180, PIP_H = 140;
  function pipDown(e: React.PointerEvent) {
    // on a phone the self-view is pinned to the picture's corner by CSS (it would otherwise sit
    // on the screen tool band), so a drag there has nothing to move — do not pretend it does
    if (window.matchMedia('(max-width: 899px)').matches) return;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    dragRef.current = { x0: e.clientX, y0: e.clientY, px0: pip.x, py0: pip.y };
  }
  function pipMove(e: React.PointerEvent) {
    if (!dragRef.current) return;
    const box = stageRef.current?.getBoundingClientRect();
    if (!box) return;
    const maxX = Math.max(8, box.width - PIP_W - 8);
    const maxY = Math.max(8, box.height - PIP_H - 8);
    // moving the pointer RIGHT shrinks the right-offset
    const nx = dragRef.current.px0 - (e.clientX - dragRef.current.x0);
    const ny = dragRef.current.py0 - (e.clientY - dragRef.current.y0);
    setPip((p) => ({ ...p, x: Math.min(maxX, Math.max(8, nx)), y: Math.max(8, Math.min(maxY, ny)) }));
  }
  function pipUp() {
    if (!dragRef.current) return;
    dragRef.current = null;
    const box = stageRef.current?.getBoundingClientRect();
    if (!box) return;
    const centerFromLeft = box.width - pip.x - PIP_W / 2;
    const centerFromTop = box.height - pip.y - PIP_H / 2;
    const next = {
      x: centerFromLeft > box.width / 2 ? 12 : Math.max(8, box.width - PIP_W - 12),
      y: centerFromTop > box.height / 2 ? 12 : Math.max(8, box.height - PIP_H - 12),
    };
    setPip((p) => { const v = { ...p, ...next }; localStorage.setItem(LS_PIP, JSON.stringify(v)); return v; });
  }
  useEffect(() => {
    if (!dragRef.current) localStorage.setItem(LS_PIP, JSON.stringify(pip));
  }, [pip.x, pip.y, pip.min, pip.hidden]);

  /**
   * Горячие клавиши (задача 2026-10-10): M — микрофон, V — камера, H — рука, C — комментарии,
   * P — участники. Не срабатывают, когда фокус в поле ввода (иначе печатающий человек вдруг
   * выключит себе микрофон) и когда фокус внутри доски: там V/H/P — собственные инструменты
   * Excalidraw, и они не должны превращаться в кнопки урока.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
      const el = e.target as (HTMLElement | null);
      if (el) {
        const tag = el.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable) return;
        if (typeof el.closest === 'function' && el.closest('.board-frame, .excalidraw, iframe')) return;
      }
      if (!session) return;
      const k = e.key.toLowerCase();
      if (k === 'm' && connected) void toggleMicInRoom();
      else if (k === 'v' && connected) void toggleCameraInRoom();
      else if (k === 'h') handM.mutate();
      else if (k === 'c') toggleTab('comments');
      else if (k === 'p') toggleTab('people');
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.id, connected, localMicOn, localCamOn, myHand, panelOpen, panelTab, savedMic, lectureMode, muteAll, hasFloor]);

  const noteHref = isTeacher
    ? `/notes?new=1&classId=${session?.classId ?? classIdParam ?? ''}&eventId=${eventId ?? session?.eventId ?? ''}`
    : '/sheets?new=1';

  /**
   * Часть 1: выключение не спрашивает ничего (это возвращение слова), включение — спрашивает,
   * включать ли ученикам устройства обратно. Оптимизм здесь ограничен: при 502 сервер state не
   * тронул, значит и кнопка обязана вернуться в прежнее положение, а не остаться «выключенной».
   */
  const setLecture = () => {
    const s = session; if (!s) return;
    if (lectureMode) { void sendLecture(false, s.lectureRestore ?? true); return; }
    setLectureAsk({ restore: true });
  };

  async function sendLecture(on: boolean, restore: boolean) {
    const s = session; if (!s) return;
    setLectureMode(on);
    try {
      await api(`/api/lessons/${s.id}/lecture-mode`, { method: 'POST', body: JSON.stringify({ on, restore }) });
    } catch {
      setLectureMode(!on);
      setError(t(on ? 'lesson.lectureStartFailed' : 'lesson.lectureStopFailed'));
    }
  }

  const barState: BarState = {
    connected, micOn: localMicOn, camOn: localCamOn, screenOn, handRaised: Boolean(myHand),
    boardOpen, commentsOpen, participantsOpen, unread, peers: peers.length,
    hands: handsQ.q.data?.hands?.length ?? 0, isTeacher, lectureMode,
    videoPaused, selfHidden: pip.hidden, fullscreen: boardFull, layout,
  };
  const barDevices: BarDevices = {
    cams: cams.map((d) => ({ deviceId: d.deviceId, label: d.label })),
    mics: mics.map((d) => ({ deviceId: d.deviceId, label: d.label })),
    savedCam, savedMic,
  };
  const barActions: BarActions = {
    mic: () => void toggleMicInRoom(),
    cam: () => void toggleCameraInRoom(),
    share: () => void toggleShare(),
    hand: () => handM.mutate(),
    board: toggleBoard,
    comments: () => toggleTab('comments'),
    participants: () => toggleTab('people'),
    layout: (l) => {
      const s = session; if (!s) return;
      setLayout(l);
      act.mutate({ path: `/api/lessons/${s.id}/layout`, body: { layout: l }, method: 'PATCH' });
    },
    lecture: setLecture,
    devices: () => setDevicesOpen(true),
    hideSelf: () => setPip((p) => ({ ...p, hidden: !p.hidden })),
    stopVideo: () => applyVideoPause(!videoPaused),
    fullscreenToggle: toggleStageFull,
    leave: () => void leaveRoom(),
    endForAll: () => {
      const s = session; if (!s) return;
      act.mutate({ path: `/api/lessons/${s.id}/end` });
      void leaveRoom();
    },
    pickCam: (id) => void pickCamera(id),
    pickMic: (id) => void pickMicrophone(id),
  };

  const mediaErrors = (
    <>
      {camErr && <p className="error" data-testid="cam-error">{camErr}</p>}
      {micErr && <p className="error" data-testid="mic-error">{micErr}</p>}
      {spkErr && <p className="error" data-testid="speaker-error">{spkErr}</p>}
    </>
  );

  const deviceSettings = (
    <DeviceSettings
      cams={barDevices.cams} mics={barDevices.mics}
      speakers={spks.map((d) => ({ deviceId: d.deviceId, label: d.label }))}
      savedCam={savedCam} savedMic={savedMic} savedSpk={savedSpk}
      onCam={(id) => void pickCamera(id)} onMic={(id) => void pickMicrophone(id)}
      onSpk={(id) => void pickSpeaker(id)}
      canPickSpeaker={canPickSpeaker} showTestSpeaker
    />
  );

  /**
   * Task 1.2: the controls that must stay reachable while the shared screen covers the whole
   * display — mute, camera, the participant strip, and leaving the lesson.
   */
  const stageControls = (
    <>
      <button type="button" className="ghost" style={{ marginTop: 0 }} data-testid="ov-mic"
        aria-label={t('lesson.toggleMic')} aria-pressed={localMicOn} onClick={() => void toggleMicInRoom()}>
        {localMicOn ? '🎙' : '🔇'}
      </button>
      <button type="button" className="ghost" style={{ marginTop: 0 }} data-testid="ov-cam"
        aria-label={t('lesson.toggleCamera')} aria-pressed={localCamOn} onClick={() => void toggleCameraInRoom()}>
        {localCamOn ? '📹' : '🚫'}
      </button>
      <button type="button" className="ghost" style={{ marginTop: 0 }} data-testid="ov-strip"
        aria-label={t('lesson.stageStrip')} aria-pressed={stripOpen} onClick={() => setStripOpen((v) => !v)}>👥</button>
      <button type="button" className="danger" style={{ marginTop: 0 }} data-testid="ov-leave"
        aria-label={t('lesson.leave')} onClick={() => void leaveRoom()}>{t('lesson.leave')}</button>
    </>
  );

  if (!eventId && !classIdParam) return <p className="error">{t('common.errorGeneric')}</p>;

  return (
    <div>
      <h1>{t('lesson.title')}</h1>
      {!session && (
        <div className="card">
          <p className="muted">{t('cal.notStarted')}</p>
          {isTeacher && (
            <button data-testid="start-lesson" onClick={() => startLesson.mutate()} disabled={startLesson.isPending}>{t('lesson.start')}</button>
          )}
        </div>
      )}
      {session && (
        <div className="lesson-shell" data-testid="lesson-shell">
          <div className="lesson-body">
            <div className="lesson-main">
              {!connected && (
                <div className="card device-check" data-testid="device-check">
                  <div className="row">
                    <button data-testid="check-devices" onClick={() => void loadPreview()} disabled={previewBusy}>{t('lesson.checkDevices')}</button>
                    <div className="spacer" />
                    <button data-testid="join-lesson" onClick={() => void joinRoom()} disabled={!previewChecked}>{t('cal.joinLesson')}</button>
                  </div>
                  {previewChecked && (
                    <>
                      <div className="row" style={{ gap: 8, alignItems: 'center' }}>
                        {/* the button says what the camera ACTUALLY does right now */}
                        <button className="ghost" style={{ marginTop: 0 }} data-testid="preview-cam-toggle"
                          aria-pressed={Boolean(previewStream)} onClick={() => void togglePreviewCam()}>
                          {previewStream ? `📹 ${t('lesson.camDisable')}` : `📹 ${t('lesson.camEnable')}`}
                        </button>
                        <span className="muted" data-testid="preview-mic-state">{micErr ? '🎤 ✕' : '🎤 ✔'}</span>
                      </div>
                      <video ref={previewVideoRef} data-testid="preview-video" className="preview-video" autoPlay playsInline muted />
                      <div className="device-check-grid">
                        <div className="panel-section">
                          <div className="panel-section-title">🎚 {t('lesson.micLevel')}</div>
                          {/* роль meter + aria-valuenow: уровень доступен и скринридеру, и тесту */}
                          <div className="mic-meter" role="meter" aria-label={t('lesson.micLevel')}
                            aria-valuenow={Math.round(Math.min(1, micLevel) * 100)} aria-valuemin={0} aria-valuemax={100}
                            data-testid="mic-meter">
                            <span style={{ width: `${Math.round(Math.min(1, micLevel) * 100)}%` }} />
                          </div>
                        </div>
                        {deviceSettings}
                      </div>
                      <p className="bar-hint">{t('lesson.devicesHint')}</p>
                    </>
                  )}
                  {error && <p className="error">{error}</p>}
                  {mediaErrors}
                </div>
              )}
              {connected && (
                <>
                  {/* student banners (task 3): why the mic is off — restored on reconnect */}
                  {!isTeacher && muteAll && <p className="banner" data-testid="banner-muted">{t('lesson.bannerMuted')}</p>}
                  {!isTeacher && lectureMode && !muteAll && <p className="banner" data-testid="banner-lecture">{t('lesson.bannerLecture')}</p>}
                  {hasFloor && <span className="badge" role="status" data-testid="floor-banner">🎙 {t('lesson.floorGiven')}</span>}
                  {floorTakenNotice && <span className="muted" role="status" data-testid="floor-taken">{t('lesson.floorTaken')}</span>}
                  {error && <p className="error">{error}</p>}
                  {mediaErrors}
                  {/* task 1.3: the presenter always knows what they are showing and can stop it here
                      (the browser's own Stop button works too — LiveKit unpublishes the track and the
                      layout returns by itself, see zz13-screen-stage.spec.ts) */}
                  {screenOn && (
                    <div className="banner banner-share" role="status" data-testid="share-banner">
                      <span>🖥 {t('lesson.shareShowing')}</span>
                      {shareSurface === 'browser' && (
                        <span className="muted" data-testid="share-mirror-warn">{t('lesson.shareMirrorWarn')}</span>
                      )}
                      <div className="spacer" />
                      <button type="button" className="danger" style={{ marginTop: 0 }} data-testid="share-stop"
                        onClick={() => void toggleShare()}>{t('lesson.shareStop')}</button>
                    </div>
                  )}
                  {/* ── task B: Meet-style stage. Board/screen/spotlight own the main
                       window; cameras shrink to a compact strip (right on desktop,
                       bottom on phones); the own camera is a draggable floating PiP. ── */}
                  {hasStage ? (
                    <div className={`lesson-stage${stripOpen ? '' : ' strip-closed'}`} ref={stageRef} data-testid="lesson-stage">
                      <div className="stage-main" data-testid="stage-main">
                        {showSwitch && !screenIsMain && (
                          <div className="stage-switch stage-switch-flow" role="group" data-testid="stage-switch"
                            aria-label={t('lesson.stageSwitchAria')}>
                            <button type="button" className={`ghost${showBoardInstead ? '' : ' chip-active'}`}
                              style={{ marginTop: 0 }} data-testid="stage-switch-screen" aria-pressed={!showBoardInstead}
                              onClick={() => setShowBoardInstead(false)}>{t('lesson.stageScreen')}</button>
                            <button type="button" className={`ghost${showBoardInstead ? ' chip-active' : ''}`}
                              style={{ marginTop: 0 }} data-testid="stage-switch-board" aria-pressed={showBoardInstead}
                              onClick={() => setShowBoardInstead(true)}>{t('lesson.stageBoard')}</button>
                          </div>
                        )}
                        {stage.kind === 'board' ? (
                          <>
                            <Suspense fallback={<div className="card board-loading" style={{ height: boardFull ? 'calc(100vh - 64px)' : '62vh' }} />}>
                              <Board sessionId={session.id} classId={session.classId} height={boardFull ? 'calc(100vh - 64px)' : '62vh'} />
                            </Suspense>
                            <button className="stage-full" style={{ marginTop: 0 }} data-testid="board-full"
                              onClick={toggleStageFull}>⛶ {t('lesson.boardFull')}</button>
                          </>
                        ) : screenIsMain && stage.tile ? (
                          <ScreenStage
                            presenter={Boolean(stage.tile.local)}
                            caption={`${stage.tile.local ? t('lesson.you') : stage.tile.name} · ${t('lesson.stageScreen')}`}
                            controls={stageControls}
                            lead={showSwitch ? (
                              <div className="stage-switch" role="group" data-testid="stage-switch"
                                aria-label={t('lesson.stageSwitchAria')}>
                                <button type="button" className={`ghost${showBoardInstead ? '' : ' chip-active'}`}
                                  style={{ marginTop: 0 }} data-testid="stage-switch-screen" aria-pressed={!showBoardInstead}
                                  onClick={() => setShowBoardInstead(false)}>{t('lesson.stageScreen')}</button>
                                <button type="button" className={`ghost${showBoardInstead ? ' chip-active' : ''}`}
                                  style={{ marginTop: 0 }} data-testid="stage-switch-board" aria-pressed={showBoardInstead}
                                  onClick={() => setShowBoardInstead(true)}>{t('lesson.stageBoard')}</button>
                              </div>
                            ) : null}
                          >
                            <VideoTile tile={stage.tile} track={tracksRef.current.get(stage.tile.key)} big hideName />
                          </ScreenStage>
                        ) : stage.tile ? (
                          <div className="stage-tile" onClick={() => setPinnedKey(stage.tile!.key)} data-testid="stage-tile">
                            <VideoTile tile={stage.tile} track={tracksRef.current.get(stage.tile.key)} big />
                          </div>
                        ) : null}
                        {/* task 1.3: the presenter's own share — proof of what leaves the machine */}
                        {screenOn && screenTile && (
                          <div className={`share-preview${sharePreview ? '' : ' preview-min'}`} data-testid="share-preview">
                            <div className="pip-bar" data-testid="share-preview-bar">
                              <span>{t('lesson.sharePreview')}</span>
                              <button type="button" className="ghost" style={{ marginTop: 0, padding: 2 }}
                                data-testid="share-preview-toggle" aria-pressed={sharePreview}
                                aria-label={t('lesson.sharePreview')}
                                onClick={() => setSharePreview((v) => !v)}>{sharePreview ? '—' : '⤢'}</button>
                            </div>
                            {sharePreview && (
                              <VideoTile tile={screenTile} track={tracksRef.current.get(screenTile.key)} />
                            )}
                          </div>
                        )}
                      </div>
                      <div className="stage-strip" data-testid="stage-strip">
                        {stripTiles.slice(0, STRIP_MAX).map((tile) => (
                          <div role="button" tabIndex={0} key={tile.key} className="strip-cell" data-testid={`strip-${tile.key}`}
                            onClick={() => setPinnedKey(pinnedKey === tile.key ? null : tile.key)}
                            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setPinnedKey(pinnedKey === tile.key ? null : tile.key); } }}>
                            <VideoTile tile={tile} track={tracksRef.current.get(tile.key)} />
                          </div>
                        ))}
                        {stripTiles.length > STRIP_MAX && (
                          <div className="strip-more" data-testid="strip-more">+{stripTiles.length - STRIP_MAX}</div>
                        )}
                      </div>
                      {/* teacher's camera for students: a small floating window (§B3) */}
                      {teacherFloats && teacherTile && (
                        <div className="lesson-pip pip-teacher" data-testid="pip-teacher" style={{ right: pip.x, top: 12 }}>
                          <VideoTile tile={teacherTile} track={tracksRef.current.get(teacherTile.key)} />
                        </div>
                      )}
                      {localTile && !pip.hidden && (
                        <div className={`lesson-pip pip-local${pip.min ? ' pip-min' : ''}`} data-testid="pip-local"
                          style={{ right: pip.x, bottom: pip.y }}>
                          <div className="pip-bar" data-testid="pip-bar"
                            onPointerDown={pipDown} onPointerMove={pipMove} onPointerUp={pipUp} onPointerCancel={pipUp}>
                            <span>{t('lesson.you')}</span>
                            <button type="button" className="ghost" style={{ marginTop: 0, padding: 2 }} data-testid="pip-min"
                              aria-label={t('lesson.pipMin')} onClick={(e) => { e.stopPropagation(); setPip((p) => ({ ...p, min: !p.min })); }}>{pip.min ? '▢' : '—'}</button>
                            <button type="button" className="ghost" style={{ marginTop: 0, padding: 2 }} data-testid="pip-hide"
                              aria-label={t('lesson.pipHide')} onClick={(e) => { e.stopPropagation(); setPip((p) => ({ ...p, hidden: true })); }}>✕</button>
                          </div>
                          {!pip.min && <VideoTile tile={localTile} track={tracksRef.current.get(localTile.key)} />}
                        </div>
                      )}
                      {localTile && pip.hidden && (
                        <button type="button" className="pip-restore" style={{ marginTop: 0 }} data-testid="pip-restore"
                          onClick={() => setPip((p) => ({ ...p, hidden: false }))}>📹</button>
                      )}
                    </div>
                  ) : (
                    <>
                      <div className={gridClass} data-testid="video-grid">
                        {tiles.map((tile) => (
                          <VideoTile key={tile.key} tile={tile} track={tracksRef.current.get(tile.key)} />
                        ))}
                      </div>
                      {peers.length === 0 && <p className="muted" data-testid="waiting-peers">{t('lesson.waitingPeers')}</p>}
                    </>
                  )}
                  {toast && (
                    <div className="toast" role="status" data-testid="lesson-toast">
                      {toast}
                      {toastAction && (
                        <button type="button" className="toast-action" data-testid="lesson-toast-action"
                          onClick={toastAction.run}>
                          {toastAction.label}
                        </button>
                      )}
                    </div>
                  )}
                  {/* Часть 1: подтверждение учителя перед включением лекции — с переключателем
                      «вернуть устройства после». Он по умолчанию включён и уезжает на сервер,
                      где лежит на сессии: переподключение ученика не должно менять решение. */}
                  {lectureAsk && (
                    <div className="modal-backdrop" role="presentation" onClick={() => setLectureAsk(null)}>
                      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="lecture-ask-title"
                        data-testid="lecture-confirm" onClick={(e) => e.stopPropagation()}>
                        <h2 id="lecture-ask-title" className="modal-title">{t('lesson.lectureConfirmTitle')}</h2>
                        <p className="muted">{t('lesson.lectureConfirmBody')}</p>
                        <label className="check-row" data-testid="lecture-restore-row">
                          <input type="checkbox" checked={lectureAsk.restore} data-testid="lecture-restore"
                            onChange={(e) => setLectureAsk({ restore: e.target.checked })} />
                          <span>{t('lesson.lectureRestoreLabel')}</span>
                        </label>
                        <div className="modal-actions">
                          <button type="button" className="ghost" data-testid="lecture-confirm-cancel"
                            onClick={() => setLectureAsk(null)}>
                            {t('common.cancel')}
                          </button>
                          <button type="button" data-testid="lecture-confirm-ok"
                            onClick={() => { const r = lectureAsk.restore; setLectureAsk(null); void sendLecture(true, r); }}>
                            {t('lesson.lectureConfirmOk')}
                          </button>
                        </div>
                      </div>
                    </div>
                  )}
                </>
              )}
              {/* board is WS-based: while a session exists it is reachable even before
                  RTC — as the stage when open, as a card under the grid otherwise */}
              {/*
                Высота доски подчинена тому же правилу, что и нижняя панель: страница урока обязана
                помещаться в окно, чтобы полоса управления была видна без прокрутки и ничего под неё
                не заезжало. 60vh оставляли страницу длиннее вьюпорта (замер скриншотами
                2026-10-11: 1280x900 — панель ушла за нижний край), поэтому берётся меньшее из
                60vh и «остаток экрана минус сетка, заголовок и панель».
              */}
              {!(connected && boardOpen) && (
                <Suspense fallback={<div className="card board-loading" style={{ height: layout === 'stage' ? '40vh' : 'min(60vh, calc(100dvh - 420px))' }} />}>
                  <Board sessionId={session.id} classId={session.classId}
                    height={layout === 'stage' ? '40vh' : 'min(60vh, calc(100dvh - 420px))'} />
                </Suspense>
              )}
            </div>

            {/* правая панель: поднятые руки и участники — в одной вкладке, комментарии — в другой.
                Она работает и до входа в комнату: рука и комментарии не требуют медиа. */}
            {panelOpen && (
            <Suspense fallback={<div className="side-panel" aria-hidden="true" />}>
              <LessonPanelLazy
                tab={panelTab} onTab={setPanelTab} onClose={() => setPanelOpen(false)}
                sessionId={session.id} isTeacher={isTeacher} lectureMode={lectureMode} muteAll={muteAll}
                peers={peers} hands={handsQ.q.data?.hands ?? []} unread={unread}
                onMuteOne={(identity) => void muteOne(identity)}
                onScreen={(identity, allow) => act.mutate({ path: `/api/lessons/${session.id}/grant-screen`, body: { identity, allow } })}
                onKick={(identity) => act.mutate({ path: `/api/lessons/${session.id}/kick`, body: { identity } })}
                onMuteAll={() => void toggleMuteAll()}
                onLecture={setLecture}
                comments={{ isTeacher, lectureMode }}
              />
            </Suspense>
            )}
          </div>

          {/* лист «Настройки устройств» из «Ещё» — тот же компонент, что на экране проверки */}
          {devicesOpen && (
            <div className="side-panel devices-sheet" data-testid="devices-sheet" role="group"
              aria-label={t('lesson.deviceSettings')}>
              <div className="panel-tabs">
                <strong style={{ padding: '0 8px', fontSize: '.9rem' }}>{t('lesson.deviceSettings')}</strong>
                <div className="spacer" />
                <button type="button" className="panel-tab" data-testid="devices-close"
                  aria-label={t('lesson.menuClose')} onClick={() => setDevicesOpen(false)}>✕</button>
              </div>
              <div className="panel-body">{deviceSettings}</div>
            </div>
          )}

          <LessonBar state={barState} actions={barActions} devices={barDevices} noteHref={noteHref} />
        </div>
      )}
      {!isTeacher && session && (
        <NotesDrawer classId={session.classId} sessionId={session.id} open={sheetsOpen} onToggle={() => setSheetsOpen((v) => !v)} />
      )}
      {/* task 2: комментарии не требуют медиа вообще, а учителю нужна и расшифровка после
          окончания урока: session уже нет, lastSessionId — есть, права решает сервер.
          Состояние «открыто» то же, что и во время урока (commentsOpen): панель, которую учитель
          держал открытой, остаётся открытой и после конца — раньше именно так и работало. */}
      {!connected && !session && (isTeacher ? lastSessionId : null) && (
        <div className="card">
          <button type="button" className="secondary" style={{ marginTop: 0 }} data-testid="comments-open"
            aria-pressed={commentsOpen} onClick={() => toggleTab('comments')}>
            💬 {t('lesson.commentsTitle')}
          </button>
          {commentsOpen && (
            <div className="panel-body" data-testid="comments-panel">
              <Suspense fallback={<p className="muted">…</p>}>
                <CommentsPanelLazy sessionId={lastSessionId!} isTeacher lectureMode={false}
                  onClose={() => setPanelOpen(false)} />
              </Suspense>
            </div>
          )}
        </div>
      )}
    </div>
  );
}