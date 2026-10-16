/**
 * Часть B, шаг B1 (2026-10-16): что умеет ЭТОТ браузер, а не «браузер вообще».
 *
 * На iPhone Safari `getDisplayMedia` нет, `requestFullscreen` у элемента есть, но с оговорками, а
 * `setSinkId` нет и на Android Chrome, и на Safari. Показывать кнопку, которая по нажатию не
 * делает ничего, — худший вариант: человек решит, что сломан урок. Поэтому кнопка либо
 * скрывается, либо заменяется понятной строкой на трёх языках.
 */

export interface Caps {
  /** показ экрана: есть ли `mediaDevices.getDisplayMedia` */
  screen: boolean;
  /** полноэкранный режим элемента: есть ли `requestFullscreen` на HTMLElement */
  fullscreen: boolean;
  /** выбор динамика: есть ли `setSinkId` у HTMLMediaElement */
  sink: boolean;
}

let cached: Caps | null = null;

export function capabilities(): Caps {
  if (cached) return cached;
  const md = navigator.mediaDevices as (MediaDevices & { getDisplayMedia?: unknown }) | undefined;
  cached = {
    screen: typeof md?.getDisplayMedia === 'function',
    fullscreen: typeof HTMLElement.prototype.requestFullscreen === 'function',
    sink: typeof (HTMLMediaElement.prototype as unknown as { setSinkId?: unknown }).setSinkId === 'function',
  };
  return cached;
}

/** Только для тестов и для скриптов съёмки: кэш возможностей иначе не обновить. */
export function resetCapabilitiesForTests(next?: Caps): void {
  cached = next ?? null;
}
