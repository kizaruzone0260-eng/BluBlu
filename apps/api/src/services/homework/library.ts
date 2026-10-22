/**
 * The teacher's material library — the Telegram surface.
 *
 * Rules this file exists to enforce:
 *  • only the linked teacher ever gets here, and every id in a button is re-checked against
 *    her owner id — a forged material id from another account simply does not exist;
 *  • uploading a book to the library NEVER sends anything to a study group; publication is a
 *    separate, explicit step inside /homework;
 *  • the file is stored as a Telegram `file_id` + metadata. Nothing here reads, parses or
 *    downloads contents: no OCR, no PDF/DOCX parser, no vision (part B of the task);
 *  • «убрать из рекомендаций» is an archive, not a delete: past publications keep the titles
 *    they were sent with, and deleting a material does not rewrite them either.
 *
 * Buttons carry `{a:'lib', x:'…'}` payloads through the same one-time `h1.` tokens as the
 * homework flow, so a double press cannot run an action twice. The ids (material, group)
 * live inside the token, never in the visible label.
 */
import type { DB } from '../../db/index.js';
import type { BotApi, InlineButton } from '../botApi.js';
import { h, materialKindLabel } from './texts.js';
import { makeHomeworkCallback } from './tokens.js';
import { listGroups, transitionDraft } from './store.js';
import {
  LIBRARY_SCREEN_LIMIT, MAX_FILE_MB, MAX_MATERIALS, MAX_MATERIAL_TITLE,
} from './constants.js';
import {
  attachDraftMaterial, clearLibrarySession, countMaterials, deleteMaterial, getMaterial,
  linkMaterialGroup, listMaterials, loadLibrarySession, materialCountByGroup, materialGroupIds,
  materialsOfGroup, renameMaterial, saveLibrarySession, saveMaterial, setMaterialStatus,
  type HwMaterialRow, type LibSessionData,
} from './libraryStore.js';
import type { HwActor, HwLang, HwMaterialKind } from './types.js';
import type { HomeworkDeps, HwIncoming, HwSession } from './flow.js';

type Btn = InlineButton;
type LibDeps = Pick<HomeworkDeps, 'db' | 'api'>;

const b = (text: string, cb?: string): Btn => ({ text, cb });
const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

const KINDS: readonly HwMaterialKind[] = ['book', 'workbook', 'other'];

async function send(
  deps: LibDeps, chatId: string, text: string, buttons?: Btn[][],
): Promise<void> {
  await deps.api.sendMessage(chatId, truncate(text, 4_000), buttons?.length ? { buttons } : undefined);
}

async function editOrSend(
  deps: LibDeps, chatId: string, messageId: number | undefined,
  text: string, buttons?: Btn[][],
): Promise<void> {
  const body = truncate(text, 4_000);
  if (messageId !== undefined) {
    try {
      await deps.api.editMessageText(chatId, messageId, body, buttons?.length ? { buttons } : undefined);
      return;
    } catch { /* the message may be too old or already removed — send a fresh one */ }
  }
  await deps.api.sendMessage(chatId, body, buttons?.length ? { buttons } : undefined);
}

const cb = (db: DB, ownerId: string, payload: Record<string, string>) =>
  makeHomeworkCallback(db, ownerId, payload);

function teacherIdOf(actor: HwActor): string | null {
  return actor.userId && actor.role === 'teacher' ? actor.userId : null;
}

// ─── naming a file ───────────────────────────────────────────────────────────

function baseName(fileName: string): string {
  const name = fileName.split(/[\\/]/).pop() ?? '';
  return name.replace(/\.[^.]{1,10}$/, '').replace(/[_+]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

/**
 * The suggested title: a file name without its extension, or a dated placeholder when
 * Telegram gave no name (photos never do). It is only a suggestion — the teacher retypes it.
 * Exported for the unit test because this is the one place a name is produced.
 */
export function suggestMaterialTitle(
  fileName: string, isPhoto: boolean, lang: HwLang, now = new Date(),
): string {
  const base = baseName(fileName);
  if (base) return base.slice(0, MAX_MATERIAL_TITLE);
  const day = now.toISOString().slice(0, 10);
  const label = isPhoto
    ? (lang === 'uz' ? 'Foto' : lang === 'en' ? 'Photo' : 'Фото')
    : (lang === 'uz' ? 'Hujjat' : lang === 'en' ? 'Document' : 'Документ');
  return `${label} ${day}`.slice(0, MAX_MATERIAL_TITLE);
}

interface UploadedFile {
  fileId: string; fileUniqueId: string; fileName: string; mimeType: string; fileSize: number | null;
}

/** The file part of an incoming message: a document, or the largest size of a photo. */
function fileOf(m: HwIncoming): { file: UploadedFile; isPhoto: boolean } | null {
  if (m.document) {
    const d = m.document;
    if (!d.file_id || !d.file_unique_id) return null;
    return {
      isPhoto: false,
      file: {
        fileId: d.file_id, fileUniqueId: d.file_unique_id, fileName: d.file_name ?? '',
        mimeType: d.mime_type ?? '', fileSize: d.file_size ?? null,
      },
    };
  }
  if (m.photo?.length) {
    const p = m.photo[m.photo.length - 1]!;
    if (!p.file_id || !p.file_unique_id) return null;
    return {
      isPhoto: true,
      file: {
        fileId: p.file_id, fileUniqueId: p.file_unique_id, fileName: '',
        mimeType: 'image/jpeg', fileSize: p.file_size ?? null,
      },
    };
  }
  return null;
}

function sizeLabel(bytes: number | null, lang: HwLang): string {
  if (!bytes || bytes <= 0) {
    return lang === 'ru' ? 'размер неизвестен' : lang === 'uz' ? 'hajmi noma’lum' : 'size unknown';
  }
  const mb = bytes / 1024 / 1024;
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function lastUsedLabel(row: HwMaterialRow, lang: HwLang, tz: string): string {
  if (!row.lastUsedAt) return h('libNeverUsed', lang);
  const locale = lang === 'ru' ? 'ru-RU' : lang === 'uz' ? 'uz-UZ' : 'en-GB';
  let at = row.lastUsedAt.toISOString().slice(0, 10);
  try {
    at = new Intl.DateTimeFormat(locale, {
      day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: tz,
    }).format(row.lastUsedAt);
  } catch { /* keep the ISO date */ }
  return h('libLastUsed', lang, { at });
}

// ─── home ────────────────────────────────────────────────────────────────────

async function renderHome(
  deps: LibDeps, chatId: string, actor: HwActor, editMessageId?: number,
): Promise<void> {
  const db = deps.db;
  const ownerId = teacherIdOf(actor)!;
  const [groups, saved] = await Promise.all([listGroups(db, ownerId), countMaterials(db, ownerId)]);
  const lines = [h('libraryTitle', actor.lang), h('libraryHint', actor.lang), ''];
  if (!groups.length) {
    lines.push(h('libraryNoGroups', actor.lang));
    await editOrSend(deps, chatId, editMessageId, lines.join('\n'), [
      [b(h('newDraftBtn', actor.lang), await cb(db, ownerId, { a: 'new' }))],
    ]);
    return;
  }
  lines.push(h('libraryCounts', actor.lang, { n: saved, g: groups.length }));
  await editOrSend(deps, chatId, editMessageId, lines.join('\n'), [
    [b(h('libraryAdd', actor.lang), await cb(db, ownerId, { a: 'lib', x: 'add' }))],
    [b(h('libraryPickForHw', actor.lang), await cb(db, ownerId, { a: 'home' }))],
    [
      b(h('libraryGroupMaterials', actor.lang), await cb(db, ownerId, { a: 'lib', x: 'groups' })),
      b(h('libraryManage', actor.lang), await cb(db, ownerId, { a: 'lib', x: 'manage' })),
    ],
  ]);
}

/** `/library` — the teacher's entry point; everyone else is refused on the server. */
export async function libraryCommand(deps: LibDeps, chatId: string, actor: HwActor): Promise<void> {
  if (!teacherIdOf(actor)) {
    await deps.api.sendMessage(chatId, h('denied', actor.lang));
    return;
  }
  await clearLibrarySession(deps.db, chatId);
  await renderHome(deps, chatId, actor);
}

// ─── the add dialog: groups → file → title → type → save ─────────────────────

async function renderAddStep(
  deps: LibDeps, chatId: string, actor: HwActor, data: LibSessionData, editMessageId?: number,
): Promise<void> {
  const db = deps.db;
  const ownerId = teacherIdOf(actor)!;
  const groups = await listGroups(db, ownerId);
  const chosen = new Set((data.groups as string[] | undefined) ?? []);
  const locked = data.source === 'homework';
  const buttons: Btn[][] = [];
  if (!locked) {
    for (const g of groups) {
      buttons.push([b(
        truncate(`${chosen.has(g.id) ? '☑' : '☐'} ${g.title}`, 55),
        await cb(db, ownerId, { a: 'lib', x: 'ag', g: g.id }),
      )]);
    }
  }
  if (data.step === 'add-groups') {
    if (chosen.size) {
      buttons.push([b(h('libGroupContinue', actor.lang, { n: chosen.size }),
        await cb(db, ownerId, { a: 'lib', x: 'agc' }))]);
    }
  } else {
    buttons.push([b(h('libSave', actor.lang), await cb(db, ownerId, { a: 'lib', x: 'save' }))]);
  }
  buttons.push([b(h('cancel', actor.lang), await cb(db, ownerId, { a: 'lib', x: 'cancel' }))]);

  const lines = data.step === 'add-groups'
    ? [h('libAskGroups', actor.lang), h('groupCount', actor.lang, { n: groups.length })].join('\n\n')
    : [
      h('libConfirmTitle', actor.lang),
      h('libConfirmLine', actor.lang, {
        t: String(data.title ?? ''),
        k: materialKindLabel((data.kind ?? 'other') as HwMaterialKind, actor.lang),
        f: String((data.file as UploadedFile | undefined)?.fileName ?? '') || '—',
        g: groups.filter((g) => chosen.has(g.id)).map((g) => g.title).join(', ') || '—',
      }),
      locked ? h('libGroupsLocked', actor.lang) : '',
    ].filter(Boolean).join('\n');
  await editOrSend(deps, chatId, editMessageId, lines, buttons);
}

async function renderKind(
  deps: LibDeps, chatId: string, actor: HwActor, editMessageId?: number,
): Promise<void> {
  const db = deps.db;
  const ownerId = teacherIdOf(actor)!;
  const rows: Btn[][] = [];
  for (const k of KINDS) {
    rows.push([b(materialKindLabel(k, actor.lang), await cb(db, ownerId, { a: 'lib', x: 'kind', k }))]);
  }
  rows.push([b(h('cancel', actor.lang), await cb(db, ownerId, { a: 'lib', x: 'cancel' }))]);
  await editOrSend(deps, chatId, editMessageId, h('libAskKind', actor.lang), rows);
}

/** Called by the homework flow: a new book for exactly the groups this draft will publish to. */
export async function startHomeworkMaterialUpload(
  deps: LibDeps, chatId: string, actor: HwActor, draftId: string,
  groupIds: string[], editMessageId?: number,
): Promise<void> {
  const ownerId = teacherIdOf(actor);
  if (!ownerId) return;
  await saveLibrarySession(deps.db, chatId, {
    step: 'add-file', groups: groupIds, source: 'homework', draftId,
  });
  await editOrSend(deps, chatId, editMessageId, h('libAskFile', actor.lang, { n: MAX_FILE_MB }));
}

async function beginAdd(
  deps: LibDeps, chatId: string, actor: HwActor, editMessageId?: number,
): Promise<void> {
  const db = deps.db;
  const ownerId = teacherIdOf(actor)!;
  const groups = await listGroups(db, ownerId);
  if (!groups.length) { await renderHome(deps, chatId, actor, editMessageId); return; }
  const data: LibSessionData = { step: 'add-groups', groups: [], source: 'library' };
  await saveLibrarySession(db, chatId, data);
  await renderAddStep(deps, chatId, actor, data, editMessageId);
}

async function toggleAddGroup(
  deps: LibDeps, chatId: string, actor: HwActor, groupId: string, editMessageId?: number,
): Promise<void> {
  const db = deps.db;
  const ownerId = teacherIdOf(actor)!;
  const data = await loadLibrarySession(db, chatId);
  if (!data || (data.step !== 'add-groups' && data.step !== 'add-confirm')) {
    await send(deps, chatId, h('badButton', actor.lang));
    return;
  }
  if (data.source === 'homework') {
    // the groups of a homework are decided by the draft, not here
    await renderAddStep(deps, chatId, actor, data, editMessageId);
    return;
  }
  const owned = (await listGroups(db, ownerId)).find((g) => g.id === groupId);
  if (!owned) { await send(deps, chatId, h('groupMissing', actor.lang)); return; }
  const chosen = new Set((data.groups as string[] | undefined) ?? []);
  if (chosen.has(groupId)) chosen.delete(groupId); else chosen.add(groupId);
  const next: LibSessionData = { ...data, groups: [...chosen] };
  await saveLibrarySession(db, chatId, next);
  await renderAddStep(deps, chatId, actor, next, editMessageId);
}

/** Store the material, and — when the homework started it — select it for that draft too. */
async function finishAdd(
  deps: LibDeps, chatId: string, actor: HwActor, data: LibSessionData,
): Promise<void> {
  const db = deps.db;
  const ownerId = teacherIdOf(actor)!;
  const file = data.file as UploadedFile | undefined;
  const title = String(data.title ?? '').trim();
  if (!file || !title) {
    await clearLibrarySession(db, chatId);
    await send(deps, chatId, h('badButton', actor.lang));
    return;
  }
  const saved = await saveMaterial(db, ownerId, {
    title,
    kind: (data.kind ?? 'other') as HwMaterialKind,
    fileId: file.fileId,
    fileUniqueId: file.fileUniqueId,
    fileName: file.fileName,
    mimeType: file.mimeType,
    fileSize: file.fileSize,
    groupIds: (data.groups as string[] | undefined) ?? [],
  });
  if (saved.status === 'limit') {
    await send(deps, chatId, h('libTooMany', actor.lang, { n: MAX_MATERIALS }));
    return;
  }
  if (saved.status !== 'created' && saved.status !== 'updated') {
    await clearLibrarySession(db, chatId);
    await send(deps, chatId, h('libraryNoGroups', actor.lang));
    return;
  }
  const material = saved.row;
  const groupIds = (data.groups as string[] | undefined) ?? [];
  const names = (await listGroups(db, ownerId))
    .filter((g) => groupIds.includes(g.id)).map((g) => g.title).join(', ') || '—';
  const lines = [
    h('libSaved', actor.lang, { t: material.title, g: names }),
    saved.status === 'updated' ? h('libUpdated', actor.lang) : '',
  ].filter(Boolean).join('\n');
  await clearLibrarySession(db, chatId);

  if (data.source === 'homework' && data.draftId) {
    const draftId = String(data.draftId);
    await attachDraftMaterial(db, draftId, material);
    const moved = await transitionDraft(db, draftId, ownerId, ['choosing_materials'], 'awaiting_instruction');
    await send(deps, chatId, [
      lines,
      h('materialAttached', actor.lang, { t: material.title }),
    ].join('\n\n'), [[
      b(h('toHomeworkBtn', actor.lang), await cb(db, ownerId, { a: moved ? 'min' : 'home', d: draftId })),
    ]]);
    return;
  }
  await send(deps, chatId, lines, [
    [
      b(h('libraryManage', actor.lang), await cb(db, ownerId, { a: 'lib', x: 'manage' })),
      b(h('libraryAdd', actor.lang), await cb(db, ownerId, { a: 'lib', x: 'add' })),
    ],
    [b(h('back', actor.lang), await cb(db, ownerId, { a: 'lib', x: 'home' }))],
  ]);
}

// ─── group list / management ─────────────────────────────────────────────────

async function renderGroupList(
  deps: LibDeps, chatId: string, actor: HwActor, editMessageId?: number,
): Promise<void> {
  const db = deps.db;
  const ownerId = teacherIdOf(actor)!;
  const [groups, counts] = await Promise.all([listGroups(db, ownerId), materialCountByGroup(db, ownerId)]);
  const lines = [h('libGroupsTitle', actor.lang)];
  if (!groups.length) lines.push(h('noGroups', actor.lang));
  for (const g of groups) {
    lines.push(h('libGroupLine', actor.lang, { g: truncate(g.title, 40), n: counts.get(g.id) ?? 0 }));
  }
  const buttons: Btn[][] = [];
  for (const g of groups) {
    buttons.push([b(truncate(g.title, 55), await cb(db, ownerId, { a: 'lib', x: 'gmat', g: g.id }))]);
  }
  buttons.push([b(h('libraryAdd', actor.lang), await cb(db, ownerId, { a: 'lib', x: 'add' }))]);
  buttons.push([b(h('back', actor.lang), await cb(db, ownerId, { a: 'lib', x: 'home' }))]);
  await editOrSend(deps, chatId, editMessageId, lines.join('\n'), buttons);
}

async function renderGroupMaterials(
  deps: LibDeps, chatId: string, actor: HwActor, groupId: string, editMessageId?: number,
): Promise<void> {
  const db = deps.db;
  const ownerId = teacherIdOf(actor)!;
  const [groups, rows] = await Promise.all([
    listGroups(db, ownerId), materialsOfGroup(db, ownerId, groupId, { limit: MAX_MATERIALS }),
  ]);
  const group = groups.find((g) => g.id === groupId);
  if (!group) { await send(deps, chatId, h('groupMissing', actor.lang)); return; }
  const lines = [h('libGroupMaterialsTitle', actor.lang, { g: truncate(group.title, 60) })];
  if (!rows.length) lines.push(h('libGroupEmpty', actor.lang));
  for (const m of rows) {
    lines.push(`• ${truncate(m.title, 60)} · ${materialKindLabel(m.kind, actor.lang)}`);
  }
  const buttons: Btn[][] = [];
  for (const m of rows.slice(0, LIBRARY_SCREEN_LIMIT)) {
    buttons.push([b(truncate(m.title, 55), await cb(db, ownerId, { a: 'lib', x: 'mat', m: m.id }))]);
  }
  buttons.push([b(h('libraryAdd', actor.lang), await cb(db, ownerId, { a: 'lib', x: 'add' }))]);
  buttons.push([b(h('back', actor.lang), await cb(db, ownerId, { a: 'lib', x: 'groups' }))]);
  await editOrSend(deps, chatId, editMessageId, lines.join('\n'), buttons);
}

async function renderManage(
  deps: LibDeps, chatId: string, actor: HwActor, filterGroupId: string | undefined,
  editMessageId?: number,
): Promise<void> {
  const db = deps.db;
  const ownerId = teacherIdOf(actor)!;
  const [groups, rows] = await Promise.all([
    listGroups(db, ownerId),
    listMaterials(db, ownerId, {
      groupId: filterGroupId, includeArchived: true, limit: LIBRARY_SCREEN_LIMIT,
    }),
  ]);
  const lines = [h('libManageTitle', actor.lang)];
  if (!rows.length) lines.push(h('libManageEmpty', actor.lang));
  for (const m of rows) {
    const mark = m.status === 'archived' ? `🗄 ${h('libArchivedMark', actor.lang)} · ` : '';
    lines.push(`• ${mark}${truncate(m.title, 55)} · ${materialKindLabel(m.kind, actor.lang)}`);
  }
  const buttons: Btn[][] = [];
  if (groups.length > 1) {
    const filters: Btn[] = [b(h('libManageAll', actor.lang), await cb(db, ownerId, { a: 'lib', x: 'manage' }))];
    for (const g of groups.slice(0, 8)) {
      filters.push(b(truncate(g.title, 22), await cb(db, ownerId, { a: 'lib', x: 'manage', g: g.id })));
    }
    buttons.push(filters);
  }
  for (const m of rows) {
    buttons.push([b(
      truncate(`${m.status === 'archived' ? '🗄 ' : ''}${m.title}`, 55),
      await cb(db, ownerId, { a: 'lib', x: 'mat', m: m.id }),
    )]);
  }
  buttons.push([b(h('libraryAdd', actor.lang), await cb(db, ownerId, { a: 'lib', x: 'add' }))]);
  buttons.push([b(h('back', actor.lang), await cb(db, ownerId, { a: 'lib', x: 'home' }))]);
  await editOrSend(deps, chatId, editMessageId, lines.join('\n'), buttons);
}

async function renderDetail(
  deps: LibDeps, chatId: string, actor: HwActor, materialId: string, editMessageId?: number,
): Promise<void> {
  const db = deps.db;
  const ownerId = teacherIdOf(actor)!;
  const row = await getMaterial(db, materialId, ownerId);
  if (!row) { await send(deps, chatId, h('libNotFound', actor.lang)); return; }
  const [groups, linked] = await Promise.all([listGroups(db, ownerId), materialGroupIds(db, row.id)]);
  const names = groups.filter((g) => linked.includes(g.id)).map((g) => g.title);
  const lines = [
    h('libInfoLine', actor.lang, {
      t: row.title,
      k: materialKindLabel(row.kind, actor.lang),
      s: row.status === 'archived' ? h('libStatusArchived', actor.lang) : h('libStatusActive', actor.lang),
      f: `${row.fileName || '—'} · ${sizeLabel(row.fileSize, actor.lang)}`,
    }),
    h('libInfoGroups', actor.lang, { g: names.join(', ') || '—' }),
    lastUsedLabel(row, actor.lang, actor.tz),
  ];
  const buttons: Btn[][] = [
    [
      b(h('libRename', actor.lang), await cb(db, ownerId, { a: 'lib', x: 'ren', m: row.id })),
      b(h('libUseElsewhere', actor.lang), await cb(db, ownerId, { a: 'lib', x: 'use', m: row.id })),
    ],
    [row.status === 'archived'
      ? b(h('libRestore', actor.lang), await cb(db, ownerId, { a: 'lib', x: 'rest', m: row.id }))
      : b(h('libArchive', actor.lang), await cb(db, ownerId, { a: 'lib', x: 'arch', m: row.id }))],
    [b(h('libDelete', actor.lang), await cb(db, ownerId, { a: 'lib', x: 'del', m: row.id }))],
    [b(h('back', actor.lang), await cb(db, ownerId, { a: 'lib', x: 'manage' }))],
  ];
  await editOrSend(deps, chatId, editMessageId, lines.join('\n'), buttons);
}

async function renderUseElsewhere(
  deps: LibDeps, chatId: string, actor: HwActor, materialId: string,
): Promise<void> {
  const db = deps.db;
  const ownerId = teacherIdOf(actor)!;
  const [row, groups, linked] = await Promise.all([
    getMaterial(db, materialId, ownerId), listGroups(db, ownerId), materialGroupIds(db, materialId),
  ]);
  if (!row) { await send(deps, chatId, h('libNotFound', actor.lang)); return; }
  const free = groups.filter((g) => !linked.includes(g.id) && g.status === 'active');
  if (!free.length) { await send(deps, chatId, h('libNoOtherGroups', actor.lang)); return; }
  const buttons: Btn[][] = [];
  for (const g of free.slice(0, LIBRARY_SCREEN_LIMIT)) {
    buttons.push([b(truncate(g.title, 55), await cb(db, ownerId, { a: 'lib', x: 'useg', m: row.id, g: g.id }))]);
  }
  buttons.push([b(h('back', actor.lang), await cb(db, ownerId, { a: 'lib', x: 'mat', m: row.id }))]);
  await send(deps, chatId, h('libAskGroups', actor.lang), buttons);
}

async function renderLinkConfirm(
  deps: LibDeps, chatId: string, actor: HwActor, materialId: string, groupId: string,
): Promise<void> {
  const db = deps.db;
  const ownerId = teacherIdOf(actor)!;
  const [row, groups] = await Promise.all([getMaterial(db, materialId, ownerId), listGroups(db, ownerId)]);
  const group = groups.find((g) => g.id === groupId);
  if (!row || !group) { await send(deps, chatId, h('libNotFound', actor.lang)); return; }
  await send(deps, chatId, h('libLinkConfirm', actor.lang, { t: row.title, g: group.title }), [
    [b(h('libLinkYes', actor.lang), await cb(db, ownerId, { a: 'lib', x: 'usey', m: row.id, g: group.id }))],
    [b(h('back', actor.lang), await cb(db, ownerId, { a: 'lib', x: 'mat', m: row.id }))],
  ]);
}

async function renderArchiveConfirm(
  deps: LibDeps, chatId: string, actor: HwActor, materialId: string,
): Promise<void> {
  const db = deps.db;
  const ownerId = teacherIdOf(actor)!;
  const row = await getMaterial(db, materialId, ownerId);
  if (!row) { await send(deps, chatId, h('libNotFound', actor.lang)); return; }
  await send(deps, chatId, h('libArchiveConfirm', actor.lang, { t: row.title }), [
    [b(h('libArchiveYes', actor.lang), await cb(db, ownerId, { a: 'lib', x: 'archy', m: row.id }))],
    [b(h('back', actor.lang), await cb(db, ownerId, { a: 'lib', x: 'mat', m: row.id }))],
  ]);
}

async function renderDeleteConfirm(
  deps: LibDeps, chatId: string, actor: HwActor, materialId: string,
): Promise<void> {
  const db = deps.db;
  const ownerId = teacherIdOf(actor)!;
  const row = await getMaterial(db, materialId, ownerId);
  if (!row) { await send(deps, chatId, h('libNotFound', actor.lang)); return; }
  await send(deps, chatId, h('libDeleteConfirm', actor.lang, { t: row.title }), [
    [b(h('libDeleteYes', actor.lang), await cb(db, ownerId, { a: 'lib', x: 'dely', m: row.id }))],
    [b(h('back', actor.lang), await cb(db, ownerId, { a: 'lib', x: 'mat', m: row.id }))],
  ]);
}

// ─── text input of the library dialog ───────────────────────────────────────

/**
 * A message that belongs to the library dialog. The homework flow calls this while a
 * `hw:lib` session is live, so a textbook sent here is filed, never mistaken for the text
 * of the task.
 */
export async function libraryInput(
  deps: LibDeps, chatId: string, actor: HwActor, m: HwIncoming, session: HwSession,
): Promise<boolean> {
  const db = deps.db;
  const ownerId = teacherIdOf(actor);
  if (!ownerId) return false;
  const data = session.data as LibSessionData;
  const text = (m.text ?? '').trim();
  if (text.toLowerCase() === '/cancel') {
    await clearLibrarySession(db, chatId);
    await send(deps, chatId, h('libCancelled', actor.lang));
    return true;
  }
  // any other command still reaches the dispatcher: /library must keep working
  if (text.startsWith('/')) return false;

  if (data.step === 'add-file') {
    const found = fileOf(m);
    if (!found) {
      const junk = Boolean(m.video || m.voice || m.sticker || m.animation || m.audio
        || m.video_note || m.poll || m.contact || m.location);
      await send(deps, chatId, junk
        ? h('videoUnsupported', actor.lang) : h('libFileBad', actor.lang));
      return true;
    }
    if (found.file.fileSize && found.file.fileSize > MAX_FILE_MB * 1024 * 1024) {
      await send(deps, chatId, h('collectTooBig', actor.lang, { n: MAX_FILE_MB }));
      return true;
    }
    const suggested = (m.caption ?? '').trim().slice(0, MAX_MATERIAL_TITLE)
      || suggestMaterialTitle(found.file.fileName, found.isPhoto, actor.lang);
    const next: LibSessionData = { ...data, step: 'add-title', file: found.file, title: suggested };
    await saveLibrarySession(db, chatId, next);
    await send(deps, chatId, h('libAskTitle', actor.lang, { n: MAX_MATERIAL_TITLE, s: suggested }));
    return true;
  }

  if (data.step === 'add-title') {
    if (!text || text.length > MAX_MATERIAL_TITLE) {
      await send(deps, chatId, h('libTitleBad', actor.lang, { n: MAX_MATERIAL_TITLE }));
      return true;
    }
    const next: LibSessionData = { ...data, step: 'add-kind', title: text };
    await saveLibrarySession(db, chatId, next);
    await renderKind(deps, chatId, actor);
    return true;
  }

  if (data.step === 'add-kind') { await renderKind(deps, chatId, actor); return true; }
  if (data.step === 'add-groups' || data.step === 'add-confirm') {
    await renderAddStep(deps, chatId, actor, data);
    return true;
  }

  if (data.step === 'rename') {
    if (!text || text.length > MAX_MATERIAL_TITLE) {
      await send(deps, chatId, h('libTitleBad', actor.lang, { n: MAX_MATERIAL_TITLE }));
      return true;
    }
    const row = await renameMaterial(db, String(data.materialId ?? ''), ownerId, text);
    await clearLibrarySession(db, chatId);
    if (!row) { await send(deps, chatId, h('libNotFound', actor.lang)); return true; }
    await send(deps, chatId, h('libRenamed', actor.lang, { t: row.title }));
    await renderDetail(deps, chatId, actor, row.id);
    return true;
  }
  return false;
}

// ─── callbacks ───────────────────────────────────────────────────────────────

/** The homework flow uses this to hand a pressed library button over. */
export function isLibraryPayload(payload: Record<string, string>): boolean {
  return payload.a === 'lib';
}

export async function libraryCallback(
  deps: LibDeps, chatId: string, actor: HwActor, payload: Record<string, string>,
  messageId?: number,
): Promise<void> {
  const db = deps.db;
  const ownerId = teacherIdOf(actor);
  if (!ownerId) { await deps.api.sendMessage(chatId, h('denied', actor.lang)); return; }
  const x = payload.x ?? '';

  switch (x) {
    case 'home':
      await clearLibrarySession(db, chatId);
      await renderHome(deps, chatId, actor, messageId);
      return;
    case 'add':
      await beginAdd(deps, chatId, actor, messageId);
      return;
    case 'ag':
      await toggleAddGroup(deps, chatId, actor, payload.g ?? '', messageId);
      return;
    case 'agc': {
      const data = await loadLibrarySession(db, chatId);
      const chosen = (data?.groups as string[] | undefined) ?? [];
      if (!data || !chosen.length) {
        await send(deps, chatId, h('libAskGroups', actor.lang));
        return;
      }
      const next: LibSessionData = { ...data, step: 'add-file' };
      await saveLibrarySession(db, chatId, next);
      await editOrSend(deps, chatId, messageId, h('libAskFile', actor.lang, { n: MAX_FILE_MB }));
      return;
    }
    case 'kind': {
      const kind = (KINDS as readonly string[]).includes(payload.k ?? '')
        ? payload.k as HwMaterialKind : 'other';
      const data = await loadLibrarySession(db, chatId);
      if (!data) { await send(deps, chatId, h('badButton', actor.lang)); return; }
      const next: LibSessionData = { ...data, step: 'add-confirm', kind };
      await saveLibrarySession(db, chatId, next);
      await renderAddStep(deps, chatId, actor, next, messageId);
      return;
    }
    case 'save': {
      const data = await loadLibrarySession(db, chatId);
      if (!data || data.step !== 'add-confirm') {
        await send(deps, chatId, h('badButton', actor.lang));
        return;
      }
      await finishAdd(deps, chatId, actor, data);
      return;
    }
    case 'cancel':
      await clearLibrarySession(db, chatId);
      await send(deps, chatId, h('libCancelled', actor.lang));
      return;
    case 'groups':
      await renderGroupList(deps, chatId, actor, messageId);
      return;
    case 'gmat':
      await renderGroupMaterials(deps, chatId, actor, payload.g ?? '', messageId);
      return;
    case 'manage':
      await renderManage(deps, chatId, actor, payload.g || undefined, messageId);
      return;
    case 'mat':
      await clearLibrarySession(db, chatId);
      await renderDetail(deps, chatId, actor, payload.m ?? '', messageId);
      return;
    case 'ren': {
      const row = await getMaterial(db, payload.m ?? '', ownerId);
      if (!row) { await send(deps, chatId, h('libNotFound', actor.lang)); return; }
      await saveLibrarySession(db, chatId, { step: 'rename', materialId: row.id });
      await send(deps, chatId, h('libRenameAsk', actor.lang, { n: MAX_MATERIAL_TITLE }));
      return;
    }
    case 'use':
      await renderUseElsewhere(deps, chatId, actor, payload.m ?? '');
      return;
    case 'useg':
      await renderLinkConfirm(deps, chatId, actor, payload.m ?? '', payload.g ?? '');
      return;
    case 'usey': {
      const ok = await linkMaterialGroup(db, payload.m ?? '', ownerId, payload.g ?? '');
      const row = ok ? await getMaterial(db, payload.m ?? '', ownerId) : null;
      const groups = await listGroups(db, ownerId);
      const group = groups.find((g) => g.id === payload.g);
      await send(deps, chatId, row && group
        ? h('libLinked', actor.lang, { t: row.title, g: group.title })
        : h('groupMissing', actor.lang));
      if (row) await renderDetail(deps, chatId, actor, row.id);
      return;
    }
    case 'arch':
      await renderArchiveConfirm(deps, chatId, actor, payload.m ?? '');
      return;
    case 'archy': {
      const row = await setMaterialStatus(db, payload.m ?? '', ownerId, 'archived');
      if (!row) { await send(deps, chatId, h('libNotFound', actor.lang)); return; }
      await send(deps, chatId, h('libArchived', actor.lang, { t: row.title }));
      await renderManage(deps, chatId, actor, undefined);
      return;
    }
    case 'rest': {
      const row = await setMaterialStatus(db, payload.m ?? '', ownerId, 'active');
      if (!row) { await send(deps, chatId, h('libNotFound', actor.lang)); return; }
      await send(deps, chatId, h('libRestored', actor.lang, { t: row.title }));
      await renderDetail(deps, chatId, actor, row.id);
      return;
    }
    case 'del':
      await renderDeleteConfirm(deps, chatId, actor, payload.m ?? '');
      return;
    case 'dely': {
      const ok = await deleteMaterial(db, payload.m ?? '', ownerId);
      await send(deps, chatId, ok ? h('libDeleted', actor.lang) : h('libNotFound', actor.lang));
      await renderManage(deps, chatId, actor, undefined);
      return;
    }
    default:
      await send(deps, chatId, h('badButton', actor.lang));
  }
}
