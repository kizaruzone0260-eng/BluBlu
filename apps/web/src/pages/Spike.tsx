import { useEffect, useRef, useState } from 'react';
import { Room, RoomEvent, type LocalTrackPublication, type RemoteTrack, type RemoteTrackPublication } from 'livekit-client';
import { api } from '../lib/api';

/**
 * Stage-0 spike: teacher ↔ student call across two networks.
 * Server issues the LiveKit JWT (POST /api/rtc/token); media flows directly
 * between client and the self-hosted LiveKit SFU (proxied via Caddy /rtc).
 */
interface Peer { identity: string; name: string }

export default function Spike() {
  const [roomName, setRoomName] = useState('spike-test');
  const [connected, setConnected] = useState(false);
  const [peers, setPeers] = useState<Peer[]>([]);
  const [error, setError] = useState('');
  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(true);
  const [screenOn, setScreenOn] = useState(false);
  const roomRef = useRef<Room | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const elsRef = useRef<Map<string, HTMLElement>>(new Map());

  useEffect(() => {
    return () => { void roomRef.current?.disconnect(); };
  }, []);

  function putMedia(key: string, el: HTMLMediaElement, label: string, isLocal: boolean) {
    const grid = gridRef.current;
    if (!grid) return;
    removeMedia(key);
    const wrapper = document.createElement('div');
    wrapper.dataset.key = key;
    if (el instanceof HTMLVideoElement) { el.playsInline = true; el.muted = isLocal; }
    el.autoplay = true;
    const cap = document.createElement('div');
    cap.className = 'muted';
    cap.textContent = label;
    wrapper.appendChild(cap);
    wrapper.appendChild(el);
    grid.appendChild(wrapper);
    elsRef.current.set(key, wrapper);
  }

  function removeMedia(key: string) {
    const old = elsRef.current.get(key);
    if (old) { old.remove(); elsRef.current.delete(key); }
  }

  function clearGrid() {
    gridRef.current?.replaceChildren();
    elsRef.current.clear();
  }

  async function join() {
    setError('');
    try {
      const { token, wsUrl } = await api<{ token: string; wsUrl: string; room: string }>('/api/rtc/token', {
        method: 'POST', body: JSON.stringify({ room: roomName }),
      });
      const room = new Room({ adaptiveStream: true, dynacast: true });
      roomRef.current = room;

      room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack, pub: RemoteTrackPublication, participant) => {
        const target = track.kind === 'video' ? document.createElement('video') : document.createElement('audio');
        target.autoplay = true;
        track.attach(target);
        putMedia(`${participant.sid}:${pub.trackSid}`, target,
          `${participant.name || participant.identity.slice(0, 8)}${pub.source === 'screen_share' ? ' · screen' : ''}${track.kind === 'audio' ? ' · 🔊' : ''}`, false);
      });
      room.on(RoomEvent.TrackUnsubscribed, (_track, pub, participant) => {
        removeMedia(`${participant.sid}:${pub.trackSid}`);
      });
      room.on(RoomEvent.LocalTrackPublished, (pub: LocalTrackPublication) => {
        const track = pub.track;
        if (!track) return;
        if (pub.source === 'screen_share') setScreenOn(true);
        const target = track.kind === 'video' ? document.createElement('video') : document.createElement('audio');
        target.autoplay = true;
        track.attach(target);
        putMedia(`local:${pub.trackSid}`, target, `you${pub.source === 'screen_share' ? ' · screen' : ''}${track.kind === 'audio' ? ' · 🔊' : ''}`, true);
      });
      room.on(RoomEvent.LocalTrackUnpublished, (pub: LocalTrackPublication) => {
        if (pub.source === 'screen_share') setScreenOn(false);
        removeMedia(`local:${pub.trackSid}`);
      });
      room.on(RoomEvent.ParticipantConnected, (p) => {
        setPeers((prev) => [...prev.filter((x) => x.identity !== p.identity), { identity: p.identity, name: p.name ?? '' }]);
      });
      room.on(RoomEvent.ParticipantDisconnected, (p) => setPeers((prev) => prev.filter((x) => x.identity !== p.identity)));
      room.on(RoomEvent.Disconnected, () => setConnected(false));

      await room.connect(wsUrl, token);
      await room.localParticipant.setMicrophoneEnabled(micOn);
      await room.localParticipant.setCameraEnabled(camOn);
      setConnected(true);
    } catch (e: unknown) {
      setError((e as { message?: string }).message ?? 'errorGeneric');
    }
  }

  async function leave() {
    await roomRef.current?.disconnect();
    roomRef.current = null;
    setConnected(false);
    setPeers([]);
    setScreenOn(false);
    clearGrid();
  }

  async function toggleMic() {
    const room = roomRef.current; if (!room) return;
    const on = !micOn; setMicOn(on);
    await room.localParticipant.setMicrophoneEnabled(on);
  }

  async function toggleCam() {
    const room = roomRef.current; if (!room) return;
    const on = !camOn; setCamOn(on);
    await room.localParticipant.setCameraEnabled(on);
  }

  async function shareScreen() {
    const room = roomRef.current; if (!room) return;
    try {
      await room.localParticipant.setScreenShareEnabled(!screenOn, { audio: true });
    } catch (e: unknown) {
      setError(`screenShare: ${(e as { message?: string }).message ?? ''}`);
    }
  }

  return (
    <div>
      <h1>Stage 0 — spike call</h1>
      <div className="card">
        {!connected ? (
          <div className="row">
            <input value={roomName} onChange={(e) => setRoomName(e.target.value)}
              style={{ flex: 1, fontFamily: 'ui-monospace, monospace' }} />
            <button style={{ marginTop: 0 }} onClick={join} disabled={!/^spike-[a-z0-9-]+$/i.test(roomName)}>Join</button>
          </div>
        ) : (
          <div className="row">
            <button className="secondary" style={{ marginTop: 0 }} onClick={toggleMic}>{micOn ? 'Mic on' : 'Mic off'}</button>
            <button className="secondary" style={{ marginTop: 0 }} onClick={toggleCam}>{camOn ? 'Cam on' : 'Cam off'}</button>
            <button className="secondary" style={{ marginTop: 0 }} onClick={shareScreen}>{screenOn ? 'Stop screen' : 'Screen'}</button>
            <div className="spacer" />
            <span className="muted">peers: {peers.length}</span>
            <button className="danger" style={{ marginTop: 0 }} onClick={leave}>Leave</button>
          </div>
        )}
        {error && <p className="error">{error}</p>}
        <p className="muted">
          Room name must match <code>spike-*</code>. Open this page on two devices in different
          networks (login with a teacher and a student account). Screen audio: Windows Chrome/Edge only.
        </p>
      </div>
      <div ref={gridRef} className="videos" />
    </div>
  );
}
