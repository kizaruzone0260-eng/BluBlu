import { createHash, randomBytes } from 'node:crypto';
import { INVITE_TOKEN_BYTES, INVITE_TOKEN_LENGTH, isInviteToken } from '@klass/shared';

/**
 * Токен одноразового приглашения (задача 2026-10-23, часть A).
 *
 * Две отдельные вещи, которые легко смешать:
 *  • сам токен — 24 байта, base64url БЕЗ паддинга (32 символа). Он существует ровно один момент:
 *    пока сервер отдаёт ссылку учителю;
 *  • его хеш — единственное, что лежит в базе. По нему токен и находится при расходе.
 *
 * base64url, а не base64: `+` и `/` в фрагменте URL либо ломают декодирование у посредников, либо
 * требуют экранирования, которого клиент никогда не делает на глаз. `-`/`_` переходят в URL как есть.
 */
export function generateInviteToken(): string {
  return randomBytes(INVITE_TOKEN_BYTES).toString('base64url').slice(0, INVITE_TOKEN_LENGTH);
}

/**
 * Тот же pepper, что у восьмизначных кодов (`env.JWT_SECRET`), НО в другой доменной ветке:
 * `link.` против `code.`. Это не косметика — без префикса приглашение-ссылка и код класса
 * хешировались бы одной функцией, и любой путь, который ищет одно, мог бы найти другое.
 * Префикс делает такие пересечения невозможными по построению, а не по аккуратности вызывающего.
 */
export function hashInviteToken(token: string, pepper: string): string {
  return createHash('sha256').update(`link.${pepper}.${token}`).digest('hex');
}

/** Только форма: токен, который не проходит `isInviteToken`, не должен доходить до базы вообще. */
export function looksLikeInviteToken(value: string): boolean {
  return isInviteToken(value);
}
