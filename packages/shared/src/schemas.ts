import { z } from 'zod';
import { DEFAULT_TIMEZONE, INVITE_MAX_TTL_DAYS, INVITE_MIN_TTL_DAYS, SUPPORTED_LOCALES } from './constants.js';
import { INVITE_LABEL_MAX, INVITE_LINK_DEFAULT_TTL_DAYS, INVITE_LINK_TTL_DAYS, isInviteToken } from './inviteLinks.js';

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
   * Часть F (2026-10-16): код из письма. ПОЛЕ ОБЯЗАТЕЛЬНО, когда включено подтверждение, — и это
   * решает маршрут, а не схема: при `EMAIL_PROVIDER=none` его не существует, и прежний клиент
   * (и прежний тест) регистрирует аккаунт ровно тем же запросом, что раньше.
   */
  emailCode: z.string().trim().regex(/^\d{6}$/, 'emailCodeRequired').optional(),
  /**
   * Language (task 1): the register screen has a language switch too, and a choice made BEFORE
   * the account exists used to be thrown away — the INSERT took the column default instead.
   * Optional, so an older client still registers.
   */
  locale: z.enum(SUPPORTED_LOCALES).optional(),
});

/**
 * Часть F: запрос кода на подтверждение почты. Имя и фамилия здесь не для аккаунта (его ещё нет),
 * а для самого письма — человек должен получить «Здравствуйте, Алия», а не безликую машинную
 * строку. Поля те же и с той же length-политикой, что у регистрации, чтобы письмо и аккаунт не
 * разошлись в написании имени.
 */
export const emailCodeRequestSchema = z.object({
  firstName: z.string().trim().min(2, 'name2').max(80),
  lastName: z.string().trim().min(2, 'name2').max(80),
  email,
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
  // часть 4: показывать ученикам архив досок этого класса (по умолчанию — нет)
  boardArchivePublic: z.boolean().optional().default(false),
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
  /**
   * Language (task 1). Optional on purpose: a profile PATCH is also how the app stores the
   * device timezone and the name screen's family name, and those requests used to re-send the
   * locale from a snapshot taken before a concurrent write. Whichever PATCH landed last then
   * looked like "the person changed the language" — run 37974043289 turned the automatic timezone
   * sync into a forged English choice. Absent means "do not touch the language", present means
   * "this is a choice" (see routes/auth.ts, which still flags `locale_explicit` only on a change).
   */
  locale: z.enum(['ru', 'uz', 'en']).optional(),
  tz: z.string().min(1).max(64).default(DEFAULT_TIMEZONE),
});

export const memberAddSchema = z.object({ userId: z.string().uuid() });
export const memberMoveSchema = z.object({ toClassId: z.string().uuid() });

/* ─── одноразовые ссылки-приглашения (задача 2026-10-23, часть A) ─────────────────────── */

/**
 * Создание приглашения учителем. `ttlDays` — строго один из трёх вариантов постановки,
 * а не любое число: «срок» должен быть тем, что человек реально понял из подписи в форме.
 */
export const inviteLinkCreateSchema = z.object({
  label: z.string().trim().max(INVITE_LABEL_MAX).optional().default(''),
  ttlDays: z.number().int().refine((d) => (INVITE_LINK_TTL_DAYS as readonly number[]).includes(d))
    .optional().default(INVITE_LINK_DEFAULT_TTL_DAYS),
});

/** Тело запроса ученика: токен всегда в ТЕЛЕ, никогда в query или path (§3.1 пункта 5). */
const inviteTokenField = z.string().trim().refine(isInviteToken, 'inviteInvalid');

export const invitePreviewSchema = z.object({ token: inviteTokenField });

/**
 * Регистрация по приглашению — те же поля и та же политика пароля, что у регистрации по коду
 * (part B), и токен вместо кода класса: класс берётся из приглашения на сервере, а не из тела.
 * `emailCode` здесь сознательно НЕТ: подтверждение почты выключено, и просить его было бы
 * обещанием, которое продукт не выполняет.
 */
export const inviteRegisterSchema = z.object({
  token: inviteTokenField,
  firstName: z.string().trim().min(2, 'name2').max(80),
  lastName: z.string().trim().min(2, 'name2').max(80),
  email,
  password: passwordPolicy,
  locale: z.enum(SUPPORTED_LOCALES).optional(),
});

/** Вход в класс уже существующим аккаунтом: кроме токена ничего не приходит. */
export const inviteJoinSchema = z.object({ token: inviteTokenField });

/**
 * Сброс пароля ученика учителем (часть C). Поле СОЗНАТЕЛЬНО опционально: без него остаётся
 * прежнее поведение — сервер сам выдаёт временный пароль, и прежние тесты/клиенты этим путем
 * пользуются. С ним — пароль, который учитель набрал сам; он проходит ровно ту же
 * `passwordPolicy`, что и регистрация, то есть «12345678» не проходит и здесь.
 */
export const memberResetPasswordSchema = z.object({
  password: passwordPolicy.optional(),
});

export type RegisterByCodeInput = z.infer<typeof registerByCodeSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type JoinByCodeInput = z.infer<typeof joinByCodeSchema>;
export type ClassCreateInput = z.infer<typeof classCreateSchema>;
export type ClassUpdateInput = z.infer<typeof classUpdateSchema>;
export type InviteCreateInput = z.infer<typeof inviteCreateSchema>;
export type ProfileUpdateInput = z.infer<typeof profileUpdateSchema>;
