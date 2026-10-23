import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Track as LkTrack } from 'livekit-client';
import VideoTile, { type Tile } from './VideoTile';
import { previewOpenByDefault } from '@klass/shared';

/**
 * Часть C (2026-10-23): содержимое окна показа экрана поверх других программ.
 *
 * Окно даёт браузер (`documentPictureInPicture`), содержимое рисуем мы — порталом в документ
 * этого окна, поэтому те же компоненты, та же тема и тот же перевод, что в уроке. Второго
 * соединения к LiveKit здесь НЕ появляется: `screenTrack`/`camTrack` — те же дорожки той же
 * комнаты, и `track.attach()` вешает один и тот же поток на второй видеоэлемент (в другом
 * документе).
 *
 * «Коридор зеркал»: когда человек показывает ВЕСЬ экран, показывать ему этот же экран нельзя —
 * он увидит окно, в котором видно окно, в котором видно его. Поэтому при `displaySurface ===
 * 'monitor'` предпросмотр свёрнут по умолчанию (значок и подпись остаются), а окно/вкладка —
 * открыты. Переключатель рядом: решение человека важнее догадки.
 */
export default function SharePip({
  screenTile, screenTrack, camTile, camTrack, micOn, camOn, surface,
  onToggleMic, onToggleCam, onStop, onReturn,
}: {
  screenTile: Tile | null; screenTrack: LkTrack | null;
  camTile: Tile | null; camTrack: LkTrack | null;
  micOn: boolean; camOn: boolean; surface: string;
  onToggleMic: () => void; onToggleCam: () => void; onStop: () => void; onReturn: () => void;
}) {
  const { t } = useTranslation();
  const [preview, setPreview] = useState(() => previewOpenByDefault(surface));
  /*
   * Показ МЕНЯЕТСЯ вместе с поверхностью: человек выбрал другой источник — правило «коридора»
   * пересчитывается. Без этого свёрнутый предпросмотр от прошлого монитора висел бы и на
   * выбранном окне, где он как раз нужен.
   */
  useEffect(() => { setPreview(previewOpenByDefault(surface)); }, [surface]);

  return (
    <div className="share-pip" data-testid="share-pip" data-surface={surface || 'unknown'}>
      {/*
        Строка состояния ОТДЕЛЬНЫМ `role="status"` внутри абзаца, а не на самом абзаце: внутрь
        live-region попала бы кнопка, а `nested-interactive` (проверка axe в zz6) на это уже
        ловила панель урока раньше — live-region не должен содержать интерактивного потомка.
      */}
      <p className="share-pip-status">
        <span role="status" data-testid="share-pip-status">
          <span aria-hidden="true">🖥</span> {t('lesson.shareShowing')}
        </span>
        <button type="button" className="ghost share-pip-mini" style={{ marginTop: 0 }}
          data-testid="share-pip-preview-toggle" aria-pressed={preview}
          aria-label={t('lesson.sharePreview')}
          onClick={() => setPreview((v) => !v)}>{preview ? '—' : '⤢'}</button>
      </p>

      <div className={`share-pip-stage${preview ? '' : ' is-min'}`} data-testid="share-pip-stage">
        {preview && screenTile && (
          <VideoTile tile={screenTile} track={screenTrack ?? undefined} hideName />
        )}
        {preview && !screenTile && <p className="muted" data-testid="share-pip-waiting">{t('lesson.sharePipWaiting')}</p>}
        {!preview && <p className="muted" data-testid="share-pip-collapsed">{t('lesson.sharePipCollapsed')}</p>}
        {camTile && (
          <div className="share-pip-cam" data-testid="share-pip-cam">
            <VideoTile tile={camTile} track={camTrack ?? undefined} />
          </div>
        )}
      </div>

      {/*
        Кнопки — те же классы и те же подписи, что у полосы урока (`bar-btn`/`bar-off`/`bar-ico`):
        человек переезжает глазами из панели в окно и обязан увидеть те же значки заглушенного
        микрофона и выключенной камеры, а не новый набор.

        `aria-label` и `title` обязательны: полоса урока прячет подпись кнопки `.bar-lbl` до 1280 px
        (styles.css), а окно показа по определению 360 px — без явной подписи кнопка осталась бы без
        имени вообще (скринридер читает accessible name из текста, а текста в доступном дереве нет).
      */}
      <div className="share-pip-bar" role="toolbar" aria-label={t('lesson.sharePipBarAria')}>
        <button type="button" className={`bar-btn${micOn ? '' : ' bar-off'}`} data-testid="share-pip-mic"
          aria-pressed={micOn} aria-label={t('lesson.toggleMic')} title={t('lesson.toggleMic')} onClick={onToggleMic}>
          <span className="bar-ico" aria-hidden="true">{micOn ? '🎙' : '🔇'}</span>
          <span className="bar-lbl">{t('lesson.toggleMic')}</span>
        </button>
        <button type="button" className={`bar-btn${camOn ? '' : ' bar-off'}`} data-testid="share-pip-cam-btn"
          aria-pressed={camOn} aria-label={t('lesson.toggleCamera')} title={t('lesson.toggleCamera')} onClick={onToggleCam}>
          <span className="bar-ico" aria-hidden="true">{camOn ? '📹' : '🚫'}</span>
          <span className="bar-lbl">{t('lesson.toggleCamera')}</span>
        </button>
        <button type="button" className="bar-btn bar-leave" data-testid="share-pip-stop"
          aria-label={t('lesson.shareStop')} title={t('lesson.shareStop')} onClick={onStop}>
          <span className="bar-ico" aria-hidden="true">⏹</span>
          <span className="bar-lbl">{t('lesson.shareStop')}</span>
        </button>
        <button type="button" className="bar-btn" data-testid="share-pip-return"
          aria-label={t('lesson.sharePipReturn')} title={t('lesson.sharePipReturn')} onClick={onReturn}>
          <span className="bar-ico" aria-hidden="true">↩</span>
          <span className="bar-lbl">{t('lesson.sharePipReturn')}</span>
        </button>
      </div>
    </div>
  );
}
