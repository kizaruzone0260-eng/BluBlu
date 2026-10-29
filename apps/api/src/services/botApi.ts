/**
 * Bot transport + callback signing (bot task §1/§6).
 *
 * Everything the bot sends goes through the narrow BotApi interface so tests
 * (and the demo) never need a real token: TELEGRAM_TRANSPORT=log swaps in a
 * capturing fake. Callback data is signed with JWT_SECRET and bound to the
 * acting user — a forged or replayed callback from another account is refused,
 * and every handler STILL re-checks rights on the server.
 */
import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import { env } from '../env.js';

/**
 * Task F (2026-10-28): `webApp` opens a Mini App in Telegram's own webview (Bot API `web_app`
 * button). This is the ONLY client-side trace of the bot token: the URL is built from the public
 * https site, never from the token, and the app verifies initData server-side.
 */
export interface InlineButton { text: string; cb?: string; url?: string; webApp?: string }
export interface SendOpts { buttons?: InlineButton[][]; html?: boolean }
/**
 * Task F.1 (2026-10-29): the button that sits next to the message field and stays there between
 * sessions (Bot API `setChatMenuButton`). Telegram refuses a `web_app` menu button over http,
 * so `default` is the honest state both when the site has no https address and for every chat
 * that must not see the teacher's Mini App at all.
 */
export type ChatMenuButton =
  | { type: 'web_app'; text: string; url: string }
  | { type: 'default' };
/**
 * Can this `file_id` still be re-sent? `missing` is Telegram's own definite refusal (4xx),
 * `unknown` is any other failure — a timeout must not block a homework. Metadata only:
 * nothing here downloads or inspects a file, which is exactly why the library can promise
 * that no AI ever reads a textbook.
 */
export type FileCheck = 'ok' | 'missing' | 'unknown';

export interface BotApi {
  /** Returns Telegram's message_id when known (publication history), otherwise null. */
  sendMessage(chatId: string, text: string, opts?: SendOpts): Promise<number | null>;
  editMessageText(chatId: string, messageId: number, text: string, opts?: SendOpts): Promise<void>;
  deleteMessage(chatId: string, messageId: number): Promise<void>;
  /** Send an already-uploaded photo/document by its Telegram file_id. */
  sendPhoto(chatId: string, fileId: string): Promise<number | null>;
  sendDocument(chatId: string, fileId: string): Promise<number | null>;
  /**
   * Re-post one existing message into another chat. This is the primary way an attachment
   * leaves the bot: Telegram copies the original message, so the media keeps its real type
   * (a PNG sent as a file stays a file), its caption and its file name — and nothing is
   * downloaded, re-uploaded or read. Throws with `error_code` when Telegram refuses (4xx),
   * which is how the caller learns the source message is gone.
   */
  copyMessage(chatId: string, fromChatId: string, messageId: number): Promise<number | null>;
  /** Copy several messages at once; an album copied this way stays an album. */
  copyMessages(chatId: string, fromChatId: string, messageIds: number[]): Promise<number[]>;
  /** Preflight of a stored `file_id` before a publication sends anything. */
  checkFile(fileId: string): Promise<FileCheck>;
  /** scope: undefined = default (global) scope, a chat id = per-chat menu */
  setMyCommands(commands: { command: string; description: string }[], languageCode: string, chatId?: string): Promise<void>;
  deleteMyCommands(languageCode: string, chatId?: string): Promise<void>;
  /**
   * The persistent menu button of ONE private chat. Per-chat, not global: a global `web_app`
   * would show the teacher's Mini App to students and unlinked people too.
   */
  setChatMenuButton(chatId: string, button: ChatMenuButton): Promise<void>;
}

/** Wraps a grammY bot api; failures bubble to the caller which logs them. */
export function grammyApi(bot: { api: any }): BotApi {
  return {
    async sendMessage(chatId, text, opts) {
      const m = await bot.api.sendMessage(chatId, text, extra(opts));
      return typeof m?.message_id === 'number' ? m.message_id : null;
    },
    async editMessageText(chatId, messageId, text, opts) {
      await bot.api.editMessageText(chatId, messageId, text, extra(opts));
    },
    async deleteMessage(chatId, messageId) {
      try { await bot.api.deleteMessage(chatId, messageId); } catch { /* Telegram often refuses old/bot messages — ignore per spec */ }
    },
    async sendPhoto(chatId, fileId) {
      const m = await bot.api.sendPhoto(chatId, fileId);
      return typeof m?.message_id === 'number' ? m.message_id : null;
    },
    async sendDocument(chatId, fileId) {
      // Sending by file_id keeps Telegram's original file name; no re-upload happens.
      const m = await bot.api.sendDocument(chatId, fileId);
      return typeof m?.message_id === 'number' ? m.message_id : null;
    },
    async copyMessage(chatId, fromChatId, messageId) {
      // No bytes move: Telegram re-posts the message it already has.
      const m = await bot.api.copyMessage(chatId, fromChatId, messageId);
      return typeof m?.message_id === 'number' ? m.message_id : null;
    },
    async copyMessages(chatId, fromChatId, messageIds) {
      const sent = await bot.api.copyMessages(chatId, fromChatId, messageIds);
      return Array.isArray(sent)
        ? sent.map((s: { message_id?: unknown }) => (typeof s?.message_id === 'number' ? s.message_id : 0)).filter((n: number) => n > 0)
        : [];
    },
    async checkFile(fileId) {
      if (!env.TELEGRAM_BOT_TOKEN) return 'unknown';
      try {
        const f = await bot.api.getFile(fileId);
        return typeof f?.file_path === 'string' && f.file_path ? 'ok' : 'missing';
      } catch (e) {
        // Only Telegram's own refusal (grammY puts the code on `error_code`) means the
        // file_id is dead. Any other failure — a timeout, a 5xx — must not stop a homework,
        // so it stays `unknown` and the send itself decides.
        // grammY can put the Bot API URL (which IS the token) into an error; never let it escape.
        const code = (e as { error_code?: unknown })?.error_code;
        return code === 400 ? 'missing' : 'unknown';
      }
    },
    async setMyCommands(commands, languageCode, chatId) {
      const scope = chatId ? { type: 'chat', chat_id: Number(chatId) } : { type: 'all_private_chats' };
      await bot.api.setMyCommands(commands, { scope, language_code: languageCode });
    },
    async deleteMyCommands(languageCode, chatId) {
      const scope = chatId ? { type: 'chat', chat_id: Number(chatId) } : { type: 'all_private_chats' };
      await bot.api.deleteMyCommands({ scope, language_code: languageCode });
    },
    async setChatMenuButton(chatId, button) {
      await bot.api.setChatMenuButton({
        chat_id: Number(chatId),
        menu_button: button.type === 'web_app'
          ? { type: 'web_app', text: button.text, web_app: { url: button.url } }
          : { type: 'default' },
      });
    },
  };
}

function extra(opts?: SendOpts) {
  const e: Record<string, unknown> = {};
  if (opts?.html) { e.parse_mode = 'HTML'; e.disable_web_page_preview = true; }
  if (opts?.buttons?.length) {
    e.reply_markup = {
      inline_keyboard: opts.buttons.map((row) => row.map((b) => (b.webApp
        ? { text: b.text, web_app: { url: b.webApp } }
        : b.cb
          ? { text: b.text, callback_data: b.cb }
          : { text: b.text, url: b.url }))),
    };
  }
  return e;
}

/** Test/dev transport: records everything, sends nothing. */
export class CapturingApi implements BotApi {
  calls: {
    kind: string; chatId: string; text?: string; messageId?: number; opts?: SendOpts;
    commands?: unknown; lang?: string; fileId?: string; fromChatId?: string; messageIds?: number[];
    menu?: ChatMenuButton;
  }[] = [];
  failNext = false;
  /** Chat ids whose sends throw — used to prove per-group publication outcomes. */
  failChats = new Set<string>();
  /** Like failChats, but with Telegram's 4xx shape: a definite refusal, safe to retry. */
  rejectChats = new Set<string>();
  failPhotoChats = new Set<string>();
  failDocumentChats = new Set<string>();
  /**
   * Only the photo (or only the document) send is refused, with Telegram's 4xx — the shape of
   * the live failure «can't use file of type Document as Photo». The text still goes out, so
   * a test can prove that a refused attachment is reported as that attachment and nothing else.
   */
  rejectPhotoChats = new Set<string>();
  rejectDocumentChats = new Set<string>();
  /** `file_id`s Telegram would refuse to re-send: the library's unavailable-file path. */
  missingFiles = new Set<string>();
  /** `fromChat:messageId` pairs Telegram refuses to copy — the teacher deleted that message. */
  missingSources = new Set<string>();
  /** Copies that die in transit (no answer at all): the outcome must stay unknown. */
  failCopyChats = new Set<string>();
  private nextMessageId = 7000;

  private fail(chatId: string, photosOnly = false, docsOnly = false) {
    if (this.rejectChats.has(chatId)) {
      throw Object.assign(new Error('fictitious telegram rejection'), { error_code: 403 });
    }
    if (this.failChats.has(chatId)
      || (photosOnly && this.failPhotoChats.has(chatId))
      || (docsOnly && this.failDocumentChats.has(chatId))) {
      throw new Error('fictitious telegram transport failure');
    }
  }
  /** Telegram's own answer when the message to copy no longer exists. */
  private missingSource(fromChatId: string, messageId: number) {
    if (this.missingSources.has(`${fromChatId}:${messageId}`)) {
      throw Object.assign(new Error('Bad Request: message to copy not found'), { error_code: 400 });
    }
  }
  async sendMessage(chatId: string, text: string, opts?: SendOpts) {
    this.fail(chatId);
    this.calls.push({ kind: 'send', chatId, text, opts });
    return ++this.nextMessageId;
  }
  async editMessageText(chatId: string, messageId: number, text: string, opts?: SendOpts) { this.calls.push({ kind: 'edit', chatId, messageId, text, opts }); }
  async deleteMessage(chatId: string, messageId: number) { this.calls.push({ kind: 'del', chatId, messageId }); }
  async sendPhoto(chatId: string, fileId: string) {
    if (this.rejectPhotoChats.has(chatId)) {
      throw Object.assign(new Error("Bad Request: can't use file of type Document as Photo"), { error_code: 400 });
    }
    this.fail(chatId, true);
    this.calls.push({ kind: 'photo', chatId, fileId });
    return ++this.nextMessageId;
  }
  async sendDocument(chatId: string, fileId: string) {
    if (this.rejectDocumentChats.has(chatId)) {
      throw Object.assign(new Error('Bad Request: file to send is not available'), { error_code: 400 });
    }
    this.fail(chatId, false, true);
    this.calls.push({ kind: 'doc', chatId, fileId });
    return ++this.nextMessageId;
  }
  async copyMessage(chatId: string, fromChatId: string, messageId: number) {
    if (this.failCopyChats.has(chatId)) throw new Error('fictitious telegram transport failure');
    this.fail(chatId);
    this.missingSource(fromChatId, messageId);
    this.calls.push({ kind: 'copy', chatId, fromChatId, messageId });
    return ++this.nextMessageId;
  }
  async copyMessages(chatId: string, fromChatId: string, messageIds: number[]) {
    if (this.failCopyChats.has(chatId)) throw new Error('fictitious telegram transport failure');
    this.fail(chatId);
    for (const id of messageIds) this.missingSource(fromChatId, id);
    this.calls.push({ kind: 'copyMany', chatId, fromChatId, messageIds });
    return messageIds.map(() => ++this.nextMessageId);
  }
  async checkFile(fileId: string) {
    return this.missingFiles.has(fileId) ? 'missing' : 'ok';
  }
  async setMyCommands(commands: unknown, lang: string, chatId?: string) { this.calls.push({ kind: 'cmds', chatId: chatId ?? '', commands, lang }); }
  async deleteMyCommands(lang: string, chatId?: string) { this.calls.push({ kind: 'delcmds', chatId: chatId ?? '', lang }); }
  async setChatMenuButton(chatId: string, menu: ChatMenuButton) { this.calls.push({ kind: 'menubtn', chatId, menu }); }
  last(kind: string) { for (let i = this.calls.length - 1; i >= 0; i--) if (this.calls[i]?.kind === kind) return this.calls[i]; return undefined; }
}

// ─── signed callback data ─────────────────────────────────────────────────────
//
// Hardening (Phase 1и): callback_data is signed with a DEDICATED key derived
// from JWT_SECRET via HKDF (label 'klass.cb.v2'), NOT with JWT_SECRET itself —
// so a leaked callback signature can never be replayed as a JWT and the auth
// master secret is not reused in the bot surface. New buttons are version 'c2'.
// The v1 scheme (HMAC over JWT_SECRET directly) is STILL VERIFIED so any button
// already rendered in a chat keeps working through the transition — a signature
// migration with zero broken buttons; nothing needs re-sending.

const hkdfCbKey = (): Buffer =>
  // HKDF-SHA256, 32-byte salt (domain separator, not a secret), info label.
  // Derivation is deterministic per JWT_SECRET, so every process agrees.
  Buffer.from(new Uint8Array(hkdfSync('sha256',
    Buffer.from(env.JWT_SECRET, 'utf8'),
    Buffer.from('klass-cb-salt-v2', 'utf8'),
    Buffer.from('klass.cb.v2', 'utf8'), 32)));

/** v2 signature with the dedicated derived key. */
const sig2 = (payload: string): string =>
  createHmac('sha256', hkdfCbKey()).update(`cb2:${payload}`).digest('base64url').slice(0, 22);

/** legacy v1 signature (kept for verification only). */
const sig1 = (payload: string): string =>
  createHmac('sha256', env.JWT_SECRET).update(`cb1:${payload}`).digest('base64url').slice(0, 22);

/** payload = {u: userId or '', a: action, c?: classId, r?: reportId, …} */
export function signCb(payload: Record<string, string>): string {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `c2.${body}.${sig2(body)}`;
}

/** Verify the signature (v2 or transitional v1) and return the payload, or null on any tampering. */
export function verifyCb(data: string): Record<string, string> | null {
  const parts = data.split('.');
  const head = parts[0]; const body = parts[1]; const given = parts[2];
  if (parts.length !== 3 || !body || !given) return null;
  let expect: string | null = null;
  if (head === 'c2') expect = sig2(body);
  else if (head === 'c1') expect = sig1(body); // transition window: legacy buttons
  if (expect === null) return null;
  const a = Buffer.from(expect); const b = Buffer.from(given);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const obj = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Record<string, string>;
    return typeof obj === 'object' && obj !== null && typeof obj.a === 'string' ? obj : null;
  } catch { return null; }
}

// ─── command menus (§1) ───────────────────────────────────────────────────────

export const TEACHER_COMMANDS = [
  ['schedule', { ru: 'Расписание', uz: 'Jadval', en: 'Schedule' }],
  ['next', { ru: 'Ближайшее событие', uz: 'Yaqin tadbir', en: 'Next event' }],
  ['classes', { ru: 'Мои классы', uz: 'Sinflarim', en: 'My classes' }],
  ['materials', { ru: 'Материалы', uz: 'Materiallar', en: 'Materials' }],
  // the Telegram library is its own command: `/materials` keeps serving BluBlu classes
  ['library', { ru: 'Библиотека материалов', uz: 'Materiallar kutubxonasi', en: 'Material library' }],
  ['announce', { ru: 'Объявление классу', uz: 'E’lon yuborish', en: 'Announce to class' }],
  ['homework', { ru: 'Домашнее задание в Telegram', uz: 'Telegramga uy vazifasi', en: 'Homework to Telegram' }],
  // Task F/F.1: the screen-based editor of the same homework, labelled as the door it is —
  // the command list is part of the teacher's menu, so it must say what tapping it opens.
  ['mini', { ru: 'Открыть BluBlu', uz: 'BluBlu’ni ochish', en: 'Open BluBlu' }],
  ['settings', { ru: 'Настройки уведомлений', uz: 'Bildirishnoma sozlamalari', en: 'Notification settings' }],
  ['language', { ru: 'Язык', uz: 'Til', en: 'Language' }],
  ['help', { ru: 'Помощь', uz: 'Yordam', en: 'Help' }],
] as const;

export const STUDENT_COMMANDS = [
  ['schedule', { ru: 'Расписание', uz: 'Jadval', en: 'Schedule' }],
  ['next', { ru: 'Ближайшее событие', uz: 'Yaqin tadbir', en: 'Next event' }],
  ['contact', { ru: 'Написать учителю', uz: 'O’qituvchiga yozish', en: 'Write to teacher' }],
  ['language', { ru: 'Язык', uz: 'Til', en: 'Language' }],
  ['stop', { ru: 'Отвязать аккаунт', uz: 'Hisobni uzish', en: 'Unlink account' }],
  ['help', { ru: 'Помощь', uz: 'Yordam', en: 'Help' }],
] as const;

export const BASIC_COMMANDS = [
  ['start', { ru: 'Начать', uz: 'Boshlash', en: 'Start' }],
  ['help', { ru: 'Помощь', uz: 'Yordam', en: 'Help' }],
  ['language', { ru: 'Язык', uz: 'Til', en: 'Language' }],
  ['contact', { ru: 'Написать учителю', uz: 'O’qituvchiga yozish', en: 'Write to teacher' }],
] as const;

type Menu = readonly (readonly [string, { ru: string; uz: string; en: string }])[];
const menuFor = (m: Menu, lang: 'ru' | 'uz' | 'en') => m.map(([c, d]) => ({ command: c, description: d[lang] }));

/** Push the right command list for a role onto one chat (and the default scope at boot). */
export async function applyMenu(api: BotApi, role: 'teacher' | 'student' | 'basic', chatId?: string): Promise<void> {
  const src = role === 'teacher' ? TEACHER_COMMANDS : role === 'student' ? STUDENT_COMMANDS : BASIC_COMMANDS;
  for (const lang of ['ru', 'uz', 'en'] as const) {
    await api.setMyCommands(menuFor(src, lang), lang, chatId);
  }
}

/**
 * The language codes a chat-scope menu is stored under, including `''` — Telegram's
 * "whatever language the client has" variant.
 */
const MENU_LANGS = ['ru', 'uz', 'en', ''] as const;

const srcFor = (role: 'teacher' | 'student' | 'basic') =>
  role === 'teacher' ? TEACHER_COMMANDS : role === 'student' ? STUDENT_COMMANDS : BASIC_COMMANDS;

/**
 * English command labels for ONE chat, under every language code.
 *
 * Live test of 2026-10-23: the teacher's BluBlu account is English (so every message the bot
 * writes is English), but her Telegram client is Russian — and the client picks the menu by
 * its own language, so she saw «Библиотека материалов» next to English screens. A per-chat
 * scope is more specific than the client language, and installing the English list under
 * ru/uz/en/'' leaves no Russian variant for that chat to fall back to. Only this chat
 * changes: other users keep the trilingual menus of `applyMenu`.
 */
export async function applyEnglishMenu(
  api: BotApi, role: 'teacher' | 'student' | 'basic', chatId: string,
): Promise<void> {
  const english = menuFor(srcFor(role), 'en');
  for (const lang of MENU_LANGS) await api.setMyCommands(english, lang, chatId);
}

/**
 * One chat, one language: when the account itself is English, every menu of that chat becomes
 * English (otherwise an English account with a Russian client sees Russian labels beside
 * English messages). A Russian or Uzbek account keeps the trilingual menu it had.
 */
export async function applyMenuForChat(
  api: BotApi, role: 'teacher' | 'student' | 'basic', chatId: string, lang: 'ru' | 'uz' | 'en',
): Promise<void> {
  if (lang === 'en') await applyEnglishMenu(api, role, chatId);
  else await applyMenu(api, role, chatId);
}

export async function removeMenu(api: BotApi, chatId: string): Promise<void> {
  for (const lang of MENU_LANGS) await api.deleteMyCommands(lang, chatId);
}

/** HTML-escape user text — nothing the user typed is ever markup (bot task). */
export const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
