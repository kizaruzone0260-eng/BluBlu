/**
 * Панель стилей доски (часть A, 2026-10-23) — чистые правила, которые можно проверить без браузера.
 *
 * Симптом живой: панель стилей Excalidraw открывается слева и перекрывает полотно, а на уроке
 * полотно важнее панели. Значит по умолчанию она закрыта, а открывается по кнопке «Стили» — и
 * решение человека запоминается ОТДЕЛЬНО для учителя и для ученика (у них разные права и разные
 * привычки: учитель рисует весь урок, ученик — только когда ему разрешили).
 *
 * Функции ничего не читают из окружения: ширина, значение из localStorage и роль приходят
 * аргументами. Именно поэтому они живут в shared, а не в `apps/web`: у веб-приложения нет
 * юнит-раннера, а проверять «не перекрывает ли панель полотно на 390 px» браузером локально
 * запрещено.
 */

/**
 * Ниже какой ширины РАМКИ ДОСКИ панель не открывается вообще.
 *
 * Правка 2026-10-24: раньше это сравнивалось с шириной ОКНА (`window.innerWidth`, порог 1280), и
 * именно поэтому «скрыть панель» выглядело ненадёжным. Полотно живёт внутри `.container` с
 * `max-width: 960px` (styles.css), то есть рамка доски НИКОГДА не бывает 1280 px — правило
 * «места достаточно» включалось по окну в три раза более широкому, чем реальное полотно, и на
 * ноутбуке 1366 px панель считалось позволительной поверх ~930-пиксельного холста. Порог теперь
 * измеряется по самой рамке: островок стилей весит ~190-210 px, значит 560 px — это ~2.7 ширины
 * панели, при котором полотну остаётся больше двух третей.
 */
export const STYLES_PANEL_MIN_FRAME = 560;

/**
 * Пороги СОБСТВЕННОЙ раскладки Excalidraw (0.18.1). Библиотека сама решает, какой ей быть, и
 * решает это по размеру своего контейнера, а не окна: в собранном коде
 * `isMobileBreakpoint(w, h) = w < MQ_MAX_WIDTH_PORTRAIT || (h < MQ_MAX_HEIGHT_LANDSCAPE &&
 * w < MQ_MAX_WIDTH_LANDSCAPE)` с константами 730 / 500 / 1000 (проверено по
 * `dist/dev/chunk-4FTI6OG3.js:315-317` установленной версии).
 *
 * Это важно ровно потому, что панель форматирования в двух раскладках живёт в разных узлах:
 *  • десктоп — `.selected-shape-actions` слева сверху; узел создаётся, когда «есть чего показать»
 *    (активен инструмент или есть выделение), и дальше видимостью распоряжается наш CSS;
 *  • мобильная — `.App-mobile-menu` в нижнем баре, и появляется она только при
 *    `appState.openMenu === 'shape'`, то есть по кнопке самой библиотеки.
 * На ноутбуке 1280×720 полотно урока выходит ~925×432 px — это вторая раскладка, и именно поэтому
 * нажатие «Стили» казалось пустым: CSS прятал узел, которого в такой раскладке просто нет.
 */
export const EXCALIDRAW_MOBILE_MAX_WIDTH = 730;
export const EXCALIDRAW_MOBILE_MAX_HEIGHT_LANDSCAPE = 500;
export const EXCALIDRAW_MOBILE_MAX_WIDTH_LANDSCAPE = 1000;

/** В мобильной ли раскладке рисует Excalidraw при таком размере СВОЕГО контейнера. */
export function excalidrawMobileChrome(width: number, height: number): boolean {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return false;
  return width < EXCALIDRAW_MOBILE_MAX_WIDTH
    || (height < EXCALIDRAW_MOBILE_MAX_HEIGHT_LANDSCAPE && width < EXCALIDRAW_MOBILE_MAX_WIDTH_LANDSCAPE);
}

export type BoardStylesRole = 'teacher' | 'student';

/** Ключ localStorage: выбор учителя и выбор ученика не должны перетекать друг в друга. */
export function stylesPanelKey(role: BoardStylesRole): string {
  return `blublu.board.styles.${role}`;
}

/**
 * Подписи состояния. Ключи названы по ДЕЙСТВИЮ, которое кнопка предлагает (`action*`), и по
 * СОСТОЯНИЮ (`hint*`) — иначе имя «ariaOpen» неизбежно врет: открытой панели подписью служит
 * «скрыть».
 *
 * Видимый текст кнопки остаётся одним и тем же: появление/исчезновение слова меняло бы ширину
 * кнопки, а строка шапки доски — это ровно то, что измеряет блокирующий спек zz20 («выдача права
 * рисовать не сдвигает полотно», допуск 2 px, прогон 39993977646). Состояние читается из
 * `aria-expanded` и из `title`, и этого довольно и человеку, и тесту.
 */
export function stylesPanelLabels(open: boolean): { aria: string; hint: string } {
  return open
    ? { aria: 'lesson.boardStylesActionHide', hint: 'lesson.boardStylesHintOpen' }
    : { aria: 'lesson.boardStylesActionShow', hint: 'lesson.boardStylesHintClose' };
}

/** Значение, которое мы пишем: строка, а не «true» — чтобы чтение было одним сравнением. */
export function stylesPanelStored(open: boolean): string {
  return open ? '1' : '0';
}

/**
 * Открыта ли панель СЕЙЧАС. `width` — ширина РАМКИ ДОСКИ, а не окна: см. STYLES_PANEL_MIN_FRAME.
 * Порядок правил важен:
 *  • узкая рамка закрывает панель независимо от сохранённого выбора — и не перезаписывает его;
 *  • сохранённого выбора нет (первый заход, приватный режим, другой браузер) → закрыто и для
 *    ученика, и для учителя: у учителя панель открывается только по нажатию.
 */
export function resolveStylesPanel(opts: {
  width: number;
  stored: string | null;
}): boolean {
  if (!Number.isFinite(opts.width) || opts.width < STYLES_PANEL_MIN_FRAME) return false;
  return opts.stored === '1';
}

/** Отличается ли роль от той, что ждёт пользователь: учитель = `me.role === 'teacher'`. */
export function boardStylesRole(role: string | undefined): BoardStylesRole {
  return role === 'teacher' ? 'teacher' : 'student';
}
