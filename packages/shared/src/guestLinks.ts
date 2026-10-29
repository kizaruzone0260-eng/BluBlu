/**
 * Гостевая ссылка на урок (задача 2026-10-28, часть 3).
 *
 * Гость — это человек БЕЗ аккаунта, которого учитель пускает посмотреть идущий урок. Ссылка
 * живёт только пока живёт урок, и сама по себе она ничего не даёт: открытие показывает форму
 * имени, вход в комнату — только после одобрения учителем. Поэтому здесь, как и у приглашений в
 * класс, только чистые правила: форма токена, сборка URL и разбор фрагмента. Генерация и хеш —
 * на сервере (`apps/api/src/lib/guestLink.ts`), потому что им нужен `node:crypto`.
 *
 * Токен едет во ФРАГМЕНТЕ (`/guest#<token>`), а не в query: фрагмент не уходит серверу, не
 * попадает в access-лог, в `Referer` и в историю прокси. Расходится он только POST-ом, и
 * открытие страницы (или предпросмотр в мессенджере) его не сжигает.
 */

/** 32 байта → 43 символа base64url без паддинга: 256 бит энтропии. */
export const GUEST_TOKEN_BYTES = 32;
export const GUEST_TOKEN_LENGTH = 43;
const GUEST_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** Ключ гостя генерирует его браузер: он отличает «мою» заявку от чужой при перезагрузке. */
const GUEST_KEY_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

/** Имя гостя видят учитель и комната — только оно, без почты и прочих полей аккаунта. */
export const GUEST_NAME_MAX = 60;

/** Путь страницы гостя — тот же, что собирает `guestUrlFor` на сервере. */
export const GUEST_PATH = '/guest';

/** Ключ, под которым приложение держит токен до первого запроса (см. `lib/guestToken.ts`). */
export const GUEST_TOKEN_KEY = '__blubluGuestToken';

export function isGuestToken(value: string): boolean {
  return GUEST_TOKEN_PATTERN.test(value);
}

export function isGuestKey(value: string): boolean {
  return GUEST_KEY_PATTERN.test(value);
}

/** trim + срезать `#`: токен мог прийти из буфера, из input или из «пересланного» текста. */
export function parseGuestToken(raw: string | null | undefined): string | null {
  const token = (raw ?? '').trim().replace(/^#/, '').trim();
  return isGuestToken(token) ? token : null;
}

/** Публичная ссылка гостя; база — тот же адрес, что у приглашений в класс. */
export function guestUrlFor(base: string, token: string): string {
  const clean = base.trim().replace(/\/+$/, '');
  return `${clean}${GUEST_PATH}#${token}`;
}

/** Те же формы, что у `joinToken`: объекты `location`/`history` браузера и их заглушки в тестах. */
type LocationLike = { hash?: string; pathname?: string; search?: string };
type HistoryLike = { replaceState(data: unknown, title: string, url: string | URL): void };

/** Нормализованный путь: '/guest', 'guest', '/guest/' приводятся к одному. */
export function isGuestPath(pathname: string | undefined): boolean {
  const bare = ('/' + (pathname ?? '').replace(/^\/+/, '')).replace(/\/+$/, '');
  return bare === GUEST_PATH;
}

/**
 * Что отдать приложению и надо ли чистить адрес. На чужой странице фрагмент не трогаем: там он
 * может быть якорем, и стирать его приложение не вправе.
 */
export function readGuestToken(hash: string | undefined, pathname: string | undefined): { token: string | null; clean: boolean } {
  const bare = (hash ?? '').trim().replace(/^#/, '').trim();
  if (!isGuestPath(pathname)) return { token: null, clean: false };
  return { token: isGuestToken(bare) ? bare : null, clean: true };
}

export function takeGuestToken(loc: LocationLike, history: HistoryLike): string | null {
  const { token, clean } = readGuestToken(loc.hash, loc.pathname);
  if (clean) history.replaceState(null, '', `${loc.pathname ?? GUEST_PATH}${loc.search ?? ''}`);
  return token;
}

export function consumeGuestToken(
  loc: LocationLike, history: HistoryLike, stashed: unknown = undefined,
): string | null {
  if (typeof stashed === 'string' && isGuestToken(stashed)) return stashed;
  return takeGuestToken(loc, history);
}
