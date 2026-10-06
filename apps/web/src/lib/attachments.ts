/**
 * Material task A — client-side helpers for external attachments. These mirror
 * the server rules (services/posts.ts) so the form can reject bad URLs before
 * sending; the server re-validates everything anyway. The browser never loads
 * third-party thumbnails (i.ytimg.com is not even in the CSP img-src) and the
 * YouTube player is only embedded after an explicit click, via youtube-nocookie.
 */

export function safeExternalUrl(raw: string): string | null {
  try {
    const u = new URL(String(raw).trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    const h = u.hostname.toLowerCase();
    if (!/^[a-z0-9.-]+$/.test(h) || !h.includes('.')) return null;
    return u.toString().slice(0, 2000);
  } catch { return null; }
}

export type AttachmentKind = 'file' | 'link' | 'youtube' | 'drive';

export function classifyAttachmentUrl(url: string): AttachmentKind {
  let h = '';
  try { h = new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return 'link'; }
  if (h === 'youtu.be' || h === 'youtube.com' || h.endsWith('.youtube.com')) return 'youtube';
  if (h === 'drive.google.com' || h === 'docs.google.com') return 'drive';
  return 'link';
}

/** 11-char video id for the nocookie embed, or null when the URL has none */
export function youtubeVideoId(url: string): string | null {
  try {
    const u = new URL(url);
    const h = u.hostname.toLowerCase().replace(/^www\./, '');
    if (h === 'youtu.be') {
      const id = u.pathname.slice(1).split('/')[0] ?? '';
      return /^[\w-]{11}$/.test(id) ? id : null;
    }
    if (h === 'youtube.com' || h.endsWith('.youtube.com')) {
      const v = u.searchParams.get('v');
      if (v && /^[\w-]{11}$/.test(v)) return v;
      const m = /^\/(embed|shorts|live)\/([\w-]{11})/.exec(u.pathname);
      if (m?.[2]) return m[2];
    }
    return null;
  } catch { return null; }
}
