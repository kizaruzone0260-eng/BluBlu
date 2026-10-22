/**
 * Hard limits of the homework module. They are deliberately below Telegram's own
 * limits so a normal send cannot fail halfway through a publication.
 */
export const MAX_ITEMS = 50;
/** One collected text/link; longer material should be split by the teacher. */
export const MAX_ITEM_TEXT = 8_000;
/** A photo/document bigger than this is refused with an explanation. */
export const MAX_FILE_MB = 20;
/** The edited final text is stored and then split for Telegram at publish time. */
export const MAX_EDIT_TEXT = 6_000;
/** Visible part of the preview; the publication always sends the full text. */
export const PREVIEW_CHARS = 3_000;
/** Telegram's message limit is 4096 UTF-16 units; keep a margin for safety. */
export const PUBLISH_CHUNK = 3_800;
/** At most this many groups per teacher — a Telegram message has ~100 buttons. */
export const MAX_GROUPS = 20;
/** A formatting pass stuck longer than this is returned to `collecting` by housekeeping. */
export const FORMATTING_STALE_MS = 5 * 60_000;
/** A publication stuck longer than this is conservatively reported as unknown. */
export const PUBLISHING_STALE_MS = 10 * 60_000;

// ─── material library (part B, 2026-10-22) ────────────────────────────────────

/** Saved files per teacher. Buttons are capped per screen, not by this number. */
export const MAX_MATERIALS = 100;
/** The title is the teacher's own words; 140 keeps it readable inside a button. */
export const MAX_MATERIAL_TITLE = 140;
/** Books attached to one homework. More than this is a different task, not a homework. */
export const MAX_DRAFT_MATERIALS = 8;
/** «Unit 2, Exercises 1–5» — the teacher's instruction, kept separate from the final text. */
export const MAX_INSTRUCTION_TEXT = 2_000;
/** Materials shown on one screen; the rest is reachable by filtering on a group. */
export const LIBRARY_SCREEN_LIMIT = 20;
/** The add/rename dialog lives in bot_sessions; a forgotten step must not block the bot. */
export const LIBRARY_SESSION_TTL_MIN = 30;
