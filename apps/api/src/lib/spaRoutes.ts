/**
 * LOW-07 (аудит 2026-10-28, пункт чек-листа 9): оболочка SPA отдавалась со статусом 200 на
 * ЛЮБОЙ не-API путь — включая несуществующие страницы и отсутствующие файлы. Для поисковика это
 * soft 404, для человека — «страница есть, но пустая», для монитора доступности — ложный успех.
 *
 * Здесь — единственный список маршрутов, которые SPA действительно рисует (App.tsx). API отвечает
 * 200 только на них, на неизвестную страницу — та же оболочка, но с кодом 404 (SPA покажет свой
 * экран), на файл с расширением — обычный 404 без HTML. Список обязан совпадать с App.tsx; это
 * держит `spa-routes.test.ts`, читающий файл маршрутов, а не копию.
 *
 * Почему не «отдавать 404 на всё, кроме `/`»: прямые ссылки на /classes/:id, /chat/:id и
 * /classes/:id/archive — рабочий вход в продукт (закладка, письмо, перезагрузка), и они не
 * должны выглядеть сломанными.
 */
export const SPA_ROUTE_TEMPLATES = [
  '/',
  '/login',
  '/register',
  '/join',
  '/guest',
  '/profile',
  '/notes',
  '/classes',
  '/classes/:id',
  '/classes/:id/archive',
  '/classes/:id/material/new',
  '/calendar',
  '/lesson',
  '/sheets',
  '/chat',
  '/chat/:id',
  // Task F (2026-10-28): Telegram Mini App entry. It is a standalone page (no app chrome), but it
  // is still a real SPA route: a reload inside Telegram must return the shell with 200.
  '/mini',
  '/spike',
  '/privacy',
  '/terms',
] as const;

/** `/classes/:id` → `^/classes/[^/]+$`; хвостовой слэш допустим, регистр — как у React Router. */
function templateToRegExp(template: string): RegExp {
  const body = template
    .split('/')
    .map((part) => (part.startsWith(':') ? '[^/]+' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('/');
  return new RegExp(`^${body}/?$`, 'i');
}

const COMPILED = SPA_ROUTE_TEMPLATES.map(templateToRegExp);

/** true — путь принадлежит SPA; сервер обязан отдать оболочку (200). */
export function isSpaRoute(pathname: string): boolean {
  const clean = pathname.split('?')[0] ?? '/';
  return COMPILED.some((re) => re.test(clean));
}

/**
 * Файловый запрос: последний сегмент содержит точку и похож на расширение. Нужен, чтобы
 * отсутствующий `/assets/x.js`, `/index.js.map` или `/fonts/x.woff2` не получал HTML-оболочку:
 * скрипт, ожидающий JS, не должен разбирать разметку.
 */
export function looksLikeStaticFile(pathname: string): boolean {
  const clean = pathname.split('?')[0] ?? '';
  const last = clean.slice(clean.lastIndexOf('/') + 1);
  return /^[^/]+\.[a-z0-9]{2,8}$/i.test(last);
}
