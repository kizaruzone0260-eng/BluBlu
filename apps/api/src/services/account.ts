import { eq } from 'drizzle-orm';
import {
  users, refreshTokens, wsTickets, chatWsTickets, chatMessages, chatReads, chatMutes,
  lessonComments, lessonCommentReads, lessonCommentMutes, lessonHands, lessonAttendance,
  studentNotes, teacherNotes, telegramLinks, telegramTokens, icsTokens, notificationPrefs,
  notifications, policyAcceptances, classMembers, loginAttempts,
} from '../db/schema.js';
import type { DB } from '../db/index.js';

/** Neutral, language-independent display name substituted on erasure. */
export const DELETED_NAME = 'Deleted user';

/**
 * Part 1(в) — account erasure (right to be forgotten) in ONE transaction.
 *
 * Policy (docs/HARDENING.md §1п):
 *  • PERSONAL, non-attributed data DISAPPEARS: the user's chat messages and their
 *    chat read/mute/ticket state, private notes and sheets, Telegram link + one-time
 *    login tokens, refresh/WS/ICS tokens, notification prefs + queued notifications,
 *    the privacy/Terms consent row, class memberships, and the brute-force counter.
 *  • CLASS content the user authored (teaching materials, files, class ownership) is
 *    KEPT so classmates don't lose shared resources — but the author IDENTITY is
 *    anonymized on the users row (every read joins users.name/last_name), so those
 *    posts/files/lessons now surface as «Deleted user». The email is rewritten to an
 *    unresolvable deleted-<id>@invalid.local and the row is soft-deleted.
 *
 * The users row is never hard-deleted because NOT-NULL FKs (classes.teacher_id,
 * posts.author_id, files.uploaded_by …) would orphan shared content; identity
 * anonymization + targeted row removal is the referentially-safe equivalent.
 */
export async function eraseAccount(db: DB, userId: string): Promise<void> {
  const [u] = await db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const priorEmail = (u?.email ?? '').toLowerCase();

  await db.transaction(async (tx) => {
    // chat — the person's own messages vanish; read/mute/ticket state too
    await tx.delete(chatMessages).where(eq(chatMessages.authorId, userId));
    await tx.delete(chatReads).where(eq(chatReads.userId, userId));
    await tx.delete(chatMutes).where(eq(chatMutes.userId, userId));
    await tx.delete(chatWsTickets).where(eq(chatWsTickets.userId, userId));
    // lesson comments (task 2, 2026-10-09): same rule as the class chat — the person's own words
    // go physically (a SOFT delete would keep them), and so does their read/mute state.
    await tx.delete(lessonComments).where(eq(lessonComments.authorId, userId));
    await tx.delete(lessonCommentReads).where(eq(lessonCommentReads.userId, userId));
    await tx.delete(lessonCommentMutes).where(eq(lessonCommentMutes.userId, userId));
    // raise-hand queue (task 2Б): a row is «this person wanted to speak in that lesson» — personal
    // enough to go with the account, and it would otherwise outlive every lesson they were in.
    await tx.delete(lessonHands).where(eq(lessonHands.userId, userId));
    // Часть 4 (2026-10-14): «кто когда был на уроке» — те же персональные данные, что и слова в
    // чате: строки присутствия удаляются физически. Каскад по FK тут НЕ спасает: строка `users`
    // не стирается (её держат NOT-NULL ссылки), а значит `on delete cascade` никогда не срабатывает,
    // и без этой строки время прихода и ухода умершего аккаунта жило бы вечно.
    await tx.delete(lessonAttendance).where(eq(lessonAttendance.userId, userId));
    // notes / sheets (private by design)
    await tx.delete(studentNotes).where(eq(studentNotes.userId, userId));
    await tx.delete(teacherNotes).where(eq(teacherNotes.teacherId, userId));
    // Telegram link + one-time login tokens
    await tx.delete(telegramLinks).where(eq(telegramLinks.userId, userId));
    await tx.delete(telegramTokens).where(eq(telegramTokens.userId, userId));
    // every kind of session/token
    await tx.delete(refreshTokens).where(eq(refreshTokens.userId, userId));
    await tx.delete(wsTickets).where(eq(wsTickets.userId, userId));
    await tx.delete(icsTokens).where(eq(icsTokens.userId, userId));
    // preferences, queued notifications, consent record
    await tx.delete(notificationPrefs).where(eq(notificationPrefs.userId, userId));
    await tx.delete(notifications).where(eq(notifications.userId, userId));
    await tx.delete(policyAcceptances).where(eq(policyAcceptances.userId, userId));
    // leave every class (the person stops appearing in member lists)
    await tx.delete(classMembers).where(eq(classMembers.userId, userId));
    // brute-force counter keyed by the (about to change) email
    if (priorEmail) await tx.delete(loginAttempts).where(eq(loginAttempts.email, priorEmail));
    // anonymize the identity — attributed content then reads as «Deleted user»
    await tx
      .update(users)
      .set({
        deletedAt: new Date(),
        email: `deleted-${userId}@invalid.local`,
        name: DELETED_NAME,
        lastName: '',
        mustChangePassword: false,
        profileCompletedAt: null,
      })
      .where(eq(users.id, userId));
  });
}
