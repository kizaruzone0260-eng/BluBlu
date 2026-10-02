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
  return fetch(path, {
    credentials: 'include',
    ...init,
    headers: {
      ...(init.body ? { 'content-type': 'application/json' } : {}),
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
  email: string;
  locale: 'ru' | 'uz';
  tz: string;
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

export async function registerByCode(name: string, email: string, password: string, code: string) {
  const j = await api<{ accessToken: string; user: Me }>('/api/auth/register', {
    method: 'POST', body: JSON.stringify({ name, email, password, code }),
  });
  setAccessToken(j.accessToken);
  return j.user;
}

export async function logout() {
  await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' }).catch(() => {});
  setAccessToken(null);
}
