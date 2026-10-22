/**
 * Persistence for the homework module. No HTTP, no Telegram, no AI — every function here
 * is a small, explicit state change that the flow can compose. Draft state transitions are
 * compare-and-swap updates (`where status in (...)`), so two presses of the same button
 * cannot both move the draft forward.
 */
import { and, asc, count, desc, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import type { DB } from '../../db/index.js';
import {
  botSessions, tgDraftItems, tgDraftTargets, tgDrafts,
  tgGroups, tgOperators, tgPublications, telegramLinks, users,
} from '../../db/schema.js';
import { sweepHomeworkTokens } from './tokens.js';
import { FORMATTING_STALE_MS, MAX_ITEMS, PUBLISHING_STALE_MS } from './constants.js';
import type { HwActor, HwItemKind, HwLang } from './types.js';

export type HwDraftRow = typeof tgDrafts.$inferSelect;
export type HwDraftStatus = HwDraftRow['status'];
export type HwGroupRow = typeof tgGroups.$inferSelect;
export type HwItemRow = typeof tgDraftItems.$inferSelect;
export type HwPublicationRow = typeof tgPublications.$inferSelect;

/** `published`/`cancelled` are final; every other state still owns the teacher's attention. */
export const ACTIVE_DRAFT_STATUSES = [
  'selecting', 'choosing_materials', 'awaiting_instruction', 'collecting', 'formatting',
  'needs_clarification', 'preview', 'publishing', 'failed', 'publish_unknown',
] as const satisfies readonly HwDraftStatus[];

type DraftPatch = Partial<Pick<
  HwDraftRow,
  | 'title' | 'formattedText' | 'instruction' | 'aiQuestions' | 'aiWarnings'
  | 'aiProvider' | 'lastError' | 'publishedAt'
>>;

// ─── identity ────────────────────────────────────────────────────────────────

/** Same source of truth as the legacy bot: telegram_links → users. No parallel accounts. */
export async function resolveActor(
  db: DB, chatId: string, fallbackLang: HwLang,
): Promise<HwActor> {
  const [link] = await db.select({ userId: telegramLinks.userId, blockedAt: telegramLinks.blockedAt })
    .from(telegramLinks).where(eq(telegramLinks.chatId, chatId)).limit(1);
  if (link && !link.blockedAt) {
    const [u] = await db.select({ role: users.role, locale: users.locale, tz: users.tz })
      .from(users).where(and(eq(users.id, link.userId), isNull(users.deletedAt))).limit(1);
    if (u) {
      return {
        userId: link.userId, role: u.role as HwActor['role'],
        lang: u.locale as HwLang, tz: u.tz,
      };
    }
  }
  return { userId: null, role: null, lang: fallbackLang, tz: 'Asia/Tashkent' };
}

/** The personal chat id linked to a Telegram user id (usually they are equal, but not by contract). */
export async function linkedUserIdByTelegramId(db: DB, telegramUserId: number): Promise<string | null> {
  const [link] = await db.select({ userId: telegramLinks.userId, blockedAt: telegramLinks.blockedAt })
    .from(telegramLinks).where(eq(telegramLinks.chatId, String(telegramUserId))).limit(1);
  return link && !link.blockedAt ? link.userId : null;
}

export async function personalChatOf(db: DB, userId: string): Promise<string | null> {
  const [link] = await db.select({ chatId: telegramLinks.chatId, blockedAt: telegramLinks.blockedAt })
    .from(telegramLinks).where(eq(telegramLinks.userId, userId)).limit(1);
  return link && !link.blockedAt ? link.chatId : null;
}

export async function upsertOperator(
  db: DB,
  userId: string,
  telegramUserId: number,
  chatId: string,
  username: string,
  displayName: string,
): Promise<void> {
  const now = new Date();
  /*
   * `telegram_chat_id` is unique: it identifies the person, not the row. When a Telegram chat
   * is unlinked and linked to ANOTHER BluBlu account (a teacher who re-registers, an account
   * merge), the old operator row would otherwise block the new one — `/homework` would throw
   * on every press and the person would look like a broken bot to themselves. The chat moved,
   * so the operator row moves with it. Nothing else of the previous owner is touched: her
   * drafts and publications are keyed by user id and stay readable to her.
   */
  await db.delete(tgOperators).where(and(
    eq(tgOperators.telegramChatId, chatId),
    sql`${tgOperators.userId} <> ${userId}`,
  ));
  await db.insert(tgOperators).values({
    userId, telegramUserId, telegramChatId: chatId, username, displayName, updatedAt: now,
  }).onConflictDoUpdate({
    target: tgOperators.userId,
    set: { telegramUserId, telegramChatId: chatId, username, displayName, updatedAt: now },
  });
}

// ─── drafts ──────────────────────────────────────────────────────────────────

export async function latestActiveDraft(db: DB, ownerId: string): Promise<HwDraftRow | null> {
  const [row] = await db.select().from(tgDrafts).where(and(
    eq(tgDrafts.ownerId, ownerId),
    inArray(tgDrafts.status, [...ACTIVE_DRAFT_STATUSES]),
  )).orderBy(desc(tgDrafts.updatedAt)).limit(1);
  return row ?? null;
}

export async function getDraft(db: DB, draftId: string, ownerId: string): Promise<HwDraftRow | null> {
  if (!/^[0-9a-f-]{36}$/i.test(draftId)) return null;
  const [row] = await db.select().from(tgDrafts)
    .where(and(eq(tgDrafts.id, draftId), eq(tgDrafts.ownerId, ownerId))).limit(1);
  return row ?? null;
}

export async function createDraft(db: DB, ownerId: string): Promise<HwDraftRow> {
  const [row] = await db.insert(tgDrafts).values({ ownerId, status: 'selecting' }).returning();
  return row!;
}

/**
 * Compare-and-swap a draft. Returns the updated row only when its previous status was one
 * of `from`; otherwise null. This is the only way the flow moves a draft forward.
 */
export async function transitionDraft(
  db: DB,
  draftId: string,
  ownerId: string,
  from: readonly HwDraftStatus[],
  to: HwDraftStatus,
  patch: DraftPatch = {},
): Promise<HwDraftRow | null> {
  const [row] = await db.update(tgDrafts)
    .set({ ...patch, status: to, updatedAt: new Date() })
    .where(and(
      eq(tgDrafts.id, draftId),
      eq(tgDrafts.ownerId, ownerId),
      inArray(tgDrafts.status, [...from]),
    ))
    .returning();
  return row ?? null;
}

/** Patch without changing status (used when only the stored text changed). */
export async function patchDraft(
  db: DB, draftId: string, ownerId: string, patch: DraftPatch,
): Promise<HwDraftRow | null> {
  const [row] = await db.update(tgDrafts).set({ ...patch, updatedAt: new Date() })
    .where(and(eq(tgDrafts.id, draftId), eq(tgDrafts.ownerId, ownerId))).returning();
  return row ?? null;
}

// ─── groups ──────────────────────────────────────────────────────────────────

export async function listGroups(
  db: DB, ownerId: string, includeRemoved = false,
): Promise<HwGroupRow[]> {
  const where = includeRemoved
    ? eq(tgGroups.ownerId, ownerId)
    : and(eq(tgGroups.ownerId, ownerId), eq(tgGroups.status, 'active'));
  return db.select().from(tgGroups).where(where).orderBy(asc(tgGroups.boundAt));
}

export async function groupOwned(db: DB, groupId: string, ownerId: string): Promise<HwGroupRow | null> {
  if (!/^[0-9a-f-]{36}$/i.test(groupId)) return null;
  const [row] = await db.select().from(tgGroups)
    .where(and(eq(tgGroups.id, groupId), eq(tgGroups.ownerId, ownerId))).limit(1);
  return row ?? null;
}

/** Binding is an upsert: re-binding a previously removed group makes it active again. */
export async function addGroup(
  db: DB, ownerId: string, telegramChatId: string, title: string,
): Promise<HwGroupRow> {
  const [row] = await db.insert(tgGroups).values({
    ownerId, telegramChatId, title, kind: 'offline', status: 'active', updatedAt: new Date(),
  }).onConflictDoUpdate({
    target: [tgGroups.ownerId, tgGroups.telegramChatId],
    set: { title, status: 'active', updatedAt: new Date() },
  }).returning();
  return row!;
}

export async function removeGroup(db: DB, groupId: string, ownerId: string): Promise<boolean> {
  const removed = await db.update(tgGroups)
    .set({ status: 'removed', updatedAt: new Date() })
    .where(and(eq(tgGroups.id, groupId), eq(tgGroups.ownerId, ownerId)))
    .returning({ id: tgGroups.id });
  if (!removed.length) return false;
  // A removed group must not stay silently selected in a draft. Publications are history
  // and are deliberately untouched.
  await db.delete(tgDraftTargets).where(eq(tgDraftTargets.groupId, groupId));
  return true;
}

export async function setGroupKind(
  db: DB, groupId: string, ownerId: string, kind: 'online' | 'offline',
): Promise<boolean> {
  const rows = await db.update(tgGroups).set({ kind, updatedAt: new Date() })
    .where(and(eq(tgGroups.id, groupId), eq(tgGroups.ownerId, ownerId)))
    .returning({ id: tgGroups.id });
  return rows.length > 0;
}

export interface SelectedGroup {
  id: string;
  title: string;
  telegramChatId: string;
  kind: 'online' | 'offline';
}

/** Selected groups of a draft, active only, in selection order. */
export async function selectedGroups(db: DB, draftId: string): Promise<SelectedGroup[]> {
  const rows = await db.select({
    id: tgGroups.id,
    title: tgGroups.title,
    telegramChatId: tgGroups.telegramChatId,
    kind: tgGroups.kind,
    status: tgGroups.status,
    position: tgDraftTargets.position,
  }).from(tgDraftTargets)
    .innerJoin(tgGroups, eq(tgGroups.id, tgDraftTargets.groupId))
    .where(eq(tgDraftTargets.draftId, draftId))
    .orderBy(asc(tgDraftTargets.position));
  return rows
    .filter((r) => r.status === 'active')
    .map(({ id, title, telegramChatId, kind }) => ({ id, title, telegramChatId, kind }));
}

/** Add/remove one group from a draft. Returns true when it is selected afterwards. */
export async function toggleTarget(
  db: DB, draftId: string, groupId: string, ownerId: string,
): Promise<boolean | null> {
  const group = await groupOwned(db, groupId, ownerId);
  if (!group || group.status !== 'active') return null;
  const [existing] = await db.select({ groupId: tgDraftTargets.groupId }).from(tgDraftTargets)
    .where(and(eq(tgDraftTargets.draftId, draftId), eq(tgDraftTargets.groupId, groupId))).limit(1);
  if (existing) {
    await db.delete(tgDraftTargets)
      .where(and(eq(tgDraftTargets.draftId, draftId), eq(tgDraftTargets.groupId, groupId)));
    return false;
  }
  const [max] = await db.select({ n: sql<number>`coalesce(max(${tgDraftTargets.position}), 0)` })
    .from(tgDraftTargets).where(eq(tgDraftTargets.draftId, draftId));
  await db.insert(tgDraftTargets).values({
    draftId, groupId, position: Number(max?.n ?? 0) + 1,
  }).onConflictDoNothing();
  return true;
}

// ─── materials ───────────────────────────────────────────────────────────────

export interface NewItem {
  kind: HwItemKind;
  text?: string;
  url?: string | null;
  fileId?: string | null;
  fileUniqueId?: string | null;
  fileName?: string | null;
  mimeType?: string | null;
  fileSize?: number | null;
  caption?: string;
  sourceMessageId: number;
  forwarded?: boolean;
}

export async function itemCount(db: DB, draftId: string): Promise<number> {
  const [row] = await db.select({ n: count() }).from(tgDraftItems).where(eq(tgDraftItems.draftId, draftId));
  return Number(row?.n ?? 0);
}

export async function listItems(db: DB, draftId: string): Promise<HwItemRow[]> {
  return db.select().from(tgDraftItems).where(eq(tgDraftItems.draftId, draftId))
    .orderBy(asc(tgDraftItems.position));
}

/**
 * Append one material. `unique(draft, source_message)` makes webhook redelivery harmless:
 * a message that was already stored returns null instead of creating a second copy.
 */
export async function addItem(db: DB, draftId: string, item: NewItem): Promise<HwItemRow | null> {
  if ((await itemCount(db, draftId)) >= MAX_ITEMS) return null;
  const [max] = await db.select({ n: sql<number>`coalesce(max(${tgDraftItems.position}), 0)` })
    .from(tgDraftItems).where(eq(tgDraftItems.draftId, draftId));
  const inserted = await db.insert(tgDraftItems).values({
    draftId,
    position: Number(max?.n ?? 0) + 1,
    kind: item.kind,
    text: item.text ?? '',
    url: item.url ?? null,
    fileId: item.fileId ?? null,
    fileUniqueId: item.fileUniqueId ?? null,
    fileName: item.fileName ?? null,
    mimeType: item.mimeType ?? null,
    fileSize: item.fileSize ?? null,
    caption: item.caption ?? '',
    sourceMessageId: item.sourceMessageId,
    forwarded: item.forwarded ?? false,
  }).onConflictDoNothing({
    target: [tgDraftItems.draftId, tgDraftItems.sourceMessageId],
  }).returning();
  return inserted[0] ?? null;
}

// ─── publications / history ───────────────────────────────────────────────────

export async function publicationsOf(db: DB, draftId: string): Promise<HwPublicationRow[]> {
  return db.select().from(tgPublications).where(eq(tgPublications.draftId, draftId))
    .orderBy(asc(tgPublications.createdAt));
}

export interface HistoryRow {
  id: string;
  status: HwPublicationRow['status'];
  groupTitle: string;
  updatedAt: Date;
  draftId: string;
  draftTitle: string;
}

export async function recentPublications(
  db: DB, ownerId: string, limit = 12,
): Promise<HistoryRow[]> {
  return db.select({
    id: tgPublications.id,
    status: tgPublications.status,
    groupTitle: tgPublications.groupTitle,
    updatedAt: tgPublications.updatedAt,
    draftId: tgPublications.draftId,
    draftTitle: tgDrafts.title,
  }).from(tgPublications)
    .innerJoin(tgDrafts, eq(tgDrafts.id, tgPublications.draftId))
    .where(eq(tgDrafts.ownerId, ownerId))
    .orderBy(desc(tgPublications.updatedAt))
    .limit(limit);
}

// ─── edit session (reuses the existing bot_sessions table, state `hw:edit`) ───

export const HW_EDIT_STATE = 'hw:edit';

export async function saveEditSession(
  db: DB, chatId: string, draftId: string, revision: string,
): Promise<void> {
  const expiresAt = new Date(Date.now() + 30 * 60_000);
  await db.insert(botSessions).values({
    chatId, state: HW_EDIT_STATE, data: { draftId, revision }, expiresAt, updatedAt: new Date(),
  }).onConflictDoUpdate({
    target: botSessions.chatId,
    set: { state: HW_EDIT_STATE, data: { draftId, revision }, expiresAt, updatedAt: new Date() },
  });
}

export async function clearHomeworkSession(db: DB, chatId: string): Promise<void> {
  await db.delete(botSessions).where(and(eq(botSessions.chatId, chatId), eq(botSessions.state, HW_EDIT_STATE)));
}

// ─── housekeeping ────────────────────────────────────────────────────────────

/**
 * A process that died while formatting leaves `formatting` behind; the teacher may simply
 * press Done again. A process that died while publishing is different: at least one message
 * may already be in a group, so the draft becomes `publish_unknown` and every unfinished
 * row becomes `uncertain` — never silently retried.
 */
export async function sweepHomeworkState(db: DB, now = new Date()): Promise<void> {
  const formattingCut = new Date(now.getTime() - FORMATTING_STALE_MS);
  const publishingCut = new Date(now.getTime() - PUBLISHING_STALE_MS);
  await db.update(tgPublications).set({ status: 'uncertain', updatedAt: now })
    .where(and(eq(tgPublications.status, 'sending'), lt(tgPublications.updatedAt, publishingCut)));
  await db.update(tgDrafts).set({ status: 'publish_unknown', updatedAt: now })
    .where(and(eq(tgDrafts.status, 'publishing'), lt(tgDrafts.updatedAt, publishingCut)));
  await db.update(tgDrafts).set({ status: 'collecting', lastError: 'formatting interrupted', updatedAt: now })
    .where(and(eq(tgDrafts.status, 'formatting'), lt(tgDrafts.updatedAt, formattingCut)));
  await sweepHomeworkTokens(db, now);
}

