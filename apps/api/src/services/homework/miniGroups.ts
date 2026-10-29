/**
 * Task G (2026-10-29): connecting a Telegram group from the Mini App.
 *
 * The Mini App cannot add itself to a group — Telegram has no such API for bots. What it CAN
 * do is hand the teacher a one-time code and then watch, server-side, the real update that
 * spends it. That is exactly what this module implements:
 *
 *  • the code is created for the VERIFIED session owner and expires in 30 minutes;
 *  • it is spent only by `/bind CODE` sent in a real group by a linked teacher who is an
 *    administrator of that group (the check lives in `homeworkGroupBind`, via Bot API);
 *  • the group's chat id is written by the same atomic claim that marks the code used, so the
 *    Mini App never accepts a `chat_id` from the client — it reads what Telegram actually did;
 *  • a code that expired, was never used, or belonged to someone else is never reported as
 *    «connected»; an unanswerable health check is `unknown`, not success.
 */
import { and, eq } from 'drizzle-orm';
import type { DB } from '../../db/index.js';
import { tgBindTokens, tgGroups } from '../../db/schema.js';
import { env } from '../../env.js';
import type { BotApi, ChatMemberStatus } from '../botApi.js';
import { MAX_GROUPS } from './constants.js';
import { listGroups } from './store.js';
import { createBindCode } from './tokens.js';

export type GroupHealth = 'ok' | 'needsRights' | 'botMissing' | 'unknown';

export interface MiniConnectStart {
  id: string;
  code: string;
  expiresAt: string;
  botUsername: string | null;
  /** `https://t.me/<bot>` — the Mini App may only offer a link, never a silent add. */
  botLink: string | null;
}

export type MiniConnectState =
  | { status: 'pending'; id: string; expiresAt: string }
  | { status: 'connected'; id: string; group: { id: string; title: string }; health: GroupHealth }
  | { status: 'expired'; id: string }
  | { status: 'notFound' };

export type MiniConnectStartResult =
  | { status: 'ok'; connect: MiniConnectStart }
  | { status: 'limit' };

const uuid = /^[0-9a-f-]{36}$/i;

export function botIdentity(): { username: string | null; link: string | null } {
  const username = env.TELEGRAM_BOT_NAME.trim() || null;
  return { username, link: username ? `https://t.me/${username}` : null };
}

/** Is the BOT itself able to publish here? A missing answer is `unknown`, never `ok`. */
export async function botHealth(api: BotApi, chatId: string): Promise<GroupHealth> {
  let botId: string;
  try {
    botId = (await api.getMe()).id;
  } catch {
    return 'unknown';
  }
  const status: ChatMemberStatus = await api.getChatMember(chatId, botId);
  switch (status) {
    case 'creator':
    case 'administrator':
      return 'ok';
    case 'member':
    case 'restricted':
      // Present but without the rights the product relies on (and without the admin status
      // `/bind` itself demands for future re-binds).
      return 'needsRights';
    case 'left':
    case 'kicked':
      return 'botMissing';
    default:
      return 'unknown';
  }
}

export async function startMiniGroupConnect(
  deps: { db: DB }, ownerId: string,
): Promise<MiniConnectStartResult> {
  const groups = await listGroups(deps.db, ownerId);
  if (groups.length >= MAX_GROUPS) return { status: 'limit' };
  const { id, code, expiresAt } = await createBindCode(deps.db, ownerId);
  const bot = botIdentity();
  return {
    status: 'ok',
    connect: {
      id, code, expiresAt: expiresAt.toISOString(),
      botUsername: bot.username, botLink: bot.link,
    },
  };
}

/**
 * Read a code's outcome. Only rows of THIS owner exist for the caller; a foreign id answers
 * `notFound` exactly like a random one.
 */
export async function miniConnectState(
  deps: { db: DB; api: BotApi }, ownerId: string, id: string,
): Promise<MiniConnectState> {
  if (!uuid.test(id)) return { status: 'notFound' };
  const [row] = await deps.db.select({
    id: tgBindTokens.id,
    expiresAt: tgBindTokens.expiresAt,
    usedAt: tgBindTokens.usedAt,
    usedChatId: tgBindTokens.usedChatId,
  }).from(tgBindTokens)
    .where(and(eq(tgBindTokens.id, id), eq(tgBindTokens.ownerId, ownerId)))
    .limit(1);
  if (!row) return { status: 'notFound' };

  if (row.usedAt) {
    if (!row.usedChatId) return { status: 'expired', id: row.id };
    const [group] = await deps.db.select({ id: tgGroups.id, title: tgGroups.title })
      .from(tgGroups)
      .where(and(
        eq(tgGroups.ownerId, ownerId),
        eq(tgGroups.telegramChatId, row.usedChatId),
        eq(tgGroups.status, 'active'),
      )).limit(1);
    if (!group) {
      // The code was spent on a group that has since been removed: it is NOT a live success.
      return { status: 'expired', id: row.id };
    }
    return {
      status: 'connected', id: row.id, group,
      health: await botHealth(deps.api, row.usedChatId),
    };
  }
  if (row.expiresAt.getTime() <= Date.now()) return { status: 'expired', id: row.id };
  return { status: 'pending', id: row.id, expiresAt: row.expiresAt.toISOString() };
}

/** Health of every active group, for the Groups screen's «refresh» action. */
export async function miniGroupsHealth(
  deps: { db: DB; api: BotApi }, ownerId: string,
): Promise<{ id: string; health: GroupHealth }[]> {
  const groups = await listGroups(deps.db, ownerId);
  return Promise.all(groups.map(async (g) => ({
    id: g.id,
    health: await botHealth(deps.api, g.telegramChatId),
  })));
}
