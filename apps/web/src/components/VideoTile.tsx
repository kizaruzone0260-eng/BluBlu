import { memo, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { Track as LkTrack } from 'livekit-client';

/** Одна плитка медиа: что показать и к какой дорожке привязать элемент. */
export interface Tile {
  key: string; kind: 'video' | 'audio'; name: string; local: boolean; screen: boolean;
  sid: string;
}

/**
 * Тайл урока. Вынесен из `pages/Lesson.tsx`, потому что с частью A (2026-10-16) одну и ту же
 * дорожку показывают два разных окна: полноэкранный урок и мини-окно на других страницах.
 * общего импорта «страница ↔ компонент» быть не должно — цикл в ES-модулях ломает инициализацию.
 */
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
export const VideoTile = memo(VideoTileBase);
export default VideoTile;
