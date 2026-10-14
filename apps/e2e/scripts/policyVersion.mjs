/**
 * Версия юридических документов для e2e-фикстур — ОДИН источник правды.
 *
 * Скрипты стека вписывают в `policy_acceptances` версию, под которой учётная запись уже согласилась
 * с политикой. Раньше они держали её как литерал ('2026-10-06'), и поднятая POLICY_VERSION молча
 * ломала весь набор: каждый boot-аккаунт попадал на экран согласия, браузерные спеки падали одна за
 * другой, а каждая падающая RTC-спека сжигала по 4–5 минут, пока джобу не убивал таймаут (прогон
 * 38524902271). Спеки zz14/zz15 читают версию из исходника — теперь то же самое делают и скрипты.
 *
 * `@klass/shared` этому пакету не зависит (в e2e нет ни build, ни зависимостей монорепо), поэтому
 * значение вычитывается из constants.ts текстом, как в zz14.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CONSTANTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)),
  '../../../packages/shared/src/constants.ts');

export function readPolicyVersion() {
  const hit = /POLICY_VERSION\s*=\s*'([^']+)'/.exec(readFileSync(CONSTANTS, 'utf8'));
  if (!hit?.[1]) throw new Error('POLICY_VERSION не найден в packages/shared/src/constants.ts');
  return hit[1];
}
