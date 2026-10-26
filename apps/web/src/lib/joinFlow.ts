/**
 * Состояние формы приглашения на время одной вкладки (2026-10-26).
 *
 * `/join` перемонтируется, когда меняется состояние входа: после `login()` /
 * `registerByInvite()` `App` обновляет `/api/me` и перерисовывает дерево маршрутов
 * (незалогиненное → Shell и обратно после «войти другим аккаунтом»). Локальный `useState`
 * при этом умирает — вместе с уже показанной причиной отказа и выбранным режимом.
 *
 * Здесь живёт ровно то, что должно пережить перемонтирование, и ничего больше:
 *  • режим (регистрация / вход) и почта — чтобы «уже есть аккаунт? войти» не начиналось с
 *    пустого поля, а смена аккаунта не возвращала к регистрации;
 *  • ошибка (`{code, reqId}`) — чтобы после входа с верным паролем, но неудачного членства
 *    человек увидел «почему» и кнопку повтора, а не чистый экран;
 *  • имя и почта из формы регистрации — чтобы переход туда-обратно не стирал набранное.
 *
 * Пароли сюда НЕ попадают. Токен хранится только как ключ «это состояние относится к этой
 * ссылке» (сам он уже лежит в памяти страницы под `JOIN_TOKEN_KEY`); запись очищается на
 * успехе (`clearJoinFlow`) и не переживает переход на другую ссылку.
 */
export interface JoinFlowError { code: string; reqId: string }

export interface JoinFlowSnapshot {
  token: string;
  mode: 'register' | 'signin';
  firstName: string;
  lastName: string;
  email: string;
  loginEmail: string;
  error: JoinFlowError | null;
}

let flow: JoinFlowSnapshot | null = null;

/** Состояние именно этой ссылки. Чужая/старая запись не должна влиять на новую. */
export function readJoinFlow(token: string): JoinFlowSnapshot | null {
  return flow && flow.token === token ? flow : null;
}

export function saveJoinFlow(next: JoinFlowSnapshot): void {
  flow = next;
}

export function clearJoinFlow(): void {
  flow = null;
}
