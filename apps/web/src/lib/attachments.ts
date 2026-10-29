/**
 * Material task A — client-side helpers for external attachments.
 *
 * `safeExternalUrl`/`classifyAttachmentUrl` больше не переписаны здесь: с 2026-10-28 (аудит
 * SEC-22 и паритет форм) это ОДНА реализация из `@klass/shared::links`, которой пользуется и
 * сервер. Копипаста расходилась молча — форма пропускала адрес, который сервер потом отклонял,
 * или наоборот. `youtubeVideoId` остаётся в вебе: сервер по нему ничего не решает.
 *
 * Браузер по-прежнему не грузит сторонние превью (i.ytimg.com нет в CSP img-src), а плеер
 * YouTube встраивается только после явного клика, через youtube-nocookie.
 */
export { safeExternalUrl, classifyAttachmentUrl, type AttachmentKind } from '@klass/shared';

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
