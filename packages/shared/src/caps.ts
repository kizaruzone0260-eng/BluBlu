/**
 * Часть B, шаг B1 (2026-10-16): чего НЕ умеет этот браузер и что показать вместо кнопки.
 *
 * Детект живёт в браузере (`apps/web/src/lib/capabilities.ts`), а здесь — только решение «какие
 * объяснения выводим»: его надо уметь проверять без браузера, и он же держит порядок строк,
 * одинаковый для трёх языков.
 */

export interface MediaCaps { screen: boolean; fullscreen: boolean; sink: boolean }

/** Ключи перевода объяснений; пустой массив — скрывать нечего, всё умеют. */
export function missingCapNotices(c: MediaCaps): string[] {
  const out: string[] = [];
  if (!c.screen) out.push('lesson.capNoScreen');
  // полноэкранный режим просят и полоса урока, и плашка доски: порядок один и тот же
  if (!c.fullscreen) out.push('lesson.capNoFullscreen');
  if (!c.sink) out.push('lesson.speakerUnsupported');
  return out;
}

/** Показывать ли вообще блок «Динамик»: без `setSinkId` список — это обещание, которое нельзя выполнить. */
export function showsSpeakerPicker(c: MediaCaps): boolean { return c.sink; }

/**
 * Есть ли хоть один пункт, который этот браузер выполнит: если нет, панель устройств надо
 * сворачивать до двух списков (камера и микрофон), а не показывать три подряд.
 */
export function hasAnyOptionalCap(c: MediaCaps): boolean { return c.screen || c.fullscreen || c.sink; }
