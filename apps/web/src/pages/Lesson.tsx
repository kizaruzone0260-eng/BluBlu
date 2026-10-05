import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Room, RoomEvent, Track, type Track as LkTrack } from 'livekit-client';
import { api, getToken, wsTicket } from '../lib/api';
import { useAuth } from '../App';
import Board from '../components/Board';
import NotesDrawer from '../components/NotesDrawer';
import { cameraAttempts, microphoneAttempts, isRetryableMediaError, mediaErrorKey } from '@klass/shared';

interface Session {
  id: string; classId: string; eventId: string | null; roomName: string;
  startedAt: string; endedAt: string | null; lectureMode: boolean; muteAll: boolean;
  layout: 'gallery' | 'stage' | 'teacher'; wsUrl: string;
}

interface PeerView {
  identity: string; name: string; micOn: boolean; camOn: boolean; screenOn: boolean;
}

interface Tile {
  key: string; kind: 'video' | 'audio'; name: string; local: boolean; screen: boolean;
}

const LS_CAM = 'blublu.camDevice';
const LS_MIC = 'blublu.micDevice';

// livekit-client keeps its capture-option types internal — derive them from the
// method signatures so the constraint chain below type-checks without casts to any
type CamOpts = NonNullable<Parameters<Room['localParticipant']['setCameraEnabled']>[1]>;
type MicOpts = NonNullable<Parameters<Room['localParticipant']['setMicrophoneEnabled']>[1]>;

/** LiveKit/RTCException name → localized sentence with the browser's reason appended. */
function useMediaErrorText() {
  const { t } = useTranslation();
  return (key: string, e: unknown) => {
    const base = t(`lesson.${key}`, { defaultValue: t('common.errorGeneric') });
    const detail = (e as { message?: string })?.message ?? '';
    return key.endsWith('Unavailable') && detail ? `${base}: ${detail}` : base;
  };
}

function VideoTile({ tile, track }: { tile: Tile; track?: LkTrack }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    const el = tile.kind === 'video' ? videoRef.current : audioRef.current;
    if (!el || !track) return;
    track.attach(el);
    return () => { track.detach(el); };
  }, [track, tile.key, tile.kind]);
  return (
    <div className="video-tile" data-testid={tile.local ? 'tile-local' : 'tile-peer'}
      data-local={tile.local ? '1' : '0'} data-screen={tile.screen ? '1' : undefined}
      // remote audio must NOT take a grid slot — it plays silently in the background
      style={tile.kind === 'audio' ? { display: 'none' } : undefined}>
      <div className="muted">{tile.name}{tile.screen ? ' · screen' : ''}</div>
      {tile.kind === 'video'
        ? <video ref={videoRef} autoPlay playsInline muted={tile.local} />
        : <audio ref={audioRef} autoPlay />}
    </div>
  );
}

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
  const [layout, setLayout] = useState<'gallery' | 'stage' | 'teacher'>('gallery');
  const [lectureMode, setLectureMode] = useState(false);
  const [screenOn, setScreenOn] = useState(false);
  const [localCamOn, setLocalCamOn] = useState(false);
  const [localMicOn, setLocalMicOn] = useState(false);
  const [muteAll, setMuteAll] = useState(false); // task 3: teacher muted everyone
  const [toast, setToast] = useState('');
  const toastTimer = useRef<number | undefined>(undefined);
  const [camErr, setCamErr] = useState('');
  const [micErr, setMicErr] = useState('');
  const [sheetsOpen, setSheetsOpen] = useState(false);
  const roomRef = useRef<Room | null>(null);

  // ── tiles are React state, NOT imperative DOM: publish/subscribe events can
  // fire BEFORE `connected` renders the grid — with DOM insertion they were
  // silently dropped (the root cause of «камера нигде не показывается»).
  const [tiles, setTiles] = useState<Tile[]>([]);
  const tracksRef = useRef<Map<string, LkTrack>>(new Map());

  // ── preview (pre-join) + device selection ──────────────────────────────────
  const [previewChecked, setPreviewChecked] = useState(false);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewStream, setPreviewStream] = useState<MediaStream | null>(null);
  const previewVideoRef = useRef<HTMLVideoElement>(null);
  const [cams, setCams] = useState<MediaDeviceInfo[]>([]);
  const [mics, setMics] = useState<MediaDeviceInfo[]>([]);
  const [savedCam, setSavedCam] = useState<string>(() => localStorage.getItem(LS_CAM) ?? '');
  const [savedMic, setSavedMic] = useState<string>(() => localStorage.getItem(LS_MIC) ?? '');

  const isTeacher = me?.role === 'teacher';

  useEffect(() => {
    const el = previewVideoRef.current;
    if (el) el.srcObject = previewStream;
  }, [previewStream]);

  async function refreshDevices() {
    try {
      const list = await navigator.mediaDevices.enumerateDevices();
      setCams(list.filter((d) => d.kind === 'videoinput'));
      setMics(list.filter((d) => d.kind === 'audioinput'));
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
    refetchInterval: 10_000,
  });

  useEffect(() => {
    setSession(status.data?.session ?? null);
    if (status.data?.session) {
      setLayout(status.data.session.layout);
      setMuteAll(status.data.session.muteAll); // restored on reload/reconnect
    }
  }, [status.data]);

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
          const msg = JSON.parse(ev.data as string) as { type: string; session?: Session; layout?: Session['layout']; on?: boolean };
          if (msg.type === 'ended') { setSession(null); void leaveRoom(); }
          if (msg.type === 'layout' && msg.layout) setLayout(msg.layout);
          if (msg.type === 'lectureMode') setLectureMode(!!msg.on);
          if (msg.type === 'muteAll') { setMuteAll(!!msg.on); applyMuteAll(!!msg.on); }
          if (msg.type === 'started' && msg.session) { setSession(msg.session); setMuteAll(msg.session.muteAll); }
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
  }, [session?.id]);

  useEffect(() => () => { void roomRef.current?.disconnect(); }, []);

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

  async function loadPreview() {
    setPreviewBusy(true);
    setError('');
    setCamErr('');
    setMicErr('');
    let micOk = false;
    // microphone: saved device → default (permission prompt lands here first)
    for (const c of microphoneAttempts(savedMic)) {
      try {
        const st = await navigator.mediaDevices.getUserMedia({ audio: c === true ? true : c });
        st.getTracks().forEach((tr) => tr.stop());
        micOk = true;
        break;
      } catch (e: unknown) {
        setMicErr(mediaErrorText(mediaErrorKey(e, 'microphone'), e));
        if (!isRetryableMediaError((e as { name?: string })?.name)) break;
      }
    }
    // camera with a LIVE self-view (the button state below is the real stream state)
    const cam = await gumCamera(savedCam);
    if (cam.stream) setPreviewStream(cam.stream);
    else setCamErr(mediaErrorText(cam.errKey, cam.err));
    await refreshDevices();
    setPreviewChecked(true);
    setPreviewBusy(false);
  }

  function stopPreview() {
    previewStream?.getTracks().forEach((tr) => tr.stop());
    setPreviewStream(null);
  }

  async function togglePreviewCam() {
    if (previewStream) { stopPreview(); setCamErr(''); return; }
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

  function showToast(msg: string) {
    setToast(msg);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(''), 3_500);
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
    stopPreview(); // release the preview stream so LiveKit can own the devices
    try {
      const { token, wsUrl } = await api<{ token: string; wsUrl: string }>(`/api/lessons/${s.id}/join`, { method: 'POST' });
      const room = new Room({ adaptiveStream: true, dynacast: true });
      roomRef.current = room;
      room.on(RoomEvent.TrackSubscribed, (track, pub, participant) => {
        addTile(
          { key: `${participant.sid}:${pub.trackSid}`, kind: track.kind === 'video' ? 'video' : 'audio', name: peerName(participant.identity, participant.name), local: false, screen: pub.source === Track.Source.ScreenShare },
          track,
        );
        refreshPeerList(room);
      });
      room.on(RoomEvent.TrackUnsubscribed, (_t, pub, participant) => removeTile(`${participant.sid}:${pub.trackSid}`));
      room.on(RoomEvent.TrackMuted, () => { refreshPeerList(room); refreshLocal(room); });
      room.on(RoomEvent.TrackUnmuted, () => { refreshPeerList(room); refreshLocal(room); });
      room.on(RoomEvent.LocalTrackPublished, (pub) => {
        const track = pub.track;
        refreshLocal(room);
        if (!track) return;
        // local AUDIO is never attached — the speaker already hears themselves via
        // the physical microphone; re-playing it is the echo users reported.
        if (track.kind === 'audio') return;
        addTile(
          { key: `local:${pub.trackSid}`, kind: 'video', name: `${t('lesson.you')}${pub.source === Track.Source.ScreenShare ? ' · screen' : ''}`, local: true, screen: pub.source === Track.Source.ScreenShare },
          track,
        );
      });
      room.on(RoomEvent.LocalTrackUnpublished, (pub) => {
        if (pub.track?.kind === 'video') removeTile(`local:${pub.trackSid}`);
        refreshLocal(room);
      });
      room.on(RoomEvent.ParticipantConnected, () => refreshPeerList(room));
      room.on(RoomEvent.ParticipantDisconnected, () => refreshPeerList(room));
      room.on(RoomEvent.Disconnected, () => setConnected(false));
      await room.connect(wsUrl, token);
      // mic first (camera failures must not swallow the mic), then camera — each
      // with its own soft→minimal constraint chain and a visible error, never silent.
      // Task 3: a student joining while lecture mode or «mute everyone» is ON
      // starts muted — the banner explains why, the state came with the session.
      const micBlocked = !isTeacher && (lectureMode || s.lectureMode || muteAll || s.muteAll);
      let micKey = '';
      let micE: unknown;
      if (!micBlocked) {
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
      const cam = await enableCameraIn(room);
      setCamErr(cam.errKey ? mediaErrorText(cam.errKey, cam.err) : '');
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
  }

  async function toggleCameraInRoom() {
    const room = roomRef.current;
    if (!room) return;
    if (localCamOn) {
      await room.localParticipant.setCameraEnabled(false).catch(() => undefined);
      setCamErr('');
    } else {
      const cam = await enableCameraIn(room);
      setCamErr(cam.errKey ? mediaErrorText(cam.errKey, cam.err) : '');
    }
    refreshLocal(room);
  }

  async function toggleMicInRoom() {
    const room = roomRef.current;
    if (!room) return;
    // task 3: while the teacher muted everyone (or lecture mode is on) a student
    // can mute themselves but NOT talk over the class — the banners say why
    if (!localMicOn && !isTeacher && (muteAll || lectureMode)) return;
    if (localMicOn) await room.localParticipant.setMicrophoneEnabled(false).catch(() => undefined);
    else {
      try {
        await room.localParticipant.setMicrophoneEnabled(true, savedMic ? ({ deviceId: { exact: savedMic } } as MicOpts) : undefined);
        setMicErr('');
      } catch (e: unknown) {
        try {
          await room.localParticipant.setMicrophoneEnabled(true);
          setMicErr('');
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
    }
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

  const devicePickers = (
    <div className="row" style={{ gap: 8 }}>
      <label htmlFor="cam-select" className="muted">{t('lesson.toggleCamera')}</label>
      <select id="cam-select" data-testid="cam-select" style={{ width: 'auto', marginTop: 0 }} value={savedCam}
        onChange={(e) => void pickCamera(e.target.value)}>
        <option value="">{t('lesson.deviceDefault')}</option>
        {cams.map((d, i) => <option key={d.deviceId || i} value={d.deviceId}>{d.label || `${t('lesson.camera')} ${i + 1}`}</option>)}
      </select>
      <label htmlFor="mic-select" className="muted">{t('lesson.toggleMic')}</label>
      <select id="mic-select" data-testid="mic-select" style={{ width: 'auto', marginTop: 0 }} value={savedMic}
        onChange={(e) => void pickMicrophone(e.target.value)}>
        <option value="">{t('lesson.deviceDefault')}</option>
        {mics.map((d, i) => <option key={d.deviceId || i} value={d.deviceId}>{d.label || `${t('lesson.microphone')} ${i + 1}`}</option>)}
      </select>
    </div>
  );

  const mediaErrors = (
    <>
      {camErr && <p className="error" data-testid="cam-error">{camErr}</p>}
      {micErr && <p className="error" data-testid="mic-error">{micErr}</p>}
    </>
  );

  if (!eventId && !classIdParam) return <p className="error">{t('common.errorGeneric')}</p>;

  return (
    <div>
      <h1>{t('lesson.title')}</h1>
      {/* D.3 — quick note with lesson binding */}
      <div className="row" style={{ marginTop: -6, marginBottom: 10 }}>
        {isTeacher ? (
          <Link data-testid="lesson-new-note" to={`/notes?new=1&classId=${session?.classId ?? classIdParam}&eventId=${eventId ?? session?.eventId ?? ''}`}>
            <button className="ghost" style={{ marginTop: 0 }}>📝 {t('home.newNote')}</button>
          </Link>
        ) : (
          <Link data-testid="lesson-new-note" to="/sheets?new=1">
            <button className="ghost" style={{ marginTop: 0 }}>📝 {t('home.newNote')}</button>
          </Link>
        )}
      </div>
      {!session && (
        <div className="card">
          <p className="muted">{t('cal.notStarted')}</p>
          {isTeacher && (
            <button data-testid="start-lesson" onClick={() => startLesson.mutate()} disabled={startLesson.isPending}>{t('lesson.start')}</button>
          )}
        </div>
      )}
      {session && (
        <>
          {!connected && (
            <div className="card">
              <div className="row">
                <button data-testid="check-devices" onClick={loadPreview} disabled={previewBusy}>{t('lesson.checkDevices')}</button>
                <div className="spacer" />
                <button data-testid="join-lesson" onClick={joinRoom} disabled={!previewChecked}>{t('cal.joinLesson')}</button>
              </div>
              {previewChecked && (
                <>
                  <div className="row" style={{ gap: 8, alignItems: 'center' }}>
                    {/* the button says what the camera ACTUALLY does right now */}
                    <button className="ghost" style={{ marginTop: 0 }} data-testid="preview-cam-toggle" onClick={() => void togglePreviewCam()}>
                      {previewStream ? `📹 ${t('lesson.camDisable')}` : `📹 ${t('lesson.camEnable')}`}
                    </button>
                    <span className="muted">{micErr ? `🎤 ✕` : `🎤 ✔`}</span>
                  </div>
                  <video ref={previewVideoRef} data-testid="preview-video" className="preview-video" autoPlay playsInline muted />
                  {devicePickers}
                </>
              )}
              {error && <p className="error">{error}</p>}
              {mediaErrors}
            </div>
          )}
          {connected && (
            <>
              <div className="row card">
                <button className="secondary" style={{ marginTop: 0 }} data-testid="mic-toggle" onClick={() => void toggleMicInRoom()}>
                  {t('lesson.toggleMic')} {localMicOn ? '🎙' : '🔇'}
                </button>
                <button className="secondary" style={{ marginTop: 0 }} data-testid="camera-toggle" onClick={() => void toggleCameraInRoom()}>
                  {t('lesson.toggleCamera')} {localCamOn ? '📹' : '🚫'}
                </button>
                {devicePickers}
                {isTeacher && (
                  <>
                    <button
                      className={`secondary${muteAll ? ' chip-active' : ''}`}
                      style={{ marginTop: 0 }}
                      data-testid="mute-all"
                      onClick={() => void toggleMuteAll()}
                      disabled={peers.length === 0}
                      title={peers.length === 0 ? t('lesson.noStudentsYet') : undefined}
                    >
                      {muteAll ? t('lesson.unmuteAll') : t('lesson.muteAll')}
                    </button>
                    <button
                      className={`secondary${lectureMode ? ' chip-active' : ''}`}
                      style={{ marginTop: 0 }}
                      data-testid="lecture-mode"
                      onClick={() => {
                        const on = !lectureMode;
                        setLectureMode(on);
                        act.mutate({ path: `/api/lessons/${session.id}/lecture-mode`, body: { on } });
                      }}
                    >
                      {lectureMode ? t('lesson.lectureOn') : t('lesson.lectureMode')}
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
                    {/* participant list (task 3): mic/cam state + per-student actions */}
                    <details className="peers" data-testid="peers-panel">
                      <summary>{t('lesson.peersTitle')} · {peers.length}</summary>
                      {peers.length === 0 && <p className="muted">{t('lesson.noStudentsYet')}</p>}
                      {peers.map((p) => (
                        <div key={p.identity} className="peer-row" data-testid={`peer-${p.identity.slice(0, 8)}`}>
                          <span className="peer-name">{p.name}</span>
                          <span title={t('lesson.toggleMic')}>{p.micOn ? '🎙' : '🔇'}</span>
                          <span title={t('lesson.toggleCamera')}>{p.camOn ? '📹' : '·'}</span>
                          {p.screenOn && <span>🖥</span>}
                          <button className="ghost" style={{ marginTop: 0, padding: '2px 6px' }} title={t('lesson.muteOne')}
                            onClick={() => void muteOne(p.identity)}>🔇
                          </button>
                          <button className="ghost" style={{ marginTop: 0, padding: '2px 6px' }} title={t('lesson.shareScreen')}
                            onClick={() => act.mutate({ path: `/api/lessons/${session.id}/grant-screen`, body: { identity: p.identity, allow: !p.screenOn } })}>🖥+
                          </button>
                          <button className="ghost" style={{ marginTop: 0, padding: '2px 6px' }} title={t('lesson.leave')}
                            onClick={() => act.mutate({ path: `/api/lessons/${session.id}/kick`, body: { identity: p.identity } })}>✕
                          </button>
                        </div>
                      ))}
                    </details>
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
                    <button className="secondary" style={{ marginTop: 0 }} onClick={() => void leaveRoom()}>{t('lesson.leave')}</button>
                    <div className="spacer" />
                    <span className="muted">{peers.length + 1} {t('lesson.inRoom')}</span>
                  </>
                )}
              </div>
              {error && <p className="error">{error}</p>}
              {mediaErrors}
              {/* student banners (task 3): why the mic is off — restored on reconnect */}
              {!isTeacher && muteAll && <p className="banner" data-testid="banner-muted">{t('lesson.bannerMuted')}</p>}
              {!isTeacher && lectureMode && !muteAll && <p className="banner" data-testid="banner-lecture">{t('lesson.bannerLecture')}</p>}
              <div className={gridClass} data-testid="video-grid">
                {tiles.map((tile) => (
                  <VideoTile key={tile.key} tile={tile} track={tracksRef.current.get(tile.key)} />
                ))}
              </div>
              {peers.length === 0 && <p className="muted" data-testid="waiting-peers">{t('lesson.waitingPeers')}</p>}
              {toast && <div className="toast" role="status" data-testid="lesson-toast">{toast}</div>}
            </>
          )}
          {/* board is WS-based: visible while a session exists, even before/without RTC */}
          {session && <Board sessionId={session.id} height={layout === 'stage' ? '40vh' : '60vh'} />}
          {!isTeacher && session && (
            <NotesDrawer classId={session.classId} sessionId={session.id} open={sheetsOpen} onToggle={() => setSheetsOpen((v) => !v)} />
          )}
        </>
      )}
    </div>
  );
}
