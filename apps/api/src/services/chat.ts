import { sql, and, eq, desc, gt, lt, isNull, inArray } from 'drizzle-orm';
import { createHash, randomBytes } from 'node:crypto';
import type { DB } from '../db/index.js';
import { env } from '../env.js';
import { chatMessages, chatMutes, chatReads, chatWsTickets, classes, classMembers, users } from '../db/schema.js';

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
}

/** newest-first page (client renders reversed), `before` cursor for older history */
export async function listMessages(db: DB, classId: string, before: Date | null, limit: number): Promise<ChatMessageRow[]> {
  const cond = before
    ? and(eq(chatMessages.classId, classId), lt(chatMessages.createdAt, before))
    : eq(chatMessages.classId, classId);
  const rows = await db
    .select({
      id: chatMessages.id, authorId: chatMessages.authorId,
      authorName: sql<string>`concat_ws(' ', ${users.name}, nullif(${users.lastName}, ''))`, text: chatMessages.text, createdAt: chatMessages.createdAt,
    })
    .from(chatMessages).innerJoin(users, eq(users.id, chatMessages.authorId))
    .where(cond).orderBy(desc(chatMessages.createdAt)).limit(limit);
  return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }));
}

export async function postMessage(db: DB, classId: string, authorId: string, authorName: string, text: string): Promise<ChatMessageRow> {
  const [row] = await db.insert(chatMessages).values({ classId, authorId, text })
    .returning({ id: chatMessages.id, createdAt: chatMessages.createdAt });
  return { id: row!.id, authorId, authorName, text, createdAt: row!.createdAt.toISOString() };
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

/** participant check used by the routes: teacher-owner or member; null ⇒ 404 */
export async function chatAccess(
  db: DB, userId: string, role: 'teacher' | 'student', classId: string,
): Promise<{ chatMode: 'on' | 'off' | 'announce' } | null> {
  if (role === 'teacher') {
    const [c] = await db.select({ chatMode: classes.chatMode }).from(classes)
      .where(and(eq(classes.id, classId), eq(classes.teacherId, userId))).limit(1);
    return c ?? null;
  }
  const [c] = await db
    .select({ chatMode: classes.chatMode })
    .from(classMembers)
    .innerJoin(classes, eq(classes.id, classMembers.classId))
    .where(and(eq(classMembers.classId, classId), eq(classMembers.userId, userId))).limit(1);
  return c ?? null;
}

void inArray; // reserved

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
