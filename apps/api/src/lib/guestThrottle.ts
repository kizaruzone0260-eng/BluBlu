import { env } from '../env.js';
import { effectiveIpFailMax } from './prodConfig.js';
import { throttleCheck, throttleRecordAttempt, throttleReset } from './throttle.js';

/**
 * Учёт промахов по гостевой ссылке (задача 2026-10-28, часть 3).
 *
 * Отдельный префикс (`gsj:`), а не общий счётчик приглашений: школа, которая весь день вводит
 * учеников в класс, не должна закрывать себе гостевые двери, и наоборот. Правила те же, что у
 * `inviteThrottle`: промах — это токен, который не нашёлся/просрочен/отозван, а также заявка с
 * неизвестным ключом (перебор ключей — это перебор). Успешная проверка токена счётчик обнуляет,
 * а кривые поля формы (пустое имя) не считаются вовсе: это опечатка честного человека.
 */
export const GUEST_JUNK_PREFIX = 'gsj:';

export function guestJunkKey(ip: string): string {
  return `${GUEST_JUNK_PREFIX}${ip}`;
}

export function guestJunkMax(): number {
  return effectiveIpFailMax(env.NODE_ENV, env.RATE_IP_FAIL_MAX);
}

export function guestJunkGate(ip: string): { allowed: boolean; retryAfterSec: number } {
  return throttleCheck(guestJunkKey(ip));
}

export function noteGuestMiss(ip: string): void {
  throttleRecordAttempt(guestJunkKey(ip), Date.now(), guestJunkMax());
}

export function noteGuestHit(ip: string): void {
  throttleReset(guestJunkKey(ip));
}
