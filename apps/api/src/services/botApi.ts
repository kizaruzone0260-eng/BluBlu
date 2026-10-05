/**
 * Bot transport + callback signing (bot task §1/§6).
 *
 * Everything the bot sends goes through the narrow BotApi interface so tests
 * (and the demo) never need a real token: TELEGRAM_TRANSPORT=log swaps in a
 * capturing fake. Callback data is signed with JWT_SECRET and bound to the
 * acting user — a forged or replayed callback from another account is refused,
 * and every handler STILL re-checks rights on the server.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../env.js';

export interface InlineButton { text: string; cb?: string; url?: string }
export interface SendOpts { buttons?: InlineButton[][]; html?: boolean }

export interface BotApi {
  sendMessage(chatId: string, text: string, opts?: SendOpts): Promise<void>;
  editMessageText(chatId: string, messageId: number, text: string, opts?: SendOpts): Promise<void>;
  deleteMessage(chatId: string, messageId: number): Promise<void>;
  /** scope: undefined = default (global) scope, a chat id = per-chat menu */
  setMyCommands(commands: { command: string; description: string }[], languageCode: string, chatId?: string): Promise<void>;
  deleteMyCommands(languageCode: string, chatId?: string): Promise<void>;
}

/** Wraps a grammY bot api; failures bubble to the caller which logs them. */
export function grammyApi(bot: { api: any }): BotApi {
  return {
    async sendMessage(chatId, text, opts) {
      await bot.api.sendMessage(chatId, text, extra(opts));
    },
    async editMessageText(chatId, messageId, text, opts) {
      await bot.api.editMessageText(chatId, messageId, text, extra(opts));
    },
    async deleteMessage(chatId, messageId) {
      try { await bot.api.deleteMessage(chatId, messageId); } catch { /* Telegram often refuses old/bot messages — ignore per spec */ }
    },
    async setMyCommands(commands, languageCode, chatId) {
      const scope = chatId ? { type: 'chat', chat_id: Number(chatId) } : { type: 'all_private_chats' };
      await bot.api.setMyCommands(commands, { scope, language_code: languageCode });
    },
    async deleteMyCommands(languageCode, chatId) {
      const scope = chatId ? { type: 'chat', chat_id: Number(chatId) } : { type: 'all_private_chats' };
      await bot.api.deleteMyCommands({ scope, language_code: languageCode });
    },
  };
}

function extra(opts?: SendOpts) {
  const e: Record<string, unknown> = {};
  if (opts?.html) { e.parse_mode = 'HTML'; e.disable_web_page_preview = true; }
  if (opts?.buttons?.length) e.reply_markup = { inline_keyboard: opts.buttons.map((row) => row.map((b) => (b.cb ? { text: b.text, callback_data: b.cb } : { text: b.text, url: b.url }))) };
  return e;
}

/** Test/dev transport: records everything, sends nothing. */
export class CapturingApi implements BotApi {
  calls: { kind: string; chatId: string; text?: string; messageId?: number; opts?: SendOpts; commands?: unknown; lang?: string }[] = [];
  failNext = false;
  async sendMessage(chatId: string, text: string, opts?: SendOpts) { this.calls.push({ kind: 'send', chatId, text, opts }); }
  async editMessageText(chatId: string, messageId: number, text: string, opts?: SendOpts) { this.calls.push({ kind: 'edit', chatId, messageId, text, opts }); }
  async deleteMessage(chatId: string, messageId: number) { this.calls.push({ kind: 'del', chatId, messageId }); }
  async setMyCommands(commands: unknown, lang: string, chatId?: string) { this.calls.push({ kind: 'cmds', chatId: chatId ?? '', commands, lang }); }
  async deleteMyCommands(lang: string, chatId?: string) { this.calls.push({ kind: 'delcmds', chatId: chatId ?? '', lang }); }
  last(kind: string) { for (let i = this.calls.length - 1; i >= 0; i--) if (this.calls[i]?.kind === kind) return this.calls[i]; return undefined; }
}

// ─── signed callback data ─────────────────────────────────────────────────────

const sig = (payload: string) =>
  createHmac('sha256', env.JWT_SECRET).update(`cb1:${payload}`).digest('base64url').slice(0, 22);

/** payload = {u: userId or '', a: action, c?: classId, r?: reportId, …} */
export function signCb(payload: Record<string, string>): string {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `c1.${body}.${sig(body)}`;
}

/** Verify the signature and return the payload, or null on any tampering. */
export function verifyCb(data: string): Record<string, string> | null {
  const parts = data.split('.');
  const head = parts[0]; const body = parts[1]; const given = parts[2];
  if (parts.length !== 3 || head !== 'c1' || !body || !given) return null;
  const expect = sig(body);
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
  ['announce', { ru: 'Объявление классу', uz: 'E’lon yuborish', en: 'Announce to class' }],
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

export async function removeMenu(api: BotApi, chatId: string): Promise<void> {
  for (const lang of ['ru', 'uz', 'en'] as const) {
    await api.deleteMyCommands(lang, chatId);
  }
}

/** HTML-escape user text — nothing the user typed is ever markup (bot task). */
export const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
