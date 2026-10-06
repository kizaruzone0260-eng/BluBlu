import type { FastifyRequest } from 'fastify';
import { requestOriginAllowed } from './origin.js';

/**
 * Hardening (Phase 1е) + production regression fix: origin check for WebSocket
 * upgrades (lesson, chat, board).
 *
 * Our sockets already authenticate with a one-time, 30 s, (user+session)-bound
 * ticket, so a cross-site page cannot ride an existing session. This is the second,
 * cheaper gate at handshake time, and it now shares ONE implementation with the
 * refresh CSRF check (lib/origin.ts): the configured deployment origins pass, and so
 * does an Origin equal to the host the request arrived on. The gate used to require
 * an exact match against PUBLIC_URL/DOMAIN whenever those were set — on Render that
 * silently refused the lesson socket (and /api/auth/refresh) from the page's own
 * origin whenever the configured address differed from the served address, which is
 * what bounced users out of Video Lesson. A missing Origin (non-browser client, e.g.
 * our e2e ticket tests via inject) is still allowed here because the ticket is the
 * real gate.
 */
export function wsOriginAllowed(req: FastifyRequest): boolean {
  return requestOriginAllowed(req);
}
