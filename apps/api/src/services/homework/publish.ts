/**
 * Publication to Telegram chats.
 *
 * Safety rules, in order of importance:
 *  • only an explicit button press starts this (the flow verifies the callback and revision);
 *  • the draft moves `preview → publishing` with one compare-and-swap update, so a second
 *    press cannot start a second run;
 *  • a library attachment is checked BEFORE anything is sent. If Telegram no longer accepts
 *    that `file_id`, nothing goes out at all: a half-published homework is exactly the
 *    duplicate the teacher must not receive;
 *  • rows are unique per (draft, group), and a group is sent to sequentially;
 *  • a failure is `failed` only when Telegram itself refused and NOTHING was delivered for
 *    that group. Any later interruption is `uncertain` — at least one message may have
 *    arrived, and such a row is never retried automatically;
 *  • after a crash, housekeeping turns `sending` into `uncertain` and the draft into
 *    `publish_unknown`, never back into a retryable state.
 */
import { and, eq } from 'drizzle-orm';
import type { DB } from '../../db/index.js';
import { tgDraftItems, tgDrafts, tgGroups, tgPublications } from '../../db/schema.js';
import { safeErrorMessage } from '../../lib/redact.js';
import type { BotApi } from '../botApi.js';
import { PUBLISH_CHUNK } from './constants.js';
import {
  dropDraftMaterials, listDraftMaterials, markMaterialsUsed, type HwDraftMaterialRow,
} from './libraryStore.js';
import {
  publicationsOf, selectedGroups, transitionDraft,
  type HwDraftRow, type HwItemRow, type HwPublicationRow,
} from './store.js';

export type PublishKind = 'already' | 'noTargets' | 'done' | 'unexpected' | 'fileMissing';

export interface PublishOutcome {
  kind: PublishKind;
  draft: HwDraftRow | null;
  rows: HwPublicationRow[];
  /** Titles of the library files Telegram refuses to re-send (only for `fileMissing`). */
  missing: string[];
}

/** Split a long message at a newline when possible; Telegram's limit is 4096 units. */
export function splitText(text: string, limit = PUBLISH_CHUNK): string[] {
  let rest = text.replace(/\r\n/g, '\n').trim();
  const chunks: string[] = [];
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit);
    if (cut < Math.floor(limit * 0.5)) cut = limit;
    const chunk = rest.slice(0, cut).trimEnd();
    if (chunk) chunks.push(chunk);
    rest = rest.slice(cut).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

/** Telegram refused this exact call: 4xx means the request never became a message. */
function telegramRejected(err: unknown): boolean {
  const e = err as { error_code?: unknown; error?: { error_code?: unknown } };
  const code = typeof e?.error_code === 'number' ? e.error_code
    : typeof e?.error?.error_code === 'number' ? e.error.error_code : null;
  return code !== null && code >= 400 && code < 500;
}

interface SendResult {
  ok: boolean;
  delivered: number;
  messageId: number | null;
  error: string;
  definite: boolean;
}

/** Photos go out as photos, everything else as a document — the file keeps its own name. */
async function sendAttachment(api: BotApi, chatId: string, file: { fileId: string; mime: string }) {
  return file.mime.startsWith('image/')
    ? api.sendPhoto(chatId, file.fileId)
    : api.sendDocument(chatId, file.fileId);
}

async function sendOne(
  api: BotApi, pub: HwPublicationRow, text: string, items: HwItemRow[],
  materials: HwDraftMaterialRow[],
): Promise<SendResult> {
  let delivered = 0;
  let messageId: number | null = null;
  try {
    for (const chunk of splitText(text)) {
      messageId = await api.sendMessage(pub.telegramChatId, chunk);
      delivered++;
    }
    for (const m of materials) {
      messageId = await sendAttachment(api, pub.telegramChatId, {
        fileId: m.telegramFileId, mime: m.mimeType,
      });
      delivered++;
    }
    for (const item of items) {
      if (item.kind === 'photo' && item.fileId) {
        messageId = await api.sendPhoto(pub.telegramChatId, item.fileId);
        delivered++;
      } else if (item.kind === 'document' && item.fileId) {
        messageId = await api.sendDocument(pub.telegramChatId, item.fileId);
        delivered++;
      }
    }
    return { ok: true, delivered, messageId, error: '', definite: false };
  } catch (e) {
    return {
      ok: false,
      delivered,
      messageId,
      error: safeErrorMessage(e).slice(0, 300) || 'telegram send failed',
      // Only a refusal with zero delivered parts is safe to retry; anything else may be a
      // duplicate on the next attempt.
      definite: delivered === 0 && telegramRejected(e),
    };
  }
}

/**
 * Ask Telegram whether each chosen file can still be re-sent. `getFile` reads metadata only —
 * no bytes are downloaded and nothing is analysed, which is the whole point of the library.
 * Anything but a definite 4xx counts as "try to send": a network hiccup must not stop a
 * homework, while a dead `file_id` must.
 */
async function unusableMaterials(db: DB, api: BotApi, draftId: string): Promise<HwDraftMaterialRow[]> {
  const bad: HwDraftMaterialRow[] = [];
  for (const m of await listDraftMaterials(db, draftId)) {
    const state = await api.checkFile(m.telegramFileId).catch(() => 'unknown' as const);
    if (state === 'missing') bad.push(m);
  }
  return bad;
}

async function finalize(
  db: DB, draftId: string, ownerId: string,
): Promise<HwDraftRow | null> {
  const rows = await publicationsOf(db, draftId);
  // «Последнее использование» only for a book that actually reached somebody.
  if (rows.some((r) => r.status === 'sent' || r.status === 'uncertain')) {
    const ids = (await listDraftMaterials(db, draftId))
      .map((m) => m.materialId).filter((id): id is string => Boolean(id));
    await markMaterialsUsed(db, ownerId, ids).catch(() => undefined);
  }
  if (rows.some((r) => r.status === 'uncertain' || r.status === 'sending')) {
    return transitionDraft(db, draftId, ownerId, ['publishing'], 'publish_unknown');
  }
  if (rows.some((r) => r.status === 'failed')) {
    return transitionDraft(db, draftId, ownerId, ['publishing'], 'failed');
  }
  return transitionDraft(db, draftId, ownerId, ['publishing'], 'published', { publishedAt: new Date() });
}

async function sendRows(
  db: DB, api: BotApi, ownerId: string, draftId: string, rows: HwPublicationRow[],
): Promise<void> {
  const [draft] = await db.select().from(tgDrafts)
    .where(and(eq(tgDrafts.id, draftId), eq(tgDrafts.ownerId, ownerId))).limit(1);
  const items = await db.select().from(tgDraftItems).where(eq(tgDraftItems.draftId, draftId))
    .orderBy(tgDraftItems.position);
  const materials = await listDraftMaterials(db, draftId);
  const text = (draft?.formattedText.trim() || draft?.title.trim() || '').trim();

  for (const pub of rows) {
    const result = await sendOne(api, pub, text, items, materials);
    const status = result.ok ? 'sent' : result.definite ? 'failed' : 'uncertain';
    await db.update(tgPublications).set({
      status,
      telegramMessageId: result.messageId,
      error: result.error,
      updatedAt: new Date(),
    }).where(eq(tgPublications.id, pub.id));
  }
}

/**
 * First publication of a draft. Only `preview` may enter. New rows are inserted with
 * `onConflictDoNothing`, so the unique (draft, group) key itself is the last line of defence.
 */
export async function publishDraft(
  db: DB, api: BotApi, draftId: string, ownerId: string,
): Promise<PublishOutcome> {
  const claimed = await transitionDraft(db, draftId, ownerId, ['preview'], 'publishing');
  if (!claimed) {
    const [draft] = await db.select().from(tgDrafts)
      .where(and(eq(tgDrafts.id, draftId), eq(tgDrafts.ownerId, ownerId))).limit(1);
    return {
      kind: 'already', draft: draft ?? null,
      rows: draft ? await publicationsOf(db, draft.id) : [], missing: [],
    };
  }
  const targets = await selectedGroups(db, draftId);
  if (!targets.length) {
    const draft = await transitionDraft(db, draftId, ownerId, ['publishing'], 'preview');
    return { kind: 'noTargets', draft, rows: [], missing: [] };
  }
  const bad = await unusableMaterials(db, api, draftId);
  if (bad.length) {
    await dropDraftMaterials(db, draftId, bad.map((m) => m.id));
    const draft = await transitionDraft(db, draftId, ownerId, ['publishing'], 'preview');
    return {
      kind: 'fileMissing', draft, rows: await publicationsOf(db, draftId),
      missing: bad.map((m) => m.title),
    };
  }
  try {
    const created = await db.insert(tgPublications).values(targets.map((g) => ({
      draftId, groupId: g.id, groupTitle: g.title, telegramChatId: g.telegramChatId,
      status: 'sending' as const,
    }))).onConflictDoNothing({
      target: [tgPublications.draftId, tgPublications.groupId],
    }).returning();
    if (!created.length) {
      // Nothing new can be sent safely. Returning to `preview` keeps the confirmation step.
      const draft = await transitionDraft(db, draftId, ownerId, ['publishing'], 'preview');
      return { kind: 'already', draft, rows: await publicationsOf(db, draftId), missing: [] };
    }
    await sendRows(db, api, ownerId, draftId, created);
    const draft = await finalize(db, draftId, ownerId);
    return { kind: 'done', draft, rows: await publicationsOf(db, draftId), missing: [] };
  } catch {
    // We may have delivered something before the unexpected error. Never guess: the draft
    // becomes unknown and housekeeping does the same for a crash.
    await db.update(tgPublications)
      .set({ status: 'uncertain', updatedAt: new Date() })
      .where(and(eq(tgPublications.draftId, draftId), eq(tgPublications.status, 'sending')));
    const draft = await transitionDraft(db, draftId, ownerId, ['publishing'], 'publish_unknown');
    return { kind: 'unexpected', draft, rows: await publicationsOf(db, draftId), missing: [] };
  }
}

/**
 * Retry only rows whose previous attempt was a definite refusal. A removed group is not
 * retried: nothing can be confirmed into a group the teacher disconnected.
 */
export async function retryFailedPublications(
  db: DB, api: BotApi, draftId: string, ownerId: string,
): Promise<PublishOutcome> {
  const failedBefore = await db.select({ id: tgPublications.id }).from(tgPublications)
    .where(and(eq(tgPublications.draftId, draftId), eq(tgPublications.status, 'failed')));
  if (!failedBefore.length) {
    const [draft] = await db.select().from(tgDrafts)
      .where(and(eq(tgDrafts.id, draftId), eq(tgDrafts.ownerId, ownerId))).limit(1);
    return {
      kind: 'noTargets', draft: draft ?? null,
      rows: await publicationsOf(db, draftId), missing: [],
    };
  }
  const claimed = await transitionDraft(db, draftId, ownerId, ['failed'], 'publishing');
  if (!claimed) {
    const [draft] = await db.select().from(tgDrafts)
      .where(and(eq(tgDrafts.id, draftId), eq(tgDrafts.ownerId, ownerId))).limit(1);
    return {
      kind: 'already', draft: draft ?? null,
      rows: draft ? await publicationsOf(db, draft.id) : [], missing: [],
    };
  }
  const bad = await unusableMaterials(db, api, draftId);
  if (bad.length) {
    await dropDraftMaterials(db, draftId, bad.map((m) => m.id));
    // back to `failed`: the definite refusal is still there and can be retried again later
    const draft = await transitionDraft(db, draftId, ownerId, ['publishing'], 'failed');
    return {
      kind: 'fileMissing', draft, rows: await publicationsOf(db, draftId),
      missing: bad.map((m) => m.title),
    };
  }
  try {
    const failed = await db.select().from(tgPublications)
      .where(and(eq(tgPublications.draftId, draftId), eq(tgPublications.status, 'failed')));
    const retryable: HwPublicationRow[] = [];
    for (const row of failed) {
      const [group] = await db.select({ status: tgGroups.status }).from(tgGroups)
        .where(eq(tgGroups.id, row.groupId)).limit(1);
      if (group && group.status === 'active') {
        retryable.push(row);
      }
    }
    const claimedRows: HwPublicationRow[] = [];
    for (const row of retryable) {
      const [moving] = await db.update(tgPublications)
        .set({ status: 'sending', attempts: row.attempts + 1, updatedAt: new Date() })
        .where(and(eq(tgPublications.id, row.id), eq(tgPublications.status, 'failed')))
        .returning();
      if (moving) claimedRows.push(moving);
    }
    await sendRows(db, api, ownerId, draftId, claimedRows);
    const draft = await finalize(db, draftId, ownerId);
    return { kind: 'done', draft, rows: await publicationsOf(db, draftId), missing: [] };
  } catch {
    await db.update(tgPublications)
      .set({ status: 'uncertain', updatedAt: new Date() })
      .where(and(eq(tgPublications.draftId, draftId), eq(tgPublications.status, 'sending')));
    const draft = await transitionDraft(db, draftId, ownerId, ['publishing'], 'publish_unknown');
    return { kind: 'unexpected', draft, rows: await publicationsOf(db, draftId), missing: [] };
  }
}

/** True when the confirmation screen may show the retry button. */
export function canRetry(rows: HwPublicationRow[]): boolean {
  return rows.some((r) => r.status === 'failed')
    && !rows.some((r) => r.status === 'uncertain' || r.status === 'sending');
}
