import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * Настройки устройств (задача 2026-10-10). Один компонент на два места: экран проверки до входа
 * и лист «Настройки устройств» из меню «Ещё». Выбор устройств назван в списке дел «убрать
 * выпадающие списки с основного экрана» — здесь это radio-строки, а не `<select>`: их видно без
 * раскрытия, они одинаково работают с клавиатуры и пальцем и не перекрыты видео.
 *
 * Динамик. livekit-client 2.22.3 умеет `Room.switchActiveDevice('audiooutput', id)`, но сам
 * браузер поддерживает это не везде (Chromium — да, Firefox/Safari — нет). Поэтому список
 * показывается только когда движок это умеет, а иначе рядом стоит честная причина, а не «сбой».
 */

export interface DeviceRow { deviceId: string; label: string }

/** Поддержка выбора динамика: Chromium отдаёт `AudioContext.setSinkId`, остальные — нет. */
export function speakerPickSupported(): boolean {
  try {
    const proto = (Object.getPrototypeOf(new AudioContext()) as unknown as Record<string, unknown>);
    return typeof proto.setSinkId === 'function';
  } catch { return false; }
}

export function DeviceSettings({ cams, mics, speakers, savedCam, savedMic, savedSpk, onCam, onMic, onSpk,
  meter, canPickSpeaker, showTestSpeaker }: {
  cams: DeviceRow[]; mics: DeviceRow[]; speakers: DeviceRow[];
  savedCam: string; savedMic: string; savedSpk: string;
  onCam: (id: string) => void; onMic: (id: string) => void; onSpk?: (id: string) => void;
  /** 0..1 из useMicMeter; отсутствие потока означает 0 */
  meter?: number; canPickSpeaker: boolean; showTestSpeaker?: boolean;
}) {
  const { t } = useTranslation();
  const [tone, setTone] = useState(false);
  const ctxRef = useRef<AudioContext | null>(null);

  useEffect(() => () => { void ctxRef.current?.close().catch(() => undefined); ctxRef.current = null; }, []);

  /** короткий тон в выбранный динамик: без `setSinkId` звук пойдёт через устройство по умолчанию */
  function playTest() {
    if (tone) return;
    setTone(true);
    try {
      const ctx = new AudioContext();
      ctxRef.current = ctx;
      const withSink = ctx as unknown as { setSinkId?: (id: string) => Promise<void> };
      const start = async () => {
        if (savedSpk && typeof withSink.setSinkId === 'function') {
          try { await withSink.setSinkId(savedSpk); } catch { /* вернёмся на дефолт — не критично */ }
        }
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        gain.gain.value = 0.05;
        osc.connect(gain).connect(ctx.destination);
        osc.start();
        osc.stop(ctx.currentTime + 0.5);
        osc.onended = () => { setTone(false); void ctx.close().catch(() => undefined); if (ctxRef.current === ctx) ctxRef.current = null; };
      };
      void start();
    } catch { setTone(false); }
  }

  const group = (kind: 'cam' | 'mic' | 'spk', icon: string, title: string, aria: string,
    list: DeviceRow[], value: string, pick: (id: string) => void) => (
    <div className="panel-section">
      <div className="panel-section-title">{icon} {title}</div>
      <div className="device-list" role="radiogroup" aria-label={aria} data-testid={`${kind}-list`}>
        <button type="button" role="radio" aria-checked={!value} className="device-item"
          data-testid={`${kind}-pick-default`} onClick={() => pick('')}>{t('lesson.deviceDefault')}</button>
        {list.map((d, i) => (
          <button key={d.deviceId || `${kind}-${i}`} type="button" role="radio" className="device-item"
            aria-checked={d.deviceId === value} data-testid={`${kind}-pick-${d.deviceId || i}`}
            onClick={() => pick(d.deviceId)}>
            {d.label || `${title} ${i + 1}`}
          </button>
        ))}
        {list.length === 0 && <p className="bar-hint" data-testid={`${kind}-list-empty`}>{t('lesson.devicesHint')}</p>}
      </div>
    </div>
  );

  return (
    <div className="panel-section" data-testid="device-settings">
      {meter !== undefined && (
        <div className="panel-section">
          <div className="panel-section-title">🎚 {t('lesson.micLevel')}</div>
          {/* role=meter + aria-valuenow: уровень доступен и скринридеру, и тесту */}
          <div className="mic-meter" role="meter" aria-label={t('lesson.micLevel')}
            aria-valuenow={Math.round(Math.min(1, meter) * 100)} aria-valuemin={0} aria-valuemax={100}
            data-testid="mic-meter">
            <span style={{ width: `${Math.round(Math.min(1, meter) * 100)}%` }} />
          </div>
        </div>
      )}
      {group('cam', '📹', t('lesson.toggleCamera'), t('lesson.pickCam'), cams, savedCam, onCam)}
      {group('mic', '🎙', t('lesson.toggleMic'), t('lesson.pickMic'), mics, savedMic, onMic)}
      {canPickSpeaker
        ? group('spk', '🔊', t('lesson.speaker'), t('lesson.speaker'), speakers, savedSpk, (id) => onSpk?.(id))
        : <p className="bar-hint" data-testid="speaker-unsupported">{t('lesson.speakerUnsupported')}</p>}
      {showTestSpeaker && (
        <button type="button" className="bar-item" data-testid="speaker-test" aria-pressed={tone} onClick={playTest}>
          🔊 {t('lesson.speakerTest')}
        </button>
      )}
    </div>
  );
}

/**
 * Индикатор уровня собственного микрофона. Возвращает 0..1 и никогда не бросает: если WebAudio
 * недоступен, полоска остаётся пустой — это украшение проверки, а не проверка прав.
 */
export function useMicMeter(stream: MediaStream | null): number {
  const [level, setLevel] = useState(0);
  useEffect(() => {
    if (!stream) { setLevel(0); return; }
    let ctx: AudioContext | null = null;
    let raf = 0;
    let stopped = false;
    try {
      ctx = new AudioContext();
      const src = ctx.createMediaStreamSource(stream);
      const an = ctx.createAnalyser();
      an.fftSize = 512;
      src.connect(an);
      const buf = new Uint8Array(an.frequencyBinCount);
      const tick = () => {
        if (stopped) return;
        an.getByteTimeDomainData(buf);
        let peak = 0;
        for (const v of buf) peak = Math.max(peak, Math.abs(v - 128) / 128);
        setLevel(peak);
        raf = requestAnimationFrame(tick);
      };
      tick();
    } catch { /* нет WebAudio — полоска остаётся нулевой */ }
    return () => {
      stopped = true; cancelAnimationFrame(raf);
      void ctx?.close().catch(() => undefined);
    };
  }, [stream]);
  return level;
}
