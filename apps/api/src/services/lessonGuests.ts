import { and, desc, eq, isNull } from 'drizzle-orm';
import { AccessToken } from 'livekit-server-sdk';
import { lessonGuestLinks, lessonGuestRequests, lessonSessions, classes } from '../db/schema.js';
import type { DB } from '../db/index.js';
import { env } from '../env.js';
import { generateGuestToken, hashGuestKey, hashGuestToken } from '../lib/guestLink.js';
import { randomUUID } from 'node:crypto';

/**
 * Гостевой доступ к уроку (задача 2026-10-28, часть 3).
 *
 * Модель в одном абзаце: учитель выпускает ОДНУ активную ссылку на сессию; человек без аккаунта
 * открывает её, вводит имя и получает заявку; учитель одобряет — и только тогда сервер выдаёт
 * ему короткоживущий LiveKit-токен «только смотреть». Ни один шаг не доверяет клиенту ни
 * `lessonId`, ни `guestId`, ни статус: всё выводится из токена ссылки (в базе — хеш) и ключа
 * гостя (в базе — тоже хеш), а состояние ссылки и урока перечитывается на КАЖДОМ запросе.
 *
 * Ссылка живёт на сессии, а не на классе: завершённый урок закрывает её без отдельной уборки,
 * а `expires_at` (6 часов) страхует урок, который забыли завершить.
 */

/** Верхняя граница жизни ссылки; настоящее закрытие — завершение урока или отзыв. */
export const GUEST_LINK_TTL_MS = 6 * 60 * 60_000;

/** LiveKit-токен гостя живёт коротко: перевыпуск только через сервер (см. `/api/guest/rtc`). */
export const GUEST_RTC_TTL = '60s';

export type GuestLinkState = 'ok' | 'revoked' | 'expired' | 'ended';
export type GuestDecision = 'pending' | 'approved' | 'rejected';
export type GuestPublicState = GuestDecision | 'revoked' | 'expired' | 'ended';

/** Ровно те поля сессии, которые нужны гостевому доступу (см. `teacherSessionFor`). */
export interface GuestSessionInfo {
  id: string;
  classId: string;
  roomName: string;
  endedAt: Date | null;
}

/**
 * Состояние ссылки. Порядок проверок — часть контракта: закончившийся урок важнее отзыва
 * (сообщение «урок закончился» честнее, чем «ссылка отозвана»), отзыв важнее срока.
 */
export function guestLinkState(
  link: { revokedAt: Date | null; expiresAt: Date },
  session: { endedAt: Date | null },
  now = new Date(),
): GuestLinkState {
  if (session.endedAt) return 'ended';
  if (link.revokedAt) return 'revoked';
  if (link.expiresAt.getTime() <= now.getTime()) return 'expired';
  return 'ok';
}

/** Эффективный статус заявки: решение учителя, пока дверь открыта; иначе — состояние двери. */
export function effectiveGuestState(
  link: { revokedAt: Date | null; expiresAt: Date },
  session: { endedAt: Date | null },
  stored: string,
  now = new Date(),
): GuestPublicState {
  const state = guestLinkState(link, session, now);
  if (state !== 'ok') return state;
  return stored === 'approved' || stored === 'rejected' ? stored : 'pending';
}

/** Найти ссылку по токену. `null` — токен не наш; просроченная/отозванная строка остаётся. */
export async function findGuestLink(db: DB, token: string) {
  const [row] = await db.select({
    id: lessonGuestLinks.id,
    sessionId: lessonGuestLinks.sessionId,
    classId: lessonGuestLinks.classId,
    createdBy: lessonGuestLinks.createdBy,
    revokedAt: lessonGuestLinks.revokedAt,
    expiresAt: lessonGuestLinks.expiresAt,
    createdAt: lessonGuestLinks.createdAt,
    className: classes.name,
    endedAt: lessonSessions.endedAt,
    roomName: lessonSessions.roomName,
  })
    .from(lessonGuestLinks)
    .innerJoin(lessonSessions, eq(lessonSessions.id, lessonGuestLinks.sessionId))
    .innerJoin(classes, eq(classes.id, lessonGuestLinks.classId))
    .where(eq(lessonGuestLinks.tokenHash, hashGuestToken(token, env.JWT_SECRET)))
    .limit(1);
  return row ?? null;
}

export type GuestLinkLookup = NonNullable<Awaited<ReturnType<typeof findGuestLink>>>;

/**
 * Создать ссылку. Прежняя активная ссылка сессии отзывается в ТОЙ ЖЕ транзакции: у урока одна
 * актуальная дверь, и «создал вторую» не должно оставлять первую открытой.
 */
export async function createGuestLink(
  db: DB, session: GuestSessionInfo, actorId: string, now = new Date(),
): Promise<{ id: string; token: string; expiresAt: Date; revoked: string[] }> {
  const token = generateGuestToken();
  const id = randomUUID();
  const expiresAt = new Date(now.getTime() + GUEST_LINK_TTL_MS);
  const revoked = await db.transaction(async (tx) => {
    /*
     * Блокировка строки сессии: два одновременных «создать ссылку» иначе оба не увидят активной
     * ссылки друг друга и оставят ДВЕ открытые двери. С блокировкой второй ждёт первого, отзывает
     * только что созданную им ссылку и выпускает свою — у урока по-прежнему одна дверь.
     */
    await tx.select({ id: lessonSessions.id }).from(lessonSessions)
      .where(eq(lessonSessions.id, session.id)).for('update');
    const old = await tx.update(lessonGuestLinks)
      .set({ revokedAt: now })
      .where(and(eq(lessonGuestLinks.sessionId, session.id), isNull(lessonGuestLinks.revokedAt)))
      .returning({ id: lessonGuestLinks.id });
    await tx.insert(lessonGuestLinks).values({
      id, sessionId: session.id, classId: session.classId, createdBy: actorId,
      tokenHash: hashGuestToken(token, env.JWT_SECRET), expiresAt, createdAt: now,
    });
    return old.map((r) => r.id);
  });
  return { id, token, expiresAt, revoked };
}

/** Закрыть активные ссылки сессии. Возвращает их идентификаторы (для журнала и отключения). */
export async function revokeGuestLinks(db: DB, sessionId: string, now = new Date()): Promise<string[]> {
  const rows = await db.update(lessonGuestLinks)
    .set({ revokedAt: now })
    .where(and(eq(lessonGuestLinks.sessionId, sessionId), isNull(lessonGuestLinks.revokedAt)))
    .returning({ id: lessonGuestLinks.id });
  return rows.map((r) => r.id);
}

/** Заявка гостя: строку создаёт только вставка, повтор с тем же ключом её не дублирует. */
export async function requestGuestAccess(
  db: DB, link: GuestLinkLookup, name: string, key: string, now = new Date(),
): Promise<{ request: { id: string; name: string; status: string; createdAt: Date }; created: boolean }> {
  const keyHash = hashGuestKey(key, link.id, env.JWT_SECRET);
  const [inserted] = await db.insert(lessonGuestRequests).values({
    linkId: link.id, sessionId: link.sessionId, name, keyHash, createdAt: now,
  }).onConflictDoNothing().returning({
    id: lessonGuestRequests.id, name: lessonGuestRequests.name,
    status: lessonGuestRequests.status, createdAt: lessonGuestRequests.createdAt,
  });
  if (inserted) return { request: inserted, created: true };
  const [existing] = await db.select({
    id: lessonGuestRequests.id, name: lessonGuestRequests.name,
    status: lessonGuestRequests.status, createdAt: lessonGuestRequests.createdAt,
  }).from(lessonGuestRequests)
    .where(and(eq(lessonGuestRequests.linkId, link.id), eq(lessonGuestRequests.keyHash, keyHash)))
    .limit(1);
  // Строка исчезла между INSERT и SELECT (каскад от удаления ссылки) — наружу это неверный ключ.
  if (!existing) return { request: { id: '', name, status: 'rejected', createdAt: now }, created: false };
  return { request: existing, created: false };
}

export async function findGuestRequest(db: DB, linkId: string, key: string) {
  const [row] = await db.select({
    id: lessonGuestRequests.id,
    name: lessonGuestRequests.name,
    status: lessonGuestRequests.status,
    createdAt: lessonGuestRequests.createdAt,
  }).from(lessonGuestRequests)
    .where(and(
      eq(lessonGuestRequests.linkId, linkId),
      eq(lessonGuestRequests.keyHash, hashGuestKey(key, linkId, env.JWT_SECRET)),
    ))
    .limit(1);
  return row ?? null;
}

export interface GuestDecisionResult {
  request: { id: string; name: string; status: string; createdAt: Date };
  previous: string | null;
}

/**
 * Решение учителя по заявке. Возвращает `null`, если заявки нет В ЭТОЙ сессии (чужая заявка —
 * тот же 404, что и несуществующая). `approve` идемпотентен; `reject` разрешён и поверх
 * `approved` — это «убрать гостя из комнаты», а не только «отклонить ожидающего».
 */
export async function decideGuestRequest(
  db: DB, sessionId: string, requestId: string, decision: 'approved' | 'rejected',
  actorId: string, now = new Date(),
): Promise<GuestDecisionResult | null> {
  const [current] = await db.select({
    id: lessonGuestRequests.id,
    name: lessonGuestRequests.name,
    status: lessonGuestRequests.status,
    createdAt: lessonGuestRequests.createdAt,
  }).from(lessonGuestRequests)
    .where(and(eq(lessonGuestRequests.id, requestId), eq(lessonGuestRequests.sessionId, sessionId)))
    .limit(1);
  if (!current) return null;
  if (current.status === decision) return { request: current, previous: current.status };
  await db.update(lessonGuestRequests)
    .set({ status: decision, decidedAt: now, decidedBy: actorId })
    .where(and(
      eq(lessonGuestRequests.id, requestId),
      eq(lessonGuestRequests.sessionId, sessionId),
      eq(lessonGuestRequests.status, current.status),
    ));
  const [updated] = await db.select({
    id: lessonGuestRequests.id, name: lessonGuestRequests.name,
    status: lessonGuestRequests.status, createdAt: lessonGuestRequests.createdAt,
  }).from(lessonGuestRequests).where(eq(lessonGuestRequests.id, requestId)).limit(1);
  return updated ? { request: updated, previous: current.status } : null;
}

export interface GuestOverview {
  link: { active: boolean; createdAt: string; expiresAt: string } | null;
  requests: { id: string; name: string; status: GuestPublicState; createdAt: string }[];
}

/** Список для учителя: последняя ссылка (даже закрытая — история) и заявки по ней. */
export async function guestOverview(
  db: DB, session: GuestSessionInfo, now = new Date(),
): Promise<GuestOverview> {
  const [link] = await db.select({
    id: lessonGuestLinks.id,
    revokedAt: lessonGuestLinks.revokedAt,
    expiresAt: lessonGuestLinks.expiresAt,
    createdAt: lessonGuestLinks.createdAt,
  }).from(lessonGuestLinks)
    .where(eq(lessonGuestLinks.sessionId, session.id))
    .orderBy(desc(lessonGuestLinks.createdAt))
    .limit(1);
  if (!link) return { link: null, requests: [] };
  const rows = await db.select({
    id: lessonGuestRequests.id,
    name: lessonGuestRequests.name,
    status: lessonGuestRequests.status,
    createdAt: lessonGuestRequests.createdAt,
  }).from(lessonGuestRequests)
    .where(eq(lessonGuestRequests.linkId, link.id))
    .orderBy(desc(lessonGuestRequests.createdAt));
  return {
    link: {
      active: guestLinkState(link, session, now) === 'ok',
      createdAt: link.createdAt.toISOString(),
      expiresAt: link.expiresAt.toISOString(),
    },
    requests: rows.map((r) => ({
      id: r.id, name: r.name,
      status: effectiveGuestState(link, session, r.status, now),
      createdAt: r.createdAt.toISOString(),
    })),
  };
}

/**
 * LiveKit-токен гостя. Права минимальны и заданы здесь, а не на клиенте: только просмотр —
 * без публикации, без данных, без модерации; имя — введённое гостем, identity — `guest:<id>`
 * заявки (по нему комната отключает гостя при отзыве, и по нему же видно, кто в комнате гость).
 * TTL короткий: перевыпуск — только этим маршрутом, после повторной серверной проверки статуса.
 */
export async function buildGuestRtcToken(opts: { room: string; requestId: string; name: string }): Promise<string> {
  const at = new AccessToken(env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET, {
    identity: `guest:${opts.requestId}`, name: opts.name, ttl: GUEST_RTC_TTL,
  });
  at.addGrant({
    room: opts.room, roomJoin: true,
    canPublish: false, canSubscribe: true, canPublishData: false,
  });
  return at.toJwt();
}
