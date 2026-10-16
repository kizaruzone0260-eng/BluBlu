/**
 * Часть F (2026-10-16): правила подтверждения почты кодом из письма. ЧИСТЫЕ константы и
 * чистые функции — без БД, без провайдера, без React. Причина, по которой они живут здесь, а
 * не в `apps/api`: ровно эти числа и проверяют тесты, и их же обязан видеть человек, который
 * настраивает `EMAIL_PROVIDER`. Если срок кода разъедется с тем, что написано в письме,
 * человек будет спорить с сервером, которого не видит.
 *
 * Порядок, который эти числа описывают: код шесть цифр, живёт 15 минут, угадывается не более
 * пяти раз, повторно запрашивается не чаще раза в минуту, а осиротевшая строка (человек так и
 * не подтвердил почту) убирается фоновой уборкой через сутки.
 */

/** Длина кода: шесть цифр — столько влезает в SMS-поле и в поле формы на телефоне. */
export const EMAIL_CODE_LENGTH = 6;
/** Сколько живёт код с момента отправки. */
export const EMAIL_CODE_TTL_MS = 15 * 60_000;
/** Потолок попыток на один код: шестой неверный код не принимается, даже если верный. */
export const EMAIL_CODE_MAX_ATTEMPTS = 5;
/** Минимальный промежуток между двумя письмами на один адрес. */
export const EMAIL_RESEND_COOLDOWN_MS = 60_000;
/** Как долго хранить строку, которую так и не использовали (фоновая уборка). */
export const EMAIL_CODE_RETENTION_MS = 24 * 3600_000;

/** Только шесть цифр: пробелы и разделители допустимы на входе, но не в значении. */
export function normalizeEmailCode(raw: string | null | undefined): string {
  return (raw ?? '').replace(/[\s -]/g, '');
}

export function isSixDigitCode(code: string): boolean {
  return /^\d{6}$/.test(code);
}

/** Годен ли код СЕЙЧАС (до всякого сверения значения). */
export function codeIsLive(row: { usedAt: number | null; expiresAt: number }, now: number): boolean {
  return row.usedAt === null && row.expiresAt > now;
}

/**
 * Принять ли эту попытку: код исчерпал попытки, срок вышел или строка уже использована —
 * всё это ОДИН ответ наружу. Различия нужны логике, а не человеку по ту сторону запроса.
 */
export function consumeVerdict(
  row: { attempts: number; usedAt: number | null; expiresAt: number },
  now: number,
): 'live' | 'attempts' | 'expired' | 'used' {
  if (row.usedAt !== null) return 'used';
  if (row.expiresAt <= now) return 'expired';
  if (row.attempts >= EMAIL_CODE_MAX_ATTEMPTS) return 'attempts';
  return 'live';
}

/**
 * Можно ли слать следующее письмо. `lastSentAt` — время последней ОТПРАВЛЕННОЙ попытки
 * (не последней попытки угадать): отказ провайдера не должен наказывать человека паузой,
 * поэтому вызывающий передаёт null, когда письмо не ушло.
 */
export function resendGate(
  lastSentAt: number | null,
  now: number,
): { allowed: true } | { allowed: false; retryAfterSec: number } {
  if (lastSentAt === null) return { allowed: true };
  const left = lastSentAt + EMAIL_RESEND_COOLDOWN_MS - now;
  if (left <= 0) return { allowed: true };
  return { allowed: false, retryAfterSec: Math.ceil(left / 1000) };
}

/** Дата-край для письма: «код действителен до HH:MM» — минуты, не секунды. */
export function codeExpiresAtMs(sentAtMs: number): number {
  return sentAtMs + EMAIL_CODE_TTL_MS;
}

/**
 * Адрес для ОДНОЙ строки журнала: `ali********@school.uz`. Полный email в stdout — это персональные
 * данные в логе, а лог читают и переживают его копии; разработчику важно только понять, КУДА
 * письмо ушло. Локальная часть остаётся различимой первыми двумя символами.
 */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at <= 0) return '*'.repeat(Math.min(email.length, 10));
  const local = email.slice(0, at);
  const head = local.slice(0, 2);
  return `${head}${'*'.repeat(Math.max(1, local.length - head.length))}@${email.slice(at + 1)}`;
}
