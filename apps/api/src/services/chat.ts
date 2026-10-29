import { sql, and, eq, desc, gt, lt, isNull, inArray } from 'drizzle-orm';
import { createHash, randomBytes } from 'node:crypto';
import type { DB } from '../db/index.js';
import { env } from '../env.js';
import { chatMessages, chatMutes, chatReads, chatWsTickets, classes, classMembers, users } from '../db/schema.js';
import { deletedReply, liveReply, type ReplyRef } from '@klass/shared';

/**
 * Item 8 — class chat. One shared thread per class; only members (students)
 * and the owning teacher see it; outsiders get 404 everywhere (§7 pattern).
 */

const TICKET_TTL_MS = 30_000;
const hashTicket = (t: string) => createHash('sha256').update(`${env.JWT_SECRET}.${t}`).digest('hex');

export async function createChatTicket(db: DB, userId: string, classId: string): Promise<string> {
  const ticket = randomBytes(24).toString('base64url');
  await db.insert(chatWsTickets).values({
    tokenHash: hashTicket(ticket), userId, classId,
    expiresAt: new Date(Date.now() + TICKET_TTL_MS),
  });
  return ticket;
}

/** Atomic one-time consumption, mirrors wsTicket semantics. */
export async function consumeChatTicket(
  db: DB, ticket: string, classId: string,
): Promise<{ userId: string; role: 'teacher' | 'student'; name: string } | null> {
  const res = await db.execute(sql`
    UPDATE chat_ws_tickets ct
       SET used_at = now()
      FROM users u
     WHERE ct.token_hash = ${hashTicket(ticket)}
       AND ct.class_id = ${classId}
       AND ct.user_id = u.id
       AND ct.used_at IS NULL
       AND ct.expires_at > now()
       AND u.deleted_at IS NULL
    RETURNING u.id AS user_id, u.role::text AS role, u.name AS name`);
  const rows = (Array.isArray(res) ? res : (res as { rows?: unknown[] }).rows ?? []) as
    { user_id: string; role: 'teacher' | 'student'; name: string }[];
  const row = rows[0];
  return row ? { userId: row.user_id, role: row.role, name: row.name } : null;
}

export async function sweepChatTickets(db: DB): Promise<void> {
  await db.execute(sql`DELETE FROM chat_ws_tickets WHERE expires_at < now() - interval '1 hour'`);
}

export async function isMuted(db: DB, classId: string, userId: string): Promise<boolean> {
  const [m] = await db.select({ until: chatMutes.until }).from(chatMutes)
    .where(and(eq(chatMutes.classId, classId), eq(chatMutes.userId, userId))).limit(1);
  if (!m) return false;
  return m.until === null || m.until.getTime() > Date.now();
}

export interface ChatMessageRow {
  id: string; authorId: string; authorName: string; text: string; createdAt: string;
  /** item 7: set once by the author's PATCH; the client shows «изменено» */
  editedAt: string | null;
  /** reply task 2: the message this one answers, or null. Built fresh on every read. */
  replyTo: ReplyRef | null;
}

const authorName = sql<string>`concat_ws(' ', ${users.name}, nullif(${users.lastName}, ''))`;

/**
 * The quotes of a page of messages, resolved in ONE extra query: the snippet always comes from
 * the CURRENT text of the original (an edit therefore refreshes every quote of it), and an id
 * that no longer resolves is a physically deleted original ⇒ `deleted: true`, empty snippet,
 * no author name (nothing of the deleted message is kept anywhere — see migration 0023).
 */
async function repliesOf(db: DB, refIds: (string | null)[]): Promise<Map<string, ReplyRef>> {
  const ids = [...new Set(refIds.filter((x): x is string => typeof x === 'string' && x.length > 0))];
  const out = new Map<string, ReplyRef>();
  if (!ids.length) return out;
  const found = await db
    .select({ id: chatMessages.id, text: chatMessages.text, authorName })
    .from(chatMessages).innerJoin(users, eq(users.id, chatMessages.authorId))
    .where(inArray(chatMessages.id, ids));
  const byId = new Map(found.map((f) => [f.id, f]));
  for (const id of ids) {
    const f = byId.get(id);
    out.set(id, f ? liveReply(id, f.authorName, f.text) : deletedReply(id));
  }
  return out;
}

/** newest-first page (client renders reversed), `before` cursor for older history */
export async function listMessages(db: DB, classId: string, before: Date | null, limit: number): Promise<ChatMessageRow[]> {
  const cond = before
    ? and(eq(chatMessages.classId, classId), lt(chatMessages.createdAt, before))
    : eq(chatMessages.classId, classId);
  const rows = await db
    .select({
      id: chatMessages.id, authorId: chatMessages.authorId,
      authorName, text: chatMessages.text, createdAt: chatMessages.createdAt, editedAt: chatMessages.editedAt,
      replyRefId: chatMessages.replyRefId,
    })
    .from(chatMessages).innerJoin(users, eq(users.id, chatMessages.authorId))
    .where(cond).orderBy(desc(chatMessages.createdAt)).limit(limit);
  const replies = await repliesOf(db, rows.map((r) => r.replyRefId));
  return rows.map((r) => ({
    id: r.id, authorId: r.authorId, authorName: r.authorName, text: r.text,
    createdAt: r.createdAt.toISOString(), editedAt: r.editedAt ? r.editedAt.toISOString() : null,
    replyTo: r.replyRefId ? replies.get(r.replyRefId) ?? deletedReply(r.replyRefId) : null,
  }));
}

/**
 * Post a message. `replyTarget` is the ORIGINAL, already validated by the route (same class,
 * still present): the id goes into both columns — `reply_to_id` as the live FK, `reply_ref_id`
 * as the tombstone-safe reference that survives the FK's ON DELETE SET NULL.
 */
export async function postMessage(
  db: DB, classId: string, authorId: string, authorName: string, text: string,
  replyTarget: { id: string; authorName: string; text: string } | null = null,
): Promise<ChatMessageRow> {
  const [row] = await db.insert(chatMessages).values({
    classId, authorId, text,
    ...(replyTarget ? { replyToId: replyTarget.id, replyRefId: replyTarget.id } : {}),
  }).returning({ id: chatMessages.id, createdAt: chatMessages.createdAt });
  return {
    id: row!.id, authorId, authorName, text, createdAt: row!.createdAt.toISOString(), editedAt: null,
    replyTo: replyTarget ? liveReply(replyTarget.id, replyTarget.authorName, replyTarget.text) : null,
  };
}

/**
 * Author-only edit (item 7): the WHERE carries author_id, so a teacher PATCHing
 * someone else's message simply matches nothing ⇒ 404, never a silent overwrite.
 */
export async function editMessage(
  db: DB, classId: string, messageId: string, authorId: string, text: string,
): Promise<ChatMessageRow | null> {
  const [r] = await db.update(chatMessages)
    .set({ text, editedAt: new Date() })
    .where(and(eq(chatMessages.id, messageId), eq(chatMessages.classId, classId), eq(chatMessages.authorId, authorId)))
    .returning({ createdAt: chatMessages.createdAt });
  if (!r) return null;
  const [full] = await db
    .select({
      id: chatMessages.id, authorId: chatMessages.authorId,
      authorName, text: chatMessages.text, createdAt: chatMessages.createdAt, editedAt: chatMessages.editedAt,
      replyRefId: chatMessages.replyRefId,
    })
    .from(chatMessages).innerJoin(users, eq(users.id, chatMessages.authorId))
    .where(eq(chatMessages.id, messageId)).limit(1);
  if (!full) return null;
  const replies = await repliesOf(db, [full.replyRefId]);
  return {
    id: full.id, authorId: full.authorId, authorName: full.authorName, text: full.text,
    createdAt: full.createdAt.toISOString(), editedAt: full.editedAt ? full.editedAt.toISOString() : null,
    replyTo: full.replyRefId ? replies.get(full.replyRefId) ?? deletedReply(full.replyRefId) : null,
  };
}

/**
 * Reply task 2: the original a new message wants to quote. Returns it ONLY when it exists in the
 * SAME class — the route answers the same 404 for "another class" and "no such message", so a
 * student cannot probe ids of classes they do not belong to.
 */
export async function findReplyTarget(
  db: DB, classId: string, messageId: string,
): Promise<{ id: string; authorName: string; text: string } | null> {
  const [row] = await db
    .select({ id: chatMessages.id, authorName, text: chatMessages.text })
    .from(chatMessages).innerJoin(users, eq(users.id, chatMessages.authorId))
    .where(and(eq(chatMessages.id, messageId), eq(chatMessages.classId, classId)))
    .limit(1);
  return row ?? null;
}

export async function deleteMessage(db: DB, classId: string, messageId: string, authorId: string): Promise<boolean> {
  const [r] = await db.delete(chatMessages)
    .where(and(eq(chatMessages.id, messageId), eq(chatMessages.classId, classId), eq(chatMessages.authorId, authorId)))
    .returning({ id: chatMessages.id });
  return Boolean(r);
}

export async function deleteMessageAny(db: DB, classId: string, messageId: string): Promise<boolean> {
  const [r] = await db.delete(chatMessages)
    .where(and(eq(chatMessages.id, messageId), eq(chatMessages.classId, classId)))
    .returning({ id: chatMessages.id });
  return Boolean(r);
}

export async function setMute(db: DB, classId: string, userId: string, mutedBy: string, until: Date | null): Promise<void> {
  // delete+insert instead of upsert: chat_mutes has only a plain index, and
  // mutes are written solely by the owning teacher — no competing writers.
  await db.delete(chatMutes).where(and(eq(chatMutes.classId, classId), eq(chatMutes.userId, userId)));
  await db.insert(chatMutes).values({ classId, userId, mutedBy, until });
}

export async function clearMute(db: DB, classId: string, userId: string): Promise<void> {
  await db.delete(chatMutes).where(and(eq(chatMutes.classId, classId), eq(chatMutes.userId, userId)));
}

export async function markRead(db: DB, userId: string, classId: string): Promise<void> {
  await db.insert(chatReads).values({ userId, classId, lastReadAt: new Date() })
    .onConflictDoUpdate({ target: [chatReads.userId, chatReads.classId], set: { lastReadAt: new Date() } });
}

export interface ChatSummary {
  classId: string; name: string; chatMode: 'on' | 'off' | 'announce';
  lastMessage: string | null; lastAuthor: string | null; lastAt: string | null; unread: number;
}

/** Sidebar list: every class the user belongs to (+ teacher's own), last message + unread. */
export async function chatSummary(db: DB, userId: string, role: 'teacher' | 'student'): Promise<ChatSummary[]> {
  const cls = role === 'teacher'
    ? await db.select({ id: classes.id, name: classes.name, chatMode: classes.chatMode }).from(classes)
        .where(and(eq(classes.teacherId, userId), isNull(classes.archivedAt)))
    : await db
        .select({ id: classes.id, name: classes.name, chatMode: classes.chatMode })
        .from(classMembers)
        .innerJoin(classes, eq(classes.id, classMembers.classId))
        .where(and(eq(classMembers.userId, userId), isNull(classes.archivedAt)));
  // one membership list per class — class counts per user are small by design
  const out: ChatSummary[] = [];
  for (const c of cls) {
    const [last] = await db
      .select({ text: chatMessages.text, createdAt: chatMessages.createdAt, authorName: sql<string>`concat_ws(' ', ${users.name}, nullif(${users.lastName}, ''))` })
      .from(chatMessages).innerJoin(users, eq(users.id, chatMessages.authorId))
      .where(eq(chatMessages.classId, c.id)).orderBy(desc(chatMessages.createdAt)).limit(1);
    const [read] = await db.select({ lastReadAt: chatReads.lastReadAt }).from(chatReads)
      .where(and(eq(chatReads.userId, userId), eq(chatReads.classId, c.id))).limit(1);
    const unreadCond = read
      ? and(eq(chatMessages.classId, c.id), gt(chatMessages.createdAt, read.lastReadAt),
          sql`${chatMessages.authorId} <> ${userId}`)
      : and(eq(chatMessages.classId, c.id), sql`${chatMessages.authorId} <> ${userId}`);
    const [uc] = await db.select({ n: sql<number>`count(*)::int` }).from(chatMessages).where(unreadCond);
    out.push({
      classId: c.id, name: c.name, chatMode: c.chatMode,
      lastMessage: last ? (last.text.length > 90 ? `${last.text.slice(0, 89)}…` : last.text) : null,
      lastAuthor: last?.authorName ?? null,
      lastAt: last ? last.createdAt.toISOString() : null,
      unread: uc?.n ?? 0,
    });
  }
  return out.sort((a, b) => (b.lastAt ?? '').localeCompare(a.lastAt ?? ''));
}

/**
 * Participant check used by the routes: teacher-owner or member; null ⇒ 404.
 *
 * 2026-10-28, аудит SEC-04: архив закрывает и чат. Это не «новый запрет», а приведение к правилу,
 * которое весь проект уже держит: `resolveClass` (`services/classes.ts:22-39`), `listEventsInRange`,
 * `chatSummary` и выдача файлов/доски/архива фильтруют `classes.archived_at`, поэтому для
 * заархивированного класса feed, материалы, доски и файлы отвечают 404, а сам класс скрыт из
 * `/api/classes`. Чат был ЕДИНСТВЕННОЙ поверхностью, которая этого фильтра не имела: выпускной
 * класс продолжал переписку, которую учитель считает закрытой, и WS-сокет (`routes/chat.ts:232`)
 * тоже её принимал. Разделение ответственности при этом то же: проверка остаётся «владелец или
 * участник», поэтому поправка не даёт доступа никому чужому и ничего не отнимает у живого класса.
 *
 * Что сознано НЕ меняется: отмена архивации возвращает чат — строки сообщений не удаляются и
 * фильтр читает состояние класса на каждый запрос, а не «закрыл навсегда».
 */
export async function chatAccess(
  db: DB, userId: string, role: 'teacher' | 'student', classId: string,
): Promise<{ chatMode: 'on' | 'off' | 'announce' } | null> {
  if (role === 'teacher') {
    const [c] = await db.select({ chatMode: classes.chatMode }).from(classes)
      .where(and(eq(classes.id, classId), eq(classes.teacherId, userId), isNull(classes.archivedAt))).limit(1);
    return c ?? null;
  }
  const [c] = await db
    .select({ chatMode: classes.chatMode })
    .from(classMembers)
    .innerJoin(classes, and(eq(classes.id, classMembers.classId), isNull(classes.archivedAt)))
    .where(and(eq(classMembers.classId, classId), eq(classMembers.userId, userId))).limit(1);
  return c ?? null;
}

/** moderation list for the teacher's chat settings */
export async function listMutes(db: DB, classId: string): Promise<{ userId: string; name: string; until: string | null }[]> {
  const rows = await db
    .select({ userId: chatMutes.userId, name: sql<string>`concat_ws(' ', ${users.name}, nullif(${users.lastName}, ''))`, until: chatMutes.until })
    .from(chatMutes).innerJoin(users, eq(users.id, chatMutes.userId))
    .where(eq(chatMutes.classId, classId));
  return rows.map((r) => ({ userId: r.userId, name: r.name, until: r.until ? r.until.toISOString() : null }));
}

export async function setChatMode(db: DB, classId: string, mode: 'on' | 'off' | 'announce'): Promise<void> {
  await db.update(classes).set({ chatMode: mode }).where(eq(classes.id, classId));
}
