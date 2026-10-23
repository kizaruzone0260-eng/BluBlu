/**
 * Токен из фрагмента URL (задача 2026-10-23, часть B).
 *
 * Ссылка приглашения выглядит как `<публичный адрес>/join#<токен>`. Фрагмент выбран не из
 * красоты: он НЕ уходит серверу — ни в access-лог Render, ни в `Referer`, ни в историю
 * промежуточных прокси. Поэтому, как только страница прочитала токен, фрагмент стирается, и
 * делается это раньше любого запроса: тот же код стоит инлайн-скриптом первым в
 * `apps/web/index.html`, до шрифтов и до модуля приложения.
 *
 * Всё это — чистые функции над переданными `location`/`history`: единственный побочный эффект
 * (replaceState) вызывается явно, и юнит проверяет поведение без браузера.
 */
import { isInviteToken } from './inviteLinks.js';

/** Ключ, под которым инлайн-скрипт shell-страницы оставляет токен до старта приложения. */
export const JOIN_TOKEN_KEY = '__blubluJoinToken';

/** Путь страницы входа по приглашению — тот же, что собирает `inviteUrlFor` на сервере. */
export const JOIN_PATH = '/join';

export interface LocationLike { hash?: string; pathname?: string; search?: string }
export interface HistoryLike { replaceState(data: unknown, title: string, url: string | URL): void }

/** Нормализованный путь: '/join', 'join', '/join/' и '//join' сводятся к одному сравнению. */
export function isJoinPath(pathname: string | undefined): boolean {
  const bare = ('/' + (pathname ?? '').replace(/^\/+/, '')).replace(/\/+$/, '');
  return bare === JOIN_PATH;
}

/**
 * Что отдать приложению и надо ли чистить адрес. `pathname` важен: фрагмент на чужой странице —
 * это не приглашение, и стирать чужой якорь (например оглавление) приложение не вправе.
 * На самом /join убирается ЛЮБОЙ фрагмент: настоящему приглашению он уже не нужен (токен
 * извлечён), а мусорному не место ни в адресной строке, ни в «перешлю отсюда».
 */
export function readJoinToken(hash: string | undefined, pathname: string | undefined): { token: string | null; clean: boolean } {
  const bare = (hash ?? '').trim().replace(/^#/, '').trim();
  if (!isJoinPath(pathname)) return { token: null, clean: false };
  return { token: isInviteToken(bare) ? bare : null, clean: true };
}

/**
 * То же с одним побочным эффектом: фрагмент убирается из адреса. `search` сохраняется — свои
 * query-параметры странице не мешают, а вот чужой фрагмент мешает. Возвращает токен, если он там
 * был.
 */
export function takeJoinToken(loc: LocationLike, history: HistoryLike): string | null {
  const { token, clean } = readJoinToken(loc.hash, loc.pathname);
  if (clean) history.replaceState(null, '', `${loc.pathname ?? JOIN_PATH}${loc.search ?? ''}`);
  return token;
}

/**
 * Достаёт токен для приложения: сначала значение, которое оставил инлайн-скрипт (к моменту
 * старта приложения фрагмента в адресе уже нет), иначе читает адрес сам. Двойное чтение
 * безопасно: на пустом фрагменте стирать нечего.
 */
export function consumeJoinToken(
  loc: LocationLike, history: HistoryLike, stashed: unknown = undefined,
): string | null {
  if (typeof stashed === 'string' && isInviteToken(stashed)) return stashed;
  return takeJoinToken(loc, history);
}
