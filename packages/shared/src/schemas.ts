import { z } from 'zod';
import { DEFAULT_TIMEZONE, INVITE_MAX_TTL_DAYS, INVITE_MIN_TTL_DAYS, SUPPORTED_LOCALES } from './constants.js';

const email = z.string().trim().toLowerCase().email().max(254);
const name = z.string().trim().min(2).max(100);

/**
 * Hardening (Phase 1д): common/breached passwords rejected at SET time. This is
 * a curated denylist of the most frequent weak passwords (case-insensitive),
 * NOT a full breach corpus — it stops the trivial "password"/"123456" class of
 * choices. Extended over time; deliberately excludes legitimate test phrases.
 */
const COMMON_PASSWORDS: ReadonlySet<string> = new Set([
  'password', 'password1', 'password12', 'password123', 'password1234', 'passw0rd', 'passworde',
  'qwerty', 'qwerty123', 'qwertyuiop', '123456', '1234567', '12345678', '123456789', '1234567890',
  'abc123', 'abcd1234', 'iloveyou', 'letmein', 'welcome', 'welcome1', 'admin', 'administrator',
  'monkey', 'dragon', 'football', 'baseball', 'sunshine', 'princess', 'login', 'password',
  'secret', 'secret123', 'trustno1', 'master', 'hello', 'freedom', 'whatever', 'qazwsx',
  '111111', '000000', '121212', '654321', '666666', '888888', 'asdasd', 'azerty', 'zuza',
]);

/** Password POLICY — applied when a password is CREATED (registration). */
export const passwordPolicy = z
  .string()
  .min(10, 'passwordTooShort')
  .max(128)
  .regex(/(?=.*[a-zА-Яа-я])(?=[^ ]+$)/, 'passwordTooSimple')
  .refine((v) => !COMMON_PASSWORDS.has(v.toLowerCase()), 'passwordTooCommon');

/** Login only checks the SHA against the stored hash — never re-applies the
 * policy, so accounts created under the earlier 8-char rule can still sign in. */
const loginPassword = z.string().min(1).max(128);

/**
 * Item 9 — registration step 2: given name + family name are separate,
 * both required. Step 1 (check-code) never reaches this schema.
 */
export const registerByCodeSchema = z.object({
  firstName: z.string().trim().min(2, 'name2').max(80),
  lastName: z.string().trim().min(2, 'name2').max(80),
  email,
  password: passwordPolicy,
  code: z.string().trim().toUpperCase(),
  /**
   * Language (task 1): the register screen has a language switch too, and a choice made BEFORE
   * the account exists used to be thrown away — the INSERT took the column default instead.
   * Optional, so an older client still registers.
   */
  locale: z.enum(SUPPORTED_LOCALES).optional(),
});

/** Item 9 — step 1 validation only; never consumes the code. */
export const checkCodeSchema = z.object({
  code: z.string().trim().min(4).max(12),
});

export const loginSchema = z.object({ email, password: loginPassword });

export const joinByCodeSchema = z.object({
  code: z.string().trim().toUpperCase(),
});

export const classCreateSchema = z.object({
  name: name.max(120),
  description: z.string().trim().max(2000).optional().default(''),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'invalidColor')
    .optional()
    .default('#4f46e5'),
  // bot task §3: publish this class schedule to the Telegram bot by name
  botPublicSchedule: z.boolean().optional().default(false),
});

export const classUpdateSchema = classCreateSchema.partial();

export const inviteCreateSchema = z.object({
  ttlDays: z
    .number()
    .int()
    .min(INVITE_MIN_TTL_DAYS)
    .max(INVITE_MAX_TTL_DAYS)
    .optional()
    .default(7),
});

export const profileUpdateSchema = z.object({
  name,
  /** item 9 — family name; optional so pre-existing accounts (empty) keep working */
  lastName: z.string().trim().max(80).optional(),
  locale: z.enum(['ru', 'uz', 'en']),
  tz: z.string().min(1).max(64).default(DEFAULT_TIMEZONE),
});

export const memberAddSchema = z.object({ userId: z.string().uuid() });
export const memberMoveSchema = z.object({ toClassId: z.string().uuid() });

export type RegisterByCodeInput = z.infer<typeof registerByCodeSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type JoinByCodeInput = z.infer<typeof joinByCodeSchema>;
export type ClassCreateInput = z.infer<typeof classCreateSchema>;
export type ClassUpdateInput = z.infer<typeof classUpdateSchema>;
export type InviteCreateInput = z.infer<typeof inviteCreateSchema>;
export type ProfileUpdateInput = z.infer<typeof profileUpdateSchema>;
