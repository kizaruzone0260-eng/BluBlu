import { sql, and, eq, gt, lt, desc, asc, isNull, not, count } from 'drizzle-orm';
import type { DB } from '../db/index.js';
import {
  lessonComments, lessonCommentMutes, lessonCommentReads, lessonSessions, users,
} from '../db/schema.js';
import { getSession } from './lessons.js';
import { resolveClass } from './classes.js';

/**
 * Task 2 (2026-10-09) — comments written during a lesson.
 *
 * Deliberately NOT the class chat: a comment belongs to the session that is running right now, it
 * has to work while the microphone is off and while «режим лекции» holds everyone's audio, and it
 * disappears from the UI the moment the lesson ends (the teacher keeps reading it). So the access
 * question is always «is this person in the class of THIS session», answered through
 * `resolveClass` — which is what makes a foreign session and a nonexistent one indistinguishable
 * (both `null`, both a 404 from the route).
 */

export const COMMENT_MAX_LEN = 500;
/** «slow» — one comment per 10 s per student, exactly as the task words it. */
export const SLOW_WINDOW_MS = 10_000;
/** the shared chat's cap, reused so nobody can flood a lesson through the side door. */
const RATE_MAX = 5;
const RATE_WINDOW_MS = 10_000;
/** the teacher's «закрепить»: three at a time, no more. */
export const PIN_MAX = 3;
/** what a reconnecting client gets back. */
export const RECONNECT_LIMIT = 50;

export interface CommentRow {
  id: string;
  authorId: string;
  authorName: string;
  text: string;
  createdAt: string;
  pinned: boolean;
  answered: boolean;
}

const authorName = sql<string>`concat_ws(' ', ${users.name}, nullif(${users.lastName}, ''))`;

/**
 * Who may see this session's comments. `null` ⇒ the route answers 404 — the same answer for
 * "another class", "no such session" and "a class that is archived", so the endpoint cannot be
 * used to probe ids.
 */
export async function commentAccess(
  db: DB, userId: string, role: 'teacher' | 'student', sessionId: string,
): Promise<{ sessionId: string; classId: string; endedAt: Date | null; mode: 'on' | 'off' | 'slow'; isTeacher: boolean } | null> {
  const s = await getSession(db, sessionId);
  if (!s) return null;
  const cls = await resolveClass(db, userId, role, s.classId);
  if (!cls) return null;
  return {
    sessionId: s.id, classId: cls.id, endedAt: s.endedAt,
    mode: s.commentsMode, isTeacher: role === 'teacher',
  };
}

/** newest-first page of LIVE comments, pinned lifted to the top; `before` walks history. */
export async function listComments(
  db: DB, sessionId: string, limit: number, before: Date | null = null,
): Promise<CommentRow[]> {
  const cond = before
    ? and(eq(lessonComments.sessionId, sessionId), isNull(lessonComments.deletedAt), lt(lessonComments.createdAt, before))
    : and(eq(lessonComments.sessionId, sessionId), isNull(lessonComments.deletedAt));
  const rows = await db
    .select({
      id: lessonComments.id, authorId: lessonComments.authorId, authorName,
      text: lessonComments.text, createdAt: lessonComments.createdAt,
      pinned: lessonComments.pinned, answered: lessonComments.answered,
    })
    .from(lessonComments).innerJoin(users, eq(users.id, lessonComments.authorId))
    .where(cond)
    .orderBy(desc(lessonComments.pinned), desc(lessonComments.createdAt))
    .limit(limit);
  return rows.map((r) => ({
    id: r.id, authorId: r.authorId, authorName: r.authorName, text: r.text,
    createdAt: r.createdAt.toISOString(), pinned: r.pinned, answered: r.answered,
  }));
}

/** the last 50 for a client that just reconnected (pinned first, oldest-first inside). */
export async function recentComments(db: DB, sessionId: string): Promise<CommentRow[]> {
  const rows = await listComments(db, sessionId, RECONNECT_LIMIT);
  return rows.sort((a, b) => (a.pinned === b.pinned
    ? a.createdAt.localeCompare(b.createdAt)
    : a.pinned ? -1 : 1));
}

export async function postComment(
  db: DB, sessionId: string, authorId: string, name: string, text: string,
): Promise<CommentRow> {
  const [row] = await db.insert(lessonComments)
    .values({ sessionId, authorId, text })
    .returning({ id: lessonComments.id, createdAt: lessonComments.createdAt });
  return {
    id: row!.id, authorId, authorName: name, text, pinned: false, answered: false,
    createdAt: row!.createdAt.toISOString(),
  };
}

/**
 * Soft delete. `authorId` narrows the WHERE to that author, which is how a student deletes only
 * their own comment while the teacher (authorId = null) deletes any — and why a student reaching
 * for someone else's row gets a plain 404 instead of a silent no-op.
 */
export async function deleteComment(
  db: DB, sessionId: string, commentId: string, authorId: string | null,
): Promise<boolean> {
  const cond = authorId
    ? and(
        eq(lessonComments.id, commentId), eq(lessonComments.sessionId, sessionId),
        eq(lessonComments.authorId, authorId), isNull(lessonComments.deletedAt),
      )
    : and(eq(lessonComments.id, commentId), eq(lessonComments.sessionId, sessionId), isNull(lessonComments.deletedAt));
  const [r] = await db.update(lessonComments).set({ deletedAt: new Date() })
    .where(cond).returning({ id: lessonComments.id });
  return Boolean(r);
}

/** current pinned rows of a session (id + text is enough for the panel's top block). */
export async function pinnedComments(db: DB, sessionId: string): Promise<CommentRow[]> {
  const rows = await db
    .select({
      id: lessonComments.id, authorId: lessonComments.authorId, authorName,
      text: lessonComments.text, createdAt: lessonComments.createdAt,
      pinned: lessonComments.pinned, answered: lessonComments.answered,
    })
    .from(lessonComments).innerJoin(users, eq(users.id, lessonComments.authorId))
    .where(and(
      eq(lessonComments.sessionId, sessionId), eq(lessonComments.pinned, true),
      isNull(lessonComments.deletedAt),
    ))
    .orderBy(asc(lessonComments.createdAt));
  return rows.map((r) => ({
    id: r.id, authorId: r.authorId, authorName: r.authorName, text: r.text,
    createdAt: r.createdAt.toISOString(), pinned: r.pinned, answered: r.answered,
  }));
}

/**
 * Pin / unpin. Returns `false` for a comment that is not in this session (404) and throws
 * `tooManyPins` when a 4th pin would be created — the route turns that into a 409 with a message,
 * so the limit is enforced on the server and the UI never has to count.
 */
export async function setPinned(db: DB, sessionId: string, commentId: string, on: boolean): Promise<'ok' | 'not-found' | 'too-many'> {
  const [mine] = await db.select({ id: lessonComments.id, pinned: lessonComments.pinned })
    .from(lessonComments)
    .where(and(eq(lessonComments.id, commentId), eq(lessonComments.sessionId, sessionId), isNull(lessonComments.deletedAt)))
    .limit(1);
  if (!mine) return 'not-found';
  if (!on) {
    await db.update(lessonComments).set({ pinned: false }).where(eq(lessonComments.id, commentId));
    return 'ok';
  }
  if (mine.pinned) return 'ok';
  const pinned = await db.select({ n: count() }).from(lessonComments)
    .where(and(
      eq(lessonComments.sessionId, sessionId), eq(lessonComments.pinned, true),
      isNull(lessonComments.deletedAt), not(eq(lessonComments.id, commentId)),
    ));
  if (Number(pinned[0]?.n ?? 0) >= PIN_MAX) return 'too-many';
  await db.update(lessonComments).set({ pinned: true }).where(eq(lessonComments.id, commentId));
  return 'ok';
}

/** «отвечено» — a teacher's workflow flag on any comment of the session. */
export async function setAnswered(db: DB, sessionId: string, commentId: string, on: boolean): Promise<boolean> {
  const [r] = await db.update(lessonComments).set({ answered: on })
    .where(and(eq(lessonComments.id, commentId), eq(lessonComments.sessionId, sessionId), isNull(lessonComments.deletedAt)))
    .returning({ id: lessonComments.id });
  return Boolean(r);
}

// ── mute for this lesson ─────────────────────────────────────────────────────
export async function isCommentMuted(db: DB, sessionId: string, userId: string): Promise<boolean> {
  const [m] = await db.select({ id: lessonCommentMutes.id }).from(lessonCommentMutes)
    .where(and(eq(lessonCommentMutes.sessionId, sessionId), eq(lessonCommentMutes.userId, userId)))
    .limit(1);
  return Boolean(m);
}

export async function setCommentMute(db: DB, sessionId: string, userId: string, mutedBy: string): Promise<void> {
  await db.delete(lessonCommentMutes)
    .where(and(eq(lessonCommentMutes.sessionId, sessionId), eq(lessonCommentMutes.userId, userId)));
  await db.insert(lessonCommentMutes).values({ sessionId, userId, mutedBy });
}

export async function clearCommentMute(db: DB, sessionId: string, userId: string): Promise<void> {
  await db.delete(lessonCommentMutes)
    .where(and(eq(lessonCommentMutes.sessionId, sessionId), eq(lessonCommentMutes.userId, userId)));
}

/** who is muted in this session — the teacher's panel shows it next to the name. */
export async function listCommentMutes(db: DB, sessionId: string): Promise<string[]> {
  const rows = await db.select({ userId: lessonCommentMutes.userId }).from(lessonCommentMutes)
    .where(eq(lessonCommentMutes.sessionId, sessionId));
  return rows.map((r) => r.userId);
}

// ── mode ────────────────────────────────────────────────────────────────────
export async function setCommentsMode(db: DB, sessionId: string, mode: 'on' | 'off' | 'slow'): Promise<void> {
  await db.update(lessonSessions).set({ commentsMode: mode }).where(eq(lessonSessions.id, sessionId));
}

// ── unread counter ───────────────────────────────────────────────────────────
/*
 * The cursor is written with the DATABASE clock, not with `new Date()`.
 *
 * `lesson_comments.created_at` comes from the same PostgreSQL clock and keeps microseconds,
 * while a JS Date is truncated to milliseconds. Two events inside one millisecond then stored
 * a `last_read_at` slightly EARLIER than the comment just shown, and the next refresh counted
 * that comment as unread again — the red test seen on 2026-10-28 and once more on 2026-10-29.
 * Measured on 2026-10-29 by inserting a comment and immediately writing the marker: 444 of 3000
 * read-backs inverted with the JS clock, 0 of 3000 with `now()`. The INSERT omits the column so
 * its own `default now()` applies.
 */
export async function markCommentsRead(db: DB, userId: string, sessionId: string): Promise<void> {
  await db.insert(lessonCommentReads).values({ userId, sessionId })
    .onConflictDoUpdate({ target: [lessonCommentReads.userId, lessonCommentReads.sessionId], set: { lastReadAt: sql`now()` } });
}

/** comments by OTHERS that arrived after this person last read them. */
export async function unreadCount(db: DB, userId: string, sessionId: string): Promise<number> {
  const [read] = await db.select({ lastReadAt: lessonCommentReads.lastReadAt }).from(lessonCommentReads)
    .where(and(eq(lessonCommentReads.userId, userId), eq(lessonCommentReads.sessionId, sessionId)))
    .limit(1);
  const cond = read
    ? and(
        eq(lessonComments.sessionId, sessionId), isNull(lessonComments.deletedAt),
        not(eq(lessonComments.authorId, userId)), gt(lessonComments.createdAt, read.lastReadAt),
      )
    : and(eq(lessonComments.sessionId, sessionId), isNull(lessonComments.deletedAt), not(eq(lessonComments.authorId, userId)));
  const rows = await db.select({ n: count() }).from(lessonComments).where(cond);
  return Number(rows[0]?.n ?? 0);
}

// ── rate limiting (per user, sliding window — same shape as the class chat) ──
const sendTimes = new Map<string, number[]>();

/**
 * Two windows at once: the chat's 5-per-10-s cap always applies, and in `slow` mode a student is
 * additionally held to one per 10 s. The teacher is never rate-limited by the mode — the task
 * words slow mode as a limit on students, and moderation has to stay possible.
 */
export function lessonCommentRateCheck(
  userId: string, slow: boolean, isTeacher: boolean, now = Date.now(),
): { allowed: boolean; retryAfterSec: number } {
  const key = `${userId}`;
  const arr = (sendTimes.get(key) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  if (arr.length >= RATE_MAX) {
    sendTimes.set(key, arr);
    return { allowed: false, retryAfterSec: Math.ceil((RATE_WINDOW_MS - (now - arr[0]!)) / 1000) };
  }
  if (slow && !isTeacher) {
    const slowArr = (sendTimes.get(`${key}:slow`) ?? []).filter((t) => now - t < SLOW_WINDOW_MS);
    if (slowArr.length >= 1) {
      sendTimes.set(key, arr);
      return { allowed: false, retryAfterSec: Math.ceil((SLOW_WINDOW_MS - (now - slowArr[0]!)) / 1000) };
    }
    slowArr.push(now);
    sendTimes.set(`${key}:slow`, slowArr);
  }
  arr.push(now);
  sendTimes.set(key, arr);
  return { allowed: true, retryAfterSec: 0 };
}

export function lessonCommentRateReset(userId: string): void {
  sendTimes.delete(userId);
  sendTimes.delete(`${userId}:slow`);
}
