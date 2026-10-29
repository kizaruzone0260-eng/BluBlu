/**
 * Mini App homework: the same drafts, library, AI provider and publication engine as the bot,
 * with a different surface and a different entry point.
 *
 * Everything here is server-authoritative:
 *  • the owner comes from the verified Mini App session, never from the request body;
 *  • groups are re-checked for ownership, `active` status and the per-teacher cap;
 *  • materials are re-checked for ownership AND for the existing «recommended for every
 *    selected group» rule before a snapshot is written;
 *  • nothing is sent until an explicit publish call on a draft in `preview`, and that call
 *    uses `publishDraft` — the same compare-and-swap / per-part outcome code as the bot.
 *
 * Formatting never sees a file: the formatter receives the teacher's text, link URLs, file
 * names and material titles only. The final text is always shown to the teacher and is what
 * publication sends; a failed or unavailable model leaves every field and the previous final
 * text untouched.
 */
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { DB } from '../../db/index.js';
import type { PublicationPart } from '../../db/schema.js';
import {
  tgDraftItems, tgDraftTargets, tgDrafts, tgGroups, tgMaterials, tgPublications,
} from '../../db/schema.js';
import { env } from '../../env.js';
import type { BotApi } from '../botApi.js';
import {
  localFormat,
} from './ai.js';
import {
  MAX_DRAFT_MATERIALS, MAX_EDIT_TEXT, MAX_GROUPS, MAX_INSTRUCTION_TEXT, MAX_ITEMS,
} from './constants.js';
import {
  countMaterials, eligibleMaterials, listDraftMaterials, listMaterials,
  materialCountByGroup, pruneDraftMaterials, setDraftMaterials,
  type HwDraftMaterialRow,
} from './libraryStore.js';
import {
  publishDraft, retryFailedPublications, canRetry,
  type PublishOutcome,
} from './publish.js';
import {
  createDraft, getDraft, listDrafts, listGroups, listItems, patchDraft, publicationsOf,
  recentPublications, selectedGroups, transitionDraft,
  type HwDraftRow, type HwDraftStatus, type HwGroupRow, type HwItemRow,
  type HwPublicationRow,
} from './store.js';
import type {
  HwAiItem, HwAiRequest, HwAiResult, HwLang, HomeworkAi,
} from './types.js';

export interface MiniDeps {
  db: DB;
  api: BotApi;
  ai: HomeworkAi;
  /** True only when a real OpenAI-compatible endpoint is configured (AI_PROVIDER + key + model). */
  aiRemote: boolean;
}

export interface MiniSession {
  userId: string;
  locale: string;
  tz: string;
  name: string;
}

export const MINI_MAX_LINKS = 5;
export const MINI_MAX_TITLE = 160;
export const MINI_MAX_LINK_URL = 1_000;
export const MINI_MAX_LINK_LABEL = 80;

/** Statuses in which a Mini App teacher may still change the homework. */
export const MINI_EDITABLE: readonly HwDraftStatus[] = [
  'collecting', 'needs_clarification', 'preview',
];

const L = {
  ru: {
    instructions: 'Задание учителя',
    links: 'Ссылки',
    materials: 'Материалы',
    deadline: 'Срок сдачи',
    warnInstruction: 'Формулировка учителя добавлена дословно: модель сохранила её не полностью.',
    warnLinks: 'Ссылки добавлены дословно.',
    warnMaterials: 'Названия материалов добавлены в текст.',
  },
  uz: {
    instructions: 'O‘qituvchi topshirig‘i',
    links: 'Havolalar',
    materials: 'Materiallar',
    deadline: 'Topshirish muddati',
    warnInstruction: 'O‘qituvchi matni so‘zma-so‘z qo‘shildi: model uni to‘liq saqlamadi.',
    warnLinks: 'Havolalar so‘zma-so‘z qo‘shildi.',
    warnMaterials: 'Material nomlari matnga qo‘shildi.',
  },
  en: {
    instructions: 'Teacher’s instructions',
    links: 'Links',
    materials: 'Materials',
    deadline: 'Deadline',
    warnInstruction: 'The teacher’s wording was appended verbatim: the model did not keep all of it.',
    warnLinks: 'Links were appended verbatim.',
    warnMaterials: 'Material titles were appended to the text.',
  },
} as const;

function langOf(locale: string): HwLang {
  return locale === 'ru' || locale === 'uz' ? locale : 'en';
}

function locTag(lang: HwLang): string {
  return lang === 'ru' ? 'ru-RU' : lang === 'uz' ? 'uz-UZ' : 'en-GB';
}

// ─── DTOs ────────────────────────────────────────────────────────────────────

export interface MiniGroupDto {
  id: string;
  title: string;
  kind: 'online' | 'offline';
  status: 'active' | 'removed';
  /** Last four characters of Telegram's chat id — a recognizable hint, never the full id. */
  chatShort: string;
  materialCount: number;
  lastPublication: { status: HwPublicationRow['status']; updatedAt: string } | null;
}

export interface MiniDraftGroupDto {
  id: string;
  title: string;
  kind: 'online' | 'offline';
}

export interface MiniLinkDto {
  id: string;
  url: string;
  label: string;
}

export interface MiniMaterialDto {
  id: string;
  materialId: string | null;
  title: string;
  kind: 'book' | 'workbook' | 'other';
  fileName: string;
}

export interface MiniPublicationDto {
  id: string;
  groupId: string;
  groupTitle: string;
  status: HwPublicationRow['status'];
  error: string;
  parts: PublicationPart[];
  delivered: number;
  attempts: number;
  updatedAt: string;
}

export interface MiniDraftDto {
  id: string;
  status: HwDraftStatus;
  title: string;
  instruction: string;
  dueAt: string | null;
  formattedText: string;
  groups: MiniDraftGroupDto[];
  materials: MiniMaterialDto[];
  links: MiniLinkDto[];
  warnings: string[];
  questions: string[];
  provider: string;
  lastError: string;
  canEdit: boolean;
  canPublish: boolean;
  canRetry: boolean;
  publications: MiniPublicationDto[];
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
}

export interface MiniDraftSummary {
  id: string;
  status: HwDraftStatus;
  title: string;
  updatedAt: string;
  groupCount: number;
  dueAt: string | null;
}

export interface MiniBootstrap {
  teacher: { name: string; locale: string; tz: string };
  groups: MiniGroupDto[];
  drafts: MiniDraftSummary[];
  publications: MiniPublicationDto[];
  materialsCount: number;
  limits: {
    groups: number;
    materials: number;
    links: number;
    title: number;
    instruction: number;
    text: number;
    items: number;
  };
  ai: { remote: boolean };
  bot: { username: string | null };
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function shortChat(chatId: string): string {
  const digits = chatId.replace(/^-/, '');
  return digits.length <= 4 ? chatId : `…${digits.slice(-4)}`;
}

function iso(d: Date | null | undefined): string | null {
  return d ? d.toISOString() : null;
}

function linkItems(items: HwItemRow[]): HwItemRow[] {
  return items.filter((i) => i.kind === 'link' && i.sourceMessageId === null);
}

function mapPublication(row: HwPublicationRow): MiniPublicationDto {
  return {
    id: row.id,
    groupId: row.groupId,
    groupTitle: row.groupTitle,
    status: row.status,
    error: row.error,
    parts: row.parts ?? [],
    delivered: (row.parts ?? []).filter((p) => p.status === 'sent').length,
    attempts: row.attempts,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function materialDto(row: HwDraftMaterialRow): MiniMaterialDto {
  return {
    id: row.id,
    materialId: row.materialId,
    title: row.title,
    kind: row.kind,
    fileName: row.fileName,
  };
}

function tokenList(text: string): string[] {
  const tokens = text.toLocaleLowerCase().match(/[a-zà-ÿа-яё0-9ʻʼ‘’]+/gi) ?? [];
  return [...new Set(tokens.filter((t) => t.length >= 2 || /\d/.test(t)))];
}

function normalized(text: string): string {
  return text.toLocaleLowerCase().replace(/\s+/g, ' ').trim();
}

function dueLabel(draft: HwDraftRow, lang: HwLang, tz: string): string | null {
  if (!draft.dueAt) return null;
  try {
    return new Intl.DateTimeFormat(locTag(lang), {
      dateStyle: 'medium', timeStyle: 'short', timeZone: tz,
    }).format(draft.dueAt);
  } catch {
    return draft.dueAt.toISOString().slice(0, 16).replace('T', ' ');
  }
}

/**
 * Compose the exact text that will be published.
 *
 * AI output is never trusted to be complete: the teacher's title, every link URL, every
 * material title and the deadline are deterministic additions. For the instruction, a token
 * check runs first; only when the model dropped some word/number/unit does the original text
 * get appended verbatim. Each forced addition is reported as a warning, so the teacher sees
 * exactly why her final text looks different from the model's draft.
 */
function finalizeFormatted(
  base: string,
  draft: HwDraftRow,
  links: HwItemRow[],
  materials: { title: string; fileName: string }[],
  lang: HwLang,
  tz: string,
): { text: string; warnings: string[] } {
  const ui = L[lang];
  const warnings: string[] = [];
  const parts: string[] = [];
  const body = base.trim();

  const title = draft.title.trim();
  if (title && !normalized(body).includes(normalized(title))) {
    parts.push(title);
  }
  parts.push(body);

  const instruction = draft.instruction.trim();
  const keyTokens = tokenList(instruction);
  const bodyLower = normalized(body);
  const missing = keyTokens.filter((token) => !bodyLower.includes(token.toLocaleLowerCase()));
  if (instruction && missing.length) {
    parts.push(`${ui.instructions}\n${instruction}`);
    warnings.push(ui.warnInstruction);
  }

  const urls = links.map((l) => (l.url ?? '').trim()).filter(Boolean);
  const missingUrls = urls.filter((url) => !body.includes(url));
  if (missingUrls.length) {
    parts.push([ui.links, ...missingUrls.map((url) => `• ${url}`)].join('\n'));
    warnings.push(ui.warnLinks);
  }

  const titles = materials.map((m) => (m.title || m.fileName).trim()).filter(Boolean);
  const missingTitles = titles.filter((t) => !bodyLower.includes(normalized(t)));
  if (missingTitles.length) {
    parts.push([ui.materials, ...missingTitles.map((t) => `• ${t}`)].join('\n'));
    warnings.push(ui.warnMaterials);
  }

  const due = dueLabel(draft, lang, tz);
  if (due && !bodyLower.includes(normalized(due))) {
    parts.push(`${ui.deadline}: ${due}`);
  }

  let text = parts.filter(Boolean).join('\n\n').trim();
  if (text.length > MAX_EDIT_TEXT) text = text.slice(0, MAX_EDIT_TEXT).trimEnd();
  return { text, warnings };
}

function aiItems(items: HwItemRow[]): HwAiItem[] {
  return items
    .filter((i) => i.kind === 'text' || i.kind === 'link' || i.kind === 'photo' || i.kind === 'document')
    .map((i) => ({
      id: i.id,
      kind: i.kind,
      text: i.text,
      url: i.url ?? '',
      fileName: i.fileName ?? '',
      mimeType: i.mimeType ?? '',
      caption: i.caption,
      forwarded: i.forwarded,
    }));
}

/** The complete formatter input. File bytes are absent by construction. */
export function buildMiniAiRequest(
  draft: HwDraftRow,
  items: HwItemRow[],
  materials: { title: string; kind: 'book' | 'workbook' | 'other'; fileName: string }[],
  locale: string,
): HwAiRequest {
  return {
    lang: langOf(locale),
    instruction: draft.instruction,
    items: aiItems(items),
    materials: materials.map((m) => ({ title: m.title, kind: m.kind, fileName: m.fileName })),
  };
}

async function groupDtos(
  db: DB, ownerId: string, includeRemoved: boolean,
): Promise<MiniGroupDto[]> {
  const [groups, countMap, pubs] = await Promise.all([
    listGroups(db, ownerId, includeRemoved),
    materialCountByGroup(db, ownerId),
    db.select({
      groupId: tgPublications.groupId,
      status: tgPublications.status,
      updatedAt: tgPublications.updatedAt,
    }).from(tgPublications)
      .innerJoin(tgDrafts, eq(tgDrafts.id, tgPublications.draftId))
      .where(eq(tgDrafts.ownerId, ownerId))
      .orderBy(desc(tgPublications.updatedAt))
      .limit(200),
  ]);
  const lastMap = new Map<string, { status: HwPublicationRow['status']; updatedAt: string }>();
  for (const p of pubs) {
    if (!lastMap.has(p.groupId)) {
      lastMap.set(p.groupId, { status: p.status, updatedAt: p.updatedAt.toISOString() });
    }
  }
  return groups.map((g: HwGroupRow) => ({
    id: g.id,
    title: g.title,
    kind: g.kind,
    status: g.status,
    chatShort: shortChat(g.telegramChatId),
    materialCount: countMap.get(g.id) ?? 0,
    lastPublication: lastMap.get(g.id) ?? null,
  }));
}

// ─── bootstrap and history ───────────────────────────────────────────────────

export async function miniBootstrap(
  deps: MiniDeps, session: MiniSession,
): Promise<MiniBootstrap> {
  const { db } = deps;
  const [groups, drafts, pubs, materialsCount] = await Promise.all([
    groupDtos(db, session.userId, false),
    listDrafts(db, session.userId, { origin: 'mini', limit: 8 }),
    recentPublications(db, session.userId, 12),
    countMaterials(db, session.userId),
  ]);
  const summaries: MiniDraftSummary[] = [];
  for (const d of drafts) {
    const selected = await selectedGroups(db, d.id);
    summaries.push({
      id: d.id,
      status: d.status,
      title: d.title,
      updatedAt: d.updatedAt.toISOString(),
      groupCount: selected.length,
      dueAt: iso(d.dueAt),
    });
  }
  return {
    teacher: { name: session.name, locale: session.locale, tz: session.tz },
    groups,
    drafts: summaries,
    publications: pubs.map((p) => ({
      id: p.id,
      groupId: p.groupId,
      groupTitle: p.groupTitle,
      status: p.status,
      error: '',
      parts: [],
      delivered: 0,
      attempts: 0,
      updatedAt: p.updatedAt.toISOString(),
    })),
    materialsCount,
    limits: {
      groups: MAX_GROUPS,
      materials: MAX_DRAFT_MATERIALS,
      links: MINI_MAX_LINKS,
      title: MINI_MAX_TITLE,
      instruction: MAX_INSTRUCTION_TEXT,
      text: MAX_EDIT_TEXT,
      items: MAX_ITEMS,
    },
    ai: { remote: deps.aiRemote },
    bot: { username: env.TELEGRAM_BOT_NAME || null },
  };
}

/** History rows carry the draft title and the group-level outcome, newest first. */
export async function miniHistory(
  deps: MiniDeps, session: MiniSession,
): Promise<{ drafts: MiniDraftSummary[]; publications: MiniPublicationDto[] }> {
  const { db } = deps;
  const drafts = await listDrafts(db, session.userId, { origin: 'mini', limit: 20 });
  const summaries: MiniDraftSummary[] = [];
  for (const d of drafts) {
    const selected = await selectedGroups(db, d.id);
    summaries.push({
      id: d.id,
      status: d.status,
      title: d.title,
      updatedAt: d.updatedAt.toISOString(),
      groupCount: selected.length,
      dueAt: iso(d.dueAt),
    });
  }
  const rows = await recentPublications(db, session.userId, 40);
  return {
    drafts: summaries,
    publications: rows.map((p) => ({
      id: p.id,
      groupId: p.groupId,
      groupTitle: p.groupTitle,
      status: p.status,
      error: '',
      parts: [],
      delivered: 0,
      attempts: 0,
      updatedAt: p.updatedAt.toISOString(),
    })),
  };
}

// ─── draft read / create / patch ─────────────────────────────────────────────

export async function miniDraftDto(
  deps: MiniDeps, session: MiniSession, draft: HwDraftRow,
): Promise<MiniDraftDto> {
  const { db } = deps;
  const [groups, materials, items, pubs] = await Promise.all([
    selectedGroups(db, draft.id),
    listDraftMaterials(db, draft.id),
    listItems(db, draft.id),
    publicationsOf(db, draft.id),
  ]);
  return {
    id: draft.id,
    status: draft.status,
    title: draft.title,
    instruction: draft.instruction,
    dueAt: iso(draft.dueAt),
    formattedText: draft.formattedText,
    groups: groups.map((g) => ({ id: g.id, title: g.title, kind: g.kind })),
    materials: materials.map(materialDto),
    links: linkItems(items).map((i) => ({ id: i.id, url: i.url ?? '', label: i.text })),
    warnings: draft.aiWarnings ?? [],
    questions: draft.aiQuestions ?? [],
    provider: draft.aiProvider,
    lastError: draft.lastError,
    canEdit: MINI_EDITABLE.includes(draft.status),
    canPublish: draft.status === 'preview',
    canRetry: canRetry(pubs),
    publications: pubs.map(mapPublication),
    createdAt: draft.createdAt.toISOString(),
    updatedAt: draft.updatedAt.toISOString(),
    publishedAt: iso(draft.publishedAt),
  };
}

export async function getMiniDraft(
  deps: MiniDeps, session: MiniSession, draftId: string,
): Promise<MiniDraftDto | null> {
  const draft = await getDraft(deps.db, draftId, session.userId);
  return draft ? miniDraftDto(deps, session, draft) : null;
}

export async function createMiniDraft(
  deps: MiniDeps, session: MiniSession,
): Promise<MiniDraftDto> {
  const draft = await createDraft(deps.db, session.userId, 'mini', 'collecting');
  return miniDraftDto(deps, session, draft);
}

export interface MiniDraftPatch {
  title?: string;
  instruction?: string;
  dueAt?: string | null;
  formattedText?: string;
  links?: { url: string; label?: string }[];
}

export type MiniPatchResult =
  | { status: 'ok'; draft: MiniDraftDto }
  | { status: 'locked' }
  | { status: 'invalid' }
  | { status: 'tooManyLinks' };

export async function patchMiniDraft(
  deps: MiniDeps, session: MiniSession, draftId: string, patch: MiniDraftPatch,
): Promise<MiniPatchResult> {
  const { db } = deps;
  const draft = await getDraft(db, draftId, session.userId);
  if (!draft) return { status: 'invalid' };
  if (!MINI_EDITABLE.includes(draft.status)) return { status: 'locked' };

  const values: Parameters<typeof patchDraft>[3] = {};
  if (patch.title !== undefined) values.title = patch.title.trim().slice(0, MINI_MAX_TITLE);
  if (patch.instruction !== undefined) {
    values.instruction = patch.instruction.trim().slice(0, MAX_INSTRUCTION_TEXT);
  }
  if (patch.formattedText !== undefined) {
    values.formattedText = patch.formattedText.replace(/\r\n/g, '\n').trimEnd().slice(0, MAX_EDIT_TEXT);
  }
  if (patch.dueAt !== undefined) {
    if (patch.dueAt === null || patch.dueAt === '') {
      values.dueAt = null;
    } else {
      const date = new Date(patch.dueAt);
      if (Number.isNaN(date.getTime())) return { status: 'invalid' };
      const year = date.getUTCFullYear();
      if (year < 2000 || year > 2100) return { status: 'invalid' };
      values.dueAt = date;
    }
  }

  if (patch.links !== undefined) {
    if (patch.links.length > MINI_MAX_LINKS) return { status: 'tooManyLinks' };
    const clean: { url: string; label: string }[] = [];
    for (const link of patch.links) {
      const url = link.url.trim();
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        return { status: 'invalid' };
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { status: 'invalid' };
      if (url.length > MINI_MAX_LINK_URL) return { status: 'invalid' };
      clean.push({ url, label: (link.label ?? '').trim().slice(0, MINI_MAX_LINK_LABEL) });
    }
    await db.transaction(async (tx) => {
      await tx.delete(tgDraftItems).where(and(
        eq(tgDraftItems.draftId, draftId),
        eq(tgDraftItems.kind, 'link'),
        isNull(tgDraftItems.sourceMessageId),
      ));
      if (clean.length) {
        const [max] = await tx.select({ n: sql<number>`coalesce(max(${tgDraftItems.position}), 0)` })
          .from(tgDraftItems).where(eq(tgDraftItems.draftId, draftId));
        const start = Number(max?.n ?? 0);
        await tx.insert(tgDraftItems).values(clean.map((link, index) => ({
          draftId,
          position: start + index + 1,
          kind: 'link' as const,
          text: link.label,
          url: link.url,
          caption: '',
          sourceMessageId: null,
          forwarded: false,
        })));
      }
    });
  }

  const updated = Object.keys(values).length
    ? await patchDraft(db, draftId, session.userId, values)
    : draft;
  if (!updated) return { status: 'invalid' };
  return { status: 'ok', draft: await miniDraftDto(deps, session, updated) };
}

// ─── groups ──────────────────────────────────────────────────────────────────

export type MiniGroupsResult =
  | { status: 'ok'; draft: MiniDraftDto; droppedMaterials: string[] }
  | { status: 'locked' }
  | { status: 'notAllowed' }
  | { status: 'tooMany' };

export async function setMiniGroups(
  deps: MiniDeps, session: MiniSession, draftId: string, groupIds: string[],
): Promise<MiniGroupsResult> {
  const { db } = deps;
  const draft = await getDraft(db, draftId, session.userId);
  if (!draft) return { status: 'notAllowed' };
  if (!MINI_EDITABLE.includes(draft.status)) return { status: 'locked' };
  const unique = [...new Set(groupIds)];
  if (unique.length !== groupIds.length) return { status: 'notAllowed' };
  if (unique.length > MAX_GROUPS) return { status: 'tooMany' };
  if (unique.some((id) => !/^[0-9a-f-]{36}$/i.test(id))) return { status: 'notAllowed' };

  if (unique.length) {
    const owned = await db.select({ id: tgGroups.id }).from(tgGroups).where(and(
      eq(tgGroups.ownerId, session.userId),
      eq(tgGroups.status, 'active'),
      inArray(tgGroups.id, unique),
    ));
    if (owned.length !== unique.length) return { status: 'notAllowed' };
  }

  await db.transaction(async (tx) => {
    await tx.delete(tgDraftTargets).where(eq(tgDraftTargets.draftId, draftId));
    if (unique.length) {
      await tx.insert(tgDraftTargets).values(
        unique.map((groupId, index) => ({ draftId, groupId, position: index + 1 })),
      );
    }
  });
  const droppedMaterials = await pruneDraftMaterials(db, draftId, session.userId);
  const updated = await getDraft(db, draftId, session.userId);
  return {
    status: 'ok',
    draft: await miniDraftDto(deps, session, updated!),
    droppedMaterials,
  };
}

// ─── materials ───────────────────────────────────────────────────────────────

export interface MiniMaterialHit {
  id: string;
  title: string;
  kind: 'book' | 'workbook' | 'other';
  fileName: string;
  fileSize: number | null;
  recommendedFor: string[];
}

function hit(row: typeof tgMaterials.$inferSelect): MiniMaterialHit {
  return {
    id: row.id,
    title: row.title,
    kind: row.kind,
    fileName: row.fileName,
    fileSize: row.fileSize,
    recommendedFor: [],
  };
}

/**
 * Materials a draft may use: only those recommended for EVERY selected group (the library's
 * existing rule), optionally filtered by text. Search covers the title and the file name —
 * the only searchable metadata the product stores; file contents are never read.
 */
export async function listMiniMaterials(
  deps: MiniDeps, session: MiniSession, opts: {
    draftId?: string;
    query?: string;
    limit?: number;
  } = {},
): Promise<{ materials: MiniMaterialHit[]; reason?: 'noGroups' | 'notFound' }> {
  const { db } = deps;
  const q = (opts.query ?? '').trim().toLocaleLowerCase().slice(0, 100);
  let rows: (typeof tgMaterials.$inferSelect)[] = [];
  if (opts.draftId) {
    const draft = await getDraft(db, opts.draftId, session.userId);
    if (!draft) return { materials: [], reason: 'notFound' };
    const groups = await selectedGroups(db, draft.id);
    if (!groups.length) return { materials: [], reason: 'noGroups' };
    rows = await eligibleMaterials(db, session.userId, groups.map((g) => g.id), 100);
  } else {
    rows = await listMaterials(db, session.userId, { limit: 100 });
  }
  if (q) {
    rows = rows.filter((m) => `${m.title} ${m.fileName}`.toLocaleLowerCase().includes(q));
  }
  return { materials: rows.slice(0, opts.limit ?? 50).map(hit) };
}

export type MiniMaterialsResult =
  | { status: 'ok'; draft: MiniDraftDto }
  | { status: 'locked' }
  | { status: 'noGroups' }
  | { status: 'notEligible' }
  | { status: 'limit' };

export async function setMiniMaterials(
  deps: MiniDeps, session: MiniSession, draftId: string, materialIds: string[],
): Promise<MiniMaterialsResult> {
  const { db } = deps;
  const draft = await getDraft(db, draftId, session.userId);
  if (!draft) return { status: 'notEligible' };
  if (!MINI_EDITABLE.includes(draft.status)) return { status: 'locked' };
  const result = await setDraftMaterials(db, draftId, session.userId, materialIds);
  if (result.status !== 'ok') return { status: result.status };
  const updated = await getDraft(db, draftId, session.userId);
  return { status: 'ok', draft: await miniDraftDto(deps, session, updated!) };
}

// ─── formatting ──────────────────────────────────────────────────────────────

export type MiniFormatResult =
  | {
    status: 'ok';
    draft: MiniDraftDto;
    warnings: string[];
    questions: string[];
    provider: string;
    usedAi: boolean;
  }
  | { status: 'locked' }
  | { status: 'notFound' }
  | { status: 'aiUnavailable' }
  | { status: 'aiError'; message: string; fallback: string };

export async function formatMiniDraft(
  deps: MiniDeps, session: MiniSession, draftId: string, mode: 'ai' | 'manual',
): Promise<MiniFormatResult> {
  const { db } = deps;
  const draft = await getDraft(db, draftId, session.userId);
  if (!draft) return { status: 'notFound' };
  if (!MINI_EDITABLE.includes(draft.status)) return { status: 'locked' };
  if (mode === 'ai' && !deps.aiRemote) return { status: 'aiUnavailable' };

  const [items, materials] = await Promise.all([
    listItems(db, draft.id),
    listDraftMaterials(db, draft.id),
  ]);
  const request = buildMiniAiRequest(draft, items, materials, session.locale);
  const lang = langOf(session.locale);
  const local = localFormat(request);

  let result: HwAiResult;
  let usedAi = false;
  if (mode === 'ai') {
    try {
      result = await deps.ai.format(request);
      usedAi = true;
    } catch {
      const fallback = finalizeFormatted(local.formatted, draft, linkItems(items), materials, lang, session.tz);
      return {
        status: 'aiError',
        message: 'aiUnavailable',
        fallback: fallback.text,
      };
    }
  } else {
    result = local;
  }

  const finalized = finalizeFormatted(result.formatted, draft, linkItems(items), materials, lang, session.tz);
  const warnings = [...new Set([...result.warnings, ...finalized.warnings])].slice(0, 10);
  const title = draft.title.trim() || result.title.slice(0, MINI_MAX_TITLE);
  const saved = await patchDraft(db, draft.id, session.userId, {
    formattedText: finalized.text,
    title,
    aiWarnings: warnings,
    aiQuestions: result.questions.slice(0, 4),
    aiProvider: result.provider,
    lastError: '',
  });
  if (!saved) return { status: 'notFound' };
  return {
    status: 'ok',
    draft: await miniDraftDto(deps, session, saved),
    warnings,
    questions: saved.aiQuestions ?? [],
    provider: saved.aiProvider,
    usedAi,
  };
}

// ─── preview / publish / retry / cancel ─────────────────────────────────────

export type MiniPreviewResult =
  | { status: 'ok'; draft: MiniDraftDto }
  | { status: 'notFound' }
  | { status: 'noGroups' }
  | { status: 'emptyHomework' }
  | { status: 'locked' };

export async function previewMiniDraft(
  deps: MiniDeps, session: MiniSession, draftId: string,
): Promise<MiniPreviewResult> {
  const { db } = deps;
  let draft = await getDraft(db, draftId, session.userId);
  if (!draft) return { status: 'notFound' };
  if (!MINI_EDITABLE.includes(draft.status)) {
    return draft.status === 'preview'
      ? { status: 'ok', draft: await miniDraftDto(deps, session, draft) }
      : { status: 'locked' };
  }
  const groups = await selectedGroups(db, draft.id);
  if (!groups.length) return { status: 'noGroups' };

  /*
   * Nothing to send is not a homework. The local formatter always emits its heading (that is
   * what keeps a bot message from being empty), so «formattedText is non-empty» cannot answer
   * this question — the CONTENT is checked instead. Without this, a teacher could confirm a
   * preview and publish a heading alone into every selected group.
   */
  const [contentItems, contentMaterials] = await Promise.all([
    listItems(db, draft.id),
    listDraftMaterials(db, draft.id),
  ]);
  if (!draft.instruction.trim() && !contentItems.length && !contentMaterials.length) {
    return { status: 'emptyHomework' };
  }

  if (!draft.formattedText.trim()) {
    const formatted = await formatMiniDraft(deps, session, draft.id, 'manual');
    if (formatted.status !== 'ok') return { status: 'emptyHomework' };
    draft = await getDraft(db, draft.id, session.userId) ?? draft;
  }
  if (!draft.formattedText.trim()) return { status: 'emptyHomework' };

  const moved = await transitionDraft(
    db, draft.id, session.userId, MINI_EDITABLE, 'preview',
  );
  const fresh = moved ?? await getDraft(db, draft.id, session.userId);
  if (!fresh) return { status: 'notFound' };
  if (fresh.status !== 'preview') return { status: 'locked' };
  return { status: 'ok', draft: await miniDraftDto(deps, session, fresh) };
}

export type MiniPublishKind =
  | 'done' | 'already' | 'noTargets' | 'unexpected' | 'notReady' | 'inProgress'
  | 'groupUnavailable';

export interface MiniPublishResult {
  kind: MiniPublishKind;
  draft: MiniDraftDto | null;
  /** Titles of groups that are gone/not owned — the teacher must re-select groups. */
  unavailableGroups?: string[];
}

/** Verify every selected group is STILL this teacher's active group, immediately before sending. */
async function verifyTargets(db: DB, ownerId: string, draftId: string): Promise<{
  ok: boolean;
  groups: { id: string; title: string }[];
}> {
  const groups = await selectedGroups(db, draftId);
  if (!groups.length) return { ok: false, groups: [] };
  const rows = await db.select({ id: tgGroups.id, status: tgGroups.status, ownerId: tgGroups.ownerId })
    .from(tgGroups).where(inArray(tgGroups.id, groups.map((g) => g.id)));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const bad = groups.filter((g) => {
    const row = byId.get(g.id);
    return !row || row.ownerId !== ownerId || row.status !== 'active';
  });
  return { ok: bad.length === 0, groups: bad };
}

async function afterOutcome(
  deps: MiniDeps, session: MiniSession, outcome: PublishOutcome, kind: MiniPublishKind,
): Promise<MiniPublishResult> {
  const draft = outcome.draft
    ? await miniDraftDto(deps, session, outcome.draft)
    : null;
  return { kind, draft };
}

export async function publishMiniDraft(
  deps: MiniDeps, session: MiniSession, draftId: string,
): Promise<MiniPublishResult> {
  const { db } = deps;
  const draft = await getDraft(db, draftId, session.userId);
  if (!draft) return { kind: 'notReady', draft: null };
  if (draft.status === 'publishing') {
    return { kind: 'inProgress', draft: await miniDraftDto(deps, session, draft) };
  }
  if (draft.status !== 'preview') {
    return { kind: 'notReady', draft: await miniDraftDto(deps, session, draft) };
  }
  const targets = await verifyTargets(db, session.userId, draftId);
  if (!targets.ok) {
    return {
      kind: 'groupUnavailable',
      draft: await miniDraftDto(deps, session, draft),
      unavailableGroups: targets.groups.map((g) => g.title),
    };
  }
  const outcome = await publishDraft(db, deps.api, draft.id, session.userId);
  const kind: MiniPublishKind = outcome.kind === 'done' || outcome.kind === 'already'
    || outcome.kind === 'noTargets' || outcome.kind === 'unexpected'
    ? outcome.kind
    : 'unexpected';
  return afterOutcome(deps, session, outcome, kind);
}

export async function retryMiniDraft(
  deps: MiniDeps, session: MiniSession, draftId: string,
): Promise<MiniPublishResult> {
  const { db } = deps;
  const draft = await getDraft(db, draftId, session.userId);
  if (!draft) return { kind: 'notReady', draft: null };
  if (draft.status === 'publishing') {
    return { kind: 'inProgress', draft: await miniDraftDto(deps, session, draft) };
  }
  if (draft.status !== 'failed' && draft.status !== 'publish_unknown') {
    return { kind: 'notReady', draft: await miniDraftDto(deps, session, draft) };
  }
  const outcome = await retryFailedPublications(db, deps.api, draft.id, session.userId);
  const kind: MiniPublishKind = outcome.kind === 'done' || outcome.kind === 'already'
    || outcome.kind === 'noTargets' || outcome.kind === 'unexpected'
    ? outcome.kind
    : 'unexpected';
  return afterOutcome(deps, session, outcome, kind);
}

export async function cancelMiniDraft(
  deps: MiniDeps, session: MiniSession, draftId: string,
): Promise<boolean> {
  const moved = await transitionDraft(
    deps.db, draftId, session.userId, MINI_EDITABLE, 'cancelled',
  );
  return moved !== null;
}

/** Test seam: the same DTO used by the API, without pretending a real Telegram delivery. */
export function publicationStatuses(draft: MiniDraftDto): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const p of draft.publications) counts[p.status] = (counts[p.status] ?? 0) + 1;
  return counts;
}
