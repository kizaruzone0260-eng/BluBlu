import { errorLine } from './redact.js';

/**
 * The listeners that turn somebody else's EventEmitter into a line we are allowed to print.
 *
 * Two reasons these exist as their own module: `pg-boss` and `ws` both extend EventEmitter, and an
 * `'error'` event with no listener is thrown by Node as an `uncaughtException` — which after the
 * crash guards means the whole API exits in the middle of a lesson. And grammY wraps whatever the
 * middleware threw in a `BotError`, so the interesting object is one level down.
 */

interface ErrorSubscribable {
  on: (event: 'error', listener: (err: unknown) => void) => unknown;
}

/** Logs `channel: Class (code)` and nothing more — see lib/redact.ts for why. */
export function attachErrorLogging(
  target: ErrorSubscribable, channel: string,
  log: (line: string) => void = (line) => { console.error(line); },
): void {
  target.on('error', (err: unknown) => log(errorLine(channel, err)));
}

/**
 * The line for a middleware failure. grammY wraps it in a `BotError` whose `.error` is the real
 * one (and whose `.ctx` holds the whole update, which is why we never print the wrapper's fields),
 * so only `BotError` is unwrapped — unwrapping `HttpError` too would throw away the class name
 * that says "the network call failed" as opposed to "Telegram answered 4xx".
 */
export function botErrorLine(err: unknown): string {
  const e = err as { name?: string; error?: unknown } | null;
  return errorLine('telegram bot', e?.name === 'BotError' ? (e.error ?? err) : err);
}
