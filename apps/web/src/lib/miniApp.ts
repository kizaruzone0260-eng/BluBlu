/**
 * Task F (2026-10-28): the Telegram Mini App client plumbing.
 *
 * Three separate things live here, and each has one reason:
 *  • the SDK loader — the official `telegram-web-app.js` is injected at runtime, because the
 *    strict CSP of every other page (`script-src 'self'`) must stay strict; only the `/mini`
 *    response widens it (see apps/api/src/app.ts, MINI_APP_CSP);
 *  • the session — a limited Mini App token kept in sessionStorage and sent as a Bearer header.
 *    No cookies: the regular web session must not be reachable from a Telegram webview, and a
 *    webview reload should keep the teacher's place for a working day, not forever;
 *  • the DTOs — a mirror of `services/homework/mini.ts` with no group chat ids and no message
 *    ids, because the server never sends them to this surface.
 */

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

export function readMiniToken(): string | null {
  try { return sessionStorage.getItem(TOKEN_KEY); } catch { return null; }
}

export function writeMiniToken(token: string | null): void {
  try {
    if (token) sessionStorage.setItem(TOKEN_KEY, token);
    else sessionStorage.removeItem(TOKEN_KEY);
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

export interface SdkLoad {
  wa: TelegramWebApp | null;
  /** the script itself could not be fetched — a different failure from «opened outside Telegram» */
  failed: boolean;
}

let sdkPromise: Promise<SdkLoad> | null = null;

/**
 * Load the official SDK once per page. Timeout is deliberate: a captive school wifi can leave a
 * script request hanging, and the page must then say so instead of showing an endless spinner.
 */
export function loadTelegramWebApp(timeoutMs = 6_000): Promise<SdkLoad> {
  sdkPromise ??= new Promise<SdkLoad>((resolve) => {
    const existing = window.Telegram?.WebApp;
    if (existing) { resolve({ wa: existing, failed: false }); return; }
    let done = false;
    let timer = 0;
    const finish = (result: SdkLoad) => {
      if (done) return;
      done = true;
      window.clearTimeout(timer);
      resolve(result);
    };
    timer = window.setTimeout(() => finish({ wa: window.Telegram?.WebApp ?? null, failed: !window.Telegram?.WebApp }), timeoutMs);
    const script = document.createElement('script');
    script.src = 'https://telegram.org/js/telegram-web-app.js';
    script.async = true;
    script.onload = () => finish({ wa: window.Telegram?.WebApp ?? null, failed: false });
    script.onerror = () => finish({ wa: null, failed: true });
    document.head.appendChild(script);
  });
  return sdkPromise;
}

/** Retry after a failed SDK load or an expired session. */
export function resetMiniSdk(): void {
  sdkPromise = null;
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
