/**
 * Часть F (2026-10-16): код подтверждения почты — запрос, атомарное списание, уборка.
 *
 * Три правила, ради которых написан именно этот файл:
 *
 *  1. **Ответ не раскрывает существование почты.** `requestEmailCode` возвращает `sent:false`
 *     когда адрес уже занят, а маршрут на это отвечает РОВНО тем же, что и при отправке:
 *     получатель ответа не видит разницы, потому что письмо он не держит в руках. Молча не
 *     отправлять — правильная половина: отправлять «на этот адрес кто-то пытался
 *     зарегистрироваться» значит слать существующему пользователю пугалку на каждый запрос,
 *     включая чужую шалость.
 *  2. **Сбой провайдера не списывает код.** Строка в БД пишется ПОСЛЕ того, как провайдер принял
 *     письмо. Не принял — прежний живой код остаётся живым, человек может попробовать сразу,
 *     и никакой паузы за чужую ошибку он не получает.
 *  3. **Списание атомарно.** `UPDATE … WHERE used_at IS NULL AND expires_at > now() RETURNING`
 *     одним утверждением: два параллельных подтверждения одного кода не могут пройти оба. И
 *     списание происходит ВНУТРИ транзакции регистрации — не создался аккаунт (не тот код
 *     класса, email уже занят) → транзакция откатывается вместе со списанием, и код не сожжён.
 */
import { createHash, randomInt } from 'node:crypto';
import { eq, lt, sql } from 'drizzle-orm';
import {
  DEFAULT_LOCALE, EMAIL_CODE_LENGTH, EMAIL_CODE_MAX_ATTEMPTS, EMAIL_CODE_RETENTION_MS,
  buildVerificationEmail, codeExpiresAtMs, consumeVerdict, resendGate, type Locale,
} from '@klass/shared';
import { emailVerifications, users } from '../db/schema.js';
import type { DB } from '../db/index.js';
import { env } from '../env.js';
import type { EmailTransport } from './email.js';
import { safeErrorMessage } from '../lib/redact.js';

/**
 * Хэш кода: соль из `JWT_SECRET` + адрес + сам код — та же форма, что у `lib/invite.ts`.
 * Адрес внутри хэша нужен, чтобы один и тот же код у двух людей не оставлял в базе одинаковую
 * метку: по совпадению хэша нельзя узнать, что код у кого-то такой же.
 */
export function hashEmailCode(code: string, email: string, salt: string = env.JWT_SECRET): string {
  return createHash('sha256').update(`${salt}.${email}.${code}`).digest('hex');
}

/** Равномерно из 10^6, включая ведущие нули: «000123» — законный код, а не ошибка форматтера. */
export function generateEmailCode(): string {
  return String(randomInt(0, 10 ** EMAIL_CODE_LENGTH)).padStart(EMAIL_CODE_LENGTH, '0');
}

export type CodeRequestResult =
  /** письмо отправлено, строка кода живёт до `expiresAt` */
  | { ok: true; sent: true }
  /** адрес уже занят: письма нет, ответ наружу — тот же, что при sent (см. правило 1) */
  | { ok: true; sent: false }
  /** слишком рано: межписьменная пауза ещё не прошла */
  | { ok: false; error: 'cooldown'; retryAfterSec: number }
  /** провайдер отказал: БД не тронута, прежний код (если был) остался живым; `reason` — для лога */
  | { ok: false; error: 'provider'; reason: string };

/**
 * Запрос кода. `email` обязан прийти нормализованным (schema lowercases/trim'ит) — по этому же
 * значению потом ищется строка, и любое расхождение в регистре означало бы «кода нет».
 */
export async function requestEmailCode(args: {
  db: DB;
  transport: EmailTransport;
  email: string;
  firstName: string;
  lastName: string;
  locale?: string;
  now?: Date;
}): Promise<CodeRequestResult> {
  const now = args.now ?? new Date();
  const [existing] = await args.db.select({ expiresAt: emailVerifications.expiresAt, sentAt: emailVerifications.sentAt, usedAt: emailVerifications.usedAt })
    .from(emailVerifications).where(eq(emailVerifications.email, args.email)).limit(1);
  const gate = resendGate(
    // Пауза отсчитывается от последней ОТПРАВКИ живого кода; использованный или истёкший не держит
    existing && existing.usedAt === null && existing.expiresAt > now ? existing.sentAt.getTime() : null,
    now.getTime(),
  );
  if (!gate.allowed) return { ok: false, error: 'cooldown', retryAfterSec: gate.retryAfterSec };

  const [account] = await args.db.select({ id: users.id }).from(users)
    .where(eq(users.email, args.email)).limit(1);
  if (account) return { ok: true, sent: false };

  const code = generateEmailCode();
  const copy = buildVerificationEmail({
    locale: args.locale, firstName: args.firstName, lastName: args.lastName, code,
  });
  try {
    await args.transport.send({
      to: args.email,
      toName: [args.firstName, args.lastName].filter(Boolean).join(' ') || undefined,
      subject: copy.subject,
      text: copy.text,
      html: copy.html,
      // только `console` это и печатает; живой провайдер поле игнорирует
      consoleLine: `${code} (${(args.locale as Locale) ?? DEFAULT_LOCALE})`,
    });
  } catch (e) {
    // причина остаётся ВЫМЫТОЙ: в тексте сетевой ошибки живёт и URL провайдера с ключом в
    // заголовке, и часть письма. Наружу уходит одно слово, в лог — `safeErrorMessage`.
    return { ok: false, error: 'provider', reason: safeErrorMessage(e) };
  }

  const expiresAt = new Date(codeExpiresAtMs(now.getTime()));
  await args.db.insert(emailVerifications)
    .values({ email: args.email, codeHash: hashEmailCode(code, args.email), attempts: 0, sentAt: now, expiresAt })
    .onConflictDoUpdate({
      target: emailVerifications.email,
      set: { codeHash: hashEmailCode(code, args.email), attempts: 0, sentAt: now, expiresAt, usedAt: null },
    });
  return { ok: true, sent: true };
}

/**
 * Проверка ПЕРЕД транзакцией: код тот же, что запрашивался, и попытки ещё есть. Возвращает `live`,
 * только чтобы транзакция регистрации имела право списывать код; на отказ по НЕВЕРНОМУ коду
 * попытка засчитывается ЗДЕСЬ И НАВСЕГДА.
 *
 * Почему это отдельный шаг, а не «считать внутри транзакции»: транзакция регистрации откатывается
 * целиком (не тот код класса, занятый email), и записанная в ней попытка уехала бы вместе с её
 * откатом. Тогда потолок из пяти попыток был бы фиктивным — переборщик угадывал бы код
 * бесконечно, каждый раз откатывая собственный счётчик. Именно это и поймал тест «попытка
 * засчитана»: 0 вместо 1.
 */
export async function precheckEmailCode(
  db: DB,
  email: string,
  code: string,
  now: Date = new Date(),
): Promise<'live' | 'invalid'> {
  const [row] = await db.select({
    attempts: emailVerifications.attempts,
    codeHash: emailVerifications.codeHash,
    usedAt: emailVerifications.usedAt,
    expiresAt: emailVerifications.expiresAt,
  }).from(emailVerifications).where(eq(emailVerifications.email, email)).limit(1);
  if (!row) return 'invalid';
  const verdict = consumeVerdict(
    { attempts: row.attempts, usedAt: row.usedAt?.getTime() ?? null, expiresAt: row.expiresAt.getTime() },
    now.getTime(),
  );
  // мёртвый код (истёк, списан, исчерпан попытками) не за что добивать: он уже ничего не стоит
  if (verdict !== 'live') return 'invalid';
  if (row.codeHash === hashEmailCode(code, email)) return 'live';
  await bumpAttempt(db, email, now);
  return 'invalid';
}

/** Одна засчитанная попытка — отдельным, НЕ откатываемым ходом (см. `precheckEmailCode`). */
async function bumpAttempt(db: DB, email: string, now: Date): Promise<void> {
  await db.execute(sql`
    UPDATE email_verifications
       SET attempts = attempts + 1
     WHERE email = ${email}
       AND used_at IS NULL
       AND expires_at > ${now.toISOString()}
       AND attempts < ${EMAIL_CODE_MAX_ATTEMPTS}`);
}

/**
 * Списать код. Возвращает `true` только если этот вызов ЗАБРАЛ код: строка помечена
 * использованной одним `UPDATE … RETURNING`, поэтому второй параллельный прогон того же кода
 * увидит 0 строк. Вызывается ВНУТРИ транзакции регистрации.
 *
 * `attempts < потолок` — часть того же утверждения: код, исчерпавший попытки, мёртв, и верное
 * значение его уже не оживляет (иначе «пять попыток» оказались бы пятью подсказками).
 */
export async function consumeEmailCode(
  tx: DB,
  email: string,
  code: string,
  now: Date = new Date(),
): Promise<boolean> {
  const hash = hashEmailCode(code, email);
  /*
   * В сыром `execute` параметр уходит как есть, а postgres.js не сериализует `Date` в текстовый
   * slot — поэтому дата передаётся ISO-строкой, а `used_at` ставится серверным `now()`: часы БД
   * и есть часы, с которыми сравнивается `expires_at`.
   */
  const at = now.toISOString();
  const claimed = await tx.execute(sql`
    UPDATE email_verifications
       SET used_at = now()
     WHERE email = ${email}
       AND code_hash = ${hash}
       AND used_at IS NULL
       AND attempts < ${EMAIL_CODE_MAX_ATTEMPTS}
       AND expires_at > ${at}
     RETURNING email`);
  const rows = (Array.isArray(claimed) ? claimed : (claimed as { rows?: unknown[] }).rows ?? []) as { email: string }[];
  return rows.length > 0;
}

/**
 * Уборка: строки, чей код давно истёк и так и не был использован. Сутки после истечения — это
 * запас на «человек подтверждал на минуту позже», дальше запись не нужна: почта не отправлена,
 * аккаунта нет, хранить адрес заявителя бессмысленно и вредно.
 */
export async function sweepEmailVerifications(db: DB, now = new Date(), maxAgeMs = EMAIL_CODE_RETENTION_MS): Promise<number> {
  const dead = new Date(now.getTime() - maxAgeMs);
  const rows = await db.delete(emailVerifications).where(lt(emailVerifications.expiresAt, dead)).returning({ email: emailVerifications.email });
  return rows.length;
}
