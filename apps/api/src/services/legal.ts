/**
 * Task G (2026-10-29): one server-side answer to «has this person accepted the current
 * Privacy Policy and Terms of Service?».
 *
 * Every surface asks this same function — the web app (`/api/me`), the bot gate, the Mini App
 * gate — so a direct URL, an old button or a fresh tab cannot invent its own answer. Stored
 * data is deliberately explicit: both document versions, the time, the UI language and the
 * surface. A version change therefore re-asks without any client-side flag.
 *
 * The legacy `version` column stays in sync with `POLICY_VERSION`: existing readers and the
 * pre-Task-G web client keep working, and an acceptance recorded elsewhere (web) is honoured
 * by the bot and the Mini App on the very next request.
 */
import { eq } from 'drizzle-orm';
import { POLICY_VERSION, PRIVACY_VERSION, TERMS_VERSION } from '@klass/shared';
import type { DB } from '../db/index.js';
import { policyAcceptances } from '../db/schema.js';

export type AcceptanceContext = 'web' | 'bot' | 'mini';

export interface LegalStatus {
  accepted: boolean;
  privacyVersion: string;
  termsVersion: string;
  /** What the server would accept right now — lets an old tab say «the text has changed». */
  currentPrivacyVersion: string;
  currentTermsVersion: string;
  acceptedAt: string | null;
  locale: string | null;
}

export function currentLegal(): Pick<LegalStatus, 'currentPrivacyVersion' | 'currentTermsVersion'> {
  return { currentPrivacyVersion: PRIVACY_VERSION, currentTermsVersion: TERMS_VERSION };
}

export async function legalStatus(db: DB, userId: string): Promise<LegalStatus> {
  const [row] = await db.select({
    privacyVersion: policyAcceptances.privacyVersion,
    termsVersion: policyAcceptances.termsVersion,
    acceptedAt: policyAcceptances.acceptedAt,
    locale: policyAcceptances.locale,
  }).from(policyAcceptances).where(eq(policyAcceptances.userId, userId)).limit(1);

  const accepted = Boolean(row
    && row.privacyVersion === PRIVACY_VERSION
    && row.termsVersion === TERMS_VERSION);
  return {
    accepted,
    privacyVersion: row?.privacyVersion ?? '',
    termsVersion: row?.termsVersion ?? '',
    ...currentLegal(),
    acceptedAt: row?.acceptedAt?.toISOString() ?? null,
    locale: row?.locale ?? null,
  };
}

export type AcceptLegalResult = 'ok' | 'stale';

/**
 * Record one person's acceptance of the CURRENT pair.
 *
 * Anything else is `stale`: a tab opened yesterday must not be able to accept yesterday's
 * text on today's terms. `onConflictDoUpdate` makes the write idempotent (double tap), and the
 * row is keyed by the authenticated user id — there is no field a caller could use to accept
 * on someone else's behalf.
 */
export async function acceptLegal(
  db: DB, userId: string,
  input: { privacyVersion: string; termsVersion: string; locale?: string; context: AcceptanceContext },
): Promise<AcceptLegalResult> {
  if (input.privacyVersion !== PRIVACY_VERSION || input.termsVersion !== TERMS_VERSION) {
    return 'stale';
  }
  const now = new Date();
  const locale = input.locale === 'ru' || input.locale === 'uz' || input.locale === 'en'
    ? input.locale : null;
  await db.insert(policyAcceptances).values({
    userId,
    version: POLICY_VERSION,
    privacyVersion: PRIVACY_VERSION,
    termsVersion: TERMS_VERSION,
    locale,
    context: input.context,
    acceptedAt: now,
  }).onConflictDoUpdate({
    target: policyAcceptances.userId,
    set: {
      version: POLICY_VERSION,
      privacyVersion: PRIVACY_VERSION,
      termsVersion: TERMS_VERSION,
      locale,
      context: input.context,
      acceptedAt: now,
    },
  });
  return 'ok';
}

/** The two public documents, in one place so every surface links to the same pages. */
export function legalLinks(base: string): { privacy: string; terms: string } {
  const clean = base.replace(/\/+$/, '');
  return { privacy: `${clean}/privacy`, terms: `${clean}/terms` };
}
