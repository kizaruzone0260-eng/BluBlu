/**
 * Note emptiness rules (shared: API validation + client draft/publish UI).
 * A note must have at least one non-whitespace character in the title OR in
 * the text of the body. A drawing (embedded by the note editor as
 * <div class="note-drawing" data-note-drawing="<encodeURIComponent(JSON)">)
 * counts as content too — a note with one stroke and no text is NOT empty.
 */

const TAGS = /<\/?[a-z][\s\S]*?>/gi;

export function notePlainText(html: string): string {
  return html
    .replace(TAGS, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;|&quot;|&#39;|&lt;|&gt;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function noteHasDrawing(bodyHtml: string): boolean {
  const re = /data-note-drawing="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(bodyHtml))) {
    const raw = m[1] ?? '';
    if (!raw) continue;
    try {
      const j = JSON.parse(decodeURIComponent(raw));
      if (Array.isArray(j?.strokes) && j.strokes.length > 0) return true;
    } catch { /* malformed payload ⇒ not content */ }
  }
  return false;
}

export function noteHasContent(title: string, bodyHtml: string): boolean {
  return title.trim().length > 0 || notePlainText(bodyHtml).length > 0 || noteHasDrawing(bodyHtml);
}
