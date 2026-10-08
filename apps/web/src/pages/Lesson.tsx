import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Room, RoomEvent, Track, type Track as LkTrack } from 'livekit-client';
import { api, getToken, wsTicket } from '../lib/api';
import { useAuth } from '../App';
import Board from '../components/Board';
import NotesDrawer from '../components/NotesDrawer';
import { cameraAttempts, microphoneAttempts, isRetryableMediaError, mediaErrorKey, pickStageContent, stageSwitchVisible, stripKeys } from '@klass/shared';
import ScreenStage from '../components/ScreenStage';

interface Session {
  id: string; classId: string; eventId: string | null; roomName: string;
  startedAt: string; endedAt: string | null; lectureMode: boolean; muteAll: boolean;
  layout: 'auto' | 'gallery' | 'stage' | 'teacher'; boardOpen: boolean; wsUrl: string;
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
const LS_PIP = 'blublu.pip'; // task B: remembered floating-camera position + flags

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

/** LiveKit/RTCException name → localized sentence with the browser's reason appended. */
function useMediaErrorText() {
  const { t } = useTranslation();
  return (key: string, e: unknown) => {
    const base = t(`lesson.${key}`, { defaultValue: t('common.errorGeneric') });
    const detail = (e as { message?: string })?.message ?? '';
    return key.endsWith('Unavailable') && detail ? `${base}: ${detail}` : base;
  };
}

function VideoTile({ tile, track, big = false, hideName = false }: {
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
  const [camErr, setCamErr] = useState('');
  const [micErr, setMicErr] = useState('');
  const [sheetsOpen, setSheetsOpen] = useState(false);
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
      setBoardOpen(status.data.session.boardOpen); // task B: the board survives a reload
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
          if (msg.type === 'board') setBoardOpen(!!msg.on); // task B: teacher opened/closed the board for all
          if (msg.type === 'lectureMode') setLectureMode(!!msg.on);
          if (msg.type === 'muteAll') { setMuteAll(!!msg.on); applyMuteAll(!!msg.on); }
          if (msg.type === 'started' && msg.session) { setSession(msg.session); setMuteAll(msg.session.muteAll); setBoardOpen(msg.session.boardOpen); }
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
          { key: `${participant.sid}:${pub.trackSid}`, kind: track.kind === 'video' ? 'video' : 'audio', name: peerName(participant.identity, participant.name), local: false, screen: pub.source === Track.Source.ScreenShare, sid: participant.sid },
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
        // what kind of surface the presenter actually picked (Chromium and Firefox report it;
        // Safari does not, and then the warning simply never appears — which is honest)
        if (pub.source === Track.Source.ScreenShare) {
          const s = (track.mediaStreamTrack?.getSettings?.() ?? {}) as { displaySurface?: string };
          const surface = s.displaySurface === 'browser' || s.displaySurface === 'window' || s.displaySurface === 'monitor'
            ? s.displaySurface : '';
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
        const top = speakers.find((s) => s.sid !== room.localParticipant.sid);
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
    setPip((p) => ({ ...p, x: Math.min(maxX, Math.max(8, nx)), y: Math.min(maxY, Math.max(8, ny)) }));
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
                    <select style={{ width: 'auto', marginTop: 0 }} data-testid="layout-select" value={layout} onChange={(e) => {
                      const l = e.target.value as Session['layout'];
                      setLayout(l);
                      act.mutate({ path: `/api/lessons/${session.id}/layout`, body: { layout: l }, method: 'PATCH' });
                    }}>
                      <option value="auto">{t('lesson.layoutAuto')}</option>
                      <option value="teacher">{t('lesson.layoutSpotlight')}</option>
                      <option value="stage">{t('lesson.layoutSidebar')}</option>
                      <option value="gallery">{t('lesson.layoutGrid')}</option>
                    </select>
                    <button
                      className={`secondary${boardOpen ? ' chip-active' : ''}`}
                      style={{ marginTop: 0 }}
                      data-testid="board-toggle"
                      aria-pressed={boardOpen}
                      onClick={toggleBoard}
                    >
                      {boardOpen ? t('lesson.boardClose') : t('lesson.boardOpen')}
                    </button>
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
                    <button className={`secondary${screenOn ? ' chip-active' : ''}`} style={{ marginTop: 0 }}
                      data-testid="share-toggle" aria-pressed={screenOn} onClick={() => void toggleShare()}>
                      {screenOn ? t('lesson.shareStop') : t('lesson.shareScreen')}
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
                    {/* «Экран | Доска»: inside the stage's own caption band while the screen is up
                        (an absolutely positioned pill over the picture covered its title bar —
                        seen in the 2026-10-08 screenshot review), a normal row above the board. */}
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
                        <Board sessionId={session.id} classId={session.classId} height={boardFull ? 'calc(100vh - 64px)' : '62vh'} />
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
                    {/* task 1.3: the presenter's own share — proof of what leaves the machine, in a
                        corner of the main window that no other control uses, above the tool band */}
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
                  {/* own camera: floating, draggable via the bar, snaps to corners,
                        minimize/hide, position remembered (localStorage) */}
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
                  {/* the presenter's own share moved INSIDE .stage-main (see above): anchored to the
                      stage it belongs to, where it cannot cover the strip or the tool band */}
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
              {toast && <div className="toast" role="status" data-testid="lesson-toast">{toast}</div>}
            </>
          )}
          {/* board is WS-based: while a session exists it is reachable even before
               RTC — as the stage when open, as a card under the grid otherwise */}
          {session && !(connected && boardOpen) && <Board sessionId={session.id} classId={session.classId} height={layout === 'stage' ? '40vh' : '60vh'} />}
          {!isTeacher && session && (
            <NotesDrawer classId={session.classId} sessionId={session.id} open={sheetsOpen} onToggle={() => setSheetsOpen((v) => !v)} />
          )}
        </>
      )}
    </div>
  );
}
