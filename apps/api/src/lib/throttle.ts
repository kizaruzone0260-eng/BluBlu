import { CODE_ATTEMPTS_PER_MIN, CODE_BLOCK_MINUTES } from '@klass/shared';

/**
 * In-memory attempt limiter for class-code entry:
 * ≤5 attempts per minute per key (IP, or IP+user), then a 15-minute block.
 * Single-instance app ⇒ process memory is sufficient for v1.
 */
const WINDOW_MS = 60_000;
const BLOCK_MS = CODE_BLOCK_MINUTES * 60_000;

interface Entry {
  attempts: number;
  windowStart: number;
  blockedUntil: number;
}

const store = new Map<string, Entry>();

export function throttleCheck(key: string, now = Date.now()): { allowed: boolean; retryAfterSec: number } {
  const e = store.get(key);
  if (!e) return { allowed: true, retryAfterSec: 0 };
  if (e.blockedUntil > now) {
    return { allowed: false, retryAfterSec: Math.ceil((e.blockedUntil - now) / 1000) };
  }
  return { allowed: true, retryAfterSec: 0 };
}

export function throttleRecordAttempt(key: string, now = Date.now()): void {
  let e = store.get(key);
  if (!e || e.blockedUntil <= now && now - e.windowStart > WINDOW_MS) {
    e = { attempts: 1, windowStart: now, blockedUntil: 0 };
    store.set(key, e);
    return;
  }
  if (now - e.windowStart > WINDOW_MS) {
    e.windowStart = now;
    e.attempts = 1;
  } else {
    e.attempts += 1;
  }
  if (e.attempts >= CODE_ATTEMPTS_PER_MIN) {
    e.blockedUntil = now + BLOCK_MS;
    e.attempts = 0;
    e.windowStart = now;
  }
}

export function throttleReset(key: string): void {
  store.delete(key);
}

/** Periodic sweep so the map cannot grow unbounded. */
export function throttleSweep(now = Date.now()): void {
  for (const [k, e] of store) {
    if (e.blockedUntil < now && now - e.windowStart > BLOCK_MS) store.delete(k);
  }
}
setInterval(throttleSweep, 10 * 60_000).unref?.();
