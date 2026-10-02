import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TEST_DATABASE_URL, preparedDb, makeTeacher, type TestDB } from './util';
import { createInviteCode, redeemInviteCode, revokeInviteCode } from '../../src/services/invites';
import { classes } from '../../src/db/schema';

/**
 * ACCEPTANCE STAGE 1: one-time code cannot be reused.
 * 20 parallel redeem requests for the SAME code — exactly one may win.
 * Requires a real Postgres (Docker): export DATABASE_URL_TEST, else skipped.
 */
const suite = TEST_DATABASE_URL ? describe : describe.skip;

suite('invite code atomicity', () => {
  let t: TestDB;
  let classId = '';
  let teacherId = '';
  const userIds: string[] = [];

  beforeAll(async () => {
    t = await preparedDb(TEST_DATABASE_URL);
    const teacher = await makeTeacher(t.sql);
    teacherId = teacher.id;
    const [cls] = await t.db.insert(classes)
      .values({ teacherId, name: 'R11', description: '', color: '#000000' })
      .returning();
    classId = cls!.id;
    for (let i = 0; i < 20; i++) {
      const id = crypto.randomUUID();
      userIds.push(id);
      await t.sql`insert into users (id, role, name, email, password_hash, locale, tz, created_at)
                  values (${id}, 'student', ${'S' + i}, ${`s${i}@x.io`}, 'x', 'ru', 'UTC', now())`;
    }
  });

  afterAll(async () => { await t?.sql.end(); });

  it('exactly one of 20 concurrent redemptions succeeds', async () => {
    const inv = await createInviteCode(t.db, classId, teacherId, 7);
    const results = await Promise.all(userIds.map((u) => redeemInviteCode(t.db, inv.code, u)));
    const winners = results.filter((r) => r.ok);
    expect(winners).toHaveLength(1);
    expect(winners[0]!.classId).toBe(classId);
    // a 21st attempt fails too
    const again = await redeemInviteCode(t.db, inv.code, userIds[0]!);
    expect(again.ok).toBe(false);
  });

  it('expired code never redeems', async () => {
    const inv = await createInviteCode(t.db, classId, teacherId, 1);
    await t.sql`update invite_codes set expires_at = now() - interval '1 hour' where id = ${inv.id}`;
    const r = await redeemInviteCode(t.db, inv.code, userIds[0]!);
    expect(r.ok).toBe(false);
  });

  it('revoked code never redeems', async () => {
    const inv = await createInviteCode(t.db, classId, teacherId, 7);
    await revokeInviteCode(t.db, inv.id, classId);
    const r = await redeemInviteCode(t.db, inv.code, userIds[1]!);
    expect(r.ok).toBe(false);
  });
});
