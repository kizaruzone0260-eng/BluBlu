import type { WebSocket } from 'ws';
import { attachErrorLogging } from './errorObservers.js';

/**
 * Minimal WS hub shared by lesson status (§3.6) and whiteboard (§3.7):
 * one room per lesson session. The board service adds its own per-connection
 * handlers on top of this registry.
 */
const rooms = new Map<string, Set<WebSocket>>();

export function wsJoin(sessionId: string, socket: WebSocket): void {
  let set = rooms.get(sessionId);
  if (!set) {
    set = new Set();
    rooms.set(sessionId, set);
  }
  set.add(socket);
  // an 'error' with no listener is thrown by Node as an uncaughtException — which would take the
  // whole API down in the middle of a lesson; this logs class+code and lets `close` follow.
  attachErrorLogging(socket, 'lesson socket');
  socket.on('close', () => {
    set!.delete(socket);
    if (set!.size === 0) rooms.delete(sessionId);
  });
}

export function wsLeave(sessionId: string, socket: WebSocket): void {
  rooms.get(sessionId)?.delete(socket);
}

export function wsBroadcast(sessionId: string, message: unknown, except?: WebSocket): number {
  const set = rooms.get(sessionId);
  if (!set) return 0;
  const data = JSON.stringify(message);
  let n = 0;
  for (const s of set) {
    if (s === except || s.readyState !== 1 /* OPEN */) continue;
    try { s.send(data); n++; } catch { /* ignore */ }
  }
  return n;
}

export function wsRoomSize(sessionId: string): number {
  return rooms.get(sessionId)?.size ?? 0;
}
