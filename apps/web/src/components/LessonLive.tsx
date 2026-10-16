import {
  createContext, lazy, Suspense, useContext, useEffect, useMemo, useRef, useState,
} from 'react';
import type { Track as LkTrack } from 'livekit-client';
import { useTranslation } from 'react-i18next';
import type { MiniPos } from '@klass/shared';
import { useFeatures } from '../lib/features';
import { VideoTile, type Tile } from './VideoTile';

/**
 * Мини-окно урока (часть A, шаг A2, 2026-10-16): то же самое соединение, только на другом экране.
 * Компонент НЕ владеет ни комнатой, ни сокетом — он показывает то, что ему дали, и зовёт то, что
 * умеет урок. Это принципиально: второе подключение к LiveKit означало бы второго участника.
 *
 * На телефоне (ширина ≤ 899 px) окно превращается в закреплённую полосу сверху: перетаскивать
 * окно пальцем по маленькому экрану неудобно, а «идёт урок» должно быть видно всегда.
 */
export interface MiniProps {
  elapsed: string;
  tile: Tile | null;
  track: LkTrack | null;
  micOn: boolean;
  camOn: boolean;
  comments: number;
  hands: number;
  /** учитель не рвёт урок молча: его кнопка требует второго нажатия (нативный confirm ломает
   * закрытие страницы в тестах и на телефоне — см. урок 2026-10-10 про `window.alert`) */
  needConfirm: boolean;
  pos: MiniPos;
  min: boolean;
  onMic: () => void;
  onCam: () => void;
  onBack: () => void;
  onLeave: () => void;
  onMin: () => void;
  onPointerDown: (e: React.PointerEvent) => void;
  onPointerMove: (e: React.PointerEvent) => void;
  onPointerUp: () => void;
}

export default function LessonMini(p: MiniProps) {
  const { t } = useTranslation();
  const [armed, setArmed] = useState(false);
  const leave = () => {
    if (p.needConfirm && !armed) { setArmed(true); return; }
    setArmed(false);
    p.onLeave();
  };
  return (
    <div className={`lesson-mini${p.min ? ' mini-min' : ''}`} data-testid="lesson-mini"
      style={{ left: p.pos.x, top: p.pos.y }} role="group" aria-label={t('lesson.miniTitle')}>
      <div className="mini-bar" data-testid="mini-bar"
        onPointerDown={p.onPointerDown} onPointerMove={p.onPointerMove} onPointerUp={p.onPointerUp} onPointerCancel={p.onPointerUp}>
        <span className="mini-live" aria-hidden="true" />
        <strong className="mini-title">{t('lesson.miniTitle')}</strong>
        <span className="mini-timer" data-testid="mini-timer" role="timer">{p.elapsed}</span>
        <div className="spacer" />
        <span className="mini-count" data-testid="mini-hands" title={t('lesson.peersTitle')}>✋ {p.hands}</span>
        <span className="mini-count" data-testid="mini-comments" title={t('lesson.commentsTitle')}>💬 {p.comments}</span>
        <button type="button" className="ghost mini-btn" style={{ marginTop: 0 }} data-testid="mini-min"
          aria-label={p.min ? t('lesson.miniExpand') : t('lesson.miniCollapse')}
          aria-pressed={p.min} onClick={p.onMin}>{p.min ? '▢' : '—'}</button>
      </div>
      {!p.min && (
        <>
          <div className="mini-media" data-testid="mini-media">
            {p.tile
              ? <VideoTile tile={p.tile} track={p.track ?? undefined} hideName />
              : <div className="mini-empty muted" data-testid="mini-empty">{t('lesson.miniNoVideo')}</div>}
          </div>
          <div className="mini-actions">
            <button type="button" className="ghost mini-btn" style={{ marginTop: 0 }} data-testid="mini-mic"
              aria-label={t('lesson.toggleMic')} aria-pressed={p.micOn} onClick={p.onMic}>
              {p.micOn ? '🎙' : '🔇'}
            </button>
            <button type="button" className="ghost mini-btn" style={{ marginTop: 0 }} data-testid="mini-cam"
              aria-label={t('lesson.toggleCamera')} aria-pressed={p.camOn} onClick={p.onCam}>
              {p.camOn ? '📹' : '🚫'}
            </button>
            <div className="spacer" />
            <button type="button" className="mini-btn" data-testid="mini-back" onClick={p.onBack}>
              {t('lesson.miniBack')}
            </button>
            <button type="button" className="danger mini-btn" data-testid="mini-leave"
              aria-pressed={armed} onClick={leave}>
              {p.needConfirm && armed
                ? t('lesson.endConfirm')
                : p.needConfirm ? t('lesson.endLesson') : t('lesson.leave')}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/* ─────────────────────────── хост урока ─────────────────────────── */

/** Куда DOM урока приедет сейчас: на свою страницу или в мини-окно. */
export type LessonMode = 'full' | 'mini';

interface HostValue {
  mode: LessonMode;
  persist: boolean;
  registerFull: (el: HTMLElement | null) => void;
  setLive: (v: boolean) => void;
}

const Ctx = createContext<HostValue>({
  mode: 'full', persist: true, registerFull: () => {}, setLive: () => {},
});

export const useLessonHost = () => useContext(Ctx);

const LessonLazy = lazy(() => import('../pages/Lesson'));

/**
 * Провайдер держит урок ОДИН РАЗ и над роутером. Переход на другую страницу больше не рвёт
 * соединение: размонтируется только слот, а экземпляр урока продолжает жить и переезжает
 * порталом в мини-окно. Поэтому комната ровно одна на человека, и `room.connect` не вызывается
 * повторно при каждом клике по навигации.
 */
export function LessonHostProvider({ children }: { children: React.ReactNode }) {
  const [fullEl, setFullEl] = useState<HTMLElement | null>(null);
  const [miniEl, setMiniEl] = useState<HTMLElement | null>(null);
  const [live, setLive] = useState(false);
  // LESSON_PERSIST: с выключенным переключателем урок живёт ровно на своей странице, как до части A
  const { lessonPersist: persist } = useFeatures();

  const value = useMemo<HostValue>(
    () => ({ mode: fullEl ? 'full' : 'mini', persist, registerFull: setFullEl, setLive }),
    [fullEl, persist],
  );
  const target = fullEl ?? miniEl;
  const mounted = persist ? (fullEl !== null || live) : fullEl !== null;

  return (
    <Ctx.Provider value={value}>
      {children}
      {/* второй контейнер существует всегда: портал в несуществующий узел означал бы мигание */}
      <div ref={setMiniEl} className="lesson-mini-host" data-testid="lesson-mini-host" aria-live="off" />
      {mounted && (
        <Suspense fallback={null}>
          <LessonLazy mode={fullEl ? 'full' : 'mini'} target={target} />
        </Suspense>
      )}
    </Ctx.Provider>
  );
}

/**
 * Слот страницы `/lesson`: сам ничего не рендерит, только отдаёт хосту узел DOM. Пока слот
 * зарегистрирован, урок показывается полноэкранно; как только человек ушёл на другую страницу,
 * слот снимается и тот же экземпляр переезжает в мини-окно.
 */
export function LessonSlot() {
  const host = useLessonHost();
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    host.registerFull(ref.current);
    return () => host.registerFull(null);
  }, [host]);
  return <div ref={ref} data-testid="lesson-slot" />;
}
