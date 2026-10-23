import { PIP_HEIGHT, PIP_WIDTH, collectStyleSources } from '@klass/shared';

/**
 * Часть C (2026-10-23): окно показа экрана ПОВЕРХ других программ.
 *
 * Это обёртка над `documentPictureInPicture` — единственным способом, которым браузер даёт
 * странице законное право на такое окно (то, что делает «мини-плеер» у YouTube). Никаких
 * `window.open` для этой цели: popup живёт во вкладке браузера, а не над Word, и зовёт
 * блокировщик всплывающих окон.
 *
 * Всё, что можно решить без DOM, уехало в `@klass/shared/screenPip.ts` и покрыто юнитами; здесь
 * остались ровно те вызовы, которые без браузера не проверить. Отказ любой ступени означает
 * «окна нет», а не «урок сломался»: показ экрана продолжает работать в штатной плашке.
 */

/** Узкое лицо API, чтобы тест и реальный браузер были одинаково подставляемы. */
export interface PipApi {
  requestWindow(options?: { width?: number; height?: number }): Promise<Window>;
}

export interface PipHandle {
  win: Window;
  doc: Document;
  close(): void;
}

export function pipApi(): PipApi | null {
  const api = (window as unknown as { documentPictureInPicture?: Partial<PipApi> }).documentPictureInPicture;
  return api && typeof api.requestWindow === 'function' ? (api as PipApi) : null;
}

/**
 * Перенос стилей в новое окно. Порядок важен: Document PiP даёт пустый документ, и без нашей
 * таблицы окно показало бы белый голый текст. Относительные `href` абсолютятся от основной
 * страницы — в пустом документе базы нет, и `/assets/x.css` без базы ушёл бы в `about:blank`.
 */
export function copyStyles(from: Document, to: Document): number {
  const tags = [...from.querySelectorAll('link[rel="stylesheet"], style')] as (HTMLLinkElement | HTMLStyleElement)[];
  const sources = collectStyleSources(
    tags.map((el) => ({
      rel: el.getAttribute('rel'),
      href: el instanceof HTMLLinkElement ? el.href : null,
      textContent: el.textContent,
    })),
    from.baseURI || location.href,
  );
  const head = to.head ?? to.documentElement.appendChild(to.createElement('head'));
  let put = 0;
  for (const src of sources) {
    if (src.kind === 'link') {
      const el = to.createElement('link');
      el.rel = 'stylesheet';
      el.href = src.href;
      head.appendChild(el);
      put += 1;
    } else {
      const el = to.createElement('style');
      el.textContent = src.css;
      head.appendChild(el);
      put += 1;
    }
  }
  return put;
}

/** Тема и язык: `data-theme` живёт на `html`, поэтому копируем атрибут, а не вычисляем заново. */
export function copyThemeAndLang(from: Document, to: Document): void {
  const html = to.documentElement;
  const theme = from.documentElement.getAttribute('data-theme');
  if (theme) html.setAttribute('data-theme', theme);
  const lang = from.documentElement.getAttribute('lang') || navigator.language || 'en';
  html.setAttribute('lang', lang);
  const dir = from.documentElement.getAttribute('dir');
  if (dir) html.setAttribute('dir', dir);
}

/**
 * Открыть окно. Возвращает `null`, если браузер такого API не имеет или вызов отвергнут (у
 * `requestWindow` есть требование пользовательского жеста — см. `Lesson.tsx`, где окно открывается
 * В ТОМ НАЖАТИИ, что запускает показ). Никаких исключений наружу не отдаём: показ экрана не должен
 * зависеть от того, удалось ли cosmetic-окно.
 */
export async function openSharePipWindow(onUserClose: () => void): Promise<PipHandle | null> {
  const api = pipApi();
  if (!api) return null;
  let win: Window;
  try {
    win = await api.requestWindow({ width: PIP_WIDTH, height: PIP_HEIGHT });
  } catch {
    return null;
  }
  const doc = win.document;
  try {
    copyStyles(document, doc);
    copyThemeAndLang(document, doc);
  } catch {
    /* стили не перенесли — окно всё равно рабочее, просто без темы; ронять показ из-за этого нельзя */
  }
  const close = () => {
    try {
      if (!win.closed) win.close();
    } catch { /* окно уже закрыто человеком */ }
  };
  // крестик на самом окне: человек закрыл его сам, и состояние урока обязан узнать об этом
  win.addEventListener('pagehide', () => { onUserClose(); close(); });
  return { win, doc, close };
}

/** Возврат фокуса: окно закрылось — работать человек будет в уроке, а не в висящем теле. */
export function focusMainPage(trigger?: HTMLElement | null): void {
  try {
    window.focus();
    if (trigger && typeof trigger.focus === 'function') trigger.focus();
  } catch { /* фокус — вежливость, а не функциональность */ }
}
