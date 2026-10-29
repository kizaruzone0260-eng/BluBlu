/**
 * Part 1(в) — account-deletion erasure (right to be forgotten). Seeds a STUDENT
 * with data in every category the task enumerates — chat, private notes, a
 * Telegram link, every token kind, prefs/notifications and the consent record —
 * then DELETEs the account and asserts each one DISAPPEARS and the identity is
 * ANONYMIZED. A second case proves a TEACHER's authored class content (post +
 * file) is KEPT for classmates but surfaced under the anonymized «Deleted user».
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { TEST_DATABASE_URL, preparedDb, makeTeacher, type TestDB } from './util.js';
import { buildApp } from '../../src/app.js';
import { env } from '../../src/env.js';
import { DELETED_NAME } from '../../src/services/account.js';
import { PRIVACY_VERSION, TERMS_VERSION } from '@klass/shared';
import { issueRefreshSession } from '../../src/services/auth.js';
import { startLesson } from '../../src/services/lessons.js';
import { hashPassword } from '../../src/lib/password.js';
import {
  users, classes, classMembers, chatMessages, chatReads, chatMutes, chatWsTickets,
  studentNotes, telegramLinks, telegramTokens, icsTokens, notificationPrefs, notifications,
  policyAcceptances, refreshTokens, wsTickets, loginAttempts, posts, files,
} from '../../src/db/schema.js';
import type { FastifyInstance } from 'fastify';

const suite = TEST_DATABASE_URL ? describe : describe.skip;
const PW = 'Passw0rd123';

suite('Part 1(в): account-deletion erasure', () => {
  let t: TestDB; let app: FastifyInstance;
  let teacherId = '', teacherTok = '', classId = '', sessionId = '';
  let stuId = '', stuEmail = '', stuTok = '';

  async function loginAs(email: string, password: string) {
    const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } });
    return (r.json().accessToken as string) ?? '';
  }

  beforeAll(async () => {
    t = await preparedDb(TEST_DATABASE_URL);
    env.RATE_LOGIN_MAX = 500;
    app = await buildApp(t.db);

    const te = await makeTeacher(t.sql, `er-t${Date.now()}@x.io`);
    teacherId = te.id; teacherTok = await loginAs(te.email, PW);
    const [cls] = await t.db.insert(classes).values({ teacherId, name: 'Erasure class' }).returning();
    classId = cls!.id;

    stuId = crypto.randomUUID(); stuEmail = `er-s${Date.now()}@x.io`.toLowerCase();
    await t.sql`insert into users (id, role, name, last_name, email, password_hash, locale, tz, created_at)
                values (${stuId}, 'student', 'Erased', 'Pupil', ${stuEmail}, ${await hashPassword(PW)}, 'ru', 'Asia/Tashkent', now())`;

    const ses = await startLesson(t.db, teacherId, classId); sessionId = ses.id;
    stuTok = await loginAs(stuEmail, PW);
  });
  afterAll(async () => { await app?.close(); await t?.sql.end(); });

  it('removes every personal category and anonymizes the account', async () => {
    // seed personal rows across all five categories (all reference stuId)
    await t.db.insert(classMembers).values({ classId, userId: stuId });
    await t.db.insert(chatMessages).values({ classId, authorId: stuId, text: 'secret homework?' });
    await t.db.insert(chatReads).values({ userId: stuId, classId });
    await t.db.insert(chatMutes).values({ classId, userId: stuId, mutedBy: teacherId });
    await t.db.insert(chatWsTickets).values({ tokenHash: 'cw-'+stuId, userId: stuId, classId, expiresAt: new Date(Date.now()+30_000) });
    await t.db.insert(studentNotes).values({ userId: stuId, classId, title: 'private', body: 'my grades' });
    await t.db.insert(telegramLinks).values({ userId: stuId, chatId: 'tg-'+stuId });
    await t.db.insert(telegramTokens).values({ tokenHash: 'tt-'+stuId, userId: stuId, expiresAt: new Date(Date.now()+900_000) });
    await t.db.insert(icsTokens).values({ userId: stuId, tokenHash: 'ics-'+stuId });
    await t.db.insert(notificationPrefs).values({ userId: stuId });
    await t.db.insert(notifications).values({ kind: 'post', userId: stuId, classId, payload: { a: 1 }, dedupeKey: 'nd-'+stuId });
    await t.db.insert(policyAcceptances).values({ userId: stuId, version: PRIVACY_VERSION, privacyVersion: PRIVACY_VERSION, termsVersion: TERMS_VERSION, context: 'legacy' });
    await issueRefreshSession(t.db, stuId);
    await t.db.insert(wsTickets).values({ tokenHash: 'ws-'+stuId, userId: stuId, sessionId, expiresAt: new Date(Date.now()+30_000) });
    await t.db.insert(loginAttempts).values({ email: stuEmail, failCount: 3 });

    // sanity: the data is present before deletion
    expect((await t.db.select().from(chatMessages).where(eq(chatMessages.authorId, stuId))).length).toBe(1);

    const del = await app.inject({ method: 'DELETE', url: '/api/me', headers: { authorization: `Bearer ${stuTok}` } });
    expect(del.statusCode).toBe(200);

    const gone: [string, Promise<unknown[]>[]] = ['x', [
      t.db.select().from(chatMessages).where(eq(chatMessages.authorId, stuId)),
      t.db.select().from(chatReads).where(eq(chatReads.userId, stuId)),
      t.db.select().from(chatMutes).where(eq(chatMutes.userId, stuId)),
      t.db.select().from(chatWsTickets).where(eq(chatWsTickets.userId, stuId)),
      t.db.select().from(studentNotes).where(eq(studentNotes.userId, stuId)),
      t.db.select().from(telegramLinks).where(eq(telegramLinks.userId, stuId)),
      t.db.select().from(telegramTokens).where(eq(telegramTokens.userId, stuId)),
      t.db.select().from(icsTokens).where(eq(icsTokens.userId, stuId)),
      t.db.select().from(notificationPrefs).where(eq(notificationPrefs.userId, stuId)),
      t.db.select().from(notifications).where(eq(notifications.userId, stuId)),
      t.db.select().from(policyAcceptances).where(eq(policyAcceptances.userId, stuId)),
      t.db.select().from(refreshTokens).where(eq(refreshTokens.userId, stuId)),
      t.db.select().from(wsTickets).where(eq(wsTickets.userId, stuId)),
      t.db.select().from(classMembers).where(eq(classMembers.userId, stuId)),
      t.db.select().from(loginAttempts).where(eq(loginAttempts.email, stuEmail)),
    ]];
    for (const rows of gone[1]) expect((await rows).length, 'personal rows erased').toBe(0);

    // the identity is anonymized (row kept for FK integrity, PII removed)
    const [u] = await t.db.select().from(users).where(eq(users.id, stuId));
    expect(u!.deletedAt).not.toBeNull();
    expect(u!.name).toBe(DELETED_NAME);
    expect(u!.lastName).toBe('');
    expect(u!.email).toBe(`deleted-${stuId}@invalid.local`);

    // the teacher no longer sees the student in the member list
    const members = await app.inject({ method: 'GET', url: `/api/classes/${classId}/members`, headers: { authorization: `Bearer ${teacherTok}` } });
    expect(members.json().some((m: { userId: string }) => m.userId === stuId)).toBe(false);

    // the erased session cannot be revived: the access token's subject has no refresh token
    expect((await t.db.select().from(refreshTokens).where(eq(refreshTokens.userId, stuId))).length).toBe(0);
  });

  it('keeps a teacher\'s authored class content but anonymizes the author', async () => {
    const te = await makeTeacher(t.sql, `er-t2${Date.now()}@x.io`);
    const tok = await loginAs(te.email, PW);
    const [cls] = await t.db.insert(classes).values({ teacherId: te.id, name: 'Kept class' }).returning();
    const [post] = await t.db.insert(posts).values({ classId: cls!.id, authorId: te.id, kind: 'material', title: 'Worksheet', body: 'do pages 1-5' }).returning();
    await t.db.insert(files).values({ postId: post!.id, storageKey: 'sk-'+post!.id, originalName: 'w.pdf', mime: 'application/pdf', size: 1234, uploadedBy: te.id });

    const del = await app.inject({ method: 'DELETE', url: '/api/me', headers: { authorization: `Bearer ${tok}` } });
    expect(del.statusCode).toBe(200);

    // shared content survives (classmates keep it)
    const p = await t.db.select().from(posts).where(eq(posts.id, post!.id));
    expect(p.length).toBe(1);
    expect((await t.db.select().from(files).where(eq(files.postId, post!.id))).length).toBe(1);
    const cls2 = await t.db.select().from(classes).where(eq(classes.id, cls!.id));
    expect(cls2.length).toBe(1);
    // but the author identity is gone
    const [u] = await t.db.select().from(users).where(eq(users.id, te.id));
    expect(u!.name).toBe(DELETED_NAME);
    expect(u!.deletedAt).not.toBeNull();
  });
});
