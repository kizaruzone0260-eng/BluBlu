/**
 * Task G (2026-10-29): a file the teacher picks in the Mini App becomes a real library
 * material.
 *
 * The order here is the security model, not an implementation detail:
 *  1. size and GROUP OWNERSHIP are checked before any side effect — a foreign group must not
 *     cause an upload to Telegram;
 *  2. the type is decided by magic bytes (`detectFileType`), never by the extension the client
 *     claims; HTML/XML/executables are not in the allowed set, and SVG is refused explicitly
 *     because it can carry script;
 *  3. the bytes go to the teacher's PRIVATE chat with this bot, so the bot really owns a
 *     `file_id` — nothing is invented, and publication can `copyMessage` the real message;
 *  4. the same bytes are written to server storage so the file survives Telegram's own copy
 *     disappearing, and so «persistent storage, not /tmp» is true;
 *  5. the library row is written only after Telegram answered. Any failure removes the
 *     Telegram message and the stored bytes — a material never points at nothing.
 */
import { randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import type { DB } from '../../db/index.js';
import { telegramLinks } from '../../db/schema.js';
import { env } from '../../env.js';
import { detectFileType, type Detected } from '../../lib/magic.js';
import { getStorage } from '../../storage/provider.js';
import type { BotApi } from '../botApi.js';
import { MAX_MATERIAL_TITLE } from './constants.js';
import {
  attachDraftMaterial, materialByUniqueId, ownedActiveGroupIds, saveMaterial, storedBytes,
  type HwMaterialRow,
} from './libraryStore.js';
import { getDraft } from './store.js';
import type { HwMaterialKind } from './types.js';

/**
 * Telegram's Bot API refuses documents above 50 MB for a bot that does not use a local Bot
 * API server; photos are capped at 10 MB and are re-sent as documents above that. The env cap
 * can be lower (Render free is 50 MB per request), and the Mini App never pretends otherwise.
 */
export const MINI_UPLOAD_MAX_MB = Math.max(1, Math.min(env.MAX_FILE_MB, 50));
export const MINI_PHOTO_MAX_MB = 10;
const QUOTA_BYTES = Math.max(1, env.TEACHER_QUOTA_GB) * 1024 ** 3;

export const MINI_UPLOAD_MIME = {
  pdf: 'application/pdf',
  // The client only offers these; the server still decides by content.
} as const;

const ALLOWED_GROUPS = new Set<Detected['group']>(['pdf', 'office', 'image', 'audio', 'video', 'text']);

/** Reasons a client can show honestly. Nothing here is a silent success. */
export type MiniUploadFailure =
  | 'unsupported'
  | 'tooLarge'
  | 'noGroups'
  | 'limit'
  | 'quota'
  | 'noPrivateChat'
  | 'telegramFailed'
  | 'invalid';

export interface MiniUploadInput {
  ownerId: string;
  title?: string;
  kind?: HwMaterialKind;
  groupIds: string[];
  draftId?: string;
  filename: string;
  bytes: Buffer;
}

export type MiniUploadResult =
  | {
    status: 'ok';
    material: HwMaterialRow;
    draftId: string | null;
    draftAttached: boolean;
    replaced: boolean;
  }
  | { status: MiniUploadFailure };

function baseName(filename: string): string {
  const name = filename.split(/[\\/]/).pop() ?? filename;
  return name.trim().slice(0, 300) || 'material';
}

function titleFrom(filename: string): string {
  const name = baseName(filename);
  const dot = name.lastIndexOf('.');
  const root = dot > 0 ? name.slice(0, dot) : name;
  return (root.trim() || name).slice(0, MAX_MATERIAL_TITLE);
}

function cleanKind(value: unknown): HwMaterialKind {
  return value === 'book' || value === 'workbook' ? value : 'other';
}

async function privateChatOf(db: DB, ownerId: string): Promise<string | null> {
  const [row] = await db.select({ chatId: telegramLinks.chatId }).from(telegramLinks)
    .where(and(eq(telegramLinks.userId, ownerId), isNull(telegramLinks.blockedAt))).limit(1);
  return row?.chatId ?? null;
}

export async function uploadMiniMaterial(
  deps: { db: DB; api: BotApi }, input: MiniUploadInput,
): Promise<MiniUploadResult> {
  const { db, api } = deps;
  const filename = baseName(input.filename);
  const size = input.bytes.length;

  if (!size) return { status: 'invalid' };
  if (size > MINI_UPLOAD_MAX_MB * 1024 * 1024) return { status: 'tooLarge' };

  const detected = detectFileType(input.bytes.subarray(0, 8192), filename);
  // SVG is an image by detector but not an attachment this flow accepts: a document that can
  // run script must not travel through a teacher's chat as a picture.
  if (detected.group === 'unknown' || !ALLOWED_GROUPS.has(detected.group)) {
    return { status: 'unsupported' };
  }
  // The guard above removed `unknown`; the remaining union always carries mime/ext.
  const type = detected as Exclude<Detected, { group: 'unknown' }>;
  if (type.mime === 'image/svg+xml') return { status: 'unsupported' };

  // Ownership BEFORE the upload: a forged group id must not cost Telegram traffic.
  const groups = await ownedActiveGroupIds(db, input.ownerId, input.groupIds);
  if (!groups.length) return { status: 'noGroups' };

  const alreadyStored = await storedBytes(db, input.ownerId);
  // A re-upload of the same Telegram file replaces the previous row and its bytes; without
  // this allowance the cap would refuse the only repair path for a broken file.
  if (alreadyStored + size > QUOTA_BYTES) return { status: 'quota' };

  const chatId = await privateChatOf(db, input.ownerId);
  if (!chatId) return { status: 'noPrivateChat' };

  const title = (input.title?.trim() || titleFrom(filename)).slice(0, MAX_MATERIAL_TITLE);
  const sendAsPhoto = type.group === 'image'
    && type.mime !== 'image/gif' && type.mime !== 'image/bmp'
    && type.mime !== 'image/tiff'
    && size <= MINI_PHOTO_MAX_MB * 1024 * 1024;

  let sent;
  try {
    sent = sendAsPhoto
      ? await api.uploadPhoto(chatId, input.bytes, filename, title)
      : await api.uploadDocument(chatId, input.bytes, filename, title);
  } catch {
    return { status: 'telegramFailed' };
  }

  const storageKey = `${randomUUID()}.${type.ext}`;
  try {
    await getStorage().put(storageKey, input.bytes);
  } catch {
    // The file already exists in Telegram; leaving it there without a library row would be
    // an orphan nobody can see. Remove it, then report the failure.
    await api.deleteMessage(chatId, sent.messageId).catch(() => undefined);
    return { status: 'telegramFailed' };
  }

  const existing = await materialByUniqueId(db, input.ownerId, sent.fileUniqueId);
  const saved = await saveMaterial(db, input.ownerId, {
    title,
    kind: cleanKind(input.kind),
    fileId: sent.fileId,
    fileUniqueId: sent.fileUniqueId,
    fileName: filename,
    // Honest metadata: what the DETECTOR said, not what the client sent.
    mimeType: type.mime,
    fileSize: size,
    groupIds: groups,
    mediaType: sent.mediaType,
    sourceChatId: chatId,
    sourceMessageId: sent.messageId,
    storageKey,
  });

  if (saved.status === 'limit' || saved.status === 'noGroups') {
    await getStorage().delete(storageKey).catch(() => undefined);
    await api.deleteMessage(chatId, sent.messageId).catch(() => undefined);
    return { status: saved.status };
  }
  if (saved.status === 'invalid') {
    await getStorage().delete(storageKey).catch(() => undefined);
    await api.deleteMessage(chatId, sent.messageId).catch(() => undefined);
    return { status: 'invalid' };
  }

  let draftId: string | null = input.draftId ?? null;
  let draftAttached = false;
  if (draftId) {
    const draft = await getDraft(db, draftId, input.ownerId);
    if (!draft) {
      draftId = null; // not hers is the same as not existing; the material itself is saved
    } else if (draft.status === 'collecting' || draft.status === 'needs_clarification'
      || draft.status === 'preview') {
      const attached = await attachDraftMaterial(db, draftId, saved.row);
      draftAttached = attached === 'added' || attached === 'exists';
    }
  }

  return {
    status: 'ok',
    material: saved.row,
    draftId,
    draftAttached,
    replaced: saved.status === 'updated',
  };
}
