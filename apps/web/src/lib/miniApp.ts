/**
 * Task F (2026-10-28): the Telegram Mini App client plumbing.
 * Task G.2 (2026-11-04): тот же слой умеет теперь и браузерный вход — см. `ensureSdk`,
 * `signInWithPassword` и `packages/shared/src/miniLaunch.ts`.
 *
 * Three separate things live here, and each has one reason:
 *  • the SDK loader — the official `telegram-web-app.js` is placed in `<head>` by the server for
 *    the `/mini` document (only that response widens CSP; see MINI_APP_CSP in apps/api/src/app.ts).
 *    The client only OBSERVES it with a bounded budget: the script's state is no longer a verdict,
 *    and the app starts without it.
 *  • the session — a limited Mini App token kept in sessionStorage and sent as a Bearer header.
 *    No cookies on the Mini App calls: the token is minted either from verified initData or from
 *    an already verified BluBlu web session, and a webview reload should keep the teacher's place
 *    for a working day, not forever;
 *  • the DTOs — a mirror of `services/homework/mini.ts` with no group chat ids and no message
 *    ids, because the server never sends them to this surface.
 */

import {
  loginSchema,
  readInitData,
  SDK_FIRST_TIMEOUT_MS, SDK_MAX_ATTEMPTS, SDK_RETRY_TIMEOUT_MS,
  TELEGRAM_SDK_URL,
  telegramBridgePresent,
  type SdkState,
} from '@klass/shared';
import { applyTheme, getThemeChoice, type ThemeChoice } from './theme';

export type MiniDraftStatus =
  | 'selecting' | 'choosing_materials' | 'awaiting_instruction' | 'collecting' | 'formatting'
  | 'needs_clarification' | 'preview' | 'publishing' | 'published' | 'failed'
  | 'publish_unknown' | 'cancelled';

export type MiniPublicationStatus = 'sending' | 'sent' | 'failed' | 'uncertain';

export interface MiniPart {
  kind: 'text' | 'material' | 'photo' | 'document';
  label: string;
  method: 'copy' | 'file_id' | 'text';
  status: 'sent' | 'failed' | 'unknown';
  messageId: number | null;
  error: string;
}

export interface MiniGroup {
  id: string;
  title: string;
  kind: 'online' | 'offline';
  status: 'active' | 'removed';
  chatShort: string;
  materialCount: number;
  lastPublication: { status: MiniPublicationStatus; updatedAt: string } | null;
}

export interface MiniDraftGroup { id: string; title: string; kind: 'online' | 'offline' }
export interface MiniLink { id: string; url: string; label: string }
export interface MiniMaterialSnapshot {
  id: string; materialId: string | null; title: string;
  kind: 'book' | 'workbook' | 'other'; fileName: string;
}
export interface MiniPublication {
  id: string; groupId: string; groupTitle: string; status: MiniPublicationStatus;
  error: string; parts: MiniPart[]; delivered: number; attempts: number; updatedAt: string;
}
export interface MiniDraft {
  id: string;
  status: MiniDraftStatus;
  title: string;
  instruction: string;
  dueAt: string | null;
  formattedText: string;
  groups: MiniDraftGroup[];
  materials: MiniMaterialSnapshot[];
  links: MiniLink[];
  warnings: string[];
  questions: string[];
  provider: string;
  lastError: string;
  canEdit: boolean;
  canPublish: boolean;
  canRetry: boolean;
  publications: MiniPublication[];
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
}
export interface MiniDraftSummary {
  id: string; status: MiniDraftStatus; title: string; updatedAt: string;
  groupCount: number; dueAt: string | null;
}
export interface MiniMaterialHit {
  id: string; title: string; kind: 'book' | 'workbook' | 'other';
  fileName: string; fileSize: number | null; recommendedFor: string[];
}
/** Task G: the server's answer to «has this person accepted the current documents?». */
export interface MiniLegalStatus {
  accepted: boolean;
  privacyVersion: string;
  termsVersion: string;
  currentPrivacyVersion: string;
  currentTermsVersion: string;
  acceptedAt: string | null;
  locale: string | null;
}
export interface MiniBootstrap {
  teacher: { name: string; locale: string; tz: string };
  groups: MiniGroup[];
  drafts: MiniDraftSummary[];
  publications: MiniPublication[];
  materialsCount: number;
  limits: {
    groups: number; materials: number; links: number; title: number;
    instruction: number; text: number; items: number;
  };
  ai: { remote: boolean };
  bot: { username: string | null };
  /** Task G: the Mini App gate reads the same status the server enforces on every route. */
  legal: MiniLegalStatus;
  /** Canonical public pages, so the gate never invents its own URLs. */
  links: { privacy: string; terms: string };
}
/** `/api/mini/history`: more rows than the home bootstrap carries (20 drafts / 40 sends). */
export interface MiniHistory {
  drafts: MiniDraftSummary[];
  publications: MiniPublication[];
}
export interface MiniAuthResponse {
  token: string;
  expiresAt: string;
  teacher: { id: string; name: string; locale: string; tz: string };
  bot: { username: string | null };
}
export interface MiniPublishResponse {
  kind: 'done' | 'already' | 'noTargets' | 'unexpected' | 'notReady' | 'inProgress' | 'groupUnavailable';
  draft: MiniDraft | null;
  unavailableGroups?: string[];
}
export interface MiniFormatResponse {
  draft: MiniDraft;
  warnings: string[];
  questions: string[];
  provider: string;
  usedAi: boolean;
  /** Present only on the 502 answer: the plain version the teacher may accept or edit. */
  fallback?: string;
}

/** Task G: a file that became a real library row after Telegram accepted it. */
export interface MiniUploadMaterial {
  id: string;
  title: string;
  kind: 'book' | 'workbook' | 'other';
  fileName: string;
  fileSize: number | null;
  mediaType: string | null;
}
export interface MiniUploadResponse {
  material: MiniUploadMaterial;
  draft: MiniDraft | null;
  draftAttached: boolean;
  replaced: boolean;
}

/** Task G: one-time code shown by the Mini App; the server only reports what Telegram did. */
export interface MiniConnectStart {
  id: string;
  code: string;
  expiresAt: string;
  botUsername: string | null;
  botLink: string | null;
}
export type MiniGroupHealth = 'ok' | 'needsRights' | 'botMissing' | 'unknown';
export type MiniConnectState =
  | { status: 'pending'; id: string; expiresAt: string }
  | { status: 'connected'; id: string; group: { id: string; title: string }; health: MiniGroupHealth }
  | { status: 'expired'; id: string }
  | { status: 'notFound' };

export interface MiniApiResult<T> {
  ok: boolean;
  status: number;
  data: T | null;
  /** Interface code from the server (`miniNotLinked`, `draftLocked`, …) or `networkError`. */
  error: string;
}

const TOKEN_KEY = 'klass_mini_token';
/** Task G.2: сессия помнит, из какой она двери — tg или web. Это подсказка интерфейсу (что
 *  показать при истечении: «перезапусти из Telegram» или «войди заново»), а не доказательство
 *  прав: сервер смотрит в собственную подпись токена, а не сюда. */
const SURFACE_KEY = 'klass_mini_surface';

export type MiniSurface = 'tg' | 'web';

export function readMiniToken(): string | null {
  try { return sessionStorage.getItem(TOKEN_KEY); } catch { return null; }
}

export function readMiniSurface(): MiniSurface | null {
  try {
    const value = sessionStorage.getItem(SURFACE_KEY);
    return value === 'tg' || value === 'web' ? value : null;
  } catch { return null; }
}

export function writeMiniToken(token: string | null, surface: MiniSurface = 'tg'): void {
  try {
    if (token) {
      sessionStorage.setItem(TOKEN_KEY, token);
      sessionStorage.setItem(SURFACE_KEY, surface);
    } else {
      sessionStorage.removeItem(TOKEN_KEY);
      sessionStorage.removeItem(SURFACE_KEY);
    }
  } catch { /* private mode: the session simply will not survive a reload */ }
}

/**
 * One request to `/api/mini`. Credentials are omitted on purpose: even if the webview happens to
 * have BluBlu cookies, the Mini App must authenticate only with the token minted from initData.
 */
export async function miniApi<T = unknown>(
  path: string,
  init: { method?: string; body?: unknown; auth?: boolean } = {},
): Promise<MiniApiResult<T>> {
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  const token = readMiniToken();
  if (init.auth !== false && token) headers.authorization = `Bearer ${token}`;
  let res: Response;
  try {
    res = await fetch(path, {
      method: init.method ?? 'GET',
      headers,
      credentials: 'omit',
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  } catch {
    return { ok: false, status: 0, data: null, error: 'networkError' };
  }
  const data = (await res.json().catch(() => null)) as unknown;
  const error = data && typeof data === 'object' && typeof (data as { error?: unknown }).error === 'string'
    ? String((data as { error: string }).error)
    : res.ok ? '' : 'serverError';
  return { ok: res.ok, status: res.status, data: data as T | null, error };
}

export interface MiniUploadArgs {
  file: File;
  title: string;
  kind: 'book' | 'workbook' | 'other';
  groupIds: string[];
  draftId?: string;
  /** 0–100 for the request body only; the server still talks to Telegram after 100 %. */
  onProgress?: (percent: number) => void;
}
export interface MiniUploadOutcome {
  ok: boolean;
  status: number;
  data: MiniUploadResponse | null;
  error: string;
}

/**
 * Task G: the one request that carries bytes. `fetch` cannot report upload progress in every
 * webview Telegram uses, so this deliberately uses XHR; everything else in the Mini App keeps
 * using `miniApi`. The token travels in the header (never a query string), and no automatic
 * retry is attempted — a repeated upload must be the teacher's explicit decision.
 */
export function uploadMiniFile(args: MiniUploadArgs): Promise<MiniUploadOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (outcome: MiniUploadOutcome) => {
      if (settled) return;
      settled = true;
      resolve(outcome);
    };
    try {
      const form = new FormData();
      form.append('title', args.title);
      form.append('kind', args.kind);
      form.append('groupIds', JSON.stringify(args.groupIds));
      if (args.draftId) form.append('draftId', args.draftId);
      form.append('file', args.file, args.file.name);

      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/mini/materials/upload');
      xhr.withCredentials = false;
      const token = readMiniToken();
      if (token) xhr.setRequestHeader('authorization', `Bearer ${token}`);
      xhr.upload.onprogress = (e) => {
        if (!e.lengthComputable || e.total <= 0) return;
        args.onProgress?.(Math.min(100, Math.round((e.loaded / e.total) * 100)));
      };
      xhr.onerror = () => finish({ ok: false, status: 0, data: null, error: 'networkError' });
      xhr.onabort = () => finish({ ok: false, status: 0, data: null, error: 'networkError' });
      xhr.onload = () => {
        let data: MiniUploadResponse | null = null;
        try { data = JSON.parse(xhr.responseText) as MiniUploadResponse; } catch { data = null; }
        const body = data as unknown as { error?: unknown } | null;
        const error = body && typeof body.error === 'string'
          ? String(body.error)
          : xhr.status >= 200 && xhr.status < 300 ? '' : 'serverError';
        finish({ ok: xhr.status >= 200 && xhr.status < 300, status: xhr.status, data, error });
      };
      xhr.send(form);
    } catch {
      finish({ ok: false, status: 0, data: null, error: 'networkError' });
    }
  });
}

// ─── Telegram SDK ────────────────────────────────────────────────────────────

export interface TelegramWebAppUser {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

export interface TelegramBackButton {
  isVisible?: boolean;
  show(): void;
  hide(): void;
  onClick(cb: () => void): void;
  offClick(cb: () => void): void;
}

export interface TelegramMainButton {
  text: string;
  show(): void;
  hide(): void;
  enable(): void;
  disable(): void;
  setText(text: string): void;
  onClick(cb: () => void): void;
  offClick(cb: () => void): void;
  showProgress?(leaveActive?: boolean): void;
  hideProgress?(): void;
}

export interface TelegramWebApp {
  initData: string;
  initDataUnsafe?: { user?: TelegramWebAppUser };
  colorScheme: 'light' | 'dark';
  themeParams: Record<string, string>;
  isExpanded?: boolean;
  ready(): void;
  expand(): void;
  close(): void;
  onEvent?(event: string, cb: () => void): void;
  offEvent?(event: string, cb: () => void): void;
  BackButton: TelegramBackButton;
  MainButton: TelegramMainButton;
  HapticFeedback?: {
    impactOccurred(style: 'light' | 'medium' | 'heavy' | 'rigid' | 'soft'): void;
    notificationOccurred(type: 'error' | 'success' | 'warning'): void;
    selectionChanged(): void;
  };
  setHeaderColor?(color: string): void;
  setBackgroundColor?(color: string): void;
  disableVerticalSwipes?(): void;
  isVersionAtLeast?(version: string): boolean;
}

declare global {
  interface Window { Telegram?: { WebApp?: TelegramWebApp } }
}

export interface SdkOutcome {
  /** что случилось со скриптом — НЕ вердикт «приложение нельзя показывать» */
  state: SdkState;
  wa: TelegramWebApp | null;
  /** сколько заходов сделано; видно в тесте «не бесконечный ли retry» */
  attempts: number;
}

let sdkPromise: Promise<SdkOutcome> | null = null;

/** Тег SDK, который сервер поставил в `<head>` документа `/mini` (Task G.2). */
function existingSdkTag(): HTMLScriptElement | null {
  return document.querySelector<HTMLScriptElement>(`script[src^="${TELEGRAM_SDK_URL}"]`);
}

function webApp(): TelegramWebApp | null {
  return window.Telegram?.WebApp ?? null;
}

/**
 * Один заход: дождаться тега из `<head>` (или вставить свой) с таймаутом.
 * `blocked` — скрипт не запустился (CSP, ошибка сети): повторять бессмысленно, это детерминизм.
 * `timeout` — ответа нет: это единственная ветка, где второй и третий заход что-то решают.
 */
function oneSdkAttempt(timeoutMs: number, reuse: boolean): Promise<'ready' | 'blocked' | 'timeout'> {
  return new Promise((resolve) => {
    if (webApp()) { resolve('ready'); return; }
    let settled = false;
    let node = reuse ? existingSdkTag() : null;
    const finish = (state: 'ready' | 'blocked' | 'timeout') => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      node?.removeEventListener('load', onLoad);
      node?.removeEventListener('error', onError);
      resolve(state);
    };
    const onLoad = () => finish(webApp() ? 'ready' : 'blocked');
    const onError = () => finish('blocked');
    const timer = window.setTimeout(() => finish('timeout'), timeoutMs);
    if (!node) {
      node = document.createElement('script');
      node.src = TELEGRAM_SDK_URL;
      node.async = true;
      document.head.appendChild(node);
    }
    node.addEventListener('load', onLoad);
    node.addEventListener('error', onError);
    // тег из `<head>` мог успеть исполниться ДО этой подписки: проверяем ещё раз
    if (webApp()) { finish('ready'); return; }
    /*
     * И наоборот: отложенный тег исполняется раньше нашего модуля, поэтому на уже догруженной
     * странице события больше не будет никогда. Ждать тогда 4 секунды и показать «нет соединения»
     * вместо честного «скрипт не запустился» — значит соврать о причине.
     */
    if (reuse && document.readyState === 'complete') finish('blocked');
  });
}

/**
 * SDK: один промис на страницу, максимум `SDK_MAX_ATTEMPTS` заходов и ни одного бесконечного
 * повтора. docstring Task G.2 в `packages/shared/src/miniLaunch.ts` объясняет, почему состояние
 * скрипта больше не равно фатальному экрану.
 */
export function ensureSdk(): Promise<SdkOutcome> {
  sdkPromise ??= (async (): Promise<SdkOutcome> => {
    const current = webApp();
    if (current) return { state: 'ready', wa: current, attempts: 0 };
    let attempts = 0;
    for (let i = 0; i < SDK_MAX_ATTEMPTS; i += 1) {
      attempts += 1;
      // первый заход ждёт тег из `<head>`, повторные вставляют свой: мёртвый узел не «очнётся»
      const outcome = await oneSdkAttempt(
        i === 0 ? SDK_FIRST_TIMEOUT_MS : SDK_RETRY_TIMEOUT_MS,
        i === 0,
      );
      if (outcome === 'ready') return { state: 'ready', wa: webApp(), attempts };
      // блокировка детерминирована: второй заход даст ровно тот же отказ
      if (outcome === 'blocked') return { state: 'blocked', wa: null, attempts };
    }
    // сюда доходит только таймаут: сеть молчала трижды
    return { state: 'timeout', wa: null, attempts };
  })();
  return sdkPromise;
}

/** То же, что было, но честно: сбрасывается и промис, и мёртвые узлы, чтобы «Try again» был
 *  реальным повтором, а не возвратом того же отказа. */
export function resetMiniSdk(): void {
  sdkPromise = null;
  for (const node of Array.from(document.querySelectorAll<HTMLScriptElement>(`script[src^="${TELEGRAM_SDK_URL}"]`))) {
    if (node.dataset.miniRetry === '1') node.remove();
    else node.dataset.miniRetry = '1';
  }
}

/** Есть ли у клиента WebApp-мост (признаки, а не user-agent). */
export function hasTelegramBridge(): boolean {
  return telegramBridgePresent(window as unknown as Parameters<typeof telegramBridgePresent>[0]);
}

/** Адрес запуска: подписанный `initData` может быть во фрагменте (как делает официальный SDK)
 *  или в query. readInitData из общего пакета — единственная реализация этого разбора. */
export function initDataFromUrl(): string | null {
  return readInitData({ hash: window.location.hash, search: window.location.search });
}

// ─── Browser mode: обычная авторизация BluBlu, тот же mini-токен ─────────────

/**
 * Вход для браузерной двери.
 *
 * Никакой второй системы: `/api/auth/login` — ровно тот же маршрут, что у веб-приложения, с тем
 * же `loginSchema` (одинаковые правила и одинаковый ответ), а `/api/mini/web/auth` меняет
 * проверенную веб-сессию на ограниченный токен Mini App. Сервер сам решает, кто вошёл; клиент не
 * передаёт ни user id, ни роль, ни «surface».
 *
 * Пароль нигде не сохраняется — только access-токен в памяти страницы (он короткоживущий, а
 * переживает перезагрузку refresh-cookie через `/api/auth/refresh`, то есть штатным механизмом).
 * fetch здесь свой, а не `lib/api.ts`: страница `/mini` стоит вне приложения (без его глобальных
 * слушателей авторизации и без его чанков), и тащить их в standalone-экран было бы второй
 * реализацией уже на уровне клиента.
 */
export async function signInWithPassword(email: string, password: string): Promise<MiniApiResult<MiniAuthResponse>> {
  const parsed = loginSchema.safeParse({ email, password });
  if (!parsed.success) return { ok: false, status: 400, data: null, error: 'invalidInput' };
  let accessToken = '';
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ email: parsed.data.email, password: parsed.data.password }),
    });
    const body = (await res.json().catch(() => null)) as { accessToken?: string; error?: string } | null;
    if (!res.ok || !body?.accessToken) {
      return { ok: false, status: res.status, data: null, error: body?.error ?? 'serverError' };
    }
    accessToken = body.accessToken;
  } catch {
    return { ok: false, status: 0, data: null, error: 'networkError' };
  }
  webAccessToken = accessToken;
  try {
    const res = await fetch('/api/mini/web/auth', {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}` },
      credentials: 'omit',
    });
    const data = (await res.json().catch(() => null)) as MiniAuthResponse | null;
    if (!res.ok || !data?.token) {
      return { ok: false, status: res.status, data: null, error: data ? 'serverError' : 'networkError' };
    }
    writeMiniToken(data.token, 'web');
    return { ok: true, status: res.status, data, error: '' };
  } catch {
    return { ok: false, status: 0, data: null, error: 'networkError' };
  }
}

/** Access-токен этой страницы (память, не хранилище). */
let webAccessToken: string | null = null;

/**
 * Продлить браузерную сессию штатным способом: refresh-cookie → новый access → новый mini-токен.
 * Отдельная функция потому, что перезагрузка страницы убивает память, а cookie жив: человек
 * должен вернуться к работе, а не к форме входа посреди урока.
 */
export async function renewWebSession(): Promise<boolean> {
  try {
    const res = await fetch('/api/auth/refresh', { method: 'POST', credentials: 'include' });
    if (!res.ok) return false;
    const body = (await res.json().catch(() => null)) as { accessToken?: string } | null;
    if (!body?.accessToken) return false;
    webAccessToken = body.accessToken;
    const mint = await fetch('/api/mini/web/auth', {
      method: 'POST',
      headers: { authorization: `Bearer ${body.accessToken}` },
      credentials: 'omit',
    });
    const data = (await mint.json().catch(() => null)) as MiniAuthResponse | null;
    if (!mint.ok || !data?.token) return false;
    writeMiniToken(data.token, 'web');
    return true;
  } catch {
    return false;
  }
}

/** Выйти: токен Mini App убирается всегда, серверная сессия — если до неё удалось достучаться. */
export async function signOutFromMini(): Promise<void> {
  const token = webAccessToken;
  writeMiniToken(null);
  webAccessToken = null;
  if (!token) return;
  try {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'include', headers: { authorization: `Bearer ${token}` } });
  } catch { /* локальный выход уже состоялся */ }
}


export const TELEGRAM_THEME_VARS = [
  '--tg-bg', '--tg-bg-2', '--tg-text', '--tg-hint', '--tg-link', '--tg-button', '--tg-button-text',
] as const;

/**
 * Task G: an explicit Light/Dark choice must win over Telegram's colours, so the inline
 * `--tg-*` values (and the marker that tells `theme.ts` «Telegram owns this document») are
 * removed before the ordinary theme is applied.
 */
export function clearTelegramTheme(): void {
  const root = document.documentElement;
  for (const cssVar of TELEGRAM_THEME_VARS) root.style.removeProperty(cssVar);
  delete root.dataset.themeSource;
}

/** Telegram's own theme, applied only to this document; the rest of the app keeps its choice. */
export function applyTelegramTheme(wa: TelegramWebApp): void {
  const root = document.documentElement;
  root.dataset.theme = wa.colorScheme === 'dark' ? 'dark' : 'light';
  // `theme.ts` listens to the OS preference; inside Telegram the app theme is authoritative,
  // so the listener must not repaint the document behind Telegram's back.
  root.dataset.themeSource = 'telegram';
  const p = wa.themeParams ?? {};
  const map: Record<string, string> = {
    bg_color: '--tg-bg',
    secondary_bg_color: '--tg-bg-2',
    text_color: '--tg-text',
    hint_color: '--tg-hint',
    link_color: '--tg-link',
    button_color: '--tg-button',
    button_text_color: '--tg-button-text',
  };
  for (const [key, cssVar] of Object.entries(map)) {
    const value = p[key];
    if (typeof value === 'string' && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(value)) {
      root.style.setProperty(cssVar, value);
    }
  }
  try {
    if (p.bg_color) wa.setBackgroundColor?.(p.bg_color);
    if (p.secondary_bg_color) wa.setHeaderColor?.(p.secondary_bg_color);
  } catch { /* older clients: the colours above still apply to the page */ }
}

/**
 * Task G, three themes:
 *  • `system` inside Telegram follows `themeParams`/`themeChanged` (not the OS directly);
 *  • `system` outside Telegram follows the browser/OS preference;
 *  • an explicit `light`/`dark` is stored in the same `klass_theme` key the web app uses and
 *    always wins — Telegram's inline colours are removed so they cannot leak through.
 */
export function applyMiniTheme(wa: TelegramWebApp | null, choice: ThemeChoice = getThemeChoice()): void {
  if (wa && choice === 'system') {
    applyTelegramTheme(wa);
    return;
  }
  clearTelegramTheme();
  applyTheme(choice);
}

export function haptic(wa: TelegramWebApp | null, kind: 'tap' | 'success' | 'error'): void {
  try {
    if (!wa?.HapticFeedback) return;
    if (kind === 'tap') wa.HapticFeedback.impactOccurred('light');
    else wa.HapticFeedback.notificationOccurred(kind);
  } catch { /* haptics are a nicety, never a dependency */ }
}
