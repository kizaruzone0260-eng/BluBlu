import type { FastifyRequest } from 'fastify';
import { env } from '../env.js';

/**
 * Hardening (Phase 1е): origin check for WebSocket upgrades.
 *
 * Our sockets already authenticate with a one-time, 30 s, (user+session)-bound
 * ticket, so a cross-site page cannot ride an existing session. This is the
 * second, cheaper gate at handshake time: when the browser sends an `Origin`
 * it must match the deployment's own origin. Same rule as the refresh CSRF
 * check — exact match against PUBLIC_URL/DOMAIN when we know them, otherwise
 * (local dev/e2e on an ephemeral host) a same-Host origin is accepted. A
 * missing Origin (non-browser client, e.g. our e2e ticket tests via inject)
 * is allowed here because the ticket is still the real gate.
 */
export function wsOriginAllowed(req: FastifyRequest): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  const allowed = new Set<string>([
    env.PUBLIC_WEB_ORIGIN, 'http://localhost:5173',
    ...(env.PUBLIC_URL ? [env.PUBLIC_URL] : []),
    ...(env.DOMAIN ? [`https://${env.DOMAIN}`] : []),
  ]);
  if (allowed.has(origin)) return true;
  if (!env.PUBLIC_URL && !env.DOMAIN) {
    try { return new URL(origin).host === (req.headers.host ?? ''); } catch { return false; }
  }
  return false;
}
