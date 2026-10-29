/**
 * The teacher-facing flow: group selection, material collection, formatting, preview,
 * editing, explicit publication and history. All user-visible strings live in texts.ts;
 * all state changes go through store.ts and all sending goes through publish.ts.
 */
import { describeError } from '../../lib/redact.js';
import type { DB } from '../../db/index.js';
import { applyEnglishMenu } from '../botApi.js';
import type { BotApi, InlineButton } from '../botApi.js';
import { LOCAL_AI } from './ai.js';
import {
  LIBRARY_SCREEN_LIMIT, MAX_DRAFT_MATERIALS, MAX_EDIT_TEXT, MAX_FILE_MB, MAX_GROUPS,
  MAX_ITEM_TEXT, MAX_ITEMS, PREVIEW_CHARS,
} from './constants.js';
import { canRetry, isRetryableRow, publishDraft, retryFailedPublications } from './publish.js';
import {
  addGroup, addItem, clearHomeworkSession, createDraft, getDraft,
  HW_EDIT_STATE, itemCount, latestActiveDraft, linkedUserIdByTelegramId, listGroups, listItems,
  patchDraft, personalChatOf, publicationsOf, recentPublications, removeGroup,
  resolveActor, saveEditSession, selectedGroups, setGroupKind, toggleTarget, transitionDraft,
  upsertOperator, type HwDraftRow, type HwItemRow, type HwPublicationRow,
} from './store.js';
import {
  claimBindCode, claimHomeworkCallback, createBindCode, makeHomeworkCallback,
} from './tokens.js';
import { h, kindLabel } from './texts.js';
import { legalStatus } from '../legal.js';
import {
  eligibleMaterials, listDraftMaterials, pruneDraftMaterials, toggleDraftMaterial,
  HW_LIB_STATE, clearLibrarySession, type HwDraftMaterialRow,
} from './libraryStore.js';
import {
  isLibraryPayload, libraryCallback, libraryInput, startHomeworkMaterialUpload,
} from './library.js';
import { materialKindLabel } from './texts.js';
import type { HwActor, HwItemKind, HwLang, HomeworkAi } from './types.js';

export interface HomeworkDeps {
  db: DB;
  api: BotApi;
  /** Missing in old tests/demos — the deterministic local formatter is used instead. */
  homeworkAi?: HomeworkAi;
}

export interface HwSession {
  state: string;
  data: Record<string, unknown>;
}

/** Structural subset of the bot's TgMessage; bot.ts passes its own object unchanged. */
export interface HwIncoming {
  message_id: number;
  from?: { id?: number; username?: string; first_name?: string; last_name?: string };
  text?: string;
  caption?: string;
  /** Telegram's album id: photos sent together share it and are copied together. */
  media_group_id?: string;
  photo?: { file_id: string; file_unique_id: string; file_size?: number }[];
  document?: {
    file_id: string; file_unique_id: string; file_name?: string;
    mime_type?: string; file_size?: number;
  };
  forward_origin?: { type?: string };
  forward_from?: { id?: number };
  forward_from_chat?: { id?: number; title?: string };
  video?: unknown; voice?: unknown; sticker?: unknown; animation?: unknown;
  audio?: unknown; video_note?: unknown; poll?: unknown; contact?: unknown; location?: unknown;
}

type Btn = InlineButton;
const b = (text: string, cb?: string): Btn => ({ text, cb });
const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

interface Teacher { userId: string; actor: HwActor }

function teacherOf(actor: HwActor): Teacher | null {
  return actor.userId && actor.role === 'teacher' ? { userId: actor.userId, actor } : null;
}

async function send(api: BotApi, chatId: string, text: string, buttons?: Btn[][]) {
  // Every screen is one Telegram message; 4000 leaves room for the button markup.
  await api.sendMessage(chatId, truncate(text, 4_000), buttons?.length ? { buttons } : undefined);
}

async function editOrSend(
  api: BotApi, chatId: string, messageId: number | undefined,
  text: string, buttons?: Btn[][],
) {
  const body = truncate(text, 4_000);
  if (messageId !== undefined) {
    try {
      await api.editMessageText(chatId, messageId, body, buttons?.length ? { buttons } : undefined);
      return;
    } catch { /* the message may be too old or already removed — send a fresh one */ }
  }
  await api.sendMessage(chatId, body, buttons?.length ? { buttons } : undefined);
}

async function cb(
  deps: HomeworkDeps, ownerId: string, payload: Record<string, string>,
  opts: { once?: boolean; ttlMs?: number } = {},
): Promise<string> {
  return makeHomeworkCallback(deps.db, ownerId, payload, opts);
}

// ─── screens ─────────────────────────────────────────────────────────────────

/**
 * Statuses from which saved materials may be chosen or uploaded. Chosing a book never changes
 * the draft's state — it only adds or removes a snapshot — so the picker is reachable from
 * collecting and from preview alike, and «back» returns to whichever screen she came from.
 */
const PICKABLE: readonly HwDraftRow['status'][] = [
  'selecting', 'choosing_materials', 'awaiting_instruction', 'collecting',
  'needs_clarification', 'preview',
];

/**
 * Statuses in which an incoming message becomes material of the draft. `selecting` is here on
 * purpose: a teacher who types «Unit 2, exercises 1–5» before pressing Continue must not be
 * ignored — the words belong to the draft she is about to fill.
 */
const INGESTIBLE: readonly HwDraftRow['status'][] = [
  'selecting', 'choosing_materials', 'awaiting_instruction', 'collecting', 'needs_clarification',
];

async function renderSelection(
  deps: HomeworkDeps, chatId: string, actor: HwActor, draft: HwDraftRow,
  editMessageId?: number,
): Promise<void> {
  const { db, api } = deps;
  const ownerId = actor.userId!;
  const [groups, selected] = await Promise.all([
    listGroups(db, ownerId),
    selectedGroups(db, draft.id),
  ]);
  const selectedIds = new Set(selected.map((g) => g.id));
  const lines = [
    h('selectTitle', actor.lang, { n: selected.length }),
    '',
    h('selectHint', actor.lang),
    groups.length ? h('groupCount', actor.lang, { n: groups.length }) : h('noGroups', actor.lang),
  ];
  if (!groups.length) {
    await editOrSend(api, chatId, editMessageId, lines.join('\n'), [
      [b(h('addGroup', actor.lang), await cb(deps, ownerId, { a: 'ga', d: draft.id }))],
      [b(h('cancel', actor.lang), await cb(deps, ownerId, { a: 'cancel', d: draft.id }))],
    ]);
    return;
  }
  /*
   * Step 1 of the simplified flow (live test 2026-10-23: too many screens): the groups, one
   * continue button, and the two things she may need about groups themselves. Materials are
   * NOT chosen here — the next screen takes text, files and library books together.
   */
  const buttons: Btn[][] = [];
  for (const g of groups) {
    const mark = selectedIds.has(g.id) ? '☑' : '☐';
    const kind = g.kind === 'online' ? h('online', actor.lang) : h('offline', actor.lang);
    buttons.push([b(
      truncate(`${mark} ${g.title} · ${kind}`, 60),
      await cb(deps, ownerId, { a: 'sel', d: draft.id, g: g.id }),
    )]);
  }
  if (selected.length) {
    buttons.push([b(h('continueBtn', actor.lang, { n: selected.length }),
      await cb(deps, ownerId, { a: 'start', d: draft.id }))]);
  }
  buttons.push([
    b(h('addGroup', actor.lang), await cb(deps, ownerId, { a: 'ga', d: draft.id })),
    b(h('manageGroups', actor.lang), await cb(deps, ownerId, { a: 'gm', d: draft.id })),
  ]);
  buttons.push([b(h('cancel', actor.lang), await cb(deps, ownerId, { a: 'cancel', d: draft.id }))]);
  await editOrSend(api, chatId, editMessageId, lines.join('\n'), buttons);
}

/**
 * Step 2 — one screen where everything arrives: her own words, photos, files, forwarded
 * messages and saved library books. Nothing is published and nothing is formatted until she
 * presses Done, so the screen itself needs no warnings, only the three actions.
 */
async function renderCollecting(
  deps: HomeworkDeps, chatId: string, actor: HwActor, draft: HwDraftRow,
  editMessageId?: number,
): Promise<void> {
  const ownerId = actor.userId!;
  const [n, materials] = await Promise.all([
    itemCount(deps.db, draft.id),
    listDraftMaterials(deps.db, draft.id),
  ]);
  const lines = [
    h('collectTitle', actor.lang, { n }),
    materials.length
      ? h('collectMaterials', actor.lang, { m: clip(materials.map((m) => m.title).join(', '), 200) })
      : '',
    '',
    h('collectHint', actor.lang),
  ].filter(Boolean);
  await editOrSend(deps.api, chatId, editMessageId, lines.join('\n'), [
    [b(h('doneCta', actor.lang), await cb(deps, ownerId, { a: 'done', d: draft.id }))],
    [
      b(h('libraryBtn', actor.lang), await cb(deps, ownerId, { a: 'mtr', d: draft.id })),
      b(h('cancel', actor.lang), await cb(deps, ownerId, { a: 'cancel', d: draft.id })),
    ],
  ]);
}

/**
 * The saved books that belong to EVERY group of this draft, most recently used first.
 * Multi-select, and a file she has not saved yet can be uploaded straight into the library.
 */
async function renderMaterialPicker(
  deps: HomeworkDeps, chatId: string, actor: HwActor, draft: HwDraftRow,
  editMessageId?: number,
): Promise<void> {
  const ownerId = actor.userId!;
  const targets = await selectedGroups(deps.db, draft.id);
  const [eligible, chosen] = await Promise.all([
    eligibleMaterials(deps.db, ownerId, targets.map((g) => g.id), LIBRARY_SCREEN_LIMIT),
    listDraftMaterials(deps.db, draft.id),
  ]);
  const picked = new Set(chosen.map((m) => m.materialId));
  const lines = [
    h('pickerTitle', actor.lang, { n: chosen.length }),
    h('pickerHint', actor.lang),
  ];
  if (!eligible.length) lines.push(h('noMaterialsForGroups', actor.lang));
  const buttons: Btn[][] = [];
  for (const m of eligible) {
    buttons.push([b(
      truncate(`${picked.has(m.id) ? '☑' : '☐'} ${m.title} · ${materialKindLabel(m.kind, actor.lang)}`, 58),
      await cb(deps, ownerId, { a: 'mtg', d: draft.id, m: m.id }),
    )]);
  }
  buttons.push([b(h('backToHomework', actor.lang, { n: chosen.length }),
    await cb(deps, ownerId, { a: 'mbk', d: draft.id }))]);
  buttons.push([
    b(h('uploadNewMaterial', actor.lang), await cb(deps, ownerId, { a: 'mup', d: draft.id })),
    b(h('cancel', actor.lang), await cb(deps, ownerId, { a: 'cancel', d: draft.id })),
  ]);
  await editOrSend(deps.api, chatId, editMessageId, lines.join('\n'), buttons);
}

async function renderClarification(
  deps: HomeworkDeps, chatId: string, actor: HwActor, draft: HwDraftRow,
): Promise<void> {
  const ownerId = actor.userId!;
  const questions = draft.aiQuestions.length ? draft.aiQuestions : [h('aiClarifyFallback', actor.lang)];
  const warnings = draft.aiWarnings.length
    ? `\n\n${h('previewWarnings', actor.lang, { w: draft.aiWarnings.map((w) => `• ${w}`).join('\n') })}`
    : '';
  const text = [
    h('clarifyTitle', actor.lang),
    ...questions.map((q) => `• ${q}`),
    '',
    h('clarifyHint', actor.lang) + warnings,
  ].join('\n');
  await send(deps.api, chatId, text, [
    [b(h('doneCta', actor.lang), await cb(deps, ownerId, { a: 'done', d: draft.id }))],
    [b(h('cancel', actor.lang), await cb(deps, ownerId, { a: 'cancel', d: draft.id }))],
  ]);
}

/**
 * Exactly what each group will receive as files: the chosen library materials plus the
 * collected photos/documents. The teacher sees this before confirming — an attachment that is
 * not listed here is not sent, and a group never receives a book of another group.
 */
function attachmentLines(
  lang: HwLang,
  targets: { title: string }[],
  items: HwItemRow[],
  materials: HwDraftMaterialRow[],
): string[] {
  if (!targets.length) return [];
  const collected = items.filter((i) => (i.kind === 'photo' || i.kind === 'document') && i.fileId);
  if (!materials.length && !collected.length) return [h('previewNoAttachments', lang)];
  return targets.map((g) => {
    const names = [
      ...materials.map((m) => `${materialKindLabel(m.kind, lang)}: ${truncate(m.title, 40)}`),
      ...collected.map((i) => (i.kind === 'document' ? (i.fileName || kindLabel('document', lang)) : kindLabel('photo', lang))),
    ];
    return h('previewAttachmentFor', lang, {
      g: truncate(g.title, 40),
      a: clip(names.join('; ') || h('previewAttachmentNone', lang), 300),
    });
  });
}

async function renderPreview(
  deps: HomeworkDeps, chatId: string, actor: HwActor, draft: HwDraftRow,
  editMessageId?: number,
): Promise<void> {
  const ownerId = actor.userId!;
  const [items, targets, materials] = await Promise.all([
    listItems(deps.db, draft.id),
    selectedGroups(deps.db, draft.id),
    listDraftMaterials(deps.db, draft.id),
  ]);
  const body = draft.formattedText.trim() || draft.title.trim();
  const shown = truncate(body, PREVIEW_CHARS);
  const names = targets.map((g) => g.title).join(', ');
  const parts = [
    h('previewTitle', actor.lang, { n: targets.length }),
    h('previewGroups', actor.lang, { g: clip(names || '—', 400) }),
  ];
  if (materials.length) {
    parts.push(h('previewMaterials', actor.lang, { m: materials.map((m) => m.title).join(', ') }));
  }
  if (draft.instruction.trim()) {
    parts.push(h('previewInstruction', actor.lang, { i: clip(draft.instruction.trim(), 300) }));
  }
  parts.push(...attachmentLines(actor.lang, targets, items, materials));
  if (draft.aiWarnings.length) {
    parts.push(h('previewWarnings', actor.lang, { w: draft.aiWarnings.map((w) => `• ${w}`).join('\n') }));
  }
  parts.push('—', shown);
  if (body.length > PREVIEW_CHARS) parts.push(h('previewCut', actor.lang, { n: PREVIEW_CHARS }));
  if (!targets.length) parts.push('', h('noTargets', actor.lang));
  parts.push('', h('previewNoPublish', actor.lang));

  const v = String(draft.updatedAt.getTime());
  /*
   * Step 4 — one confirmation and the three things she can still change: the words, more
   * materials, the groups. Nothing else. Publication never starts by itself.
   */
  const buttons: Btn[][] = [];
  if (targets.length) {
    buttons.push([b(h('publishBtn', actor.lang), await cb(deps, ownerId, { a: 'pub', d: draft.id, v }))]);
  }
  buttons.push([
    b(h('editBtn', actor.lang), await cb(deps, ownerId, { a: 'edit', d: draft.id, v })),
    b(h('addBtn', actor.lang), await cb(deps, ownerId, { a: 'add', d: draft.id, v })),
  ]);
  buttons.push([
    b(h('changeGroups', actor.lang), await cb(deps, ownerId, { a: 'chg', d: draft.id })),
    b(h('cancel', actor.lang), await cb(deps, ownerId, { a: 'cancel', d: draft.id })),
  ]);
  await editOrSend(deps.api, chatId, editMessageId, parts.join('\n'), buttons);
}

/**
 * Step 5 — what really happened, part by part.
 *
 * The old headline counted GROUPS and said «0 of 1 sent» for a homework whose text was
 * sitting in the group and whose file had been refused. The parts are what the teacher can
 * act on, so each one is named: the text, then every attachment, each with its own outcome.
 */
async function renderResult(
  deps: HomeworkDeps, chatId: string, actor: HwActor, draft: HwDraftRow,
): Promise<void> {
  const ownerId = actor.userId!;
  const rows = await publicationsOf(deps.db, draft.id);
  const lines: string[] = [h('publishResultTitle', actor.lang)];
  let needsReupload = false;
  for (const row of rows.slice(0, 25)) {
    const g = clip(row.groupTitle, 60);
    const parts = row.parts ?? [];
    const ok = parts.filter((p) => p.status === 'sent').length;
    const bad = parts.filter((p) => p.status === 'failed').length;
    const unknown = parts.filter((p) => p.status === 'unknown').length;
    if (!parts.length) {
      // a row written before per-part tracking existed: say what the row itself guarantees
      if (row.status === 'sent') lines.push(h('pubSent', actor.lang, { g }));
      else if (row.status === 'failed') lines.push(h('pubFailed', actor.lang, { g, r: clip(row.error || h('sendFailed', actor.lang), 80) }));
      else lines.push(h('pubCheckGroup', actor.lang, { g }));
      continue;
    }
    if (row.status === 'sent') lines.push(h('pubSent', actor.lang, { g }));
    else if (unknown > 0) lines.push(h('pubCheckGroup', actor.lang, { g }));
    else if (ok === 0) lines.push(h('pubFailed', actor.lang, { g, r: clip(row.error || h('sendFailed', actor.lang), 80) }));
    else lines.push(h('pubPartial', actor.lang, { g, ok, bad }));
    for (const p of parts) {
      if (p.status === 'sent' && row.status === 'sent') continue; // nothing to explain
      const label = p.kind === 'text' ? h('partText', actor.lang) : clip(p.label, 40);
      const state = p.status === 'sent' ? h('partSent', actor.lang)
        : p.status === 'unknown' ? h('partUnknown', actor.lang)
          : h('partFailed', actor.lang, { r: clip(p.error, 70) });
      lines.push(h('partLine', actor.lang, { l: label, s: state }));
      if (p.status === 'failed' && p.kind !== 'text') needsReupload = true;
    }
  }
  lines.push('');
  const all = rows.length > 0 && rows.every((r) => r.status === 'sent');
  if (all) lines.push(h('publishedAll', actor.lang));
  else if (rows.some((r) => r.status === 'uncertain' || r.status === 'sending')) lines.push(h('publishedUnknown', actor.lang));
  else lines.push(h('publishedSome', actor.lang));
  if (needsReupload) lines.push(h('reuploadHint', actor.lang));

  const buttons: Btn[][] = [];
  // Retry only what is provably missing: a definite refusal, or a run whose every part has a
  // definite outcome. An unknown part never gets a button — the teacher looks at the group.
  if (canRetry(rows)) {
    buttons.push([b(h('retryBtn', actor.lang), await cb(deps, ownerId, { a: 'retry', d: draft.id }))]);
  }
  buttons.push([b(h('newDraftBtn', actor.lang), await cb(deps, ownerId, { a: 'new' }))]);
  buttons.push([b(h('historyBtn', actor.lang), await cb(deps, ownerId, { a: 'hist' }))]);
  await send(deps.api, chatId, lines.join('\n'), buttons);
}

function statusWord(status: HwPublicationRow['status'], lang: HwLang): string {
  if (status === 'sent') return h('statusSent', lang);
  if (status === 'failed') return h('statusFailed', lang);
  if (status === 'uncertain') return h('statusUncertain', lang);
  return h('statusSending', lang);
}

function historyDate(date: Date, lang: HwLang, tz: string): string {
  const locale = lang === 'ru' ? 'ru-RU' : lang === 'uz' ? 'uz-UZ' : 'en-GB';
  try {
    return new Intl.DateTimeFormat(locale, {
      day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: tz,
    }).format(date);
  } catch {
    return date.toISOString().slice(0, 16).replace('T', ' ');
  }
}

async function renderHistory(
  deps: HomeworkDeps, chatId: string, actor: HwActor,
): Promise<void> {
  const rows = await recentPublications(deps.db, actor.userId!, 12);
  const lines = [h('historyTitle', actor.lang)];
  if (!rows.length) lines.push(h('historyEmpty', actor.lang));
  for (const row of rows) {
    lines.push(h('historyLine', actor.lang, {
      at: historyDate(row.updatedAt, actor.lang, actor.tz),
      g: clip(row.groupTitle, 50),
      s: statusWord(row.status, actor.lang),
    }));
  }
  const buttons: Btn[][] = [[
    b(h('back', actor.lang), await cb(deps, actor.userId!, { a: 'home' })),
  ]];
  // A separate message: the preview/result screen that opened History keeps its buttons.
  await send(deps.api, chatId, lines.join('\n'), buttons);
}

// ─── command entry ───────────────────────────────────────────────────────────

export async function homeworkCommand(
  deps: HomeworkDeps, chatId: string, actor: HwActor, m?: HwIncoming,
): Promise<void> {
  const teacher = teacherOf(actor);
  if (!teacher) {
    await send(deps.api, chatId, h('denied', actor.lang));
    return;
  }
  await clearHomeworkSession(deps.db, chatId);
  // `/homework` is a fresh look at the draft: a half-finished library dialog must not keep
  // stealing the teacher's next message. The library itself is one `/library` away.
  await clearLibrarySession(deps.db, chatId);
  if (m) {
    const from = m.from;
    const displayName = [from?.first_name, from?.last_name].filter(Boolean).join(' ').trim();
    await upsertOperator(
      deps.db, teacher.userId, from?.id ?? chatIdNumber(chatId), chatId,
      from?.username ?? '', displayName,
    );
    /*
     * English command labels for THIS chat, whenever the account is English. Telegram draws
     * the menu from the CLIENT language, so an English account with a Russian app was shown
     * «Библиотека материалов» beside English screens (live test 2026-10-23). `setMyCommands`
     * is idempotent and sends no message; a failure here must not break /homework.
     */
    if (actor.lang === 'en') {
      await applyEnglishMenu(deps.api, 'teacher', chatId).catch(() => undefined);
    }
  }
  let draft = await latestActiveDraft(deps.db, teacher.userId);
  if (!draft) draft = await createDraft(deps.db, teacher.userId);
  await renderDraft(deps, chatId, actor, draft);
}

/** Telegram private chat id is numeric; the DB keeps it as text. */
function chatIdNumber(chatId: string): number {
  const n = Number(chatId);
  return Number.isFinite(n) ? n : 0;
}

async function renderDraft(
  deps: HomeworkDeps, chatId: string, actor: HwActor, draft: HwDraftRow,
  editMessageId?: number,
): Promise<void> {
  // The two library screens of the old flow are gone (live test: too many steps). A draft
  // left in one of them by the previous version is moved to the single collecting screen.
  if (draft.status === 'choosing_materials' || draft.status === 'awaiting_instruction') {
    const moved = await transitionDraft(
      deps.db, draft.id, actor.userId!, ['choosing_materials', 'awaiting_instruction'], 'collecting',
    );
    return renderCollecting(deps, chatId, actor, moved ?? draft, editMessageId);
  }
  switch (draft.status) {
    case 'selecting': return renderSelection(deps, chatId, actor, draft, editMessageId);
    case 'collecting': return renderCollecting(deps, chatId, actor, draft, editMessageId);
    case 'formatting':
      return send(deps.api, chatId, h('formatting', actor.lang));
    case 'needs_clarification': return renderClarification(deps, chatId, actor, draft);
    case 'preview': return renderPreview(deps, chatId, actor, draft, editMessageId);
    case 'publishing': {
      const rows = await publicationsOf(deps.db, draft.id);
      return send(deps.api, chatId, h('publishing', actor.lang, { n: rows.length || 1 }));
    }
    case 'failed':
    case 'publish_unknown':
      return renderResult(deps, chatId, actor, draft);
    default:
      return;
  }
}

// ─── materials ───────────────────────────────────────────────────────────────

function isForwarded(m: HwIncoming): boolean {
  return Boolean(m.forward_origin || m.forward_from || m.forward_from_chat);
}

function isSingleLink(text: string): boolean {
  return /^(?:https?:\/\/|t\.me\/|www\.)\S+$/i.test(text) && !/\s/.test(text);
}

function unsupported(m: HwIncoming): boolean {
  return Boolean(m.video || m.voice || m.sticker || m.animation || m.audio
    || m.video_note || m.poll || m.contact || m.location);
}

interface IngestResult {
  ok: boolean;
  reason?: 'empty' | 'unsupported' | 'tooLong' | 'tooBig' | 'tooMany' | 'duplicate';
  kind?: HwItemKind;
  count?: number;
}

async function ingest(
  deps: HomeworkDeps, chatId: string, draft: HwDraftRow, actor: HwActor, m: HwIncoming,
): Promise<IngestResult> {
  const { db } = deps;
  const sourceMessageId = m.message_id;
  // Where the message physically is: publication copies THIS message into the group, so a
  // photo stays a photo, a file keeps its name, and no byte ever touches Render.
  const source = { sourceChatId: chatId, sourceMessageId, sourceMediaGroupId: m.media_group_id ?? null };
  const forwarded = isForwarded(m);
  const caption = (m.caption ?? '').slice(0, 1024);
  const text = (m.text ?? '').trim();

  let input: Parameters<typeof addItem>[2] | null = null;
  if (m.photo?.length) {
    const photo = m.photo[m.photo.length - 1]!;
    if (photo.file_size && photo.file_size > MAX_FILE_MB * 1024 * 1024) {
      return { ok: false, reason: 'tooBig' };
    }
    input = {
      kind: 'photo', fileId: photo.file_id, fileUniqueId: photo.file_unique_id,
      fileSize: photo.file_size ?? null, caption, ...source, forwarded,
    };
  } else if (m.document) {
    const doc = m.document;
    if (doc.file_size && doc.file_size > MAX_FILE_MB * 1024 * 1024) {
      return { ok: false, reason: 'tooBig' };
    }
    input = {
      kind: 'document', fileId: doc.file_id, fileUniqueId: doc.file_unique_id,
      fileName: doc.file_name ?? null, mimeType: doc.mime_type ?? null,
      fileSize: doc.file_size ?? null, caption, ...source, forwarded,
    };
  } else if (text) {
    if (text.length > MAX_ITEM_TEXT) return { ok: false, reason: 'tooLong' };
    input = isSingleLink(text)
      ? { kind: 'link', url: text, ...source, forwarded }
      : { kind: 'text', text, ...source, forwarded };
  } else if (unsupported(m)) {
    return { ok: false, reason: 'unsupported' };
  } else {
    return { ok: false, reason: 'empty' };
  }

  if ((await itemCount(db, draft.id)) >= MAX_ITEMS) return { ok: false, reason: 'tooMany' };
  const item = await addItem(db, draft.id, input);
  if (!item) {
    return { ok: false, reason: 'duplicate', count: await itemCount(db, draft.id) };
  }
  return {
    ok: true, kind: item.kind, count: await itemCount(db, draft.id),
  };
}

async function ingestAndAck(
  deps: HomeworkDeps, chatId: string, actor: HwActor, draft: HwDraftRow, m: HwIncoming,
): Promise<void> {
  const result = await ingest(deps, chatId, draft, actor, m);
  if (result.ok) {
    await send(deps.api, chatId, h('collectAck', actor.lang, {
      kind: kindLabel(result.kind!, actor.lang), n: result.count ?? 0,
    }));
    return;
  }
  switch (result.reason) {
    case 'tooLong':
      await send(deps.api, chatId, h('collectTooLong', actor.lang, { n: MAX_ITEM_TEXT }));
      return;
    case 'tooBig':
      await send(deps.api, chatId, h('collectTooBig', actor.lang, { n: MAX_FILE_MB }));
      return;
    case 'tooMany':
      await send(deps.api, chatId, h('collectTooMany', actor.lang, { n: MAX_ITEMS }));
      return;
    case 'unsupported':
      await send(deps.api, chatId, h('videoUnsupported', actor.lang));
      return;
    case 'duplicate':
      return; // the same Telegram message is already in the draft; never count it twice
    default:
      await send(deps.api, chatId, h('collectUnsupported', actor.lang));
  }
}

// ─── formatting ─────────────────────────────────────────────────────────────
//
// There is deliberately no download step here. The formatter receives the teacher's own
// words, the titles she chose and the text she sent — never a byte of a PDF, DOCX or photo.
// Files are attachments for the students; reading them would mean OCR/parsers the task
// forbids, and a model inventing a page number it cannot have seen.

export async function homeworkDone(
  deps: HomeworkDeps, chatId: string, actor: HwActor,
): Promise<void> {
  const teacher = teacherOf(actor);
  if (!teacher) {
    await send(deps.api, chatId, h('denied', actor.lang));
    return;
  }
  const draft = await latestActiveDraft(deps.db, teacher.userId);
  if (!draft) {
    await send(deps.api, chatId, h('noMaterials', actor.lang));
    return;
  }
  if (draft.status === 'preview') {
    await renderPreview(deps, chatId, actor, draft);
    return;
  }
  if (draft.status === 'formatting') {
    await send(deps.api, chatId, h('formatting', actor.lang));
    return;
  }
  if (draft.status !== 'collecting' && draft.status !== 'needs_clarification') {
    await renderDraft(deps, chatId, actor, draft);
    return;
  }
  const [items, targets, materials] = await Promise.all([
    listItems(deps.db, draft.id),
    selectedGroups(deps.db, draft.id),
    listDraftMaterials(deps.db, draft.id),
  ]);
  // A saved book plus «Unit 2» is already a complete homework: no collected message needed.
  if (!items.length && !materials.length && !draft.instruction.trim()) {
    await send(deps.api, chatId, h('noMaterials', actor.lang));
    return;
  }
  if (!targets.length) {
    const moved = await transitionDraft(deps.db, draft.id, teacher.userId, ['collecting', 'needs_clarification'], 'selecting');
    await send(deps.api, chatId, h('noTargets', actor.lang));
    if (moved) await renderSelection(deps, chatId, actor, moved);
    return;
  }
  const claimed = await transitionDraft(
    deps.db, draft.id, teacher.userId, ['collecting', 'needs_clarification'], 'formatting',
  );
  if (!claimed) {
    const fresh = await getDraft(deps.db, draft.id, teacher.userId);
    if (fresh) await renderDraft(deps, chatId, actor, fresh);
    return;
  }
  await send(deps.api, chatId, h('formatting', actor.lang));

  const ai = deps.homeworkAi ?? LOCAL_AI;
  try {
    const result = await ai.format({
      lang: actor.lang,
      instruction: draft.instruction.trim(),
      items: items.map((i) => ({
        id: i.id, kind: i.kind, text: i.text, url: i.url ?? '',
        fileName: i.fileName ?? '', mimeType: i.mimeType ?? '',
        caption: i.caption, forwarded: i.forwarded,
      })),
      materials: materials.map((m) => ({
        title: m.title, kind: m.kind, fileName: m.fileName,
      })),
    });
    const formatted = result.formatted.trim();
    if (!formatted) throw new Error('formatter returned empty text');
    const warnings = [...new Set(result.warnings)].slice(0, 10);
    const provider = result.provider || 'unknown';
    if (result.status === 'needs_clarification') {
      const questions = (result.questions.length ? result.questions : [h('aiClarifyFallback', actor.lang)])
        .slice(0, 5);
      const saved = await transitionDraft(deps.db, draft.id, teacher.userId, ['formatting'], 'needs_clarification', {
        title: result.title.trim() || h('hwDefaultTitle', actor.lang),
        formattedText: formatted, aiQuestions: questions, aiWarnings: warnings,
        aiProvider: provider, lastError: '',
      });
      if (saved) await renderClarification(deps, chatId, actor, saved);
      return;
    }
    const saved = await transitionDraft(deps.db, draft.id, teacher.userId, ['formatting'], 'preview', {
      title: result.title.trim() || h('hwDefaultTitle', actor.lang),
      formattedText: formatted, aiQuestions: [], aiWarnings: warnings,
      aiProvider: provider, lastError: '',
    });
    if (saved) await renderPreview(deps, chatId, actor, saved);
  } catch (e) {
    // describeError names a class, not a provider message (those may carry request bodies).
    // A plain Error therefore has no useful label for a teacher; say what actually happened.
    const described = describeError(e);
    const reason = described === 'Error' ? h('formatUnavailable', actor.lang) : described;
    const saved = await transitionDraft(deps.db, draft.id, teacher.userId, ['formatting'], 'collecting', {
      lastError: reason.slice(0, 200),
    });
    await send(deps.api, chatId, h('formatFailed', actor.lang, { reason }), saved ? [[
      b(h('doneCta', actor.lang), await cb(deps, teacher.userId, { a: 'done', d: draft.id })),
    ]] : undefined);
  }
}

// ─── text input / edit-mode ─────────────────────────────────────────────────

export async function homeworkInput(
  deps: HomeworkDeps, chatId: string, actor: HwActor, m: HwIncoming,
  session?: HwSession | null,
): Promise<boolean> {
  // Never compete with an existing announce/contact dialog.
  if (session && !session.state.startsWith('hw:')) return false;
  const teacher = teacherOf(actor);
  if (!teacher) return false;

  // The library dialog owns its messages: a textbook sent here is filed, never mistaken
  // for the text of the task.
  if (session?.state === HW_LIB_STATE) {
    return libraryInput(deps, chatId, actor, m, session);
  }

  const text = (m.text ?? '').trim();
  if (session?.state === HW_EDIT_STATE) {
    if (text.startsWith('/') && text.toLowerCase() !== '/cancel') return false;
    await clearHomeworkSession(deps.db, chatId);
    if (text.toLowerCase() === '/cancel') {
      await send(deps.api, chatId, h('editCancelled', actor.lang));
      return true;
    }
    const draft = await getDraft(deps.db, String(session.data.draftId ?? ''), teacher.userId);
    if (!draft || draft.status !== 'preview' || !text) {
      await send(deps.api, chatId, h('badButton', actor.lang));
      return true;
    }
    if (text.length > MAX_EDIT_TEXT) {
      await send(deps.api, chatId, h('editTooLong', actor.lang, { n: MAX_EDIT_TEXT }));
      return true;
    }
    const updated = await patchDraft(deps.db, draft.id, teacher.userId, { formattedText: text });
    if (updated) {
      await send(deps.api, chatId, h('editDone', actor.lang));
      await renderPreview(deps, chatId, actor, updated);
    }
    return true;
  }

  const draft = await latestActiveDraft(deps.db, teacher.userId);
  if (!draft) return false;

  if (text.toLowerCase() === '/cancel') {
    if (draft.status === 'formatting') {
      await send(deps.api, chatId, h('formatting', actor.lang));
      return true;
    }
    if (draft.status === 'publishing') {
      const rows = await publicationsOf(deps.db, draft.id);
      await send(deps.api, chatId, h('publishing', actor.lang, { n: rows.length || 1 }));
      return true;
    }
    if (!CANCELLABLE.includes(draft.status)) return false;
    const cancelled = await transitionDraft(
      deps.db, draft.id, teacher.userId,
      CANCELLABLE, 'cancelled',
    );
    if (cancelled) await send(deps.api, chatId, h('cancelled', actor.lang));
    return true;
  }
  if (text.startsWith('/')) return false;

  /*
   * A draft sitting in one of the two removed screens still takes her words: it moves to
   * collecting first, then the message is stored like any other material.
   */
  if (draft.status === 'awaiting_instruction' || draft.status === 'choosing_materials') {
    const moved = await transitionDraft(
      deps.db, draft.id, teacher.userId,
      ['awaiting_instruction', 'choosing_materials'], 'collecting',
    );
    if (moved) await renderCollecting(deps, chatId, actor, moved);
  }
  // Her first message may arrive before she presses Continue; the draft is the same draft.
  if (!INGESTIBLE.includes(draft.status)) return false;
  await ingestAndAck(deps, chatId, actor, draft, m);
  return true;
}

// ─── callbacks ───────────────────────────────────────────────────────────────

async function draftForAction(
  deps: HomeworkDeps, payload: Record<string, string>, ownerId: string,
  statuses: readonly HwDraftRow['status'][], useRevision = false,
): Promise<HwDraftRow | null> {
  const draft = await getDraft(deps.db, payload.d ?? '', ownerId);
  if (!draft || !statuses.includes(draft.status)) return null;
  if (useRevision && payload.v !== String(draft.updatedAt.getTime())) return null;
  return draft;
}

export async function homeworkCallback(
  deps: HomeworkDeps, chatId: string, actor: HwActor, data: string,
  messageId?: number,
): Promise<void> {
  const teacher = teacherOf(actor);
  if (!teacher) {
    await send(deps.api, chatId, h('denied', actor.lang));
    return;
  }
  const ownerId = teacher.userId;
  const payload = await claimHomeworkCallback(deps.db, data, ownerId);
  if (!payload) {
    await send(deps.api, chatId, h('badButton', actor.lang));
    return;
  }
  const action = payload.a ?? '';

  try {
    if (isLibraryPayload(payload)) {
      await libraryCallback(deps, chatId, actor, payload, messageId);
      return;
    }
    switch (action) {
      case 'sel': {
        const draft = await draftForAction(deps, payload, ownerId, ['selecting']);
        if (!draft) { await send(deps.api, chatId, h('badButton', actor.lang)); return; }
        const selected = await toggleTarget(deps.db, draft.id, payload.g ?? '', ownerId);
        if (selected === null) { await send(deps.api, chatId, h('groupMissing', actor.lang)); return; }
        const fresh = await getDraft(deps.db, draft.id, ownerId);
        if (fresh) await renderSelection(deps, chatId, actor, fresh, messageId);
        return;
      }
      case 'start': {
        const draft = await draftForAction(deps, payload, ownerId, ['selecting']);
        if (!draft) { await send(deps.api, chatId, h('badButton', actor.lang)); return; }
        if (!(await selectedGroups(deps.db, draft.id)).length) {
          await send(deps.api, chatId, h('noTargets', actor.lang));
          return;
        }
        // groups may have changed since a book was chosen — a snapshot for the old set is
        // not a decision about these groups, so it goes back to the picker
        const dropped = await pruneDraftMaterials(deps.db, draft.id, ownerId);
        const moved = await transitionDraft(deps.db, draft.id, ownerId, ['selecting'], 'collecting');
        if (!moved) { await send(deps.api, chatId, h('badButton', actor.lang)); return; }
        if (dropped.length) {
          await send(deps.api, chatId, h('materialsUnlinked', actor.lang, { m: clip(dropped.join(', '), 200) }));
        }
        await renderCollecting(deps, chatId, actor, moved, messageId);
        return;
      }
      /** Every status a draft may be edited from — the picker and the upload dialog work there. */
      case 'mtr':
      case 'mtl': {
        const draft = await draftForAction(deps, payload, ownerId, PICKABLE);
        if (!draft) { await send(deps.api, chatId, h('badButton', actor.lang)); return; }
        await renderMaterialPicker(deps, chatId, actor, draft, messageId);
        return;
      }
      case 'mtg': {
        const draft = await draftForAction(deps, payload, ownerId, PICKABLE);
        if (!draft) { await send(deps.api, chatId, h('badButton', actor.lang)); return; }
        const result = await toggleDraftMaterial(deps.db, draft.id, ownerId, payload.m ?? '');
        if (result === 'limit') {
          await send(deps.api, chatId, h('materialsLimit', actor.lang, { n: MAX_DRAFT_MATERIALS }));
        } else if (result === 'missing') {
          await send(deps.api, chatId, h('libNotFound', actor.lang));
        }
        const fresh = await getDraft(deps.db, draft.id, ownerId);
        if (fresh) await renderMaterialPicker(deps, chatId, actor, fresh, messageId);
        return;
      }
      case 'mup': {
        const draft = await draftForAction(deps, payload, ownerId, PICKABLE);
        if (!draft) { await send(deps.api, chatId, h('badButton', actor.lang)); return; }
        const targets = await selectedGroups(deps.db, draft.id);
        if (!targets.length) { await send(deps.api, chatId, h('noTargets', actor.lang)); return; }
        await startHomeworkMaterialUpload(
          deps, chatId, actor, draft.id, targets.map((g) => g.id), messageId,
        );
        return;
      }
      /** Back from the picker: the screen the teacher came from, whatever the draft's status. */
      case 'mbk':
      case 'min':
      case 'msc': {
        const draft = await draftForAction(deps, payload, ownerId, PICKABLE);
        if (!draft) { await send(deps.api, chatId, h('badButton', actor.lang)); return; }
        // the picker message itself turns back into her screen — one message, not two
        await renderDraft(deps, chatId, actor, draft, messageId);
        return;
      }
      case 'gm': {
        const draft = await draftForAction(deps, payload, ownerId, ['selecting']);
        if (!draft) { await send(deps.api, chatId, h('badButton', actor.lang)); return; }
        await renderGroupManage(deps, chatId, actor, draft, messageId);
        return;
      }
      case 'ga': {
        await showBindCode(deps, chatId, actor, payload.d ?? '');
        return;
      }
      case 'gt': {
        const groups = await listGroups(deps.db, ownerId);
        const group = groups.find((g) => g.id === payload.g);
        if (!group) { await send(deps.api, chatId, h('groupMissing', actor.lang)); return; }
        await setGroupKind(deps.db, group.id, ownerId, group.kind === 'online' ? 'offline' : 'online');
        const draft = await getDraft(deps.db, payload.d ?? '', ownerId);
        if (draft) await renderGroupManage(deps, chatId, actor, draft, messageId);
        return;
      }
      case 'gr': {
        const draft = await getDraft(deps.db, payload.d ?? '', ownerId);
        const group = (await listGroups(deps.db, ownerId)).find((g) => g.id === payload.g);
        if (!draft || !group) { await send(deps.api, chatId, h('groupMissing', actor.lang)); return; }
        await editOrSend(deps.api, chatId, messageId,
          h('groupRemoveConfirm', actor.lang, { g: group.title }), [
            [b(h('groupRemoveYes', actor.lang), await cb(deps, ownerId, { a: 'gry', d: draft.id, g: group.id }))],
            [b(h('back', actor.lang), await cb(deps, ownerId, { a: 'gm', d: draft.id }))],
          ]);
        return;
      }
      case 'gry': {
        await removeGroup(deps.db, payload.g ?? '', ownerId);
        const draft = await getDraft(deps.db, payload.d ?? '', ownerId);
        await send(deps.api, chatId, h('groupRemoved', actor.lang));
        if (draft) await renderGroupManage(deps, chatId, actor, draft);
        return;
      }
      case 'bk': {
        const draft = await draftForAction(deps, payload, ownerId, ['selecting', 'choosing_materials']);
        if (!draft) { await send(deps.api, chatId, h('badButton', actor.lang)); return; }
        const back = draft.status === 'choosing_materials'
          ? await transitionDraft(deps.db, draft.id, ownerId, ['choosing_materials'], 'selecting')
          : draft;
        if (back) await renderSelection(deps, chatId, actor, back, messageId);
        return;
      }
      case 'done':
        await homeworkDone(deps, chatId, actor);
        return;
      case 'edit': {
        const draft = await draftForAction(deps, payload, ownerId, ['preview'], true);
        if (!draft) { await send(deps.api, chatId, h('badButton', actor.lang)); return; }
        await saveEditSession(deps.db, chatId, draft.id, payload.v ?? '');
        await send(deps.api, chatId, h('editPrompt', actor.lang, { n: MAX_EDIT_TEXT }));
        return;
      }
      case 'add': {
        const draft = await draftForAction(deps, payload, ownerId, ['preview'], true);
        if (!draft) { await send(deps.api, chatId, h('badButton', actor.lang)); return; }
        const moved = await transitionDraft(deps.db, draft.id, ownerId, ['preview'], 'collecting');
        if (!moved) { await send(deps.api, chatId, h('badButton', actor.lang)); return; }
        // the preview screen itself turns into the collecting screen: one message, not two
        await renderCollecting(deps, chatId, actor, moved, messageId);
        return;
      }
      case 'chg': {
        const draft = await draftForAction(deps, payload, ownerId, ['preview']);
        if (!draft) { await send(deps.api, chatId, h('badButton', actor.lang)); return; }
        const moved = await transitionDraft(deps.db, draft.id, ownerId, ['preview'], 'selecting');
        if (moved) await renderSelection(deps, chatId, actor, moved, messageId);
        return;
      }
      case 'pub': {
        const draft = await draftForAction(deps, payload, ownerId, ['preview'], true);
        if (!draft) { await send(deps.api, chatId, h('publishAlready', actor.lang)); return; }
        const targets = await selectedGroups(deps.db, draft.id);
        if (!targets.length) {
          await send(deps.api, chatId, h('noTargets', actor.lang));
          await renderSelection(deps, chatId, actor, draft);
          return;
        }
        await editOrSend(deps.api, chatId, messageId,
          h('publishing', actor.lang, { n: targets.length }));
        const outcome = await publishDraft(deps.db, deps.api, draft.id, ownerId);
        if (outcome.draft) {
          if (outcome.kind === 'done' || outcome.draft.status !== 'preview') {
            await renderResult(deps, chatId, actor, outcome.draft);
          } else {
            await renderPreview(deps, chatId, actor, outcome.draft);
          }
        }
        return;
      }
      case 'retry': {
        // `publish_unknown` is included: with per-part outcomes a teacher may press retry for
        // the parts Telegram definitely refused, while the unknown ones stay unsendable
        const draft = await draftForAction(deps, payload, ownerId, ['failed', 'publish_unknown']);
        if (!draft) { await send(deps.api, chatId, h('retryAlready', actor.lang)); return; }
        const rows = await publicationsOf(deps.db, draft.id);
        const retryableCount = rows.filter(isRetryableRow).length;
        if (!retryableCount) { await send(deps.api, chatId, h('retryNone', actor.lang)); return; }
        await editOrSend(deps.api, chatId, messageId,
          h('publishing', actor.lang, { n: retryableCount }));
        const outcome = await retryFailedPublications(deps.db, deps.api, draft.id, ownerId);
        if (outcome.kind === 'noTargets') {
          await send(deps.api, chatId, h('retryNone', actor.lang));
          return;
        }
        if (outcome.kind === 'already') {
          await send(deps.api, chatId, h('retryAlready', actor.lang));
        }
        if (outcome.draft) await renderResult(deps, chatId, actor, outcome.draft);
        return;
      }
      case 'cancel': {
        const draft = await getDraft(deps.db, payload.d ?? '', ownerId);
        if (!draft) { await send(deps.api, chatId, h('badButton', actor.lang)); return; }
        if (!CANCELLABLE.includes(draft.status)) {
          await renderDraft(deps, chatId, actor, draft);
          return;
        }
        const cancelled = await transitionDraft(deps.db, draft.id, ownerId,
          CANCELLABLE, 'cancelled');
        await clearHomeworkSession(deps.db, chatId);
        if (cancelled) await send(deps.api, chatId, h('cancelled', actor.lang));
        return;
      }
      case 'hist':
        await renderHistory(deps, chatId, actor);
        return;
      case 'home':
        await homeworkCommand(deps, chatId, actor);
        return;
      case 'new': {
        const current = await latestActiveDraft(deps.db, ownerId);
        if (current) {
          if (current.status === 'formatting' || current.status === 'publishing') {
            await renderDraft(deps, chatId, actor, current);
            return;
          }
          const closed = await transitionDraft(deps.db, current.id, ownerId,
            [
              'selecting', 'choosing_materials', 'awaiting_instruction', 'collecting',
              'needs_clarification', 'preview', 'failed', 'publish_unknown',
            ],
            'cancelled');
          if (!closed) {
            await send(deps.api, chatId, h('error', actor.lang));
            return;
          }
          await clearHomeworkSession(deps.db, chatId);
        }
        const fresh = await createDraft(deps.db, ownerId);
        await renderSelection(deps, chatId, actor, fresh);
        return;
      }
      default:
        await send(deps.api, chatId, h('badButton', actor.lang));
    }
  } catch {
    await send(deps.api, chatId, h('error', actor.lang));
  }
}

async function renderGroupManage(
  deps: HomeworkDeps, chatId: string, actor: HwActor, draft: HwDraftRow,
  editMessageId?: number,
): Promise<void> {
  const ownerId = actor.userId!;
  const groups = await listGroups(deps.db, ownerId);
  const lines = [h('groupManageTitle', actor.lang), h('groupManageHint', actor.lang)];
  if (!groups.length) lines.push(h('noGroups', actor.lang));
  const buttons: Btn[][] = [];
  for (const g of groups) {
    const kind = g.kind === 'online' ? h('online', actor.lang) : h('offline', actor.lang);
    buttons.push([
      b(truncate(`${g.title} · ${kind}`, 45), await cb(deps, ownerId, { a: 'gt', d: draft.id, g: g.id })),
      b('✕', await cb(deps, ownerId, { a: 'gr', d: draft.id, g: g.id })),
    ]);
  }
  buttons.push([b(h('addGroup', actor.lang), await cb(deps, ownerId, { a: 'ga', d: draft.id }))]);
  buttons.push([b(h('back', actor.lang), await cb(deps, ownerId, { a: 'bk', d: draft.id }))]);
  await editOrSend(deps.api, chatId, editMessageId, lines.join('\n'), buttons);
}

async function showBindCode(
  deps: HomeworkDeps, chatId: string, actor: HwActor, draftId: string,
): Promise<void> {
  const ownerId = actor.userId!;
  const groups = await listGroups(deps.db, ownerId);
  if (groups.length >= MAX_GROUPS) {
    await send(deps.api, chatId, h('tooManyGroups', actor.lang, { n: MAX_GROUPS }));
    return;
  }
  const bind = await createBindCode(deps.db, ownerId);
  const code = bind.code;
  const draft = await getDraft(deps.db, draftId, ownerId);
  const buttons: Btn[][] = [];
  if (draft) buttons.push([b(h('back', actor.lang), await cb(deps, ownerId, { a: 'bk', d: draft.id }))]);
  await send(deps.api, chatId, [
    h('bindCodeTitle', actor.lang, { code }),
    '',
    h('bindInstructions', actor.lang, { code }),
  ].join('\n'), buttons);
}

// ─── group /bind (the only new group-side command) ───────────────────────────

/**
 * `/bind CODE` in a group. The bot otherwise stays silent in groups, exactly as before:
 * this function answers only when the message really is a /bind command.
 */
export async function homeworkGroupBind(
  deps: HomeworkDeps, chatId: string, senderTelegramId: number, text: string,
  title: string | undefined,
  isGroupAdmin: (chatId: string, tgUserId: number) => Promise<boolean>,
): Promise<boolean> {
  const parts = text.trim().split(/\s+/);
  const cmd = (parts[0] ?? '').split('@')[0]?.toLowerCase() ?? '';
  if (cmd !== '/bind') return false;
  /*
   * English: these four answers go out BEFORE the owner's account is known, so there is no
   * locale to read — and the live test showed a Russian line inside an otherwise English
   * screen. The group reply is the teacher's product language, and after the bind succeeds the
   * messages follow the owner's own locale again.
   */
  const fallback: HwLang = 'en';

  if (!(await isGroupAdmin(chatId, senderTelegramId))) {
    await send(deps.api, chatId, h('bindNotAdmin', fallback));
    return true;
  }
  const code = parts[1] ?? '';
  if (!code) {
    await send(deps.api, chatId, h('bindUsage', fallback));
    return true;
  }
  const senderId = await linkedUserIdByTelegramId(deps.db, senderTelegramId);
  if (!senderId) {
    await send(deps.api, chatId, h('bindWrongAccount', fallback));
    return true;
  }
  /*
   * Task G: /bind is a product function, so it obeys the same legal gate as the private chat.
   * The code itself can only be created by an accepted account, but a code minted before a
   * version bump must not connect a group for someone who has not accepted the new documents.
   */
  const legal = await legalStatus(deps.db, senderId);
  if (!legal.accepted) {
    await send(deps.api, chatId, h('bindLegalRequired', fallback));
    return true;
  }
  const claim = await claimBindCode(deps.db, code, senderId, chatId);
  if (!claim) {
    await send(deps.api, chatId, h('bindInvalid', fallback));
    return true;
  }
  if (claim.status === 'wrongAccount') {
    await send(deps.api, chatId, h('bindWrongAccount', fallback));
    return true;
  }
  const ownerId = claim.ownerId;
  const personalChat = await personalChatOf(deps.db, ownerId);
  const actor = await resolveActor(deps.db, personalChat ?? String(senderTelegramId), fallback);
  if (actor.role !== 'teacher') {
    await send(deps.api, chatId, h('bindWrongAccount', fallback));
    return true;
  }
  const existing = await listGroups(deps.db, ownerId);
  const already = existing.find((g) => g.telegramChatId === chatId);
  if (!already && existing.length >= MAX_GROUPS) {
    await send(deps.api, chatId, h('tooManyGroups', actor.lang, { n: MAX_GROUPS }));
    return true;
  }
  const groupTitle = (title ?? '').trim() || h('groupFallback', actor.lang, { id: chatId });
  await addGroup(deps.db, ownerId, chatId, groupTitle);
  await send(deps.api, chatId, h('bindGroupOk', actor.lang, { g: groupTitle }));
  if (personalChat) {
    await deps.api.sendMessage(personalChat, h('bindDm', actor.lang, { g: groupTitle }))
      .catch(() => undefined);
  }
  return true;
}

/** Exported for tests: statuses that still allow cancelling a draft from a button. */
export const CANCELLABLE: readonly HwDraftRow['status'][] = [
  'selecting', 'choosing_materials', 'awaiting_instruction', 'collecting',
  'needs_clarification', 'preview',
];
