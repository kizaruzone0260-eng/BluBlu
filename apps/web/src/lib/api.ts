let accessToken: string | null = null;
let restorePromise: Promise<boolean> | null = null;
const listeners = new Set<(loggedIn: boolean) => void>();

/**
 * `notify=false` — для экрана приглашения: вход и регистрация там не заканчиваются входом.
 * Раньше токен объявлялся сразу, `App` перезагружал `/api/me`, дерево маршрутов менялось, и
 * `/join` перемонтировался ПОСРЕДИ запроса «войти в класс». Теперь экран сначала доводит
 * вход/регистрацию до членства, и только потом сам зовёт `onDone()` (тот же refresh).
 * Так токен не теряется, ошибка соединения не выдаётся за «вы уже вошли», а учитель видит
 * экран смены аккаунта, а не пустую страницу.
 */
export interface AuthNotifyOption { deferNotify?: boolean }

export function setAccessToken(t: string | null, notify = true) {
  accessToken = t;
  if (t == null) restorePromise = null;
  if (notify) listeners.forEach((l) => l(t != null));
}

export function getToken(): string | null {
  return accessToken;
}

export function onAuthChange(cb: (loggedIn: boolean) => void) {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

export class ApiError extends Error {
  constructor(public status: number, public code: string, public reqId = '') {
    super(code);
  }
}

/**
 * A request that never reached the server (offline, DNS, a canceled navigation, a portal
 * wifi with a captive page). Task B: this used to surface as «Something went wrong», which
 * sent pupils to their teacher with a sentence that describes neither side.
 */
export const NETWORK_ERROR = 'networkError';

async function rawFetch(path: string, init: RequestInit): Promise<Response> {
  // FormData must NOT get the JSON content-type — fetch has to set
  // multipart/form-data with its own boundary (material uploads, task A).
  const isForm = typeof FormData !== 'undefined' && init.body instanceof FormData;
  return fetch(path, {
    credentials: 'include',
    ...init,
    headers: {
      ...(init.body && !isForm ? { 'content-type': 'application/json' } : {}),
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      ...init.headers,
    },
  });
}

/** Single-flight refresh so parallel 401s don't burn the rotating token. */
let refreshing: Promise<boolean> | null = null;

async function tryRefresh(): Promise<boolean> {
  refreshing ??= (async () => {
    try {
      const r = await fetch('/api/auth/refresh', { method: 'POST', credentials: 'include' });
      if (!r.ok) return false;
      const j = await r.json();
      setAccessToken(j.accessToken);
      return true;
    } finally {
      setTimeout(() => { refreshing = null; }, 0);
    }
  })();
  return refreshing;
}

/**
 * Boot-time session restore — MUST share the single-flight above.
 * Without it, a double effect run (React StrictMode dev) POSTs /refresh twice
 * with the same rotating cookie → reuse detection kills the token family →
 * the user is logged out on every hard page load.
 */
export function restoreSession(): Promise<boolean> {
  if (accessToken) return Promise.resolve(true);
  restorePromise ??= tryRefresh();
  return restorePromise;
}

export async function api<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await rawFetch(path, init);
  } catch {
    // fetch itself rejected: no server answer at all. Distinct from a 5xx, because the fix on
    // the student's side is different (wait / check the network) and the log has nothing to find.
    throw new ApiError(0, NETWORK_ERROR);
  }
  if (res.status === 401 && accessToken) {
    if (await tryRefresh()) res = await rawFetch(path, init);
    else { setAccessToken(null); }
  }
  if (!res.ok) {
    // The server answers every failure with `{error, reqId}`; a body that is not JSON (a proxy
    // error page, an empty 502) still has to say something true rather than break the screen.
    const body = await res.json().catch(() => ({ error: res.status >= 500 ? 'serverError' : 'invalidInput' }));
    throw new ApiError(res.status, (body as { error?: string }).error ?? 'errorGeneric',
      (body as { reqId?: string }).reqId ?? res.headers.get('x-request-id') ?? '');
  }
  return res.status === 204 ? (undefined as T) : res.json();
}

export interface Me {
  id: string;
  role: 'teacher' | 'student';
  name: string;
  /** item 9 — family name; ''/undefined for accounts created before the split */
  lastName?: string;
  email: string;
  locale: 'ru' | 'uz' | 'en';
  /**
   * Language (task 1): did this person ever pick a language themselves? Only then may the
   * profile override what the device is already showing — `locale` alone cannot tell a choice
   * from the column default.
   */
  localeExplicit?: boolean;
  tz: string;
  /** name screen (task 2): false → show «Имя и фамилия» before the app */
  profileCompleted: boolean;
  /** legal (Phase 2): false → the accept-Privacy-and-Terms gate is shown */
  policyAccepted: boolean;
  /** part 3: a temporary password was issued — must change before use */
  mustChangePassword: boolean;
}

/** Accept the current privacy+terms bundle (version is sent for validation). */
export async function acceptPolicy(version: string): Promise<void> {
  await api('/api/me/accept-policy', { method: 'POST', body: JSON.stringify({ version }) });
}

/** Part 3: change your own password (verifies the current one server-side). */
export async function changePassword(current: string, next: string): Promise<void> {
  await api('/api/me/change-password', { method: 'POST', body: JSON.stringify({ current, next }) });
}

/** Part 3: sign out of every device (revoke all refresh sessions). */
/**
 * «Выйти со всех устройств». The endpoint is behind `app.authenticate`, so it MUST go through
 * `api()` — the raw fetch this used to make sent no Authorization header, the server answered
 * 401, the refresh cookie stayed valid, and the next page load silently logged the user back in.
 * (Found by apps/e2e/tests/zz15-locale.spec.ts, which logs out and signs in again: the trace is
 * `POST /api/auth/logout-all → 401` followed by `POST /api/auth/refresh → 200`.)
 * The local token is dropped even when the call fails: the user must never look "signed in"
 * after asking to be signed out.
 */
export async function logoutAll(): Promise<void> {
  try { await api('/api/auth/logout-all', { method: 'POST' }); } catch { /* still signed out locally */ }
  setAccessToken(null);
}

/**
 * One-time 30 s ticket for our WebSockets (§audit: no long-lived token in URLs).
 * Fetch immediately before each connect; on reconnect fetch a fresh one.
 */
export async function wsTicket(sessionId: string): Promise<string> {
  const r = await api<{ ticket: string }>('/api/ws/ticket', {
    method: 'POST', body: JSON.stringify({ sessionId }),
  });
  return r.ticket;
}

export async function fetchMe(): Promise<Me | null> {
  try {
    return await api<Me>('/api/me');
  } catch {
    return null;
  }
}

export async function login(email: string, password: string, { deferNotify = false }: AuthNotifyOption = {}) {
  const j = await api<{ accessToken: string; user: Me }>('/api/auth/login', {
    method: 'POST', body: JSON.stringify({ email, password }),
  });
  setAccessToken(j.accessToken, !deferNotify);
  return j.user;
}

/*
 * 2026-10-27: вместе с приёмом в класс по восьмизначному коду из клиента убраны `checkCode`
 * («проверить код, не расходуя») и `registerByCode`. Маршруты ещё отвечают — 410 с переводимой
 * причиной, — но экран, который умел только этот способ, больше не существует: аккаунт ученика
 * либо заводит учитель (`createStudent`), либо человек регистрируется сам по одноразовой ссылке
 * (`registerByInvite`).
 */

/**
 * Часть F (2026-10-16): попросить шестизначный код на почту. Отдельная функция именно потому,
 * что её ответ НИЧЕГО не сообщает о существовании аккаунта: и «письмо отправлено», и «адрес уже
 * занят» приходят одним и тем же 202, и экран обязан держаться на том же тексте.
 */
export async function requestEmailCode(firstName: string, lastName: string, email: string, locale?: string): Promise<void> {
  await api<{ ok: true }>('/api/auth/email-code', {
    method: 'POST',
    body: JSON.stringify({ firstName, lastName, email, ...(locale ? { locale } : {}) }),
  });
}

/* ─── одноразовая ссылка-приглашение (задача 2026-10-23, часть B) ───────────────────────── */

/**
 * «Куда меня зовут» — ничего не расходует. Отдельная функция потому, что у ответа ровно два
 * поля и он не должен превратиться в «проверку кода»: проверка приглашения тоже обязана
 * оставаться безвредной, иначе предпросмотр в мессенджере сжигал бы ссылку.
 */
export async function previewInvite(token: string): Promise<{ className: string; expiresAt: string | null }> {
  return api<{ className: string; expiresAt: string | null }>('/api/invitations/preview', {
    method: 'POST', body: JSON.stringify({ token }),
  });
}

/** Регистрация по приглашению: аккаунт + класс + расход токена одним запросом. */
export async function registerByInvite(
  token: string, firstName: string, lastName: string, email: string, password: string, locale?: string,
  { deferNotify = false, emailCode }: AuthNotifyOption & { emailCode?: string } = {},
): Promise<{ user: Me; classId: string }> {
  const j = await api<{ accessToken: string; user: Me; classId: string }>('/api/invitations/register', {
    method: 'POST',
    body: JSON.stringify({
      token, firstName, lastName, email, password,
      ...(locale ? { locale } : {}),
      // часть F (переехала сюда 2026-10-27): при выключенном подтверждении поля просто нет
      ...(emailCode ? { emailCode } : {}),
    }),
  });
  setAccessToken(j.accessToken, !deferNotify);
  return { user: j.user, classId: j.classId };
}

/** Войти в приглашённый класс уже существующим аккаунтом. `alreadyMember` — честно, без дублей. */
export async function joinByInvite(token: string): Promise<{ classId: string; alreadyMember: boolean }> {
  return api<{ classId: string; alreadyMember: boolean }>('/api/invitations/join', {
    method: 'POST', body: JSON.stringify({ token }),
  });
}

export async function logout() {
  await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' }).catch(() => {});
  setAccessToken(null);
}
