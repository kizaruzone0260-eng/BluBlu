/** Cryptographically safe alphabet: no 0/O, 1/I/L to avoid confusion when read aloud. */
export const INVITE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const INVITE_CODE_LENGTH = 8;
export const INVITE_DEFAULT_TTL_DAYS = 7;
export const INVITE_MIN_TTL_DAYS = 1;
export const INVITE_MAX_TTL_DAYS = 30;

/** Code entry: max 5 attempts per minute per account+IP, then block 15 minutes. */
export const CODE_ATTEMPTS_PER_MIN = 5;
export const CODE_BLOCK_MINUTES = 15;

export const ACCESS_TOKEN_TTL = '15m';
export const REFRESH_TOKEN_TTL_DAYS = 30;

export const MAX_FILE_MB = 100;
export const TEACHER_QUOTA_GB = 5;
export const MAX_CLASS_PARTICIPANTS_V1 = 25;

export const DEFAULT_TIMEZONE = 'Asia/Tashkent';
export const SUPPORTED_LOCALES = ['ru', 'uz', 'en'] as const;

export type Locale = (typeof SUPPORTED_LOCALES)[number];
export type UserRole = 'teacher' | 'student';
