let accessToken: string | null = null;
const listeners = new Set<(loggedIn: boolean) => void>();

export function setAccessToken(t: string | null) {
  accessToken = t;
  listeners.forEach((l) => l(t != null));
}

export function getToken(): string | null {
  return accessToken;
}

export function onAuthChange(cb: (loggedIn: boolean) => void) {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

export class ApiError extends Error {
  constructor(public status: number, public code: string) {
    super(code);
  }
}

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
  return tryRefresh();
}

export async function api<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  let res = await rawFetch(path, init);
  if (res.status === 401 && accessToken) {
    if (await tryRefresh()) res = await rawFetch(path, init);
    else { setAccessToken(null); }
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: 'errorGeneric' }));
    throw new ApiError(res.status, body.error ?? 'errorGeneric');
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
  tz: string;
  /** name screen (task 2): false → show «Имя и фамилия» before the app */
  profileCompleted: boolean;
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

export async function login(email: string, password: string) {
  const j = await api<{ accessToken: string; user: Me }>('/api/auth/login', {
    method: 'POST', body: JSON.stringify({ email, password }),
  });
  setAccessToken(j.accessToken);
  return j.user;
}

/** item 9 step 1 — verify the class code WITHOUT consuming it (throws on invalid). */
export async function checkCode(code: string): Promise<void> {
  await api<{ ok: true }>('/api/auth/check-code', { method: 'POST', body: JSON.stringify({ code }) });
}

export async function registerByCode(firstName: string, lastName: string, email: string, password: string, code: string) {
  const j = await api<{ accessToken: string; user: Me }>('/api/auth/register', {
    method: 'POST', body: JSON.stringify({ firstName, lastName, email, password, code }),
  });
  setAccessToken(j.accessToken);
  return j.user;
}

export async function logout() {
  await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' }).catch(() => {});
  setAccessToken(null);
}
