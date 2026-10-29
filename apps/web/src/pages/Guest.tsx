import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Room, RoomEvent, type RemoteParticipant, type RemoteTrack, type RemoteTrackPublication } from 'livekit-client';
import { GUEST_NAME_MAX, isGuestKey } from '@klass/shared';
import { currentGuestToken, guestRequested, markGuestRequested } from '../lib/guestToken';

/**
 * Страница гостя (задача 2026-10-28, часть 3).
 *
 * Без регистрации и без пользовательской сессии: токен ссылки + имя. Пока учитель не одобрил,
 * страница только ждёт; LiveKit-токен и комната появляются ПОСЛЕ одобрения и только из
 * `/api/guest/rtc`, где сервер заново проверяет ссылку, урок и статус заявки. Поэтому «старый
 * одобренный ответ» в клиенте ничего не открывает.
 *
 * Гость — зритель: страница никогда не просит микрофон/камеру и не публикует треки. Она также
 * не знает ни списка участников, ни имени учителя: только имя класса из предпросмотра.
 */

type Phase =
  | 'loading' | 'invalid' | 'form' | 'pending' | 'connecting' | 'viewing'
  | 'rejected' | 'revoked' | 'expired' | 'ended' | 'closed' | 'error';

interface ApiResult { ok: boolean; status: number; data?: Record<string, unknown>; error?: string }

/** Сырой fetch без access-token и cookie: гостевые маршруты не должны видеть чужую сессию. */
async function guestApi(path: string, body: Record<string, unknown>): Promise<ApiResult> {
  try {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      credentials: 'omit',
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { ok: res.ok, status: res.status, data, error: typeof data.error === 'string' ? data.error : undefined };
  } catch {
    return { ok: false, status: 0, error: 'networkError' };
  }
}

/** Ключ гостя: 32 случайных байта в base64url, живёт в localStorage ЭТОГО браузера. */
function browserGuestKey(): string {
  try {
    const kept = localStorage.getItem('klass_guest_key');
    if (kept && isGuestKey(kept)) return kept;
  } catch { /* приватный режим */ }
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const key = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  try { localStorage.setItem('klass_guest_key', key); } catch { /* не запомнили — останется в памяти */ }
  return key;
}

const ERROR_PHASE: Record<string, Phase> = {
  guestLinkInvalid: 'invalid',
  guestLinkRevoked: 'revoked',
  guestLinkExpired: 'expired',
  lessonEnded: 'ended',
  guestApprovalRequired: 'pending',
  guestRequestRejected: 'rejected',
  guestRequestNotFound: 'form',
  networkError: 'error',
};

export default function Guest() {
  const { t } = useTranslation();
  const [token] = useState<string | null>(() => currentGuestToken(window as unknown as Window & { [key: string]: unknown }));
  const [key] = useState(() => browserGuestKey());
  const [phase, setPhase] = useState<Phase>(token ? 'loading' : 'invalid');
  const [className, setClassName] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const roomRef = useRef<Room | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const elsRef = useRef<Map<string, HTMLElement>>(new Map());
  const resumedRef = useRef(false);

  useEffect(() => { document.title = t('guest.title'); }, [t]);

  const clearGrid = useCallback(() => {
    gridRef.current?.replaceChildren();
    elsRef.current.clear();
  }, []);

  useEffect(() => () => {
    void roomRef.current?.disconnect();
    roomRef.current = null;
  }, []);

  const removeMedia = (k: string) => {
    const el = elsRef.current.get(k);
    if (el) { el.remove(); elsRef.current.delete(k); }
  };

  const putMedia = (k: string, el: HTMLMediaElement, label: string) => {
    const grid = gridRef.current;
    if (!grid) return;
    removeMedia(k);
    const wrapper = document.createElement('div');
    wrapper.dataset.key = k;
    wrapper.className = 'guest-tile';
    el.autoplay = true;
    const cap = document.createElement('div');
    cap.className = 'muted';
    cap.textContent = label;
    wrapper.appendChild(cap);
    wrapper.appendChild(el);
    grid.appendChild(wrapper);
    elsRef.current.set(k, wrapper);
  };

  const connect = useCallback(async (guestToken: string) => {
    setPhase('connecting');
    const r = await guestApi('/api/guest/rtc', { token: guestToken, key });
    if (!r.ok) { setPhase(ERROR_PHASE[r.error ?? ''] ?? 'error'); return; }
    const { token: rtcToken, wsUrl } = r.data as { token: string; wsUrl: string };
    const room = new Room({ adaptiveStream: true });
    roomRef.current = room;
    room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack, pub: RemoteTrackPublication, participant: RemoteParticipant) => {
      const el = track.kind === 'video' ? document.createElement('video') : document.createElement('audio');
      // видео — только встроенно и без звука; звук идёт отдельной дорожкой, его включает кнопка
      if (el instanceof HTMLVideoElement) { el.playsInline = true; el.muted = true; }
      track.attach(el);
      const who = participant.name || participant.identity.slice(0, 8);
      putMedia(`${participant.sid}:${pub.trackSid}`, el,
        pub.source === 'screen_share' ? `${who} · ${t('guest.screenShare')}` : who);
    });
    room.on(RoomEvent.TrackUnsubscribed, (_track, pub, participant) => {
      removeMedia(`${participant.sid}:${pub.trackSid}`);
    });
    room.on(RoomEvent.ParticipantDisconnected, (p) => {
      for (const k of [...elsRef.current.keys()]) {
        if (k.startsWith(`${p.sid}:`)) removeMedia(k);
      }
    });
    room.on(RoomEvent.Disconnected, () => {
      clearGrid();
      if (roomRef.current === room) setPhase('closed');
    });
    try {
      await room.connect(wsUrl, rtcToken);
      setPhase('viewing');
    } catch {
      clearGrid();
      void room.disconnect();
      roomRef.current = null;
      setPhase('closed');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, t, clearGrid]);

  /** Проверка статуса: единственный способ узнать, что учитель уже одобрил (гость не в сокете). */
  const checkStatus = useCallback(async (guestToken: string): Promise<Phase | null> => {
    const r = await guestApi('/api/guest/status', { token: guestToken, key });
    if (!r.ok) {
      const p = ERROR_PHASE[r.error ?? ''] ?? 'error';
      setPhase(p);
      return p;
    }
    const status = String(r.data?.status ?? 'pending');
    if (status === 'approved') { await connect(guestToken); return 'connecting'; }
    const p = (status === 'pending' || status === 'rejected' || status === 'revoked'
      || status === 'expired' || status === 'ended') ? status as Phase : 'pending';
    setPhase(p);
    return p;
  }, [key, connect]);

  // Предпросмотр — первое, что узнаёт страница: класс и «ссылка ещё жива».
  useEffect(() => {
    if (!token) return;
    void (async () => {
      const r = await guestApi('/api/guest/preview', { token });
      if (!r.ok) { setPhase(ERROR_PHASE[r.error ?? ''] ?? 'invalid'); return; }
      setClassName(String(r.data?.className ?? ''));
      // Возврат на вкладку после перезагрузки: если заявка уже отправлялась, узнаём её судьбу.
      if (!guestRequested(window as unknown as Window & { [key: string]: unknown })) { setPhase('form'); return; }
      if (resumedRef.current) return;
      resumedRef.current = true;
      await checkStatus(token);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  // Ожидание одобрения: мягкий опрос раз в 4 секунды. Гость не подключён к сокету урока и не
  // должен им подключаться — опрос видит только его собственную заявку.
  useEffect(() => {
    if (phase !== 'pending' || !token) return;
    let cancelled = false;
    const timer = window.setInterval(() => {
      if (cancelled) return;
      void checkStatus(token);
    }, 4_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [phase, token, checkStatus]);

  const submit = async () => {
    if (!token || busy) return;
    const clean = name.trim().replace(/\s+/g, ' ').slice(0, GUEST_NAME_MAX);
    if (!clean) return;
    setBusy(true);
    const r = await guestApi('/api/guest/request', { token, key, name: clean });
    setBusy(false);
    if (!r.ok) { setPhase(ERROR_PHASE[r.error ?? ''] ?? 'error'); return; }
    markGuestRequested(window as unknown as Window & { [key: string]: unknown });
    const status = String(r.data?.status ?? 'pending');
    if (status === 'approved') { await connect(token); return; }
    if (status === 'pending') setPhase('pending');
    else if (status === 'rejected' || status === 'revoked' || status === 'expired' || status === 'ended') setPhase(status);
    else setPhase('error');
  };

  const retry = async () => {
    if (!token) return;
    setPhase('loading');
    await checkStatus(token);
  };

  const shell = (body: ReactNode) => (
    <div className="container guest-page">
      <div className="guest-head">
        <h1>{t('guest.title')}</h1>
        {className && <p className="muted" data-testid="guest-class">{className}</p>}
      </div>
      {body}
      <p className="muted guest-foot">{t('guest.privacyNote')}</p>
    </div>
  );

  if (!token || phase === 'invalid') {
    return shell(
      <div className="card" data-testid="guest-invalid">
        <p>{t('guest.invalid')}</p>
        <p className="muted">{t('guest.invalidHint')}</p>
      </div>,
    );
  }

  if (phase === 'revoked' || phase === 'expired' || phase === 'ended' || phase === 'rejected') {
    const body = phase === 'rejected'
      ? { testid: 'guest-rejected', title: t('guest.rejected'), hint: t('guest.rejectedHint') }
      : phase === 'revoked'
        ? { testid: 'guest-revoked', title: t('guest.revoked'), hint: t('guest.revokedHint') }
        : phase === 'expired'
          ? { testid: 'guest-expired', title: t('guest.expired'), hint: t('guest.expiredHint') }
          : { testid: 'guest-ended', title: t('guest.ended'), hint: t('guest.endedHint') };
    return shell(
      <div className="card" data-testid={body.testid} role="status">
        <p>{body.title}</p>
        <p className="muted">{body.hint}</p>
      </div>,
    );
  }

  if (phase === 'loading' || phase === 'connecting') {
    return shell(<p className="muted" data-testid="guest-loading">…</p>);
  }

  if (phase === 'closed') {
    return shell(
      <div className="card" data-testid="guest-closed" role="status">
        <p>{t('guest.closed')}</p>
        <button type="button" data-testid="guest-retry" onClick={() => void retry()}>{t('guest.reconnect')}</button>
      </div>,
    );
  }

  if (phase === 'error') {
    return shell(
      <div className="card" data-testid="guest-error" role="status">
        <p className="error">{t('guest.errorGeneric')}</p>
        <button type="button" data-testid="guest-retry" onClick={() => void retry()}>{t('guest.reconnect')}</button>
      </div>,
    );
  }

  if (phase === 'pending') {
    return shell(
      <div className="card" data-testid="guest-waiting" role="status" aria-live="polite">
        <p><strong>{t('guest.waitingTitle')}</strong></p>
        <p className="muted">{t('guest.waitingHint')}</p>
        <button type="button" className="ghost" data-testid="guest-check" onClick={() => void retry()}>
          {t('guest.checkAgain')}
        </button>
      </div>,
    );
  }

  if (phase === 'viewing') {
    return shell(
      <>
        <p className="badge" role="status" data-testid="guest-approved">{t('guest.approved')}</p>
        <p className="muted" data-testid="guest-viewer-note">{t('guest.viewerNote')}</p>
        <div className="videos guest-videos" ref={gridRef} data-testid="guest-videos" />
        <button type="button" className="secondary" style={{ marginTop: 0 }} data-testid="guest-enable-sound"
          onClick={() => { void roomRef.current?.startAudio().catch(() => undefined); }}>
          🔊 {t('guest.enableSound')}
        </button>
      </>,
    );
  }

  return shell(
    <form className="card" data-testid="guest-form" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <p>{t('guest.formTitle')}</p>
      <label htmlFor="guest-name">{t('guest.nameLabel')}</label>
      <input id="guest-name" data-testid="guest-name" value={name} autoComplete="name"
        maxLength={GUEST_NAME_MAX} placeholder={t('guest.namePlaceholder')}
        onChange={(e) => setName(e.target.value)} />
      <div className="row">
        <button type="submit" data-testid="guest-request" disabled={busy || !name.trim()}>
          {t('guest.request')}
        </button>
      </div>
    </form>,
  );
}
