import { Bot } from 'grammy';
import { DEFAULT_LOCALE } from '@klass/shared';
import { and, eq, gt } from 'drizzle-orm';
import type { DB } from '../db/index.js';
import { env } from '../env.js';
import { consumeLinkToken, hashToken, unlinkUser } from './notify.js';
import { classLinkTokens, classTelegramChats, telegramLinks, users as usersTable } from '../db/schema.js';

export function createBot(): Bot | null {
  if (!env.TELEGRAM_BOT_TOKEN) return null;
  return new Bot(env.TELEGRAM_BOT_TOKEN);
}

export interface BotDeps {
  db: DB;
  /** is the acting Telegram account an admin of this group? (grammY getChatMember in prod) */
  isGroupAdmin: (chatId: string, tgUserId: number) => Promise<boolean>;
}

const T = {
  usage: {
    ru: 'Пришлите ссылку привязки из профиля BluBlu или /stop.',
    uz: 'Proildagi bog‘lanish havolasini yuboring yoki /stop.',
    en: 'Send the link URL from your BluBlu profile, or /stop.',
  },
  linked: {
    ru: 'Готово: Telegram привязан к аккаунту BluBlu.',
    uz: 'Tayyor: Telegram BluBlu hisobiga bog‘landi.',
    en: 'Done: Telegram is linked to your BluBlu account.',
  },
  badLink: {
    ru: 'Ссылка недействительна или устарела. Создайте новую в профиле.',
    uz: 'Havola yaroqsiz yoki eskirgan. Proilda yangisini yarating.',
    en: 'This link is invalid or expired. Create a new one in your profile.',
  },
  stopped: {
    ru: 'Ок, уведомления отключены.',
    uz: 'OK, bildirishnomalar o‘chirildi.',
    en: 'OK, notifications are off.',
  },
  needCode: {
    ru: 'Используйте /link <код> — код создаётся в интерфейсе класса.',
    uz: '/link <kod> ishlating — kod sinf interfeysida yaratiladi.',
    en: 'Use /link <code> — the code is created in the class UI.',
  },
  notAdmin: {
    ru: 'Команду /link может выполнять только администратор группы.',
    uz: '/link buyrug‘ini faqat guruh administratori bajara oladi.',
    en: 'Only a group administrator can run /link.',
  },
  needPersonal: {
    ru: 'Сначала привяжите личный Telegram в профиле BluBlu (команда /start из личной ссылки).',
    uz: 'Avval proilda shaxsiy Telegramni boglang (/start shaxsiy havola orqali).',
    en: 'First link your personal Telegram in the BluBlu profile (/start via your personal link).',
  },
  badCode: {
    ru: 'Код привязки не найден или истёк. Создайте новый в интерфейсе класса.',
    uz: 'Bog‘lash kodi topilmadi yoki eskirgan. Sinf interfeysida yangisini yarating.',
    en: 'Link code not found or expired. Create a new one in the class UI.',
  },
  okGroup: {
    ru: 'Группа привязана к классу. Уведомления будут приходить сюда.',
    uz: 'Guruh sinfga bog‘landi. Bildirishnomalar shu yerga keladi.',
    en: 'The group is linked to the class. Notifications will arrive here.',
  },
} as const;

type Key = keyof typeof T;

async function localeForUserId(db: DB, userId: string): Promise<'ru' | 'uz' | 'en'> {
  const [u] = await db.select({ locale: usersTable.locale }).from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  return u?.locale ?? DEFAULT_LOCALE;
}

/** the language of whoever is writing: their linked account, or nothing if this chat is unbound */
async function localeForChat(db: DB, chatId: string): Promise<'ru' | 'uz' | 'en' | null> {
  const [link] = await db.select({ userId: telegramLinks.userId }).from(telegramLinks)
    .where(eq(telegramLinks.chatId, chatId)).limit(1);
  return link ? await localeForUserId(db, link.userId) : null;
}

const msg = (k: Key, loc: 'ru' | 'uz' | 'en') => T[k][loc];

/**
 * Pure update handler used by the grammY webhook route. Returns the reply text,
 * so unit/integration tests assert the flow without Telegram network (§3.9).
 */
export async function processUpdate(
  deps: BotDeps,
  update: { message?: { text?: string; chat?: { id?: number; type?: string }; from?: { id?: number } } },
): Promise<{ handled: boolean; reply?: string }> {
  const m = update.message;
  if (!m?.text || m.chat?.id === undefined) return { handled: false };
  const chatId = String(m.chat.id);
  const text = m.text.trim();

  if (text.startsWith('/start')) {
    const token = text.split(/\s+/)[1] ?? '';
    if (!token) return { handled: true, reply: msg('usage', DEFAULT_LOCALE) };
    const ok = await consumeLinkToken(deps.db, token, chatId);
    // A rejected token is answered in the language of the chat that already exists — a person
    // retrying an expired link should not suddenly get English (or Russian) because the failure
    // path had no profile to ask. Unbound chat ⇒ product default.
    let loc = (await localeForChat(deps.db, chatId)) ?? DEFAULT_LOCALE;
    if (ok) {
      const [link] = await deps.db.select({ userId: telegramLinks.userId }).from(telegramLinks)
        .where(eq(telegramLinks.chatId, chatId)).limit(1);
      if (link) loc = await localeForUserId(deps.db, link.userId);
    }
    return { handled: true, reply: ok ? msg('linked', loc) : msg('badLink', loc) };
  }

  if (text.startsWith('/stop')) {
    // answer BEFORE the unlink, in the language of the account that is being unlinked
    const who = (await localeForChat(deps.db, chatId)) ?? DEFAULT_LOCALE;
    await unlinkUserByChat(deps.db, chatId);
    return { handled: true, reply: msg('stopped', who) };
  }

  if (text.startsWith('/link') && (m.chat.type === 'group' || m.chat.type === 'supergroup')) {
    const code = (text.split(/\s+/)[1] ?? '').toUpperCase();
    // §3.9: only a group administrator may link. The ACTOR is identifiable even in a group —
    // their private chat id equals their tg user id — so the refusal is answered in their
    // language, not in the product default; an unlinked actor gets the default, which is English.
    const tgUserId = m.from?.id ?? 0;
    const actorLoc = (await localeForChat(deps.db, String(tgUserId))) ?? DEFAULT_LOCALE;
    if (!code) return { handled: true, reply: msg('needCode', actorLoc) };
    if (!(await deps.isGroupAdmin(chatId, tgUserId))) return { handled: true, reply: msg('notAdmin', actorLoc) };
    // the acting teacher must have a personal link (chat_id of the private chat equals their tg user id)
    const [personal] = await deps.db.select({ userId: telegramLinks.userId }).from(telegramLinks)
      .where(eq(telegramLinks.chatId, String(tgUserId))).limit(1);
    if (!personal) return { handled: true, reply: msg('needPersonal', actorLoc) };
    const loc = await localeForUserId(deps.db, personal.userId);
    const rows = await deps.db.select().from(classLinkTokens)
      .where(and(eq(classLinkTokens.tokenHash, hashToken(code)), gt(classLinkTokens.expiresAt, new Date())))
      .limit(1);
    const tokenRow = rows[0];
    if (!tokenRow) return { handled: true, reply: msg('badCode', loc) };
    await deps.db.delete(classLinkTokens).where(eq(classLinkTokens.tokenHash, tokenRow.tokenHash)); // one-shot
    await deps.db.insert(classTelegramChats)
      .values({ classId: tokenRow.classId, chatId, linkedBy: personal.userId })
      .onConflictDoUpdate({
        target: [classTelegramChats.classId, classTelegramChats.chatId],
        set: { linkedBy: personal.userId, linkedAt: new Date() },
      });
    (await import('./audit.js')).audit(deps.db, personal.userId, 'telegram_group_link', { classId: tokenRow.classId, chatId });
    return { handled: true, reply: msg('okGroup', loc) };
  }

  return { handled: false };
}

async function unlinkUserByChat(db: DB, chatId: string) {
  await db.delete(telegramLinks).where(eq(telegramLinks.chatId, chatId));
}
