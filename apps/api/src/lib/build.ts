import { TELEGRAM_SDK_URL } from '@klass/shared';

/**
 * Build stamp (task 1): the short commit hash shown ONLY in the interface
 * (Profile + Login footers). Render injects RENDER_GIT_COMMIT at runtime, so
 * the API stamps it into the served index.html <meta name="app-build"> — the
 * value never appears in /api/health or any JSON API response. Local dev and
 * static builds keep the placeholder.
 */
export function currentBuildId(): string {
  const c = process.env.RENDER_GIT_COMMIT ?? '';
  return /^[0-9a-f]{7,40}$/i.test(c) ? c.slice(0, 7) : 'dev';
}

/** Replace the placeholder meta content in index.html (pure, testable). */
export function injectBuildMeta(html: string, build: string): string {
  return html.replace(
    /(<meta\s+name="app-build"\s+content=")[^"]*(")/i,
    `$1${build}$2`,
  );
}

/**
 * Task G.2 (2026-11-04): официальный SDK Telegram обязан быть в `<head>` ДО скриптов приложения —
 * так написано в документации Telegram, и так убирается гонка, которая была раньше: модуль
 * приложения исполнялся первым, сам вставлял `<script>` в head и только потом читал запуск.
 *
 * Инъекция здесь, а не в `apps/web/index.html`, по двум причинам, и обе рабочие:
 *  • тег нужен ровно одному документу (`/mini`). Добавить его в shell означало бы CSP-нарушение
 *    на каждой странице: `script-src 'self'` остальных страниц справедливо блокирует telegram.org,
 *    и человек получил бы ошибку в консоли там, где никакого Mini App нет;
 *  • `defer` держит порядок исполнения (классический `defer` исполняется до отложенного модуля,
 *    в порядке появления в документе) и не блокирует первую отрисовку на 119 КБ чужого скрипта —
 *    на мобильной сети это было бы платой за то, что человек всё равно увидит сразу.
 *
 * URL один на весь репозиторий — `TELEGRAM_SDK_URL` из общего пакета; его же читает юнит-тест.
 */
export function injectTelegramSdk(html: string, url: string = TELEGRAM_SDK_URL): string {
  if (html.includes(url)) return html; // уже в shell (dev-сборка): второй копией был бы двойной старт
  const tag = `<script defer src="${url}"></script>`;
  const moduleAt = html.search(/<script[^>]+type="module"/i);
  if (moduleAt >= 0) return `${html.slice(0, moduleAt)}${tag}\n    ${html.slice(moduleAt)}`;
  const headClose = html.lastIndexOf('</head>');
  if (headClose >= 0) return `${html.slice(0, headClose)}${tag}\n  ${html.slice(headClose)}`;
  return `${tag}${html}`;
}
