/**
 * Часть C (2026-10-23) — окно показа экрана поверх других программ (Document Picture-in-Picture).
 *
 * Здесь только ТО, что можно решить без браузера: умеет ли этот браузер такое окно, свёрнут ли
 * предпросмотр по умолчанию, показывать ли подсказку про Chrome/Edge и что именно переносить в
 * новое окно из стилей основной страницы. Сам вызов `documentPictureInPicture.requestWindow` и
 * перенос узлов живут в `apps/web/src/lib/documentPip.ts` — там, где есть DOM.
 *
 * Функции чистые и получают всё аргументами, потому что браузерные спеки локально запрещены, а
 * решение «монитор → предпросмотр свёрнут» обязано быть проверенным, а не заявленным.
 */

/** Размер нового окна по умолчанию. `resizeable` у Document PiP включать нельзя — он весь resizable. */
export const PIP_WIDTH = 360;
export const PIP_HEIGHT = 220;

/** Ключ localStorage: подсказку про другой браузер человек один раз закрыл — больше не просим. */
export const PIP_HINT_KEY = 'blublu.lesson.pipHintOff';

/**
 * Умеет ли ЭТОТ браузер окно поверх других программ.
 *
 * `apiPresent` — честная проверка наличия `documentPictureInPicture` (есть в десктопных
 * Chromium и нет в Safari, Firefox и на телефонах), а не догадка по строке UA. UA добавляется
 * только ОТВЕРГАЮЩЕ: на телефоне API может однажды появиться, но окно 360×220 поверх
 * клавиатуры бесполезно — там и так одно окно. Мобильные отметки перечислены явно, потому что
 * «не десктоп» по UA иначе не определить.
 */
const MOBILE_MARKS = ['Android', 'iPhone', 'iPod', 'iPad', 'Mobile', 'Silk/', 'SM-', 'Redmi', 'Kazehakri'];

export function canUseDocumentPip(opts: { apiPresent: boolean; userAgent: string }): boolean {
  if (!opts.apiPresent) return false;
  const ua = opts.userAgent ?? '';
  // iPadOS 13+ выдаёт себя за macOS и при этом не умеет такие окна; отдельной отметки нет,
  // поэтому максимум, что мы можем, — не открывать окно на явном телефоне.
  return !MOBILE_MARKS.some((m) => ua.includes(m));
}

/**
 * Свёрнут ли предпросмотр собственного показа.
 *
 * «Коридор зеркал»: человек показывает ВЕСЬ монитор, в окне — он же, показывающий окно, в котором
 * он показывает окно. Поэтому при `displaySurface === 'monitor'` предпросмотр по умолчанию свёрнут
 * (значок + подпись остаются), а окно/вкладка показываются сразу: там повторяющейся картинки нет.
 * Неизвестная поверхность (`''` — Safari не отдаёт `displaySurface`) трактуется в пользу показа:
 * пустое окно хуже, чем лишняя плитка.
 */
export function previewOpenByDefault(displaySurface: string): boolean {
  return displaySurface !== 'monitor';
}

/**
 * Показывать ли строку «для окна поверх других программ откройте урок в Chrome или Edge».
 * Просим один раз: после того как человек закрыл подсказку, она больше не появляется.
 */
export function shouldShowPipHint(opts: { apiPresent: boolean; dismissed: string | null | undefined }): boolean {
  if (opts.apiPresent) return false;
  return opts.dismissed !== '1';
}

/** Один источник правды для ключа: веб читает и пишет его одними и теми же словами. */
export function pipHintDismissed(stored: string | null | undefined): boolean {
  return stored === '1';
}

/**
 * Что перенести из `<head>` основной страницы в новое окно, чтобы он выглядел так же (темы,
 * шрифты, все CSS-переменные). Чистая часть задачи: по списку тегов возвращаем список того, что
 * нужно вставить, в ТОМ ЖЕ порядке — порядок важен, иначе переопределения в styles.css поедут.
 *
 * `baseUrl` обязателен: в PiP-окне документ пустой, и относительный `href` без базы ушёл бы в
 * `about:blank` вместо `/assets/x.css`.
 */
export type StyleSource =
  | { kind: 'link'; href: string }
  | { kind: 'style'; css: string };

export interface HeadTagLike {
  rel?: string | null;
  href?: string | null;
  textContent?: string | null;
}

export function collectStyleSources(tags: readonly HeadTagLike[], baseUrl: string): StyleSource[] {
  const out: StyleSource[] = [];
  for (const tag of tags) {
    if (tag.rel === 'stylesheet' && tag.href) {
      let abs = tag.href;
      try { abs = new URL(tag.href, baseUrl).href; } catch { /* как есть: битый href не повод терять остальные стили */ }
      out.push({ kind: 'link', href: abs });
    } else if (tag.textContent && tag.textContent.trim() !== '') {
      out.push({ kind: 'style', css: tag.textContent });
    }
  }
  return out;
}

/** Тема новой копии: `data-theme` переносится со знаком «на себя», иначе окно останется светлым. */
export const PIP_THEME_ATTR = 'data-theme';
