import { eq, and, isNull, lt } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import type { Locale } from '@klass/shared';
import { users, classMembers, refreshTokens, loginAttempts } from '../db/schema.js';
import type { DB } from '../db/index.js';
import { env } from '../env.js';
import { hashPassword, verifyPassword } from '../lib/password.js';
import { isUniqueViolation } from '../lib/pgErrors.js';
import {
  signAccessToken, generateRefreshToken, generateFamilyId, hashRefreshToken,
} from '../lib/tokens.js';
import { redeemInviteLink, peekInviteLink, inviteStateCode } from './invites.js';
import { consumeEmailCode, precheckEmailCode } from './emailVerify.js';

/**
 * Ответ входа. `'invalidCode'` из списка ушёл 2026-10-27 вместе с приёмом в класс по коду:
 * расходиться больше нечему, а состояния токена приглашения — это отдельный
 * `InviteRegisterResult`.
 */
export type AuthResult =
  | { ok: true; accessToken: string; user: PublicUser }
  | { ok: false; error: 'invalidCredentials' | 'emailTaken' | 'emailCodeInvalid' };

export interface PublicUser {
  id: string;
  role: 'teacher' | 'student';
  name: string;
  /** item 9 — family name ('' for accounts created before the split). */
  lastName: string;
  email: string;
  locale: string;
  /** task 1: was this language ever chosen by the person, or is it the column default? */
  localeExplicit: boolean;
  tz: string;
  /** name screen (task 2): false → the «Имя и фамилия» gate must be shown. */
  profileCompleted: boolean;
  /** part 3: a temporary password was issued — force a change before use. */
  mustChangePassword: boolean;
}

function toPublic(u: typeof users.$inferSelect): PublicUser {
  return {
    id: u.id, role: u.role, name: u.name, lastName: u.lastName, email: u.email,
    locale: u.locale, tz: u.tz, profileCompleted: u.profileCompletedAt != null,
    localeExplicit: u.localeExplicit,
    mustChangePassword: u.mustChangePassword,
  };
}

/**
 * Two ways a student account comes into being, and both are ONE transaction (2026-10-27).
 *
 *  • `registerStudentByInviteLink` — человек пришёл по одноразовой ссылке, пароль выбирает сам;
 *    аккаунт + членство + расход токена (+ списание кода из письма, если подтверждение включено)
 *    — одним ходом, либо ничего;
 *  • `createStudentByTeacher` — аккаунт заводит учитель: пароль временный, поэтому
 *    `mustChangePassword` поднимается сразу, и расходывать здесь нечего.
 *
 * Оба наследуют один и тот же набор правил, выстраданный на регистрации по коду класса:
 * занятый адрес читается ЯВНО до записей (обычный случай не должен зависеть от формы ошибки),
 * а гонку двух одинаковых запросов решает уникальный индекс `users.email` — `isUniqueViolation`
 * ниже идёт по цепочке `cause`, потому что drizzle заворачивает ошибку драйвера в свою.
 *
 * Часть F (2026-10-16) про код из письма живёт там же, где и была: ПРОВЕРКА — до транзакции
 * (засчитанная попытка обязана пережить откат), СПИСАНИЕ — внутри (ошибка по классу или по адресу
 * не сжигает письмо, и человек пробует снова тем же кодом).
 */
class EmailCodeError extends Error {}
class EmailTakenError extends Error {}

/*
 * Task B (2026-10-23) — the reason a pupil saw «Something went wrong» on step 2.
 *
 * The unique index on `users.email` is the race guard for two registrations of one address, and
 * the code below used to read `err.code === '23505'` to turn it into `emailTaken`. Inside
 * `db.transaction` that never matches: drizzle-orm wraps whatever the driver threw in its own
 * `Failed query: …` error and the Postgres code lands on `err.cause.code` (proved by the
 * reproduction that became test/integration/auth-nat.test.ts — a second registration of a taken
 * address answered 500, not 409, and the screen had nothing better to say than the generic
 * sentence). The walk down the cause chain now lives in `lib/pgErrors.ts`, because the same check
 * guards the lesson-start race (SEC-11); the pre-read below remains the common path, the
 * constraint is the concurrent one.
 */

/**
 * Аккаунт ученика, который создаёт учитель (2026-10-27, «упростить приём в класс»).
 *
 * Что это заменяет и почему это НЕ вторая система авторизации. Прежний путь «учитель видит
 * занятую почту → ученик должен сначала сам создать аккаунт» упирался в тупик: у маленького
 * человека нет ни ссылки, ни терпения, а у учителя есть имя, фамилия и почта. Здесь тот же
 * `hashPassword`, та же `passwordPolicy` (её проверяет маршрут, до вызова), та же таблица, та же
 * колонка `must_change_password` и тот же серверный гейт в `plugins/auth.ts`. Никакого второго
 * хранения паролей и ни одной новой сессии: функция НЕ выдаёт токен — учитель не входит в систему
 * ЧУЖИМ аккаунтом, он только заводит этот аккаунт.
 *
 * Атомарность — одно обязательство целиком: либо аккаунт + членство, либо ничего. Откат по членству
 * (например, класс удалили в тот же миг) не оставляет «сироту» без класса, а отказ по занятой почте
 * не оставляет половину строк. Гонку двух одинаковых запросов решает уникальный индекс
 * `users.email` — тот же приём, что у регистрации по ссылке: обычный случай отвечает ЯВНОЕ чтение,
 * гонку — `isUniqueViolation`.
 *
 * `mustChangePassword: true` — суть, а не вежливость: пароль набрал и будет передавать другой
 * человек, и первый вход обязан закончиться его сменой. `profileCompletedAt` ставится сразу: имя и
 * фамилия уже известны, и показывать экран «Имя и фамилия» человеку, у которого их спросили,
 * бессмысленно. `locale` НЕ трогается: язык ещё никто не выбирал, и аккаунт честнее держать на
 * продуктовом default с `localeExplicit: false`, чем за учителя решать, на каком языке ребёнок
 * будет учиться.
 */
export type StudentCreateResult =
  | { ok: true; user: PublicUser }
  | { ok: false; error: 'emailTaken' };

export async function createStudentByTeacher(
  db: DB,
  classId: string,
  input: { firstName: string; lastName: string; email: string; password: string },
): Promise<StudentCreateResult> {
  const passwordHash = await hashPassword(input.password);
  try {
    const user = await db.transaction(async (tx) => {
      // `users.email` уникальна по ВСЕМ строкам, включая мягко удалённые, — поэтому проверка
      // так же игнорирует `deleted_at`, как и индекс. Удалённый аккаунт держит свой адрес:
      // создать новый на него нельзя, и сказать это надо «почта занята», а не 500.
      const takenBefore = await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, input.email))
        .limit(1);
      if (takenBefore.length > 0) throw new EmailTakenError();
      const [u] = await tx
        .insert(users)
        .values({
          role: 'student', name: input.firstName, lastName: input.lastName, email: input.email,
          passwordHash, mustChangePassword: true, profileCompletedAt: new Date(),
        })
        .returning();
      if (!u) throw new Error('student insert returned no row');
      await tx.insert(classMembers).values({ classId, userId: u.id });
      return u;
    });
    return { ok: true, user: toPublic(user) };
  } catch (err) {
    if (err instanceof EmailTakenError) return { ok: false, error: 'emailTaken' };
    // гонка: два запроса с одной почтой в один миг — второго останавливает индекс, и его код
    // может лежать в любом звене обёртки drizzle
    if (isUniqueViolation(err)) return { ok: false, error: 'emailTaken' };
    throw err;
  }
}

/**
 * Одноразовая ссылка-приглашение (2026-10-23, часть A): регистрация тем же атомарным ходом, что и
 * регистрация по коду класса. Отличие одно — вместо проверки восьмизначного кода расходуется
 * токен приглашения, и расход происходит ВНУТРИ той же транзакции.
 *
 * Почему это важно ровно так же, как с кодом: если бы токен списывался до вставки аккаунта,
 * любая ошибка (занятая почта, отвалившийся коннект) оставляла человека без приглашения, а
 * учитель получал бы «ссылка не работает» вместо второй попытки. Здесь либо аккаунт + членство +
 * израсходованное приглашение, либо ничего.
 *
 * 2026-10-27: сюда переехало подтверждение почты (`emailCode`), которое раньше умела только
 * регистрация по коду класса. Причина ровно одна: с выведенным кодом ссылка осталась единственным
 * публичным способом завести аккаунт, а включатель `EMAIL_PROVIDER` — свойство транспорта, а не
 * маршрута. Если бы требование кода осталось у умершего пути, почтовое подтверждение тихо
 * превратилось бы в украшение: письмо приходит, а спросить его не у чего. Порядок — как в старом
 * коде: ПРОВЕРКА до дорогой работы (засчитанная попытка обязана пережить откат и не обязана
 * оплачивать argon2), СПИСАНИЕ внутри транзакции (ошибка по классу или по адресу не сжигает
 * письмо, и человек пробует снова тем же кодом).
 */
export type InviteRegisterResult =
  | { ok: true; accessToken: string; user: PublicUser; classId: string; inviteId: string }
  | { ok: false; error: 'emailTaken' | 'invalidInput' | 'emailCodeInvalid' | 'inviteInvalid' | 'inviteExpired' | 'inviteRevoked' | 'inviteUsed' };

class InviteStateError extends Error {
  constructor(readonly state: 'inviteInvalid' | 'inviteExpired' | 'inviteRevoked' | 'inviteUsed' | 'invalidInput') { super(state); }
}

export async function registerStudentByInviteLink(
  db: DB,
  input: {
    token: string; firstName: string; lastName: string; email: string; password: string; locale?: Locale;
    /** код из письма; `undefined` = подтверждение почты выключено (EMAIL_PROVIDER=none) */
    emailCode?: string;
  },
): Promise<InviteRegisterResult> {
  /*
   * Дешёвая проверка токена ДО аргон2 (правка 2026-10-24). Хеширование пароля — это CPU-работа
   * на десятки миллисекунд с настроек, выбранных ради стойкости, и раньше её оплачивал КАЖДЫЙ
   * запрос, включая тот, где приглашение заведомо не существует: один скрипт с мусорными токенами
   * превращался в платный для сервера перебор. Проверка ниже — только чтение одной строки по
   * хешу, и она ничего не расходует.
   *
   * Это НЕ замена транзакционной проверки, а дешёвый фильтр перед дорогой работой: состояние
   * приглашения перепроверяется внутри транзакции (`peekInviteLink(tx, …)`), а расход остаётся
   * единственным атомарным `UPDATE … WHERE used_at IS NULL`. Гонка от этого не появляется: два
   * параллельных запроса, прошедшие фильтр, всё равно спорят на UPDATE, и проигравший откатывает
   * аккаунт и членство целиком.
   */
  const pre = await peekInviteLink(db, input.token);
  if (pre.state !== 'ok') return { ok: false, error: inviteStateCode(pre.state) };
  // Часть F: код из письма проверяется ДО аргон2 и до транзакции — попытка должна пережить
  // откат, а платная работа не должна оплачиваться опечаткой в шести цифрах.
  if (input.emailCode !== undefined
    && (await precheckEmailCode(db, input.email, input.emailCode)) !== 'live') {
    return { ok: false, error: 'emailCodeInvalid' };
  }
  const passwordHash = await hashPassword(input.password);
  try {
    const created = await db.transaction(async (tx) => {
      // Порядок внутри транзакции важен. Сначала — состояние токена: пока приглашение не
      // проверено, мы не имеем права сообщить НИЧЕГО про адрес (иначе постучать списком почт
      // можно было бы любым мусорным токеном). Расход же остаётся ПОСЛЕДНИМ шагом: промах
      // по адресу или по вставке откатывает всё, и ссылка не сгорает.
      const peek = await peekInviteLink(tx, input.token);
      if (peek.state !== 'ok') throw new InviteStateError(inviteStateCode(peek.state));
      // занятый адрес читается ЯВНО до любых записей, чтобы обычный случай не зависел от формы
      // ошибки уникального индекса (тот же приём, что у `createStudentByTeacher`)
      const taken = await tx.select({ id: users.id }).from(users).where(eq(users.email, input.email)).limit(1);
      if (taken.length > 0) throw new EmailTakenError();
      // списание письма — ВНУТРИ и до вставки: отказ по классу или по адресу откатывает его
      // обратно, и человек пробует снова ТЕМ ЖЕ кодом из того же письма
      if (input.emailCode !== undefined) {
        const spent = await consumeEmailCode(tx as unknown as DB, input.email, input.emailCode);
        if (!spent) throw new EmailCodeError();
      }
      const [u] = await tx.insert(users).values({
        role: 'student', name: input.firstName, lastName: input.lastName, email: input.email, passwordHash,
        profileCompletedAt: new Date(),
        ...(input.locale ? { locale: input.locale, localeExplicit: true } : {}),
      }).returning();
      if (!u) throw new InviteStateError('invalidInput');
      // расход — ПОСЛЕ вставки аккаунта и ТЕМ ЖЕ ходом: `UPDATE … WHERE used_at IS NULL` решает
      // и гонку двух запросов с одной ссылкой (один проходит, второй кидает InviteStateError и
      // вся транзакция, вместе с аккаунтом, откатывается), и «сбой не сжигает приглашение»
      const redeem = await redeemInviteLink(tx, input.token, u.id);
      if (!redeem.ok) throw new InviteStateError(inviteStateCode(redeem.state));
      await tx.insert(classMembers).values({ classId: redeem.classId, userId: u.id });
      return { user: u, classId: redeem.classId, inviteId: redeem.inviteId };
    });
    const accessToken = await signAccessToken({
      sub: created.user.id, role: created.user.role, locale: created.user.locale,
    });
    return { ok: true, accessToken, user: toPublic(created.user), classId: created.classId, inviteId: created.inviteId };
  } catch (err) {
    if (err instanceof EmailTakenError) return { ok: false, error: 'emailTaken' };
    // списание не состоялось (письмо уже израсходовано или истекло между проверкой и транзакцией)
    if (err instanceof EmailCodeError) return { ok: false, error: 'emailCodeInvalid' };
    if (err instanceof InviteStateError) {
      return err.state === 'invalidInput'
        ? { ok: false, error: 'invalidInput' }
        : { ok: false, error: err.state };
    }
    if (isUniqueViolation(err)) return { ok: false, error: 'emailTaken' };
    throw err;
  }
}

/**
 * Progressive, per-account brute-force lockout (Hardening part 2). Postgres-
 * backed so it survives restarts and applies across every client IP. The delay
 * grows exponentially after 5 consecutive failures (30 s, 60 s, …) and is
 * CAPPED at 15 minutes, so no account — owner or teacher included — is ever
 * locked out permanently. `email` arrives normalized (the login schema
 * lowercases/trims it).
 */
const LOCK_THRESHOLD = 5;
const LOCK_BASE_MS = 30_000;
const LOCK_MAX_MS = 900_000; // 15 minutes

async function lockState(db: DB, email: string): Promise<{ locked: boolean }> {
  const [row] = await db.select().from(loginAttempts).where(eq(loginAttempts.email, email)).limit(1);
  if (row?.lockedUntil && row.lockedUntil.getTime() > Date.now()) return { locked: true };
  return { locked: false };
}

async function recordFailure(db: DB, email: string): Promise<void> {
  const [row] = await db.select().from(loginAttempts).where(eq(loginAttempts.email, email)).limit(1);
  const failCount = (row?.failCount ?? 0) + 1;
  const lockedUntil = failCount >= LOCK_THRESHOLD
    ? new Date(Date.now() + Math.min(LOCK_BASE_MS * 2 ** (failCount - LOCK_THRESHOLD), LOCK_MAX_MS))
    : null;
  await db.insert(loginAttempts)
    .values({ email, failCount, lockedUntil, updatedAt: new Date() })
    .onConflictDoUpdate({ target: loginAttempts.email, set: { failCount, lockedUntil, updatedAt: new Date() } });
}

/**
 * Одна задержка на «нет такого аккаунта» и «не тот пароль» — и на смене пароля тоже.
 *
 * SEC-14 (аудит 2026-10-28): раньше здесь лежал литерал с параметрами `m=19456,t=2,p=1`, а
 * настоящие хеши считаются с параметрами из env. `argon2.verify` читает параметры ИЗ СТРОКИ
 * хеша, поэтому после перенастройки (`ARGON2_MEMORY_COST` выше, например) промах по аккаунту
 * отвечал бы быстрее настоящей проверки — ровно тот признак, который маскировка обязана
 * скрывать. Теперь фиктивный хеш считается тем же `hashPassword` (те же env-параметры), один
 * раз и лениво: значение не секрет, но и не константа, чтобы «пустой» пароль нельзя было
 * подобрать к нему.
 */
let dummyHash: Promise<string> | null = null;

export function dummyPasswordHash(): Promise<string> {
  if (!dummyHash) {
    dummyHash = hashPassword(randomBytes(32).toString('base64url')).catch((e) => {
      dummyHash = null; // следующий вызов попробует снова, а не запомнит отказ навсегда
      throw e;
    });
  }
  return dummyHash;
}

/**
 * B2 (2026-10-16): строка счётчика, у которой нет активной блокировки и которая не
 * обновлялась сутки, ничего не защищает — она просто копит email'ы. Удаляется фоновой
 * уборкой. Строки с наступившей блокировкой не трогаются намеренно: `failCount` у них и есть
 * память о том, что окно следующего перебора должно быть длиннее.
 */
export const LOGIN_ATTEMPT_TTL_MS = 24 * 3600_000;

export async function sweepLoginAttempts(db: DB, now = new Date(), maxAgeMs = LOGIN_ATTEMPT_TTL_MS): Promise<number> {
  const rows = await db.delete(loginAttempts).where(and(
    isNull(loginAttempts.lockedUntil),
    lt(loginAttempts.updatedAt, new Date(now.getTime() - maxAgeMs)),
  )).returning({ email: loginAttempts.email });
  return rows.length;
}

/**
 * SEC-13 (аудит 2026-10-28): строки `refresh_tokens` не убирались по истечении — таблица
 * росла каждым входом навсегда. Удаляются только ПРОСРОЧЕННЫЕ строки: заменённая, но ещё не
 * истёкшая строка нужна ротации (окно grace) и обнаружению повторного использования семейства,
 * поэтому её трогать нельзя — иначе «уборка» ослабила бы защиту.
 */
export async function sweepRefreshTokens(db: DB, now = new Date()): Promise<number> {
  const rows = await db.delete(refreshTokens)
    .where(lt(refreshTokens.expiresAt, now))
    .returning({ id: refreshTokens.id });
  return rows.length;
}

export async function login(db: DB, email: string, password: string): Promise<AuthResult> {
  // Locked out? Record the attempt anyway (so continued hammering GROWS the
  // window, up to the cap) but return the SAME generic failure as a bad
  // password — the response never reveals whether the account exists or is
  // merely throttled. A dummy verify keeps the timing uniform.
  if ((await lockState(db, email)).locked) {
    await verifyPassword(await dummyPasswordHash(), password);
    await recordFailure(db, email);
    return { ok: false, error: 'invalidCredentials' };
  }
  const [user] = await db.select().from(users)
    .where(and(eq(users.email, email), isNull(users.deletedAt)))
    .limit(1);
  if (!user) {
    await verifyPassword(await dummyPasswordHash(), password); // constant-ish time on missing user
    await recordFailure(db, email);
    return { ok: false, error: 'invalidCredentials' };
  }
  if (!(await verifyPassword(user.passwordHash, password))) {
    await recordFailure(db, email);
    return { ok: false, error: 'invalidCredentials' };
  }
  // success clears the counter for this account
  await db.delete(loginAttempts).where(eq(loginAttempts.email, email));
  const accessToken = await signAccessToken({ sub: user.id, role: user.role, locale: user.locale });
  return { ok: true, accessToken, user: toPublic(user) };
}

export interface SessionPair {
  refreshToken: string;
  expiresAt: Date;
}

export async function issueRefreshSession(db: DB, userId: string, familyId?: string): Promise<SessionPair> {
  const token = generateRefreshToken();
  const expiresAt = new Date(Date.now() + env.REFRESH_TTL_DAYS * 86_400_000);
  await db.insert(refreshTokens).values({
    userId,
    tokenHash: hashRefreshToken(token),
    familyId: familyId ?? generateFamilyId(),
    expiresAt,
  });
  return { refreshToken: token, expiresAt };
}

export type RefreshResult =
  | { ok: true; userId: string; newRefresh: SessionPair }
  | { ok: false; reason: 'invalid' | 'expired' | 'reused' };

/**
 * Rotation: old token is marked replaced; presenting a replaced token kills the
 * whole family — UNLESS within REFRESH_REUSE_GRACE_MS of the rotation AND the
 * family still has its active successor untouched. That grace covers the benign
 * case: the browser aborted the rotation response (instant reload) and replays
 * the stale token; a real thief replay gets a fresh session ≤5 s old, while any
 * later replay still triggers the family kill.
 */
export async function rotateRefresh(db: DB, token: string): Promise<RefreshResult> {
  const hash = hashRefreshToken(token);
  const [row] = await db.select().from(refreshTokens).where(eq(refreshTokens.tokenHash, hash)).limit(1);
  if (!row) return { ok: false, reason: 'invalid' };
  if (row.replacedAt) {
    const withinGrace = Date.now() - row.replacedAt.getTime() <= env.REFRESH_REUSE_GRACE_MS;
    if (withinGrace) {
      const [successor] = await db.select({ id: refreshTokens.id }).from(refreshTokens)
        .where(and(eq(refreshTokens.familyId, row.familyId), isNull(refreshTokens.replacedAt)))
        .limit(1);
      if (successor) {
        await db.update(refreshTokens).set({ replacedAt: new Date() })
          .where(and(eq(refreshTokens.id, successor.id), isNull(refreshTokens.replacedAt)));
        const fresh = await issueRefreshSession(db, row.userId, row.familyId);
        return { ok: true, userId: row.userId, newRefresh: fresh };
      }
    }
    await db.delete(refreshTokens).where(eq(refreshTokens.familyId, row.familyId));
    return { ok: false, reason: 'reused' };
  }
  if (row.expiresAt.getTime() <= Date.now()) return { ok: false, reason: 'expired' };
  const updated = await db
    .update(refreshTokens)
    .set({ replacedAt: new Date() })
    .where(and(eq(refreshTokens.id, row.id), isNull(refreshTokens.replacedAt)))
    .returning({ id: refreshTokens.id });
  if (updated.length === 0) {
    // concurrent double-use: treat as reuse
    await db.delete(refreshTokens).where(eq(refreshTokens.familyId, row.familyId));
    return { ok: false, reason: 'reused' };
  }
  const newRefresh = await issueRefreshSession(db, row.userId, row.familyId);
  return { ok: true, userId: row.userId, newRefresh };
}

export async function logout(db: DB, token: string): Promise<void> {
  await db.delete(refreshTokens).where(eq(refreshTokens.tokenHash, hashRefreshToken(token)));
}

/**
 * Временный пароль ученика (задание учителя из списка класса).
 *
 * Три вещи происходят обязательно, и вторая из них — причина, по которой сброс раньше «не
 * работал»:
 *  1) новый хеш + `must_change_password = true` (серверный гейт в `plugins/auth.ts` не пустит
 *     дальше смены пароля);
 *  2) снятие существующих refresh-сессий;
 *  3) снятие строки `login_attempts`.
 *
 * Пункт 3 — это и есть исправление (задача 2026-10-23, часть C). Ученик, которого не пускает в
 * аккаунт, и есть тот, кому ставят новый пароль: к этому моменту он уже успел пять раз ошибиться,
 * а `login()` под блокировкой пароль даже не проверяет. Пока строка счётчика висела, учитель
 * менял пароль, ученик вводил новый и получал тот же 401 — до 15 минут, и каждая попытка окно
 * удлиняла. Сброс пароля access возвращает сразу.
 *
 * Анти-перебор это не ослабляет: снимается ровно строка того аккаунта, чей пароль только что
 * поменял учитель с правами на этот класс. Дальше счётчик начинается с нуля — как после любого
 * законного входа.
 */
export async function setTempPassword(db: DB, userId: string, newPassword: string): Promise<void> {
  const [who] = await db.select({ email: users.email }).from(users).where(eq(users.id, userId)).limit(1);
  await db.update(users)
    .set({ passwordHash: await hashPassword(newPassword), mustChangePassword: true })
    .where(eq(users.id, userId));
  await db.delete(refreshTokens).where(eq(refreshTokens.userId, userId));
  if (who?.email) await db.delete(loginAttempts).where(eq(loginAttempts.email, who.email));
}

/** Revoke every refresh session for a user (logout-all / on password change). */
export async function revokeAllSessions(db: DB, userId: string): Promise<void> {
  await db.delete(refreshTokens).where(eq(refreshTokens.userId, userId));
}

/**
 * Part 3: change one's own password. Verifies the current password, applies the
 * registration policy to the new one, clears the must-change flag, and revokes
 * ALL other refresh sessions (the caller re-issues a fresh session for the
 * current device so the user is not kicked out where they just acted).
 * Returns false when the current password is wrong or the new one is invalid.
 */
export async function changePassword(
  db: DB, userId: string, current: string, next: string,
): Promise<{ ok: true } | { ok: false; reason: 'wrongCurrent' | 'weak' }> {
  const [u] = await db.select().from(users)
    .where(and(eq(users.id, userId), isNull(users.deletedAt))).limit(1);
  if (!u) return { ok: false, reason: 'wrongCurrent' };
  /*
   * B1 (2026-10-16): смена пароля — это тоже проверка текущего, и раньше она ничего
   * не стоила: счётчик перебора стоял только на входе. Модель можно было подбирать здесь
   * сколько угодно, обходя локаут, который держит `/api/auth/login`. Теперь тот же счётчик
   * (ключ — нормализованный email аккаунта), та же задержка и тот же ответ: «wrongCurrent»
   * не различает «не угадал» и «заблокирован на N минут», а успех сбрасывает счётчик.
   */
  if ((await lockState(db, u.email)).locked) {
    await verifyPassword(await dummyPasswordHash(), current); // ровный тайминг и под блокировкой
    await recordFailure(db, u.email);          // продолжение стука растит окно (до потолка)
    return { ok: false, reason: 'wrongCurrent' };
  }
  if (!(await verifyPassword(u.passwordHash, current))) {
    await recordFailure(db, u.email);
    return { ok: false, reason: 'wrongCurrent' };
  }
  // same policy as registration (≥10, two character classes, no spaces, not a common password)
  const { passwordPolicy } = await import('@klass/shared');
  if (!passwordPolicy.safeParse(next).success) return { ok: false, reason: 'weak' };
  await db.update(users)
    .set({ passwordHash: await hashPassword(next), mustChangePassword: false })
    .where(eq(users.id, userId));
  // успех сбрасывает счётчик — как вход, иначе одна опечатка помнит аккаунту сутки
  await db.delete(loginAttempts).where(eq(loginAttempts.email, u.email));
  await revokeAllSessions(db, userId);
  return { ok: true };
}

export function signAccessTokenForUser(u: typeof users.$inferSelect): Promise<string> {
  return signAccessToken({ sub: u.id, role: u.role, locale: u.locale });
}
