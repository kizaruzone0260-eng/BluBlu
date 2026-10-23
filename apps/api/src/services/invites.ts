import { sql, eq, and, isNull, gt, desc } from 'drizzle-orm';
import { inviteCodes, classes, users, classMembers } from '../db/schema.js';
import type { DB, Tx } from '../db/index.js';
import { env } from '../env.js';
import { generateInviteCode, hashInviteCode } from '../lib/invite.js';
import { generateInviteToken, hashInviteToken } from '../lib/inviteLink.js';
import { randomUUID } from 'node:crypto';

export interface RedeemResult {
  ok: boolean;
  classId?: string;
}

export async function createInviteCode(
  db: DB,
  classId: string,
  createdBy: string,
  ttlDays: number,
): Promise<{ id: string; code: string; expiresAt: Date }> {
  const code = generateInviteCode();
  const id = randomUUID();
  const expiresAt = new Date(Date.now() + ttlDays * 86_400_000);
  await db.insert(inviteCodes).values({
    id,
    classId,
    codeHash: hashInviteCode(code, env.JWT_SECRET),
    createdBy,
    expiresAt,
  });
  return { id, code, expiresAt };
}

/**
 * Atomic single-statement redemption (acceptance criterion of stage 1):
 * two concurrent requests can never consume the same code, because the row
 * is locked by the UPDATE itself and only an unused, unrevoked, unexpired row matches.
 */
/**
 * Item 9 step 1 — verify WITHOUT consuming: active, unredeemed, unexpired, unrevoked.
 * The caller must answer with ONE generic error for every failing state, so an
 * attacker cannot tell a wrong code from a used or expired one.
 */
export async function peekInviteCode(db: DB, plainCode: string): Promise<boolean> {
  const hash = hashInviteCode(plainCode, env.JWT_SECRET);
  const [row] = await db
    .select({ id: inviteCodes.id })
    .from(inviteCodes)
    .where(and(
      eq(inviteCodes.codeHash, hash),
      // «code» — чтобы ссылка-приглашение никогда не могла притвориться кодом класса, даже если
      // когда-нибудь чья-то хеш-функция совпадёт (сейчас их разделяет доменный префикс).
      eq(inviteCodes.kind, 'code'),
      isNull(inviteCodes.usedAt),
      isNull(inviteCodes.revokedAt),
      gt(inviteCodes.expiresAt, new Date()),
    ))
    .limit(1);
  return Boolean(row);
}

export async function redeemInviteCode(db: DB, plainCode: string, userId: string): Promise<RedeemResult> {
  const hash = hashInviteCode(plainCode, env.JWT_SECRET);
  const res = await db.execute(sql`
    UPDATE invite_codes
       SET used_by = ${userId}, used_at = now()
     WHERE code_hash = ${hash}
       AND kind = 'code'
       AND used_at IS NULL
       AND revoked_at IS NULL
       AND expires_at > now()
    RETURNING class_id`);
  const rows = (Array.isArray(res) ? res : (res as { rows?: unknown[] }).rows ?? []) as { class_id: string }[];
  const row = rows[0];
  if (!row) return { ok: false };
  return { ok: true, classId: row.class_id };
}

export type InviteStatus = 'active' | 'used' | 'expired' | 'revoked';

export async function listInviteCodes(db: DB, classId: string) {
  const rows = await db
    .select({
      id: inviteCodes.id,
      createdAt: inviteCodes.createdAt,
      expiresAt: inviteCodes.expiresAt,
      usedAt: inviteCodes.usedAt,
      revokedAt: inviteCodes.revokedAt,
      usedByName: sql<string | null>`(select name from users where users.id = invite_codes.used_by)`,
    })
    .from(inviteCodes)
    .where(and(eq(inviteCodes.classId, classId), eq(inviteCodes.kind, 'code')))
    .orderBy(desc(inviteCodes.createdAt));
  const now = Date.now();
  return rows.map((r) => ({
    ...r,
    status: (r.revokedAt ? 'revoked' : r.usedAt ? 'used' : r.expiresAt.getTime() <= now ? 'expired' : 'active') as InviteStatus,
  }));
}

/** Only the ACTIVE code of a class may be revoked. Returns true if it was active. */
export async function revokeInviteCode(db: DB, id: string, classId: string): Promise<boolean> {
  const res = await db
    .update(inviteCodes)
    .set({ revokedAt: new Date() })
    .where(and(
      eq(inviteCodes.id, id),
      eq(inviteCodes.classId, classId),
      eq(inviteCodes.kind, 'code'),
      isNull(inviteCodes.usedAt),
      isNull(inviteCodes.revokedAt),
      gt(inviteCodes.expiresAt, new Date()),
    ))
    .returning({ id: inviteCodes.id });
  return res.length > 0;
}

/** Активный КОД класса (ссылки-приглашения здесь не учитываются — у них свой список). */
export async function getActiveInviteForClass(db: DB, classId: string) {
  const [row] = await db
    .select({ id: inviteCodes.id, expiresAt: inviteCodes.expiresAt })
    .from(inviteCodes)
    .where(and(
      eq(inviteCodes.classId, classId),
      eq(inviteCodes.kind, 'code'),
      isNull(inviteCodes.usedAt),
      isNull(inviteCodes.revokedAt),
      gt(inviteCodes.expiresAt, new Date()),
    ))
    .limit(1);
  return row ?? null;
}

export async function classExists(db: DB, classId: string) {
  const [c] = await db.select({ id: classes.id }).from(classes).where(eq(classes.id, classId)).limit(1);
  return Boolean(c);
}

/* ─── одноразовые ссылки-приглашения (2026-10-23, часть A) ─────────────────────────────── */

/**
 * Создать приглашение-ссылку. Возвращает ПЛАЙН токена ровно один раз — больше его никто не
 * увидит: в базе лежит только `hashInviteToken` (та же ветка pepper, что у кодов, но с префиксом
 * `link.`, поэтому код класса и токен ссылки физически не могут дать один хеш).
 */
export async function createInviteLink(
  db: DB, classId: string, createdBy: string, opts: { label: string; ttlDays: number },
): Promise<{ id: string; token: string; expiresAt: Date }> {
  const token = generateInviteToken();
  const id = randomUUID();
  const expiresAt = new Date(Date.now() + opts.ttlDays * 86_400_000);
  await db.insert(inviteCodes).values({
    id, classId, codeHash: hashInviteToken(token, env.JWT_SECRET), createdBy, expiresAt,
    kind: 'link', label: opts.label,
  });
  return { id, token, expiresAt };
}

/**
 * Состояние токена. Здесь СОЗНАТЕЛЬНО четыре разных ответа (просрочен / отозван / использован /
 * неверен), а не один «неверный», как у восьмизначного кода: код класса перебирают, и
 * различать его состояния нельзя, а токен — 24 случайных байта, угадать его нельзя в принципе,
 * зато ученику бесполезно сообщать «ссылка не подходит», когда надо сказать «попросите новую».
 */
export type InviteTokenState = 'ok' | 'invalid' | 'expired' | 'revoked' | 'used';

/** Плохое состояние токена — то, что превращается в код ответа. `ok` сюда не входит намеренно. */
export type InviteTokenFailure = Exclude<InviteTokenState, 'ok'>;

/**
 * Состояние → код интерфейса (и ключ локали). Одна функция, а не карта в каждом маршруте:
 * код, которого нет в `authErrors.ts` и в трёх локалях, — это мёртвая ветка на экране ученика,
 * и появляется такая ветка ровно тогда, когда маппинг написан дважды.
 */
export function inviteStateCode(state: InviteTokenFailure):
  'inviteInvalid' | 'inviteExpired' | 'inviteRevoked' | 'inviteUsed' {
  return state === 'invalid' ? 'inviteInvalid'
    : state === 'expired' ? 'inviteExpired'
    : state === 'revoked' ? 'inviteRevoked' : 'inviteUsed';
}

export interface InvitePeek {
  state: InviteTokenState;
  classId?: string;
  className?: string;
  expiresAt?: Date;
}

export async function peekInviteLink(db: DB | Tx, token: string): Promise<InvitePeek> {
  const [row] = await db
    .select({
      id: inviteCodes.id, classId: inviteCodes.classId, expiresAt: inviteCodes.expiresAt,
      usedAt: inviteCodes.usedAt, revokedAt: inviteCodes.revokedAt, className: classes.name,
    })
    .from(inviteCodes)
    .innerJoin(classes, eq(classes.id, inviteCodes.classId))
    .where(and(eq(inviteCodes.codeHash, hashInviteToken(token, env.JWT_SECRET)), eq(inviteCodes.kind, 'link')))
    .limit(1);
  if (!row) return { state: 'invalid' };
  if (row.usedAt) return { state: 'used' };
  if (row.revokedAt) return { state: 'revoked' };
  if (row.expiresAt.getTime() <= Date.now()) return { state: 'expired' };
  return { state: 'ok', classId: row.classId, className: row.className, expiresAt: row.expiresAt };
}

/**
 * Расход токена. Одна команда `UPDATE … WHERE использован IS NULL AND отозван IS NULL AND срок не
 * вышел RETURNING` — ровно как у кодов: два параллельных запроса с одной ссылкой не создают двух
 * учеников, потому что строку блокирует сам UPDATE, и второй раз те же условия уже не проходят.
 * `tx` принимается для того, чтобы регистрация отдала членство в классе ТЕМ ЖЕ ходом.
 */
export async function redeemInviteLink(
  db: DB | Tx, token: string, userId: string,
): Promise<{ ok: true; classId: string; inviteId: string } | { ok: false; state: InviteTokenFailure }> {
  const hash = hashInviteToken(token, env.JWT_SECRET);
  const res = await db.execute(sql`
    UPDATE invite_codes
       SET used_by = ${userId}, used_at = now()
     WHERE code_hash = ${hash}
       AND kind = 'link'
       AND used_at IS NULL
       AND revoked_at IS NULL
       AND expires_at > now()
    RETURNING class_id, id`);
  const rows = (Array.isArray(res) ? res : (res as { rows?: unknown[] }).rows ?? []) as { class_id: string; id: string }[];
  const row = rows[0];
  if (!row) return { ok: false, state: await classifyMissingLink(db, hash) };
  return { ok: true, classId: row.class_id, inviteId: row.id };
}

/**
 * Почему расход не удался — для ЧЕЛОВЕКА, а не для атакующего: токен уже проверен по хешу,
 * и остаться могло только «истёк», «отозван» или «использован». «Неверный» — это случай, когда
 * строки нет вообще (например, ссылку отозвали и удалили).
 */
async function classifyMissingLink(db: DB | Tx, hash: string): Promise<InviteTokenFailure> {
  const [row] = await db
    .select({ expiresAt: inviteCodes.expiresAt, usedAt: inviteCodes.usedAt, revokedAt: inviteCodes.revokedAt })
    .from(inviteCodes)
    .where(and(eq(inviteCodes.codeHash, hash), eq(inviteCodes.kind, 'link')))
    .limit(1);
  if (!row) return 'invalid';
  if (row.usedAt) return 'used';
  if (row.revokedAt) return 'revoked';
  if (row.expiresAt.getTime() <= Date.now()) return 'expired';
  // строка живая и не использована, но UPDATE её не взял: значит между проверкой и расходом
  // успел встать другой запрос — для второго это ровно «уже использовано»
  return 'used';
}

/** Отозвать можно только активное приглашение; возвращает true, если отзыв действительно был. */
export async function revokeInviteLink(db: DB, id: string, classId: string, revokedBy: string): Promise<boolean> {
  const res = await db
    .update(inviteCodes)
    .set({ revokedAt: new Date(), revokedBy })
    .where(and(
      eq(inviteCodes.id, id),
      eq(inviteCodes.classId, classId),
      eq(inviteCodes.kind, 'link'),
      isNull(inviteCodes.usedAt),
      isNull(inviteCodes.revokedAt),
      gt(inviteCodes.expiresAt, new Date()),
    ))
    .returning({ id: inviteCodes.id });
  return res.length > 0;
}

/**
 * Отзыв «одной кнопкой» для маршрута учителя: тот же `POST …/invites/:id/revoke`, что и для
 * кодов, теперь закрывает оба вида приглашений и всегда помечает, КТО отозвал. Возвращает вид
 * отозванной строки — маршрут пишет это в журнал — или null, если отзываемого там нет (чужой
 * класс, уже использовано, уже отозвано, срок истёк).
 */
export async function revokeInvitation(
  db: DB, id: string, classId: string, revokedBy: string,
): Promise<'code' | 'link' | null> {
  const rows = await db
    .update(inviteCodes)
    .set({ revokedAt: new Date(), revokedBy })
    .where(and(
      eq(inviteCodes.id, id),
      eq(inviteCodes.classId, classId),
      isNull(inviteCodes.usedAt),
      isNull(inviteCodes.revokedAt),
      gt(inviteCodes.expiresAt, new Date()),
    ))
    .returning({ kind: inviteCodes.kind });
  const row = rows[0];
  return row ? (row.kind === 'link' ? 'link' : 'code') : null;
}

/**
 * Список приглашений класса — обоих видов, с пометкой вида. `usedByName` отдаётся ТОЛЬКО
 * учителю этого класса (маршрут под `authenticateTeacher` + `resolveClass`), и это ровно то,
 * что требует постановка: «Used (show the student's name only to the authorized teacher)».
 * Сам токен или хеш здесь не появляются никогда.
 */
export async function listInvitations(db: DB, classId: string) {
  const rows = await db
    .select({
      id: inviteCodes.id,
      kind: inviteCodes.kind,
      label: inviteCodes.label,
      createdAt: inviteCodes.createdAt,
      expiresAt: inviteCodes.expiresAt,
      usedAt: inviteCodes.usedAt,
      revokedAt: inviteCodes.revokedAt,
      usedByName: sql<string | null>`(select concat_ws(' ', u.name, nullif(u.last_name, '')) from users u where u.id = invite_codes.used_by)`,
    })
    .from(inviteCodes)
    .where(eq(inviteCodes.classId, classId))
    .orderBy(desc(inviteCodes.createdAt));
  const now = Date.now();
  return rows.map((r) => ({
    ...r,
    status: (r.revokedAt ? 'revoked' : r.usedAt ? 'used' : r.expiresAt.getTime() <= now ? 'expired' : 'active') as InviteStatus,
  }));
}

/** Имя класса по id — нужно предпросмотру, где приглашение ещё не «принадлежит» запросившему. */
export async function classNameOf(db: DB, classId: string): Promise<string | null> {
  const [c] = await db.select({ name: classes.name }).from(classes).where(eq(classes.id, classId)).limit(1);
  return c?.name ?? null;
}

/** Есть ли у человека уже членство в классе (чтобы не создавать дубль и сказать это прямо). */
export async function isClassMember(db: DB | Tx, classId: string, userId: string): Promise<boolean> {
  const [row] = await db
    .select({ userId: classMembers.userId })
    .from(classMembers)
    .where(and(eq(classMembers.classId, classId), eq(classMembers.userId, userId)))
    .limit(1);
  return Boolean(row);
}

/**
 * Вход в класс уже существующим аккаунтом по ссылке-приглашению.
 *
 * Расход токена и членство — одним ходом транзакции. Отдельное решение, которое надо назвать:
 * если аккаунт УЖЕ в этом классе, ссылка всё равно считается израсходованной. Иначе «уже
 * участник» оставило бы живую ссылку, по которой вслед за ним вошёл бы второй человек, и
 * обещание «одно приглашение — один ученик» перестало бы выполняться.
 */
export async function joinClassByInviteLink(
  db: DB, token: string, userId: string,
): Promise<
  | { ok: true; classId: string; already: boolean }
  | { ok: false; state: InviteTokenFailure }
> {
  const peek = await peekInviteLink(db, token);
  const classId = peek.classId;
  if (peek.state !== 'ok' || !classId) return { ok: false, state: peek.state === 'ok' ? 'invalid' : peek.state };
  return db.transaction(async (tx) => {
    const redeem = await redeemInviteLink(tx, token, userId);
    if (!redeem.ok) return { ok: false, state: redeem.state };
    const already = await isClassMember(tx, classId, userId);
    if (!already) {
      await tx.insert(classMembers).values({ classId: redeem.classId, userId });
    }
    return { ok: true, classId: redeem.classId, already };
  });
}
