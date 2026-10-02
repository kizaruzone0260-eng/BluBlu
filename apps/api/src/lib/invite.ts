import { createHash, randomInt } from 'node:crypto';
import { INVITE_ALPHABET, INVITE_CODE_LENGTH } from '@klass/shared';

/**
 * Cryptographically random code from an ambiguous-free alphabet
 * (no 0/O, 1/I/L). randomInt is rejection-sampled — uniform over the alphabet.
 */
export function generateInviteCode(length = INVITE_CODE_LENGTH): string {
  let out = '';
  for (let i = 0; i < length; i++) {
    out += INVITE_ALPHABET[randomInt(0, INVITE_ALPHABET.length)];
  }
  return out;
}

export function normalizeInviteCode(raw: string): string {
  return raw.toUpperCase().replace(/[\s-]/g, '');
}

export function hashInviteCode(code: string, salt: string): string {
  return createHash('sha256').update(`${salt}.${code}`).digest('hex');
}

/** Reject codes that could not have been generated (wrong alphabet/length). */
export function looksLikeInviteCode(code: string): boolean {
  if (code.length !== INVITE_CODE_LENGTH) return false;
  return [...code].every((ch) => INVITE_ALPHABET.includes(ch));
}
