/**
 * Publication to Telegram chats.
 *
 * Safety rules, in order of importance:
 *  • only an explicit button press starts this (the flow verifies the callback and revision);
 *  • the draft moves `preview → publishing` with one compare-and-swap update, so a second
 *    press cannot start a second run;
 *  • rows are unique per (draft, group), and a group is sent to sequentially;
 *  • every part of a homework (the text, then each attachment) gets its OWN recorded outcome
 *    in `tg_publications.parts`, because "the text arrived and the file did not" is not the
 *    same message to a teacher as "nothing was sent" — the live test of 2026-10-23 proved the
 *    old summary lied;
 *  • an attachment is COPIED from the teacher's original message (`copyMessage` /
 *    `copyMessages`). Telegram then re-posts the file with the type it really has, its caption
 *    and its name — nothing is downloaded, re-uploaded or read. `file_id` is only a fallback,
 *    and it is sent as the type it was received as: a PNG sent «as a file» has a document
 *    `file_id`, and `sendPhoto` rejects it with «400 can't use file of type Document as Photo»;
 *  • a failure is `failed` only when Telegram itself refused and NOTHING was delivered for
 *    that group. Any later interruption is `uncertain` — at least one message may have
 *    arrived, and such a row is never retried automatically;
 *  • after a crash, housekeeping turns `sending` into `uncertain` and the draft into
 *    `publish_unknown`, never back into a retryable state.
 */
import { and, eq, inArray } from 'drizzle-orm';
import type { DB } from '../../db/index.js';
import type { PublicationPart } from '../../db/schema.js';
import { tgDraftItems, tgDrafts, tgGroups, tgPublications } from '../../db/schema.js';
import { safeErrorMessage } from '../../lib/redact.js';
import { audit } from '../audit.js';
import type { BotApi } from '../botApi.js';
import { PUBLISH_CHUNK } from './constants.js';
import { listDraftMaterials, markMaterialsUsed, type HwDraftMaterialRow } from './libraryStore.js';
import {
  publicationsOf, selectedGroups, transitionDraft,
  type HwDraftRow, type HwItemRow, type HwPublicationRow,
} from './store.js';

export type PublishKind = 'already' | 'noTargets' | 'done' | 'unexpected';

export interface PublishOutcome {
  kind: PublishKind;
  draft: HwDraftRow | null;
  rows: HwPublicationRow[];
  /** Labels of attachments Telegram refused outright — what the teacher should re-send. */
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
  const code = telegramCode(err);
  return code !== null && code >= 400 && code < 500;
}

/** Telegram's own status code, when the failure carries one. */
function telegramCode(err: unknown): number | null {
  const e = err as { error_code?: unknown; error?: { error_code?: unknown } };
  if (typeof e?.error_code === 'number') return e.error_code;
  if (typeof e?.error?.error_code === 'number') return e.error.error_code;
  return null;
}

/** Short, teacher-readable reason. Never a URL (grammY puts the bot token in it). */
const reason = (err: unknown): string =>
  safeErrorMessage(err).slice(0, 160) || 'telegram rejected the send';

/** One message that has to leave: the text, a saved book, a photo, a document. */
interface Attachment {
  partKind: 'material' | 'photo' | 'document';
  label: string;
  /** Source messages, already grouped into albums: one copy call per entry. */
  sources: { chatId: string; messageIds: number[] }[];
  fileId: string | null;
  /** How the file arrived in Telegram. `null` = a row written before this was recorded. */
  mediaType: 'photo' | 'document' | null;
}

/**
 * Everything the teacher will receive as files, in the order of the preview screen: the
 * library books chosen for this draft, then the photos and documents she sent herself.
 * Photos of one album are merged into a single attachment so the album stays one album.
 */
export function buildAttachments(materials: HwDraftMaterialRow[], items: HwItemRow[]): Attachment[] {
  const out: Attachment[] = [];
  for (const m of materials) {
    const chatId = m.sourceChatId ?? '';
    const messageId = m.sourceMessageId ?? 0;
    out.push({
      partKind: 'material',
      label: m.title || m.fileName || 'material',
      sources: chatId && messageId ? [{ chatId, messageIds: [messageId] }] : [],
      fileId: m.telegramFileId || null,
      mediaType: m.mediaType ?? null,
    });
  }
  // Album key → the index of the attachment that already holds it, so the second, third and
  // fourth photo of the same album join the FIRST copy call instead of becoming three.
  const albumIndex = new Map<string, number>();
  for (const i of items) {
    if (i.kind !== 'photo' && i.kind !== 'document') continue;
    const label = i.fileName || (i.kind === 'photo' ? 'photo' : 'document');
    const source = i.sourceChatId && i.sourceMessageId
      ? { chatId: i.sourceChatId, messageId: i.sourceMessageId }
      : null;
    const albumKey = source && i.sourceMediaGroupId
      ? `${source.chatId}:${i.sourceMediaGroupId}`
      : null;
    const joined = albumKey === null ? undefined : albumIndex.get(albumKey);
    if (source && joined !== undefined) {
      const attachment = out[joined];
      const first = attachment?.sources[0];
      if (attachment && first && first.chatId === source.chatId) {
        first.messageIds.push(source.messageId);
        continue;
      }
    }
    const attachment: Attachment = {
      partKind: i.kind,
      label,
      sources: source ? [{ chatId: source.chatId, messageIds: [source.messageId] }] : [],
      fileId: i.fileId || null,
      mediaType: i.kind,
    };
    out.push(attachment);
    if (albumKey) albumIndex.set(albumKey, out.length - 1);
  }
  return out;
}

/** Send one attachment: copy the original message, fall back to the stored `file_id`. */
async function sendAttachment(
  api: BotApi, chatId: string, a: Attachment,
): Promise<{ status: PublicationPart['status']; messageId: number | null; method: PublicationPart['method']; error: string }> {
  for (const s of a.sources) {
    try {
      const messageId = s.messageIds.length > 1
        ? (await api.copyMessages(chatId, s.chatId, s.messageIds)).at(-1) ?? null
        : await api.copyMessage(chatId, s.chatId, s.messageIds[0]!);
      return { status: 'sent', messageId, method: 'copy', error: '' };
    } catch (e) {
      // A definite refusal means nothing was posted: the `file_id` fallback is safe here.
      // Anything else (timeout, 5xx, dropped connection) may have delivered the file, so
      // the outcome stays unknown and no second send is attempted — a duplicate in a group
      // of students is worse than a missing file.
      if (!telegramRejected(e)) {
        return { status: 'unknown', messageId: null, method: 'copy', error: reason(e) };
      }
      if (!a.fileId) {
        return { status: 'failed', messageId: null, method: 'copy', error: reason(e) };
      }
      try {
        const messageId = a.mediaType === 'photo'
          ? await api.sendPhoto(chatId, a.fileId)
          : await api.sendDocument(chatId, a.fileId);
        return { status: 'sent', messageId, method: 'file_id', error: reason(e) };
      } catch (e2) {
        return telegramRejected(e2)
          ? { status: 'failed', messageId: null, method: 'file_id', error: reason(e2) }
          : { status: 'unknown', messageId: null, method: 'file_id', error: reason(e2) };
      }
    }
  }
  if (!a.fileId) return { status: 'failed', messageId: null, method: 'file_id', error: 'no source message and no file_id' };
  try {
    const messageId = a.mediaType === 'photo'
      ? await api.sendPhoto(chatId, a.fileId)
      : await api.sendDocument(chatId, a.fileId);
    return { status: 'sent', messageId, method: 'file_id', error: '' };
  } catch (e) {
    return telegramRejected(e)
      ? { status: 'failed', messageId: null, method: 'file_id', error: reason(e) }
      : { status: 'unknown', messageId: null, method: 'file_id', error: reason(e) };
  }
}

interface GroupResult {
  parts: PublicationPart[];
  status: HwPublicationRow['status'];
  messageId: number | null;
  error: string;
}

/**
 * The recorded part standing at one position of the previous attempt, if that position really
 * still holds the same piece of homework. Position matters: two plain photos have the same
 * label («photo»), so matching by label alone could mark a file as delivered that never was,
 * and skipping it would silently lose it. The order is deterministic — the library books in
 * their position, then the collected files in theirs — so a position only shifts when the
 * teacher adds something, and new material lands after the old ones.
 */
function arrivedAt(
  previous: PublicationPart[], index: number, kind: PublicationPart['kind'], label: string,
): PublicationPart | null {
  const p = previous[index];
  return p && p.kind === kind && p.label === label && p.status === 'sent' ? p : null;
}

/**
 * Everything one group receives: the text (possibly in chunks), then each attachment.
 *
 * `previous` is the recorded outcome of the last attempt. A part that is known to have
 * arrived is carried over and NEVER sent again — that is what makes a deliberate "send the
 * file that failed" safe: the homework text stays a single message in the group.
 */
async function sendOne(
  api: BotApi, pub: HwPublicationRow, text: string, items: HwItemRow[],
  materials: HwDraftMaterialRow[], previous: PublicationPart[] = [],
): Promise<GroupResult> {
  const parts: PublicationPart[] = [];
  let delivered = 0;
  let firstTextId: number | null = null;

  const chunks = splitText(text);
  const prevText = previous.filter((p) => p.kind === 'text');
  const textAlreadyOut = chunks.length > 0 && prevText.length === chunks.length
    && prevText.every((p) => p.status === 'sent');
  if (textAlreadyOut) {
    parts.push(...prevText);
    delivered += prevText.length;
    firstTextId = prevText.find((p) => p.messageId)?.messageId ?? null;
  } else if (chunks.length) {
    try {
      for (const chunk of chunks) {
        const messageId = await api.sendMessage(pub.telegramChatId, chunk);
        delivered++;
        if (firstTextId === null && messageId) firstTextId = messageId;
        parts.push({
          kind: 'text', label: 'text', method: 'text',
          status: 'sent', messageId: messageId ?? null, error: '',
        });
      }
    } catch (e) {
      const definite = delivered === 0 && telegramRejected(e);
      parts.push({
        kind: 'text', label: 'text', method: 'text',
        status: definite ? 'failed' : 'unknown', messageId: null, error: reason(e),
      });
      // Nothing more may be attempted: with an unknown text outcome the attachments would read
      // as a second homework if the text actually arrived.
      return {
        parts,
        status: definite ? 'failed' : 'uncertain',
        messageId: firstTextId,
        error: reason(e),
      };
    }
  }

  const attachments = buildAttachments(materials, items);
  for (let j = 0; j < attachments.length; j++) {
    const a = attachments[j]!;
    const done = arrivedAt(previous, prevText.length + j, a.partKind, a.label);
    if (done) {
      parts.push(done);
      delivered++;
      continue;
    }
    const r = await sendAttachment(api, pub.telegramChatId, a);
    parts.push({
      kind: a.partKind, label: a.label, method: r.method,
      status: r.status, messageId: r.messageId, error: r.error,
    });
    if (r.status === 'sent') delivered++;
  }

  const failed = parts.filter((p) => p.status === 'failed');
  const unknown = parts.filter((p) => p.status === 'unknown');
  const status: HwPublicationRow['status'] = unknown.length ? 'uncertain'
    : failed.length ? 'failed' : 'sent';
  // `failed` for the whole row is only honest when NOTHING arrived; one delivered part makes
  // the run partially real, and a partial run must never be retried automatically.
  const finalStatus: HwPublicationRow['status'] =
    status === 'failed' && delivered === 0 ? 'failed'
      : status === 'failed' ? 'uncertain' : status;
  const error = [...failed, ...unknown].map((p) => `${p.label}: ${p.error}`).join('; ');
  return { parts, status: finalStatus, messageId: firstTextId, error: error.slice(0, 300) };
}

async function finalize(
  db: DB, draftId: string, ownerId: string,
): Promise<HwDraftRow | null> {
  const rows = await publicationsOf(db, draftId);
  // "Last used" only for a book that actually reached somebody.
  if (rows.some((r) => r.status === 'sent' || r.status === 'uncertain')) {
    const ids = (await listDraftMaterials(db, draftId))
      .map((m) => m.materialId).filter((id): id is string => Boolean(id));
    await markMaterialsUsed(db, ownerId, ids).catch(() => undefined);
  }
  /*
   * Одна запись на исход (2026-10-28, аудит SEC-08). До этого homework не оставлял следа в
   * `audit_log` вообще: «кто и когда раздал задание классам» можно было восстановить только по
   * строкам `tg_drafts`/`tg_publications`, то есть по машинному состоянию, а не по поступку
   * человека. Машина состояний при этом остаётся ЕДИНСТВЕННЫМ местом, где живут тайминги и partie:
   * здесь нарочно дублируется только факт и счётчики — без текстов заданий, без названий групп и
   * без identifiers чатов учеников.
   */
  const outcome = rows.some((r) => r.status === 'uncertain' || r.status === 'sending')
    ? 'publish_unknown'
    : rows.some((r) => r.status === 'failed') ? 'failed' : 'published';
  const draft = outcome === 'published'
    ? await transitionDraft(db, draftId, ownerId, ['publishing'], outcome, { publishedAt: new Date() })
    : await transitionDraft(db, draftId, ownerId, ['publishing'], outcome);
  audit(db, ownerId, 'homework_publish', {
    draftId, status: outcome, groups: rows.length,
    failed: rows.filter((r) => r.status === 'failed').length,
  });
  return draft;
}

async function sendRows(
  db: DB, api: BotApi, ownerId: string, draftId: string, rows: HwPublicationRow[],
): Promise<string[]> {
  const [draft] = await db.select().from(tgDrafts)
    .where(and(eq(tgDrafts.id, draftId), eq(tgDrafts.ownerId, ownerId))).limit(1);
  const items = await db.select().from(tgDraftItems).where(eq(tgDraftItems.draftId, draftId))
    .orderBy(tgDraftItems.position);
  const materials = await listDraftMaterials(db, draftId);
  const text = (draft?.formattedText.trim() || draft?.title.trim() || '').trim();
  const refused: string[] = [];

  for (const pub of rows) {
    const result = await sendOne(api, pub, text, items, materials, pub.parts ?? []);
    await db.update(tgPublications).set({
      status: result.status,
      telegramMessageId: result.messageId,
      error: result.error,
      parts: result.parts,
      updatedAt: new Date(),
    }).where(eq(tgPublications.id, pub.id));
    refused.push(...result.parts
      .filter((p) => p.kind !== 'text' && p.status !== 'sent')
      .map((p) => p.label));
  }
  return [...new Set(refused)];
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
    const missing = await sendRows(db, api, ownerId, draftId, created);
    const draft = await finalize(db, draftId, ownerId);
    return { kind: 'done', draft, rows: await publicationsOf(db, draftId), missing };
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
 * A row whose missing pieces are KNOWN: nothing arrived at all (`failed`), or every part has
 * a definite outcome and at least one part was definitely refused. A row with an unknown part
 * is never retried automatically — the teacher checks the group instead of risking a second
 * homework for the same lesson.
 */
export function isRetryableRow(row: HwPublicationRow): boolean {
  if (row.status === 'sending') return false;
  if (row.status === 'failed') return true;
  const parts = row.parts ?? [];
  return parts.length > 0
    && parts.every((p) => p.status !== 'unknown')
    && parts.some((p) => p.status === 'failed');
}

/**
 * Retry the rows whose failures are definite. Parts that already arrived are not sent again;
 * a removed group is not retried: nothing can be confirmed into a group the teacher
 * disconnected.
 */
export async function retryFailedPublications(
  db: DB, api: BotApi, draftId: string, ownerId: string,
): Promise<PublishOutcome> {
  const [draft] = await db.select().from(tgDrafts)
    .where(and(eq(tgDrafts.id, draftId), eq(tgDrafts.ownerId, ownerId))).limit(1);
  const rows = draft ? await publicationsOf(db, draftId) : [];
  const retryableIds = rows.filter(isRetryableRow).map((r) => r.id);
  if (!retryableIds.length) {
    return {
      kind: 'noTargets', draft: draft ?? null, rows, missing: [],
    };
  }
  const claimed = await transitionDraft(db, draftId, ownerId, ['failed', 'publish_unknown'], 'publishing');
  if (!claimed) {
    return {
      kind: 'already', draft: draft ?? null,
      rows: draft ? await publicationsOf(db, draft.id) : [], missing: [],
    };
  }
  try {
    const failed = await db.select().from(tgPublications)
      .where(and(eq(tgPublications.draftId, draftId), inArray(tgPublications.id, retryableIds)));
    const retryable: HwPublicationRow[] = [];
    for (const row of failed) {
      const [group] = await db.select({ status: tgGroups.status }).from(tgGroups)
        .where(eq(tgGroups.id, row.groupId)).limit(1);
      if (group && group.status === 'active' && isRetryableRow(row)) {
        retryable.push(row);
      }
    }
    const claimedRows: HwPublicationRow[] = [];
    for (const row of retryable) {
      const [moving] = await db.update(tgPublications)
        .set({ status: 'sending', attempts: row.attempts + 1, updatedAt: new Date() })
        .where(and(eq(tgPublications.id, row.id), eq(tgPublications.status, row.status)))
        .returning();
      if (moving) claimedRows.push(moving);
    }
    const missing = await sendRows(db, api, ownerId, draftId, claimedRows);
    const draft2 = await finalize(db, draftId, ownerId);
    return { kind: 'done', draft: draft2, rows: await publicationsOf(db, draftId), missing };
  } catch {
    await db.update(tgPublications)
      .set({ status: 'uncertain', updatedAt: new Date() })
      .where(and(eq(tgPublications.draftId, draftId), eq(tgPublications.status, 'sending')));
    const draft2 = await transitionDraft(db, draftId, ownerId, ['publishing'], 'publish_unknown');
    return { kind: 'unexpected', draft: draft2, rows: await publicationsOf(db, draftId), missing: [] };
  }
}

/** True when the confirmation screen may show the retry button. */
export function canRetry(rows: HwPublicationRow[]): boolean {
  return rows.some(isRetryableRow);
}

/** Count of parts that really arrived — the honest number behind the result headline. */
export function deliveredParts(row: HwPublicationRow): number {
  return (row.parts ?? []).filter((p) => p.status === 'sent').length;
}
