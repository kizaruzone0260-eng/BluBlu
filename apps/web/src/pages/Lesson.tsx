import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Room, RoomEvent, Track } from 'livekit-client';
import { api, getToken } from '../lib/api';
import { useAuth } from '../App';

interface Session {
  id: string; classId: string; eventId: string | null; roomName: string;
  startedAt: string; endedAt: string | null; lectureMode: boolean;
  layout: 'gallery' | 'stage' | 'teacher'; wsUrl: string;
}

interface PeerView {
  identity: string; name: string; micOn: boolean; camOn: boolean; screenOn: boolean;
}

export default function Lesson() {
  const { t } = useTranslation();
  const { me } = useAuth();
  const qc = useQueryClient();
  const [params] = useSearchParams();
  const eventId = params.get('eventId') ?? undefined;
  const classIdParam = params.get('classId') ?? undefined;

  const [session, setSession] = useState<Session | null>(null);
  const [connected, setConnected] = useState(false);
  const [peers, setPeers] = useState<PeerView[]>([]);
  const [error, setError] = useState('');
  const [layout, setLayout] = useState<'gallery' | 'stage' | 'teacher'>('gallery');
  const [lectureMode, setLectureMode] = useState(false);
  const [previewDevices, setPreviewDevices] = useState<{ cams: MediaDeviceInfo[]; mics: MediaDeviceInfo[] }>({ cams: [], mics: [] });
  const [previewReady, setPreviewReady] = useState(false);
  const [screenOn, setScreenOn] = useState(false);
  const roomRef = useRef<Room | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const elsRef = useRef<Map<string, HTMLElement>>(new Map());

  const isTeacher = me?.role === 'teacher';

  // resolve active session + subscribe to WS status
  const status = useQuery({
    queryKey: ['lesson-status', eventId, classIdParam],
    queryFn: () => api<{ session: Session | null }>(
      `/api/lessons/active?${eventId ? `eventId=${eventId}` : `classId=${classIdParam}`}`,
    ),
    enabled: !!eventId || !!classIdParam,
    refetchInterval: 10_000,
  });

  useEffect(() => {
    setSession(status.data?.session ?? null);
    if (status.data?.session) setLayout(status.data.session.layout);
  }, [status.data]);

  useEffect(() => {
    const s = session;
    if (!s) return;
    const token = getToken();
    if (!token) return;
    const ws = new WebSocket(`ws${location.protocol === 'https:' ? 's' : ''}://${location.host}/api/ws/lesson/${s.id}?token=${encodeURIComponent(token)}`);
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data as string) as { type: string; session?: Session; layout?: Session['layout']; on?: boolean };
      if (msg.type === 'ended') { setSession(null); void leaveRoom(); }
      if (msg.type === 'layout' && msg.layout) setLayout(msg.layout);
      if (msg.type === 'lectureMode') setLectureMode(!!msg.on);
      if (msg.type === 'started' && msg.session) setSession(msg.session);
    };
    return () => ws.close();
  }, [session?.id]);

  useEffect(() => () => { void roomRef.current?.disconnect(); }, []);

  async function loadPreview() {
    try {
      // ask once to populate labels
      try { await navigator.mediaDevices.getUserMedia({ audio: true, video: true }); } catch { /* partial ok */ }
      const devices = await navigator.mediaDevices.enumerateDevices();
      setPreviewDevices({
        cams: devices.filter((d) => d.kind === 'videoinput'),
        mics: devices.filter((d) => d.kind === 'audioinput'),
      });
      setPreviewReady(true);
    } catch {
      setError('deviceAccessDenied');
    }
  }

  function put(key: string, el: HTMLElement, label: string) {
    const grid = gridRef.current;
    if (!grid) return;
    elsRef.current.get(key)?.remove();
    const wrap = document.createElement('div');
    wrap.dataset.key = key;
    const cap = document.createElement('div');
    cap.className = 'muted';
    cap.textContent = label;
    if (el instanceof HTMLVideoElement) { el.playsInline = true; }
    wrap.appendChild(cap);
    wrap.appendChild(el);
    grid.appendChild(wrap);
    elsRef.current.set(key, wrap);
  }

  function drop(key: string) {
    elsRef.current.get(key)?.remove();
    elsRef.current.delete(key);
  }

  function refreshPeerList(room: Room) {
    const list: PeerView[] = [];
    for (const p of room.remoteParticipants.values()) {
      const pubs = p.getTrackPublications();
      list.push({
        identity: p.identity,
        name: p.name || p.identity.slice(0, 8),
        micOn: pubs.some((t2) => t2.kind === Track.Kind.Audio && t2.track !== undefined && !t2.isMuted),
        camOn: pubs.some((t2) => t2.kind === Track.Kind.Video && t2.track !== undefined && !t2.isMuted && t2.source !== Track.Source.ScreenShare),
        screenOn: pubs.some((t2) => t2.source === Track.Source.ScreenShare && t2.track !== undefined),
      });
    }
    setPeers(list);
  }

  async function joinRoom() {
    const s = session;
    if (!s) return;
    setError('');
    try {
      const { token, wsUrl } = await api<{ token: string; wsUrl: string }>(`/api/lessons/${s.id}/join`, { method: 'POST' });
      const room = new Room({ adaptiveStream: true, dynacast: true });
      roomRef.current = room;
      room.on(RoomEvent.TrackSubscribed, (track, pub, participant) => {
        const el = track.kind === 'video' ? document.createElement('video') : document.createElement('audio');
        el.autoplay = true;
        track.attach(el);
        put(`${participant.sid}:${pub.trackSid}`, el,
          `${participant.name || participant.identity.slice(0, 8)}${pub.source === Track.Source.ScreenShare ? ' · screen' : ''}${track.kind === 'audio' ? ' · 🔊' : ''}`);
        refreshPeerList(room);
      });
      room.on(RoomEvent.TrackUnsubscribed, (_t, pub, participant) => drop(`${participant.sid}:${pub.trackSid}`));
      room.on(RoomEvent.TrackMuted, () => refreshPeerList(room));
      room.on(RoomEvent.TrackUnmuted, () => refreshPeerList(room));
      room.on(RoomEvent.LocalTrackPublished, (pub) => {
        const track = pub.track;
        if (!track) return;
        if (pub.source === Track.Source.ScreenShare) setScreenOn(true);
        const el = track.kind === 'video' ? document.createElement('video') : document.createElement('audio');
        el.autoplay = true;
        if (el instanceof HTMLVideoElement) el.muted = true;
        track.attach(el);
        put(`local:${pub.trackSid}`, el, `you${pub.source === Track.Source.ScreenShare ? ' · screen' : ''}${track.kind === 'audio' ? ' · 🔊' : ''}`);
      });
      room.on(RoomEvent.LocalTrackUnpublished, (pub) => {
        if (pub.source === Track.Source.ScreenShare) setScreenOn(false);
        drop(`local:${pub.trackSid}`);
      });
      room.on(RoomEvent.ParticipantConnected, () => refreshPeerList(room));
      room.on(RoomEvent.ParticipantDisconnected, () => refreshPeerList(room));
      room.on(RoomEvent.Disconnected, () => setConnected(false));
      await room.connect(wsUrl, token);
      await room.localParticipant.setMicrophoneEnabled(true);
      await room.localParticipant.setCameraEnabled(true);
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
    elsRef.current.clear();
    gridRef.current?.replaceChildren();
  }

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

  const gridClass = useMemo(() => `videos layout-${layout}`, [layout]);

  if (!eventId && !classIdParam) return <p className="error">{t('common.errorGeneric')}</p>;

  return (
    <div>
      <h1>{t('lesson.title')}</h1>
      {!session && (
        <div className="card">
          <p className="muted">{t('cal.notStarted')}</p>
          {isTeacher && (
            <button onClick={() => startLesson.mutate()} disabled={startLesson.isPending}>{t('lesson.start')}</button>
          )}
        </div>
      )}
      {session && (
        <>
          {!connected && (
            <div className="card">
              <div className="row">
                <button onClick={loadPreview} disabled={previewReady && !error}>{previewReady ? '🎤 ✔' : t('lesson.checkDevices')}</button>
                <div className="spacer" />
                <button onClick={joinRoom} disabled={!previewReady}>{t('cal.joinLesson')}</button>
              </div>
              {previewReady && (
                <p className="muted">
                  {t('lesson.camera')}: {previewDevices.cams.length} · {t('lesson.microphone')}: {previewDevices.mics.length}
                </p>
              )}
              {error && <p className="error">{error}</p>}
            </div>
          )}
          {connected && (
            <>
              <div className="row card">
                {isTeacher && (
                  <>
                    <button className="secondary" style={{ marginTop: 0 }} onClick={() => act.mutate({ path: `/api/lessons/${session.id}/mute`, body: { all: true, kind: 'audio' } })}>
                      {t('lesson.muteAll')}
                    </button>
                    <button className="secondary" style={{ marginTop: 0 }} onClick={() => {
                      const on = !lectureMode;
                      setLectureMode(on);
                      act.mutate({ path: `/api/lessons/${session.id}/lecture-mode`, body: { on } });
                    }}>
                      {t('lesson.lectureMode')} {lectureMode ? '✔' : ''}
                    </button>
                    <select style={{ width: 'auto', marginTop: 0 }} value={layout} onChange={(e) => {
                      const l = e.target.value as Session['layout'];
                      setLayout(l);
                      act.mutate({ path: `/api/lessons/${session.id}/layout`, body: { layout: l }, method: 'PATCH' });
                    }}>
                      <option value="gallery">{t('lesson.layoutGallery')}</option>
                      <option value="stage">{t('lesson.layoutStage')}</option>
                      <option value="teacher">{t('lesson.layoutTeacher')}</option>
                    </select>
                    {peers.map((p) => (
                      <span key={p.identity} className="badge">
                        {p.name} {p.micOn ? '🎙' : '🔇'}{p.screenOn ? ' 🖥' : ''}
                        <a href="#" onClick={(e) => {
                          e.preventDefault();
                          act.mutate({ path: `/api/lessons/${session.id}/grant-screen`, body: { identity: p.identity, allow: !p.screenOn } });
                        }}> 🖥+</a>
                        <a href="#" onClick={(e) => {
                          e.preventDefault();
                          act.mutate({ path: `/api/lessons/${session.id}/kick`, body: { identity: p.identity } });
                        }}> ✕</a>
                      </span>
                    ))}
                    <div className="spacer" />
                    <button className="secondary" style={{ marginTop: 0 }} onClick={async () => {
                      const room = roomRef.current;
                      if (!room) return;
                      const on = !screenOn;
                      try { await room.localParticipant.setScreenShareEnabled(on, { audio: true }); } catch { setError('screenShareFailed'); }
                    }}>
                      {t('lesson.shareScreen')}
                    </button>
                    <button className="danger" style={{ marginTop: 0 }} onClick={() => {
                      act.mutate({ path: `/api/lessons/${session.id}/end` });
                      void leaveRoom();
                    }}>{t('lesson.endLesson')}</button>
                  </>
                )}
                {!isTeacher && (
                  <>
                    <button className="secondary" style={{ marginTop: 0 }} onClick={async () => {
                      const room = roomRef.current; if (!room) return;
                      const pub = room.localParticipant.getTrackPublications()
                        .find((tp) => tp.source === Track.Source.Microphone);
                      const on = !(pub && pub.track && !pub.isMuted);
                      await room.localParticipant.setMicrophoneEnabled(on);
                    }}>{t('lesson.toggleMic')}</button>
                    <button className="secondary" style={{ marginTop: 0 }} onClick={() => void leaveRoom()}>{t('lesson.leave')}</button>
                    <div className="spacer" />
                    <span className="muted">{peers.length + 1} {t('lesson.inRoom')}</span>
                  </>
                )}
              </div>
              {error && <p className="error">{error}</p>}
              <div ref={gridRef} className={gridClass} />
            </>
          )}
        </>
      )}
    </div>
  );
}
