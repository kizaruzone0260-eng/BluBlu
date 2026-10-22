/**
 * Formatting provider.
 *
 * `AI_PROVIDER=none` (the default) uses the deterministic local formatter: it only
 * reassembles what the teacher wrote, never invents a task, and does not touch the network.
 * A real OpenAI-compatible endpoint is configured with AI_* variables; it receives the same
 * text and must return strict JSON. Nothing here publishes anything.
 *
 * What the model never gets is the point of this file's shape: no bytes, no images, no
 * extracted text. A PDF, DOCX or photo is an attachment for the students; the formatter sees
 * its title and the teacher's own instructions only. That rules out OCR, parsers and vision
 * for homework, and it also rules out a model inventing a page number it cannot have read.
 */
import { z } from 'zod';
import { env } from '../../env.js';
import { h, kindLabel } from './texts.js';
import { MAX_EDIT_TEXT } from './constants.js';
import type { HwAiRequest, HwAiResult, HomeworkAi } from './types.js';

function cleanList(values: string[], limit: number): string[] {
  return values.map((v) => v.trim()).filter(Boolean).slice(0, limit);
}

function materialTitles(req: HwAiRequest): string[] {
  return req.materials.map((m) => m.title.trim() || m.fileName.trim()).filter(Boolean);
}

function attachedFiles(req: HwAiRequest): string[] {
  return [
    ...req.materials.map((m) => m.title.trim() || m.fileName.trim()),
    ...req.items
      .filter((i) => i.kind === 'photo' || i.kind === 'document')
      .map((i) => i.fileName.trim() || kindLabel(i.kind, req.lang)),
  ].filter(Boolean);
}

/**
 * A warning, never a silent assumption: attachments leave as files and their contents were
 * not part of the wording. The teacher checks the formulation before publishing.
 */
function attachmentWarning(req: HwAiRequest): string[] {
  const names = attachedFiles(req);
  if (!names.length) return [];
  const shown = names.slice(0, 6).join(', ') + (names.length > 6 ? ` … +${names.length - 6}` : '');
  return [h('aiWarnAttachments', req.lang, { names: shown.slice(0, 240) })];
}

/** Deterministic, offline formatting: order preserved, wording not invented. */
export function localFormat(req: HwAiRequest): HwAiResult {
  const instruction = req.instruction.trim();
  const texts = req.items.filter((i) => i.kind === 'text' && i.text.trim());
  const links = req.items.filter((i) => i.kind === 'link' && i.url.trim());
  const photos = req.items.filter((i) => i.kind === 'photo');
  const documents = req.items.filter((i) => i.kind === 'document');
  const titles = materialTitles(req);

  const firstLine = (instruction || texts[0]?.text || titles[0] || '')
    .split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  const title = (firstLine || h('hwDefaultTitle', req.lang)).slice(0, 120);

  const blocks: string[] = [h('hwHeading', req.lang)];
  if (titles.length === 1) {
    blocks.push(h('materialLabel', req.lang, { t: titles[0]! }));
  } else if (titles.length > 1) {
    blocks.push([h('materialsLabel', req.lang), ...titles.map((t) => `• ${t}`)].join('\n'));
  }
  if (instruction) blocks.push(`${h('taskLabel', req.lang)}\n${instruction}`);
  if (texts.length) blocks.push(texts.map((i) => i.text.trim()).join('\n\n'));
  if (links.length) {
    const label = kindLabel('link', req.lang);
    blocks.push(links.map((i) => `${label}: ${i.url.trim()}`).join('\n'));
  }
  if (photos.length) {
    const label = kindLabel('photo', req.lang);
    blocks.push(photos.map((i, n) => `${label} ${n + 1}${i.caption.trim() ? `: ${i.caption.trim()}` : ''}`).join('\n'));
  }
  if (documents.length) {
    const label = kindLabel('document', req.lang);
    blocks.push(documents.map((i) => `${label}: ${i.fileName || i.text || '—'}`).join('\n'));
  }
  // A homework always has an instruction, a material or a message; the guard keeps it non-empty.
  const formatted = blocks.filter(Boolean).join('\n\n').slice(0, MAX_EDIT_TEXT);
  return {
    status: 'ok', title, formatted,
    questions: [], warnings: attachmentWarning(req), provider: 'local',
  };
}

// ─── OpenAI-compatible provider ──────────────────────────────────────────────

const aiJsonSchema = z.object({
  title: z.string().min(1).max(160).optional(),
  formatted: z.string().min(1).max(MAX_EDIT_TEXT),
  questions: z.array(z.string().max(400)).max(5).optional(),
  warnings: z.array(z.string().max(400)).max(10).optional(),
});

const NUMBERS = /(?<!\d)(\d{2,}|\d{1,2}[:.]\d{2}|\d{1,2}[./]\d{1,2})(?!\d)/g;

/**
 * Days of the week and the word «deadline», in the three languages the product ships.
 * A model loves to add «сдать до пятницы»: it reads like a normal homework line and the
 * number guard cannot see it. These stems are checked the same way as numbers — a warning
 * for the teacher, never a silent edit, and never a blocked publication.
 */
const DEADLINE_STEMS = [
  // russian
  'понедельник', 'вторник', 'среду', 'среда', 'четверг', 'пятниц', 'суббот', 'воскресень',
  'дедлайн',
  // english
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'deadline',
  // uzbek (latin)
  'dushanba', 'seshanba', 'chorshanba', 'payshanba', 'juma', 'shanba', 'yakshanba', 'muddat',
];

function numbersIn(text: string): string[] {
  return [...text.matchAll(NUMBERS)].map((m) => m[1]!).filter(Boolean);
}

function sourceText(req: HwAiRequest): string {
  return [
    req.instruction,
    ...req.materials.map((m) => `${m.title} ${m.fileName}`),
    ...req.items.map((i) => `${i.text} ${i.url} ${i.fileName} ${i.caption}`),
  ].join(' \u0000 ').toLocaleLowerCase();
}

function foreignNumbers(req: HwAiRequest, formatted: string): string[] {
  const source = new Set<string>();
  for (const value of [req.instruction, ...req.materials.map((m) => `${m.title} ${m.fileName}`)]) {
    for (const n of numbersIn(value)) source.add(n);
  }
  for (const item of req.items) {
    for (const value of [item.text, item.url, item.fileName, item.caption]) {
      for (const n of numbersIn(value)) source.add(n);
    }
  }
  const foreign = [...new Set(numbersIn(formatted))].filter((n) => !source.has(n)).slice(0, 5);
  return foreign.length ? [h('aiWarnForeignNumbers', req.lang, { nums: foreign.join(', ') })] : [];
}

/**
 * The same guard for a deadline written in words. A stem counts as foreign only when it
 * appears in the formatted message and nowhere in what the teacher supplied.
 */
function foreignDeadlines(req: HwAiRequest, formatted: string): string[] {
  const lower = formatted.toLocaleLowerCase();
  const source = sourceText(req);
  const found = DEADLINE_STEMS.filter((stem) => lower.includes(stem) && !source.includes(stem));
  return found.length ? [h('aiWarnForeignDates', req.lang, { words: found.slice(0, 4).join(', ') })] : [];
}

function systemPrompt(lang: string): string {
  return [
    'You format a teacher’s homework message for Telegram.',
    'You are given ONLY: the teacher’s own instruction, the titles of the attached files,',
    'and any text the teacher typed. The contents of the attached PDFs, DOCX files and photos',
    'are NOT provided and you must never pretend to know them.',
    'Use ONLY facts present in what you were given. Never invent tasks, page numbers,',
    'exercises, dates, deadlines, grades or requirements. Preserve names, links and numbers',
    'exactly as written.',
    'The attachments are sent separately as files: mention their titles, nothing else.',
    `Write the final message in ${lang}.`,
    'Return STRICT JSON only, no markdown fences:',
    '{"title": string (short, <=120 chars),',
    ' "formatted": string (the exact plain-text message to publish, <=4000 chars),',
    ' "questions": string[] (0-3 concise questions; use only when essential information is missing),',
    ' "warnings": string[] (0-5 short notes for the teacher)}.',
    'If the instruction is sufficient, "questions" MUST be an empty array.',
    'formatted must be plain text (no HTML, no Markdown tables).',
  ].join(' ');
}

/** The complete payload the model may see. No bytes, no file contents, no image parts. */
function userPayload(req: HwAiRequest): string {
  return JSON.stringify({
    instruction: req.instruction,
    materials: req.materials.map((m) => ({
      title: m.title, kind: m.kind, fileName: m.fileName,
      note: 'attachment sent as a file; its contents are not available',
    })),
    messages: req.items.map((item) => ({
      kind: item.kind,
      text: item.text,
      url: item.url,
      fileName: item.fileName,
      mimeType: item.mimeType,
      caption: item.caption,
      forwarded: item.forwarded,
    })),
  });
}

function extractJson(content: string): unknown {
  const trimmed = content.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('AI provider returned no JSON object');
  return JSON.parse(trimmed.slice(start, end + 1));
}

function languageName(lang: string): string {
  return lang === 'ru' ? 'Russian' : lang === 'uz' ? 'Uzbek (Latin script)' : 'English';
}

async function remoteFormat(req: HwAiRequest, cfg: {
  baseUrl: string; apiKey: string; model: string; timeoutMs: number;
}): Promise<HwAiResult> {
  const res = await fetch(`${cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      model: cfg.model,
      temperature: 0.2,
      max_tokens: 1500,
      messages: [
        { role: 'system', content: systemPrompt(languageName(req.lang)) },
        { role: 'user', content: userPayload(req) },
      ],
    }),
    signal: AbortSignal.timeout(cfg.timeoutMs),
  });
  // Only the status: a provider's error body can echo the request it was given.
  if (!res.ok) throw new Error(`AI provider returned HTTP ${res.status}`);
  const body = await res.json() as {
    choices?: { message?: { content?: unknown } }[];
  };
  const raw = body.choices?.[0]?.message?.content;
  const text = typeof raw === 'string'
    ? raw
    : Array.isArray(raw)
      ? raw.map((part) => (part as { text?: string })?.text ?? '').join('')
      : '';
  if (!text.trim()) throw new Error('AI provider returned an empty answer');
  const parsed = aiJsonSchema.safeParse(extractJson(text));
  if (!parsed.success) throw new Error('AI provider returned an unexpected JSON shape');

  const questions = cleanList(parsed.data.questions ?? [], 4);
  const warnings = cleanList(parsed.data.warnings ?? [], 8);
  const formatted = parsed.data.formatted.trim().slice(0, MAX_EDIT_TEXT);
  const title = (parsed.data.title ?? '').trim().slice(0, 120)
    || formatted.split('\n').map((l) => l.trim()).find(Boolean)?.slice(0, 120)
    || h('hwDefaultTitle', req.lang);
  return {
    status: questions.length ? 'needs_clarification' : 'ok',
    title, formatted,
    questions,
    warnings: [...warnings, ...attachmentWarning(req),
      ...foreignNumbers(req, formatted), ...foreignDeadlines(req, formatted)].slice(0, 10),
    provider: `openai-compatible:${cfg.model}`,
  };
}

// ─── factory ─────────────────────────────────────────────────────────────────

/** The runtime provider from env. `none` is a real, working offline implementation. */
export function makeHomeworkAi(): HomeworkAi {
  if (env.AI_PROVIDER === 'openai-compatible' && env.AI_API_KEY && env.AI_MODEL) {
    return {
      format: (req) => remoteFormat(req, {
        baseUrl: env.AI_BASE_URL, apiKey: env.AI_API_KEY, model: env.AI_MODEL,
        timeoutMs: env.AI_TIMEOUT_MS,
      }),
    };
  }
  return {
    format: async (req) => localFormat(req),
  };
}

/** Tests and the demo can inject their own; a missing dependency falls back to `local`. */
export const LOCAL_AI: HomeworkAi = {
  format: async (req) => localFormat(req),
};
