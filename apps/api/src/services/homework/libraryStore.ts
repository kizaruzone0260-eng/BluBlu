/**
 * Persistence for the teacher's material library (part B, 2026-10-22).
 *
 * A material is a FILE the teacher uploads once (a textbook, a workbook) and re-uses as an
 * attachment. Only Telegram's `file_id` and metadata are stored — never the bytes, and never
 * anything extracted from the document. Every read and write here is keyed by the owner id:
 * one teacher can never list, rename, archive or delete another teacher's material, and the
 * caller cannot reach a group that is not hers.
 *
 * The draft copy (`tg_draft_materials`) is a snapshot on purpose: renaming or deleting a
 * library entry must not rewrite a draft that is being written, and must never change the
 * history of what was already published.
 */
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { DB } from '../../db/index.js';
import {
  botSessions, tgDraftMaterials, tgDraftTargets, tgGroups, tgMaterialGroups, tgMaterials,
} from '../../db/schema.js';
import {
  LIBRARY_SESSION_TTL_MIN, MAX_DRAFT_MATERIALS, MAX_MATERIALS, MAX_MATERIAL_TITLE,
} from './constants.js';
import type { HwMaterialKind } from './types.js';

export type HwMaterialRow = typeof tgMaterials.$inferSelect;
export type HwDraftMaterialRow = typeof tgDraftMaterials.$inferSelect;

/** The one text-input dialog the library owns (bot_sessions, prefix `hw:` like the draft). */
export const HW_LIB_STATE = 'hw:lib';

export interface MaterialInput {
  title: string;
  kind: HwMaterialKind;
  fileId: string;
  fileUniqueId: string;
  fileName: string;
  mimeType: string;
  fileSize: number | null;
  groupIds: string[];
  /**
   * Where the file physically is in Telegram: the teacher's own message. Publication copies
   * THAT message instead of re-sending a `file_id`, so the media keeps the type it arrived
   * with — `mediaType` is recorded, never guessed from the MIME type.
   */
  mediaType?: 'photo' | 'document' | null;
  sourceChatId?: string | null;
  sourceMessageId?: number | null;
}

export type SaveMaterialResult =
  | { status: 'created'; row: HwMaterialRow }
  | { status: 'updated'; row: HwMaterialRow }
  | { status: 'limit' }
  | { status: 'noGroups' }
  | { status: 'invalid' };

const cleanTitle = (value: string): string => value.trim().slice(0, MAX_MATERIAL_TITLE);

/** Active groups of THIS owner, in the order asked for. Anything else simply does not exist. */
export async function ownedActiveGroupIds(db: DB, ownerId: string, ids: string[]): Promise<string[]> {
  const unique = [...new Set(ids.filter((id) => /^[0-9a-f-]{36}$/i.test(id)))];
  if (!unique.length) return [];
  const rows = await db.select({ id: tgGroups.id }).from(tgGroups)
    .where(and(
      eq(tgGroups.ownerId, ownerId),
      eq(tgGroups.status, 'active'),
      inArray(tgGroups.id, unique),
    ));
  const found = new Set(rows.map((r) => r.id));
  return unique.filter((id) => found.has(id));
}

export async function countMaterials(db: DB, ownerId: string): Promise<number> {
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(tgMaterials)
    .where(eq(tgMaterials.ownerId, ownerId));
  return Number(row?.n ?? 0);
}

/**
 * Save an uploaded file. The same `file_unique_id` updates the existing row instead of
 * filling the library with copies of one book — which is also how a broken `file_id` gets
 * repaired: re-uploading the file replaces the identifier in place.
 */
export async function saveMaterial(
  db: DB, ownerId: string, input: MaterialInput,
): Promise<SaveMaterialResult> {
  const title = cleanTitle(input.title);
  if (!title || !input.fileId || !input.fileUniqueId) return { status: 'noGroups' };
  const groupIds = await ownedActiveGroupIds(db, ownerId, input.groupIds);
  if (!groupIds.length) return { status: 'noGroups' };

  const [existing] = await db.select().from(tgMaterials)
    .where(and(eq(tgMaterials.ownerId, ownerId), eq(tgMaterials.fileUniqueId, input.fileUniqueId)))
    .limit(1);
  if (!existing && (await countMaterials(db, ownerId)) >= MAX_MATERIALS) return { status: 'limit' };

  const now = new Date();
  const values = {
    ownerId, title, kind: input.kind, telegramFileId: input.fileId,
    fileUniqueId: input.fileUniqueId, fileName: input.fileName.slice(0, 300),
    mimeType: input.mimeType.slice(0, 120), fileSize: input.fileSize,
    mediaType: input.mediaType ?? null,
    sourceChatId: input.sourceChatId ?? null,
    sourceMessageId: input.sourceMessageId ?? null,
    status: 'active' as const, updatedAt: now,
  };
  // A re-upload is a NEW message in a NEW place: the copy coordinates move with the file.
  const saved = existing
    ? await db.update(tgMaterials).set({
      title: values.title, kind: values.kind, telegramFileId: values.telegramFileId,
      fileName: values.fileName, mimeType: values.mimeType, fileSize: values.fileSize,
      mediaType: values.mediaType, sourceChatId: values.sourceChatId,
      sourceMessageId: values.sourceMessageId, status: 'active', updatedAt: now,
    }).where(eq(tgMaterials.id, existing.id)).returning()
    : await db.insert(tgMaterials).values(values).returning();
  const row = saved[0];
  if (!row) return { status: 'noGroups' };

  if (groupIds.length) {
    await db.insert(tgMaterialGroups).values(
      groupIds.map((groupId) => ({ materialId: row.id, groupId })),
    ).onConflictDoNothing();
  }
  return existing ? { status: 'updated', row } : { status: 'created', row };
}

export async function getMaterial(db: DB, materialId: string, ownerId: string): Promise<HwMaterialRow | null> {
  if (!/^[0-9a-f-]{36}$/i.test(materialId)) return null;
  const [row] = await db.select().from(tgMaterials)
    .where(and(eq(tgMaterials.id, materialId), eq(tgMaterials.ownerId, ownerId))).limit(1);
  return row ?? null;
}

/**
 * Materials recommended for a draft: ACTIVE and attached to EVERY selected group.
 *
 * The `all groups` rule is what keeps a book out of a group it was never meant for: with two
 * target groups the teacher sees only what both of them may get, so the same message and the
 * same attachment land in each. Recently used first, then newest — no AI ranking in v1.
 */
export async function eligibleMaterials(
  db: DB, ownerId: string, groupIds: string[], limit = 20,
): Promise<HwMaterialRow[]> {
  const ids = await ownedActiveGroupIds(db, ownerId, groupIds);
  if (!ids.length) return [];
  const chosen = await db.select({ materialId: tgMaterialGroups.materialId })
    .from(tgMaterialGroups)
    .innerJoin(
      tgMaterials,
      and(eq(tgMaterials.id, tgMaterialGroups.materialId), eq(tgMaterials.ownerId, ownerId)),
    )
    .where(and(
      eq(tgMaterials.status, 'active'),
      inArray(tgMaterialGroups.groupId, ids),
    ))
    .groupBy(tgMaterialGroups.materialId)
    .having(sql`count(distinct ${tgMaterialGroups.groupId}) = ${ids.length}`);
  const materialIds = chosen.map((r) => r.materialId);
  if (!materialIds.length) return [];
  return db.select().from(tgMaterials)
    .where(and(
      eq(tgMaterials.ownerId, ownerId),
      eq(tgMaterials.status, 'active'),
      inArray(tgMaterials.id, materialIds),
    ))
    .orderBy(sql`${tgMaterials.lastUsedAt} desc nulls last`, desc(tgMaterials.createdAt))
    .limit(limit);
}

export async function materialsOfGroup(
  db: DB, ownerId: string, groupId: string, opts: { includeArchived?: boolean; limit?: number } = {},
): Promise<HwMaterialRow[]> {
  if (!(await ownedActiveGroupIds(db, ownerId, [groupId])).length) return [];
  const links = await db.select({ materialId: tgMaterialGroups.materialId })
    .from(tgMaterialGroups).where(eq(tgMaterialGroups.groupId, groupId));
  const ids = links.map((l) => l.materialId);
  if (!ids.length) return [];
  const filters = [eq(tgMaterials.ownerId, ownerId), inArray(tgMaterials.id, ids)];
  if (!opts.includeArchived) filters.push(eq(tgMaterials.status, 'active'));
  return db.select().from(tgMaterials).where(and(...filters))
    .orderBy(sql`${tgMaterials.lastUsedAt} desc nulls last`, desc(tgMaterials.createdAt))
    .limit(opts.limit ?? 20);
}

/** Library list for management: everything the owner has, optionally filtered by one group. */
export async function listMaterials(
  db: DB, ownerId: string, opts: { groupId?: string; includeArchived?: boolean; limit?: number } = {},
): Promise<HwMaterialRow[]> {
  if (opts.groupId) return materialsOfGroup(db, ownerId, opts.groupId, opts);
  const filters = [eq(tgMaterials.ownerId, ownerId)];
  if (!opts.includeArchived) filters.push(eq(tgMaterials.status, 'active'));
  return db.select().from(tgMaterials).where(and(...filters))
    .orderBy(desc(tgMaterials.updatedAt))
    .limit(opts.limit ?? 20);
}

/** Groups screen: how many ACTIVE materials each of the owner's groups has. */
export async function materialCountByGroup(
  db: DB, ownerId: string,
): Promise<Map<string, number>> {
  const rows = await db.execute(sql`
    select g.id as group_id, count(m.id)::int as n
      from tg_groups g
      left join tg_material_groups mg on mg.group_id = g.id
      left join tg_materials m on m.id = mg.material_id
       and m.owner_id = ${ownerId} and m.status = 'active'
     where g.owner_id = ${ownerId} and g.status = 'active'
     group by g.id`);
  const list = (Array.isArray(rows) ? rows : (rows as { rows?: unknown[] }).rows ?? []) as
    { group_id: string; n: number }[];
  return new Map(list.map((r) => [r.group_id, Number(r.n)]));
}

export async function materialGroupIds(db: DB, materialId: string): Promise<string[]> {
  const rows = await db.select({ groupId: tgMaterialGroups.groupId }).from(tgMaterialGroups)
    .where(eq(tgMaterialGroups.materialId, materialId));
  return rows.map((r) => r.groupId);
}

/** «Использовать в другой группе». Ownership of BOTH rows is re-checked here. */
export async function linkMaterialGroup(
  db: DB, materialId: string, ownerId: string, groupId: string,
): Promise<boolean> {
  const material = await getMaterial(db, materialId, ownerId);
  if (!material) return false;
  const owned = await ownedActiveGroupIds(db, ownerId, [groupId]);
  if (!owned.length) return false;
  const inserted = await db.insert(tgMaterialGroups).values({ materialId, groupId: owned[0]! })
    .onConflictDoNothing().returning({ materialId: tgMaterialGroups.materialId });
  return inserted.length > 0;
}

export async function renameMaterial(
  db: DB, materialId: string, ownerId: string, title: string,
): Promise<HwMaterialRow | null> {
  const clean = cleanTitle(title);
  if (!clean) return null;
  const rows = await db.update(tgMaterials)
    .set({ title: clean, updatedAt: new Date() })
    .where(and(eq(tgMaterials.id, materialId), eq(tgMaterials.ownerId, ownerId)))
    .returning();
  return rows[0] ?? null;
}

export async function setMaterialStatus(
  db: DB, materialId: string, ownerId: string, status: 'active' | 'archived',
): Promise<HwMaterialRow | null> {
  const rows = await db.update(tgMaterials)
    .set({ status, updatedAt: new Date() })
    .where(and(eq(tgMaterials.id, materialId), eq(tgMaterials.ownerId, ownerId)))
    .returning();
  return rows[0] ?? null;
}

/**
 * Delete from the library. Draft snapshots survive (`material_id` → NULL) and publications
 * are untouched, so the group history and the teacher's own history keep the titles that
 * were actually sent.
 */
export async function deleteMaterial(db: DB, materialId: string, ownerId: string): Promise<boolean> {
  const rows = await db.delete(tgMaterials)
    .where(and(eq(tgMaterials.id, materialId), eq(tgMaterials.ownerId, ownerId)))
    .returning({ id: tgMaterials.id });
  return rows.length > 0;
}

/** «Последнее использование» — only what a publication actually reached a group with. */
export async function markMaterialsUsed(
  db: DB, ownerId: string, materialIds: string[], when = new Date(),
): Promise<void> {
  const ids = [...new Set(materialIds.filter((id) => /^[0-9a-f-]{36}$/i.test(id)))];
  if (!ids.length) return;
  await db.update(tgMaterials).set({ lastUsedAt: when })
    .where(and(eq(tgMaterials.ownerId, ownerId), inArray(tgMaterials.id, ids)));
}

// ─── materials chosen for one draft ──────────────────────────────────────────

export async function listDraftMaterials(db: DB, draftId: string): Promise<HwDraftMaterialRow[]> {
  return db.select().from(tgDraftMaterials).where(eq(tgDraftMaterials.draftId, draftId))
    .orderBy(asc(tgDraftMaterials.position));
}

export async function draftMaterialCount(db: DB, draftId: string): Promise<number> {
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(tgDraftMaterials)
    .where(eq(tgDraftMaterials.draftId, draftId));
  return Number(row?.n ?? 0);
}

/**
 * Choose or un-choose one library material for a draft. The caller decides eligibility (the
 * picker only ever offers eligible rows), this function proves ownership again.
 */
export async function toggleDraftMaterial(
  db: DB, draftId: string, ownerId: string, materialId: string,
): Promise<'added' | 'removed' | 'limit' | 'missing'> {
  const existing = await db.select().from(tgDraftMaterials)
    .where(and(eq(tgDraftMaterials.draftId, draftId), eq(tgDraftMaterials.materialId, materialId)))
    .limit(1);
  if (existing.length) {
    await db.delete(tgDraftMaterials)
      .where(and(eq(tgDraftMaterials.draftId, draftId), eq(tgDraftMaterials.materialId, materialId)));
    return 'removed';
  }
  const material = await getMaterial(db, materialId, ownerId);
  if (!material) return 'missing';
  if (material.status !== 'active') return 'missing';
  if ((await draftMaterialCount(db, draftId)) >= MAX_DRAFT_MATERIALS) return 'limit';
  const [max] = await db.select({ n: sql<number>`coalesce(max(${tgDraftMaterials.position}), 0)` })
    .from(tgDraftMaterials).where(eq(tgDraftMaterials.draftId, draftId));
  const inserted = await db.insert(tgDraftMaterials).values({
    draftId, materialId: material.id, position: Number(max?.n ?? 0) + 1,
    title: material.title, kind: material.kind, telegramFileId: material.telegramFileId,
    fileUniqueId: material.fileUniqueId, fileName: material.fileName,
    mimeType: material.mimeType, fileSize: material.fileSize,
    mediaType: material.mediaType, sourceChatId: material.sourceChatId,
    sourceMessageId: material.sourceMessageId,
  }).onConflictDoNothing().returning();
  return inserted.length ? 'added' : 'missing';
}

/**
 * Replace the whole material selection of a draft (Mini App step 3).
 *
 * The picker shows `eligibleMaterials`, and this function proves the same rule again: every
 * requested row must be the owner's ACTIVE material and recommended for ALL currently selected
 * groups. A client that sends someone else's material id, an archived row or a book attached
 * to only one of three groups gets a refusal, not a partial selection.
 */
export type SetDraftMaterialsResult =
  | { status: 'ok'; materials: HwDraftMaterialRow[] }
  | { status: 'noGroups' }
  | { status: 'notEligible' }
  | { status: 'limit' };

export async function setDraftMaterials(
  db: DB, draftId: string, ownerId: string, materialIds: string[],
): Promise<SetDraftMaterialsResult> {
  const ids = [...new Set(materialIds)];
  if (ids.length !== materialIds.length) return { status: 'notEligible' };
  if (ids.some((id) => !/^[0-9a-f-]{36}$/i.test(id))) return { status: 'notEligible' };
  if (ids.length > MAX_DRAFT_MATERIALS) return { status: 'limit' };
  const targets = await db.select({ groupId: tgDraftTargets.groupId }).from(tgDraftTargets)
    .where(eq(tgDraftTargets.draftId, draftId));
  const groupIds = targets.map((t) => t.groupId);
  if (!groupIds.length) return { status: 'noGroups' };

  const eligible = ids.length ? await eligibleMaterials(db, ownerId, groupIds, MAX_MATERIALS) : [];
  const byId = new Map(eligible.map((m) => [m.id, m]));
  if (ids.some((id) => !byId.has(id))) return { status: 'notEligible' };

  await db.transaction(async (tx) => {
    await tx.delete(tgDraftMaterials).where(eq(tgDraftMaterials.draftId, draftId));
    if (ids.length) {
      await tx.insert(tgDraftMaterials).values(ids.map((id, index) => {
        const m = byId.get(id)!;
        return {
          draftId, materialId: m.id, position: index + 1,
          title: m.title, kind: m.kind, telegramFileId: m.telegramFileId,
          fileUniqueId: m.fileUniqueId, fileName: m.fileName,
          mimeType: m.mimeType, fileSize: m.fileSize,
          mediaType: m.mediaType, sourceChatId: m.sourceChatId,
          sourceMessageId: m.sourceMessageId,
        };
      }));
    }
  });
  return { status: 'ok', materials: await listDraftMaterials(db, draftId) };
}

/**
 * A material uploaded during the homework flow is chosen for that draft immediately.
 */
export async function attachDraftMaterial(
  db: DB, draftId: string, material: HwMaterialRow,
): Promise<'added' | 'exists' | 'limit'> {
  if ((await draftMaterialCount(db, draftId)) >= MAX_DRAFT_MATERIALS) return 'limit';
  const [max] = await db.select({ n: sql<number>`coalesce(max(${tgDraftMaterials.position}), 0)` })
    .from(tgDraftMaterials).where(eq(tgDraftMaterials.draftId, draftId));
  const inserted = await db.insert(tgDraftMaterials).values({
    draftId, materialId: material.id, position: Number(max?.n ?? 0) + 1,
    title: material.title, kind: material.kind, telegramFileId: material.telegramFileId,
    fileUniqueId: material.fileUniqueId, fileName: material.fileName,
    mimeType: material.mimeType, fileSize: material.fileSize,
    mediaType: material.mediaType, sourceChatId: material.sourceChatId,
    sourceMessageId: material.sourceMessageId,
  }).onConflictDoNothing().returning({ id: tgDraftMaterials.id });
  return inserted.length ? 'added' : 'exists';
}

export async function dropDraftMaterials(
  db: DB, draftId: string, ids: string[],
): Promise<string[]> {
  if (!ids.length) return [];
  const rows = await db.delete(tgDraftMaterials)
    .where(and(eq(tgDraftMaterials.draftId, draftId), inArray(tgDraftMaterials.id, ids)))
    .returning({ title: tgDraftMaterials.title });
  return rows.map((r) => r.title);
}

/**
 * Groups changed ⇒ a snapshot chosen for the old set is no longer a decision the teacher
 * made for these groups. Drop those (a snapshot whose library row is gone stays: deleting a
 * book must not rewrite a draft). Returns the titles dropped, for the message.
 */
export async function pruneDraftMaterials(
  db: DB, draftId: string, ownerId: string,
): Promise<string[]> {
  const targets = await db.select({ groupId: tgDraftTargets.groupId }).from(tgDraftTargets)
    .where(eq(tgDraftTargets.draftId, draftId));
  const eligible = await eligibleMaterials(db, ownerId, targets.map((t) => t.groupId), MAX_MATERIALS);
  const allowed = new Set(eligible.map((m) => m.id));
  const stale = (await listDraftMaterials(db, draftId))
    .filter((row) => row.materialId !== null && !allowed.has(row.materialId!))
    .map((row) => row.id);
  return dropDraftMaterials(db, draftId, stale);
}

// ─── the one text dialog the library owns ────────────────────────────────────

export interface LibSessionData {
  step: string;
  [key: string]: unknown;
}

export async function saveLibrarySession(
  db: DB, chatId: string, data: LibSessionData,
): Promise<void> {
  const expiresAt = new Date(Date.now() + LIBRARY_SESSION_TTL_MIN * 60_000);
  await db.insert(botSessions).values({
    chatId, state: HW_LIB_STATE, data: data as Record<string, unknown>, expiresAt,
    updatedAt: new Date(),
  }).onConflictDoUpdate({
    target: botSessions.chatId,
    set: {
      state: HW_LIB_STATE, data: data as Record<string, unknown>, expiresAt, updatedAt: new Date(),
    },
  });
}

export async function clearLibrarySession(db: DB, chatId: string): Promise<void> {
  await db.delete(botSessions).where(and(eq(botSessions.chatId, chatId), eq(botSessions.state, HW_LIB_STATE)));
}

/** The dialog a callback or a file belongs to. An expired row is dropped, like the bot's own. */
export async function loadLibrarySession(db: DB, chatId: string): Promise<LibSessionData | null> {
  const [row] = await db.select().from(botSessions).where(eq(botSessions.chatId, chatId)).limit(1);
  if (!row || row.state !== HW_LIB_STATE) return null;
  if (row.expiresAt.getTime() <= Date.now()) {
    await db.delete(botSessions).where(eq(botSessions.chatId, chatId));
    return null;
  }
  return row.data as unknown as LibSessionData;
}
