import { and, asc, eq, sql } from 'drizzle-orm';
import type { DB } from '../db/index.js';
import { lessonHands, users } from '../db/schema.js';
import { getSession } from './lessons.js';
import { resolveClass } from './classes.js';

/**
 * «Поднять руку» (task 2Б, 2026-10-10).
 *
 * A hand belongs to the lesson that is running, exactly like a comment: it is keyed by the session,
 * so it cannot be carried into the next lesson, and lowering it DELETEs the row instead of marking
 * one — a finished lesson keeps no list of who wanted to speak, and there is no state to clean up.
 *
 * `granted_at` is the teacher's «дать слово». It is only a fact about the lesson; what actually
 * lets the student talk is the LiveKit permission computed from it in `services/lessons.ts`
 * (`floorPermission`), because a remote unmute is refused by LiveKit and the student's own client
 * has to do that part.
 *
 * Access is decided through `resolveClass` — the same reasoning as comments and moderation, which
 * is why a foreign session and a nonexistent one answer identically (both `null`, both a 404).
 */

export interface HandRow {
  userId: string;
  name: string;
  raisedAt: string;
  grantedAt: string | null;
}

const displayName = sql<string>`concat_ws(' ', ${users.name}, nullif(${users.lastName}, ''))`;

export async function handAccess(
  db: DB, userId: string, role: 'teacher' | 'student', sessionId: string,
): Promise<{ sessionId: string; roomName: string; lectureMode: boolean; endedAt: Date | null; isTeacher: boolean } | null> {
  const s = await getSession(db, sessionId);
  if (!s) return null;
  const cls = await resolveClass(db, userId, role, s.classId);
  if (!cls) return null;
  return { sessionId: s.id, roomName: s.roomName, lectureMode: s.lectureMode, endedAt: s.endedAt, isTeacher: role === 'teacher' };
}

/**
 * Raise — or re-raise — a hand. `on conflict do update` resets the timestamp only, so tapping the
 * button twice cannot produce a second queue entry and cannot lose a floor the teacher already
 * gave. Returns the row, so the caller can broadcast it.
 */
export async function raiseHand(db: DB, sessionId: string, userId: string): Promise<HandRow | null> {
  const [row] = await db.insert(lessonHands)
    .values({ sessionId, userId, raisedAt: new Date(), grantedAt: null })
    .onConflictDoUpdate({
      target: [lessonHands.sessionId, lessonHands.userId],
      set: { raisedAt: new Date() },
    })
    .returning({ userId: lessonHands.userId, raisedAt: lessonHands.raisedAt, grantedAt: lessonHands.grantedAt });
  if (!row) return null;
  return {
    userId: row.userId, name: await nameOf(db, userId),
    raisedAt: row.raisedAt.toISOString(),
    grantedAt: row.grantedAt ? row.grantedAt.toISOString() : null,
  };
}

/** Lower a hand. Only the owner's row is addressable, so "not yours" is a 404, not a 403. */
export async function lowerHand(db: DB, sessionId: string, userId: string): Promise<boolean> {
  const [r] = await db.delete(lessonHands)
    .where(and(eq(lessonHands.sessionId, sessionId), eq(lessonHands.userId, userId)))
    .returning({ id: lessonHands.id });
  return Boolean(r);
}

/** The whole queue, oldest first — the teacher's list and a reconnecting client's starting point. */
export async function listHands(db: DB, sessionId: string): Promise<HandRow[]> {
  const rows = await db
    .select({
      userId: lessonHands.userId, name: displayName,
      raisedAt: lessonHands.raisedAt, grantedAt: lessonHands.grantedAt,
    })
    .from(lessonHands)
    .innerJoin(users, eq(users.id, lessonHands.userId))
    .where(eq(lessonHands.sessionId, sessionId))
    .orderBy(asc(lessonHands.raisedAt));
  return rows.map((r) => ({
    userId: r.userId, name: r.name,
    raisedAt: r.raisedAt.toISOString(),
    grantedAt: r.grantedAt ? r.grantedAt.toISOString() : null,
  }));
}

/**
 * Mark / unmark the floor. Both are keyed by "this person has a hand up": a queue entry that does
 * not exist is `false`, which the route answers as the same 404 an unknown id gets — the teacher
 * grants the floor to somebody who asked, never to a typed-in uuid. Both are idempotent, so the
 * route may re-apply the LiveKit permission on every call without a double-grant state.
 */
export async function setFloor(db: DB, sessionId: string, userId: string, on: boolean): Promise<boolean> {
  const [r] = await db.update(lessonHands)
    .set({ grantedAt: on ? new Date() : null })
    .where(and(eq(lessonHands.sessionId, sessionId), eq(lessonHands.userId, userId)))
    .returning({ userId: lessonHands.userId });
  return Boolean(r);
}

/** Teacher: everyone down at once. Returns the rows that had the floor, so their permission is put back. */
export async function lowerAll(db: DB, sessionId: string): Promise<{ cleared: number; hadFloor: string[] }> {
  const gone = await db.delete(lessonHands)
    .where(eq(lessonHands.sessionId, sessionId))
    .returning({ userId: lessonHands.userId, grantedAt: lessonHands.grantedAt });
  return {
    cleared: gone.length,
    hadFloor: gone.filter((g) => g.grantedAt).map((g) => g.userId as string),
  };
}

/** Lesson over: the queue is gone. Called from `endLesson` — the floor is a live-lesson thing. */
export async function clearHands(db: DB, sessionId: string): Promise<number> {
  const gone = await db.delete(lessonHands).where(eq(lessonHands.sessionId, sessionId)).returning({ id: lessonHands.id });
  return gone.length;
}

async function nameOf(db: DB, userId: string): Promise<string> {
  const [u] = await db.select({ name: displayName }).from(users).where(eq(users.id, userId)).limit(1);
  return u?.name ?? '';
}
