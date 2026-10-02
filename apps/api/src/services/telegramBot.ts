import { Bot } from 'grammy';
import { and, eq, gt } from 'drizzle-orm';
import type { DB } from '../db/index.js';
import { env } from '../env.js';
import { consumeLinkToken, hashToken, unlinkUser } from './notify.js';
import { classLinkTokens, classTelegramChats, telegramLinks } from '../db/schema.js';

export function createBot(): Bot | null {
  if (!env.TELEGRAM_BOT_TOKEN) return null;
  return new Bot(env.TELEGRAM_BOT_TOKEN);
}

export interface BotDeps {
  db: DB;
  /** is the acting Telegram account an admin of this group? (grammY getChatMember in prod) */
  isGroupAdmin: (chatId: string, tgUserId: number) => Promise<boolean>;
}

const REPLY = {
  usage: 'Пришлите ссылку привязки из профиля Klass или /stop.',
  linked: 'Готово: Telegram привязан к аккаунту Klass.',
  badLink: 'Ссылка недействительна или устарела. Создайте новую в профиле.',
  stopped: 'Ок, уведомления отключены.',
  needCode: 'Используйте /link <код> — код создаётся в интерфейсе класса.',
  notAdmin: 'Команду /link может выполнять только администратор группы.',
  needPersonal: 'Сначала привяжите личный Telegram в профиле Klass (команда /start из личной ссылки).',
  badCode: 'Код привязки не найден или истёк. Создайте новый в интерфейсе класса.',
  okGroup: 'Группа привязана к классу. Уведомления будут приходить сюда.',
};

/**
 * Pure update handler used by the grammY webhook route. Returns the reply text,
 * so unit/integration tests assert the flow without Telegram network (§3.9).
 */
export async function processUpdate(
  deps: BotDeps,
  update: { message?: { text?: string; chat?: { id?: number; type?: string }; from?: { id?: number } } },
): Promise<{ handled: boolean; reply?: string }> {
  const msg = update.message;
  if (!msg?.text || msg.chat?.id === undefined) return { handled: false };
  const chatId = String(msg.chat.id);
  const text = msg.text.trim();

  if (text.startsWith('/start')) {
    const token = text.split(/\s+/)[1] ?? '';
    if (!token) return { handled: true, reply: REPLY.usage };
    const ok = await consumeLinkToken(deps.db, token, chatId);
    return { handled: true, reply: ok ? REPLY.linked : REPLY.badLink };
  }

  if (text.startsWith('/stop')) {
    await unlinkUserByChat(deps.db, chatId);
    return { handled: true, reply: REPLY.stopped };
  }

  if (text.startsWith('/link') && (msg.chat.type === 'group' || msg.chat.type === 'supergroup')) {
    const code = (text.split(/\s+/)[1] ?? '').toUpperCase();
    if (!code) return { handled: true, reply: REPLY.needCode };
    // §3.9: only a group administrator may link
    const tgUserId = msg.from?.id ?? 0;
    if (!(await deps.isGroupAdmin(chatId, tgUserId))) return { handled: true, reply: REPLY.notAdmin };
    // the acting teacher must have a personal link (chat_id of the private chat equals their tg user id)
    const [personal] = await deps.db.select({ userId: telegramLinks.userId }).from(telegramLinks)
      .where(eq(telegramLinks.chatId, String(tgUserId))).limit(1);
    if (!personal) return { handled: true, reply: REPLY.needPersonal };
    const rows = await deps.db.select().from(classLinkTokens)
      .where(and(eq(classLinkTokens.tokenHash, hashToken(code)), gt(classLinkTokens.expiresAt, new Date())))
      .limit(1);
    const tokenRow = rows[0];
    if (!tokenRow) return { handled: true, reply: REPLY.badCode };
    await deps.db.delete(classLinkTokens).where(eq(classLinkTokens.tokenHash, tokenRow.tokenHash)); // one-shot
    await deps.db.insert(classTelegramChats)
      .values({ classId: tokenRow.classId, chatId, linkedBy: personal.userId })
      .onConflictDoUpdate({
        target: [classTelegramChats.classId, classTelegramChats.chatId],
        set: { linkedBy: personal.userId, linkedAt: new Date() },
      });
    return { handled: true, reply: REPLY.okGroup };
  }

  return { handled: false };
}

async function unlinkUserByChat(db: DB, chatId: string) {
  await db.delete(telegramLinks).where(eq(telegramLinks.chatId, chatId));
}
