/**
 * File type detection by content (§3.3: magic bytes, not extension).
 * Allowed v1 set: pdf, docx/pptx/xlsx (OOXML zips), txt, images, mp3/m4a, mp4.
 */
export type Detected =
  | { group: 'pdf'; mime: string; ext: string }
  | { group: 'office'; mime: string; ext: 'docx' | 'pptx' | 'xlsx' }
  | { group: 'image'; mime: string; ext: string }
  | { group: 'audio'; mime: string; ext: string }
  | { group: 'video'; mime: string; ext: string }
  | { group: 'text'; mime: 'text/plain'; ext: 'txt' }
  | { group: 'unknown' };

const start = (b: Buffer, sig: number[], off = 0): boolean =>
  sig.every((v, i) => b[off + i] === v);

const ascii = (b: Buffer, s: string, off = 0): boolean =>
  b.length >= off + s.length && b.subarray(off, off + s.length).toString('latin1') === s;

/** Detect from first bytes + filename hint (OOXML and text need the extension). */
export function detectFileType(head: Buffer, filename: string): Detected {
  const lower = filename.toLowerCase();
  const ext = lower.includes('.') ? lower.slice(lower.lastIndexOf('.') + 1) : '';

  if (start(head, [0x25, 0x50, 0x44, 0x46])) return { group: 'pdf', mime: 'application/pdf', ext: 'pdf' };
  if (start(head, [0x89, 0x50, 0x4e, 0x47])) return { group: 'image', mime: 'image/png', ext: 'png' };
  if (start(head, [0xff, 0xd8, 0xff])) return { group: 'image', mime: 'image/jpeg', ext: 'jpg' };
  if (ascii(head, 'GIF8')) return { group: 'image', mime: 'image/gif', ext: 'gif' };
  if (ascii(head, 'BM')) return { group: 'image', mime: 'image/bmp', ext: 'bmp' };
  if (ascii(head, 'RIFF') && ascii(head, 'WEBP', 8)) return { group: 'image', mime: 'image/webp', ext: 'webp' };
  if (ascii(head, 'II*\0') || ascii(head, 'MM\0*')) return { group: 'image', mime: 'image/tiff', ext: 'tiff' };

  // ISO BMFF: ....ftyp — mp4 / m4a distinguished by extension
  if (ascii(head, 'ftyp', 4)) {
    if (ext === 'm4a') return { group: 'audio', mime: 'audio/mp4', ext: 'm4a' };
    if (ext === 'mp4') return { group: 'video', mime: 'video/mp4', ext: 'mp4' };
    return { group: 'unknown' };
  }
  if (ascii(head, 'ID3') || (head[0] === 0xff && ((head[1] ?? 0) & 0xe0) === 0xe0)) {
    return { group: 'audio', mime: 'audio/mpeg', ext: 'mp3' };
  }

  // OOXML documents are ZIP containers: PK\x03\x04 + required extension whitelist
  if (start(head, [0x50, 0x4b, 0x03, 0x04])) {
    if (ext === 'docx') return { group: 'office', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', ext: 'docx' };
    if (ext === 'pptx') return { group: 'office', mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', ext: 'pptx' };
    if (ext === 'xlsx') return { group: 'office', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ext: 'xlsx' };
    return { group: 'unknown' };
  }

  // Plain text: printable/whitespace only (guard the first 8 KiB), txt-ish extension
  if (ext === 'txt' || ext === 'md' || ext === 'csv') {
    const sample = head.subarray(0, Math.min(head.length, 8192));
    let weird = 0;
    for (const c of sample) {
      if (c === 0x00) return { group: 'unknown' }; // NUL ⇒ binary
      if (c < 0x09 || (c > 0x0d && c < 0x20)) weird++;
    }
    if (weird / Math.max(1, sample.length) < 0.01) return { group: 'text', mime: 'text/plain', ext: 'txt' };
  }
  return { group: 'unknown' };
}

/** Types safe for browser inline preview. SVG excluded: it can carry scripts. */
export function isInlineSafe(mime: string): boolean {
  if (mime === 'image/svg+xml') return false;
  return mime.startsWith('image/') || mime === 'application/pdf'
    || mime.startsWith('audio/') || mime.startsWith('video/')
    || mime.startsWith('text/');
}
