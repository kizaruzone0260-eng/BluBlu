import { consumeGuestToken, isGuestToken, GUEST_TOKEN_KEY, type HistoryLike, type LocationLike } from '@klass/shared';

/**
 * Токен гостевой ссылки в браузере (задача 2026-10-28, часть 3).
 *
 * Ссылка выглядит как `/guest#<token>`; фрагмент стирается из адресной строки на первом же
 * рендере (как у `/join`), а сам токен остаётся в памяти и в sessionStorage ВКЛАДКИ. Это
 * отличие от приглашения в класс сделано осознанно: гостю предстоит пережить одобрение
 * учителем — он может обновить страницу, пока ждёт, — и «ссылка пропала после F5» было бы
 * поломкой функции. sessionStorage исчезает вместе с вкладкой, в адресной строке и в Referer
 * токена нет.
 */

type GuestWindow = Window & { [key: string]: unknown };

const STORE_KEY = 'klass_guest_token';
export const GUEST_REQUESTED_KEY = 'klass_guest_requested';

function storedToken(win: GuestWindow): string | null {
  try {
    const value = win.sessionStorage?.getItem(STORE_KEY);
    return typeof value === 'string' && isGuestToken(value) ? value : null;
  } catch {
    return null;
  }
}

function rememberToken(win: GuestWindow, token: string): void {
  try { win.sessionStorage?.setItem(STORE_KEY, token); } catch { /* приватный режим */ }
}

export function primeGuestToken(win: GuestWindow): void {
  const token = consumeGuestToken(
    win.location as unknown as LocationLike,
    win.history as unknown as HistoryLike,
    win[GUEST_TOKEN_KEY],
  );
  if (!token) return;
  win[GUEST_TOKEN_KEY] = token;
  rememberToken(win, token);
}

export function currentGuestToken(win: GuestWindow): string | null {
  const stashed = win[GUEST_TOKEN_KEY];
  if (typeof stashed === 'string' && isGuestToken(stashed)) {
    rememberToken(win, stashed);
    return stashed;
  }
  const kept = storedToken(win);
  if (kept) win[GUEST_TOKEN_KEY] = kept;
  return kept;
}

/** «Я уже отправлял заявку в этой вкладке» — чтобы при загрузке не стучаться статусом впустую. */
export function markGuestRequested(win: GuestWindow): void {
  try { win.sessionStorage?.setItem(GUEST_REQUESTED_KEY, '1'); } catch { /* нечего помнить */ }
}

export function guestRequested(win: GuestWindow): boolean {
  try { return win.sessionStorage?.getItem(GUEST_REQUESTED_KEY) === '1'; } catch { return false; }
}
