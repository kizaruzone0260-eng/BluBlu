/**
 * Часть 5 (2026-10-14) → часть E (2026-10-17): имя файла Word.
 *
 * Сборка .docx переехала в `@klass/shared/boardDocxBuild`: той же сборки требуют и проверки без
 * браузера (юнит-тест распаковывает готовый файл), а `apps/api` не видит зависимости `apps/web`.
 * Здесь остаётся только именование: PDF и Word обязаны называться одинаково (класс может
 * содержать кириллицу и `oʻ/gʻ`), поэтому обе кнопки идут через `boardExportBaseName` — иначе
 * правила именования разъезжаются при первой же правке одной из кнопок.
 */
import { boardExportBaseName } from './boardPdf';

export function boardWordFileName(className: string, at: Date = new Date()): string {
  return `${boardExportBaseName(className, at)}.docx`;
}
