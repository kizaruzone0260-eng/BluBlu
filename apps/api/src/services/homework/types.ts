/**
 * Telegram homework assistant — shared types.
 *
 * The module is intentionally independent of `classes`/`posts`: an offline group is a
 * Telegram chat, a draft is owned by a teacher, and a publication belongs to that chat.
 * The optional BluBlu-class bridge is not part of this MVP.
 */
export type HwLang = 'ru' | 'uz' | 'en';

export interface HwActor {
  userId: string | null;
  role: 'teacher' | 'student' | null;
  lang: HwLang;
  tz: string;
}

export type HwItemKind = 'text' | 'link' | 'photo' | 'document';
export type HwMaterialKind = 'book' | 'workbook' | 'other';

/** Material as the formatter sees it. File bytes never enter the database. */
export interface HwAiItem {
  id: string;
  kind: HwItemKind;
  text: string;
  url: string;
  fileName: string;
  mimeType: string;
  caption: string;
  forwarded: boolean;
}

/**
 * A saved library material, as the formatter sees it: the title the teacher typed and the
 * file name. Nothing else — the contents of a PDF/DOCX/photo are never read, parsed,
 * downloaded or sent to a model. The file is an attachment for the students, not a source
 * of facts.
 */
export interface HwAiMaterial {
  title: string;
  kind: HwMaterialKind;
  fileName: string;
}

export interface HwAiRequest {
  /** Language the final message must be written in. */
  lang: HwLang;
  /** The teacher's own words about what to do (`Unit 2, Exercises 1–5`), may be empty. */
  instruction: string;
  items: HwAiItem[];
  materials: HwAiMaterial[];
}

export type HwAiStatus = 'ok' | 'needs_clarification';

export interface HwAiResult {
  status: HwAiStatus;
  title: string;
  formatted: string;
  questions: string[];
  warnings: string[];
  /** Human-readable provider label stored with the draft (`local`, model name, test fake). */
  provider: string;
}

/**
 * Injected in tests and by the runtime (env-configured provider or safe local formatter).
 * There is deliberately no "can it read photos" flag: this module never gives a model the
 * contents of a file.
 */
export interface HomeworkAi {
  format(req: HwAiRequest): Promise<HwAiResult>;
}
