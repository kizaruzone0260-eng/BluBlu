/**
 * Первичная обработка фрагмента приглашения (задача 2026-10-23, часть B).
 *
 * Вызывается ПЕРВЫМ оператором `main.tsx` — раньше темы, раньше ReactDOM и раньше любого
 * запроса, который приложение может сделать. Почему не инлайн-скриптом в `index.html`: наша же
 * CSP (`script-src 'self'`) отбрасывает инлайн-скрипты на served-сборке, и этот файл — самое
 * раннее место, где код разрешён. Утечки при этом нет: фрагмент не уходит серверу ни в каком
 * виде, `Referer` у нас `same-origin`, а сторонних ресурсов в shell нет ни одного.
 *
 * Токен, который мы достали из адреса, кладётся в `window[JOIN_TOKEN_KEY]` — ровно то же имя,
 * которое читает `consumeJoinToken` на странице `/join`. Иначе очистка случилась бы ДО чтения, и
 * экран потерял бы приглашение: адрес уже чистый, а в памяти страницы ключа нет.
 */
import { consumeJoinToken, isInviteToken, JOIN_TOKEN_KEY, takeJoinToken } from '@klass/shared';

type JoinWindow = Window & { [key: string]: unknown };

/**
 * Копия токена на время вкладки (задача 2026-10-28, повторное добавление ученика).
 *
 * До этой правки токен жил только в памяти страницы, а `lib/joinFlow.ts` — только в памяти
 * модуля. Перезагрузка (или возврат из другого приложения на телефоне) стирала оба, хотя
 * ссылка оставалась действующей: человек видел «Приглашение не найдено» и терял приглашение.
 * Постановка требует, чтобы приглашение переживало обязательный вход, поэтому токен теперь
 * лежит ещё и в `sessionStorage`:
 *  • это НЕ cookie и НЕ уходит серверу — ровно та же гарантия, что у фрагмента адреса;
 *  • `sessionStorage` умирает вместе с вкладкой и не виден другим вкладкам, так что
 *    пересланная ссылка не даёт доступа там, где её открыли, а успешный вход её очищает;
 *  • пароли и почта сюда не попадают — только сам одноразовый токен.
 */
const STORE_KEY = 'klass_join_token';

function storedToken(win: JoinWindow): string | null {
  try {
    const value = win.sessionStorage?.getItem(STORE_KEY);
    return typeof value === 'string' && isInviteToken(value) ? value : null;
  } catch {
    // приватный режим или запрет хранилища: приложение работает как раньше, из памяти
    return null;
  }
}

function rememberToken(win: JoinWindow, token: string): void {
  try { win.sessionStorage?.setItem(STORE_KEY, token); } catch { /* см. storedToken */ }
}

/** Чистит адрес и оставляет токен странице. Идемпотентна: повторный вызов ничего не трогает. */
export function primeJoinToken(win: JoinWindow): void {
  const token = takeJoinToken(win.location, win.history);
  if (!token) return;
  win[JOIN_TOKEN_KEY] = token;
  rememberToken(win, token);
}

/**
 * Токен для экрана `/join`: свежий из адреса/памяти страницы, иначе — сохранённый при
 * предыдущей загрузке этой вкладки. Возвращённое значение снова кладётся в оба места, чтобы
 * последующее перемонтирование (вход меняет дерево маршрутов) ничего не потеряло.
 */
export function currentJoinToken(win: JoinWindow): string | null {
  const fresh = consumeJoinToken(win.location, win.history, win[JOIN_TOKEN_KEY]);
  if (fresh) {
    win[JOIN_TOKEN_KEY] = fresh;
    rememberToken(win, fresh);
    return fresh;
  }
  const kept = storedToken(win);
  if (kept) win[JOIN_TOKEN_KEY] = kept;
  return kept;
}

/**
 * Токен израсходован — убираем его и из памяти страницы.
 *
 * Нужно ровно на успешном исходе. Пока идёт вход или регистрация, stash обязан пережить
 * перемонтирование `/join` (после входа меняется дерево маршрутов) и неудачную попытку.
 * А после членства он больше не нужен: ссылка одноразовая, и оставлять её в window значило бы
 * держать в памяти ключ, который уже ничего не открывает.
 */
export function forgetJoinToken(win: JoinWindow): void {
  delete win[JOIN_TOKEN_KEY];
  try { win.sessionStorage?.removeItem(STORE_KEY); } catch { /* чистить нечего */ }
}
