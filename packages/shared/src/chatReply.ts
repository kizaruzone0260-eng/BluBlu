/**
 * Chat replies (task 2, 2026-10-08) — the pieces of a quote the API sends along with a message.
 *
 * The snippet is built on the SERVER from the CURRENT text of the original, so an edit of the
 * original changes every quote of it, and a deleted original has nothing to show. It lives in
 * shared (not inline in the route) because the rule «до 120 символов» has to be unit-tested:
 * slicing a JS string cuts UTF-16 halves, which would break Cyrillic pairs and emoji.
 */

export const REPLY_SNIPPET_MAX = 120;

/** Collapse line runs to single spaces and cut to 120 CODE POINTS. Plain text, always. */
export function replySnippet(text: string): string {
  const flat = text.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  return [...flat].slice(0, REPLY_SNIPPET_MAX).join('');
}

/** What the client renders: «Иван: …» or «Сообщение удалено» when `deleted` is true. */
export interface ReplyRef {
  id: string;
  authorName: string | null;
  snippet: string;
  deleted: boolean;
}

/** The quote of an original that is no longer in the database. */
export const deletedReply = (id: string): ReplyRef => ({ id, authorName: null, snippet: '', deleted: true });

export const liveReply = (id: string, authorName: string, text: string): ReplyRef =>
  ({ id, authorName, snippet: replySnippet(text), deleted: false });
