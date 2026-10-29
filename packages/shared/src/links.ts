/**
 * Открытые ссылки-вложения: ОДНА проверка для сервера и для формы (аудит 2026-10-28).
 *
 * До этой правки `safeExternalUrl`/`classifyAttachmentUrl` были записаны дважды — в
 * `apps/api/src/services/posts.ts` и `apps/web/src/lib/attachments.ts`, — и правка одной копии
 * молча расходилась с другой. Паритет проверок здесь не косметика: форма решает, что отправить,
 * а сервер — что сохранить, и ученик открывает сохранённое в браузере.
 *
 * Что именно защищается (SEC-22). Сервер эти адреса никогда не запрашивает — SSRF из API тут
 * нет. Опасность в другом: ссылка сохраняется в материале, её нажимает ученик, и браузер идёт
 * на `http://127.0.0.1:…` или `http://169.254.169.254/…` — то есть в локальную сеть или облачные
 * метаданные с точки зрения ЖЕРТВЫ. Литеральные такой адрес-хост поэтому отклоняется на входе.
 * Разбор имён, которые РЕЗОЛВЯТСЯ в петлю (например, публичный DNS, указывающий на 127.0.0.1),
 * сюда не входит сознательно: проверка потребовала бы DNS-запроса на каждый линк, а это уже
 * сетевое действие из API (и утечка «какие ссылки проверяют») — граница названа, а не спрятана.
 *
 * Правила: только `http:`/`https:`, только хост из латиницы, цифр, точки и дефиса, обязательная
 * точка (голый `localhost` не проходит), и не литеральный IPv4 из служебных диапазонов:
 * 0.0.0.0/8 («эта сеть»), 127.0.0.0/8 (петля), 169.254.0.0/16 (link-local, включая метаданные
 * облака). WHATWG-парсер сам приводит десятичные/шестнадцатеричные записи IPv4 к точечной
 * форме (`http://2130706433/` → `127.0.0.1`), поэтому проверка смотрит уже нормализованный хост.
 * IPv6 в квадратных скобках не проходит символьный фильтр — и петля `[::1]` тоже.
 *
 * Хвостовая точка (`localhost.`, `foo.localhost.`) снимается до проверки: для браузера это тот
 * же хост, а спека резолвит `*.localhost` в петлю без DNS — значит, и он должен отсекаться
 * здесь, а не оставаться дырой рядом с явным `127.0.0.1`.
 */
function isBlockedIpv4Host(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return a === 0 || a === 127 || (a === 169 && b === 254);
}

/**
 * Only absolute http(s) URLs with a dotted host survive. Pure parsing: the server NEVER fetches
 * these URLs. The length cap protects the feed layout, not security.
 */
export function safeExternalUrl(raw: string): string | null {
  try {
    const u = new URL(String(raw).trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    const h = u.hostname.toLowerCase().replace(/\.+$/, '');
    if (!/^[a-z0-9.-]+$/.test(h) || !h.includes('.')) return null;
    if (h === 'localhost' || h.endsWith('.localhost')) return null;
    if (isBlockedIpv4Host(h)) return null;
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
