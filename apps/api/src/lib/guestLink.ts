import { createHash, randomBytes } from 'node:crypto';
import { GUEST_TOKEN_BYTES, GUEST_TOKEN_LENGTH } from '@klass/shared';

/**
 * Секреты гостевой ссылки (задача 2026-10-28, часть 3).
 *
 * Здесь два разных секрета, и они не должны смешиваться:
 *  • токен ССЫЛКИ — 32 случайных байта, живёт в ответе на создание и больше нигде; в базе только
 *    хеш. Ветка pepper `guest.` отделяет его от приглашений в класс (`link.`) и кодов почты —
 *    один и тот же хеш не должен находиться двумя разными путями;
 *  • ключ ГОСТЯ — его генерирует браузер гостя, и он отличает «ту же заявку» от новой. Ветка
 *    `guestkey.` и `linkId` в материалах хеша делают ключи двух разных ссылок несовместимыми:
 *    утёкший ключ не станет пропуском в другой урок.
 *
 * Оба хеша — sha256 с секретом сервера, как у приглашений (`hashInviteToken`): перебор по базе
 * не даёт ни одного действующего значения.
 */
export function generateGuestToken(): string {
  return randomBytes(GUEST_TOKEN_BYTES).toString('base64url').slice(0, GUEST_TOKEN_LENGTH);
}

export function hashGuestToken(token: string, pepper: string): string {
  return createHash('sha256').update(`guest.${pepper}.${token}`).digest('hex');
}

export function hashGuestKey(key: string, linkId: string, pepper: string): string {
  return createHash('sha256').update(`guestkey.${pepper}.${linkId}.${key}`).digest('hex');
}
