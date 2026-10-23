/**
 * Request id (task B, 2026-10-23).
 *
 * A student who cannot log in has nothing to tell a teacher but «Something went wrong». With a
 * short id printed under the message and echoed in the access log, the same complaint becomes a
 * findable line: the teacher (or the owner) greps the id and sees the real reason.
 *
 * The id is a random 10-character lowercase token, NOT a sequence and NOT derived from anything
 * the person typed: it must not leak the request rate, the account, or the email, and it must fit
 * on a phone screen. `crypto.randomBytes` is used rather than `req.id`'s default counter for the
 * same reason — a counter reveals how many requests the process has served.
 */
import { randomBytes } from 'node:crypto';

const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz'; // no i, l, o, u: readable when dictated
const LENGTH = 10;

/** New id for one request. Called by Fastify's `genReqId`, so every request gets exactly one. */
export function newRequestId(): string {
  const bytes = randomBytes(LENGTH);
  let out = '';
  for (let i = 0; i < LENGTH; i++) {
    const byte = bytes[i] ?? 0;
    out += ALPHABET[byte % ALPHABET.length] ?? ALPHABET[0]!;
  }
  return out;
}

/** Shape of an issued id — used by tests and by the client's display guard. */
export const REQUEST_ID_PATTERN = new RegExp(`^[${ALPHABET}]{${LENGTH}}$`);

/**
 * The body of every error answer: the code the interface translates, plus the id.
 *
 * One helper on purpose — an error without `reqId` is exactly the bug this exists to fix, so a
 * route must not be able to build a body by hand without noticing.
 */
export function errorBody(reqId: unknown, code: string): { error: string; reqId: string } {
  return { error: code, reqId: typeof reqId === 'string' ? reqId : '' };
}
