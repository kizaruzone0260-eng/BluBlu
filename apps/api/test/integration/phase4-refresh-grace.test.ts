/**
 * Part 4б — refresh rotation grace vs. a slow (stalled) rotation response.
 *
 * Scenario a real browser hits: the /refresh POST rotates the cookie, but the
 * RESPONSE is slow (up to ~3 s on a bad network) while the page reloads, so the
 * client replays the now-stale token AFTER the grace window has closed. We prove:
 *  • at the OLD production value (2 s) a 3-s-delayed replay trips the reuse-theft
 *    kill and the session DIES — i.e. 2 s is NOT safe for a 3 s stall;
 *  • at 5 s the same replay HEALS the session (the benign reload survives);
 *  • the shipped default (and, after this task, the production clamp) is 5 s, so
 *    a normal user on a slow link is not logged out.
 *
 * This is the justification for reverting the production grace to 5 s in env.ts.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { TEST_DATABASE_URL, preparedDb, makeTeacher, type TestDB } from './util.js';
import { env } from '../../src/env.js';
import { issueRefreshSession, rotateRefresh } from '../../src/services/auth.js';
import { refreshTokens } from '../../src/db/schema.js';

const suite = TEST_DATABASE_URL ? describe : describe.skip;

suite('Part 4б: refresh-reuse grace vs. a stalled rotation', () => {
  let t: TestDB;
  let uid = '';
  const prevGrace = env.REFRESH_REUSE_GRACE_MS;

  beforeAll(async () => {
    t = await preparedDb(TEST_DATABASE_URL);
    const te = await makeTeacher(t.sql, `grace${Date.now()}@x.io`);
    uid = te.id;
  });
  afterAll(async () => { env.REFRESH_REUSE_GRACE_MS = prevGrace; await t?.sql.end(); });

  async function clearFamily() { await t.db.delete(refreshTokens).where(eq(refreshTokens.userId, uid)); }
  // age the rotated token's replaced_at so a replay looks like it landed `sec` later
  async function backdateReplacedAt(sec: number) {
    await t.sql`update refresh_tokens set replaced_at = now() - (${sec} * interval '1 second')
                where user_id = ${uid} and replaced_at is not null`;
  }

  it('the shipped default grace is ≥ 3 s (survives a stalled rotation)', () => {
    expect(prevGrace).toBeGreaterThanOrEqual(3000);
  });

  it('2 s grace: a 3-s-delayed stale replay KILLS the family (session dies)', async () => {
    await clearFamily();
    const a = await issueRefreshSession(t.db, uid);
    const rot = await rotateRefresh(t.db, a.refreshToken); // token a → replaced, successor issued
    expect(rot.ok).toBe(true);
    await backdateReplacedAt(3); // the rotation response arrived 3 s late

    env.REFRESH_REUSE_GRACE_MS = 2000; // the OLD production value
    const replay = await rotateRefresh(t.db, a.refreshToken); // client retries the stale cookie
    expect(replay.ok).toBe(false);
    if (!replay.ok) expect(replay.reason).toBe('reused');

    // theft kill wiped the WHOLE family — the successor is gone too, so the user
    // is logged out: at 2 s a 3 s stall is fatal.
    const left = await t.db.select().from(refreshTokens).where(eq(refreshTokens.userId, uid));
    expect(left).toHaveLength(0);
  });

  it('5 s grace: the SAME 3-s-delayed replay HEALS the session (survives)', async () => {
    await clearFamily();
    const a = await issueRefreshSession(t.db, uid);
    const rot = await rotateRefresh(t.db, a.refreshToken);
    expect(rot.ok).toBe(true);
    await backdateReplacedAt(3);

    env.REFRESH_REUSE_GRACE_MS = 5000; // the reverted production value
    const replay = await rotateRefresh(t.db, a.refreshToken);
    expect(replay.ok).toBe(true); // benign reload absorbed inside the window
    if (replay.ok) {
      // a fresh active successor exists → the user is still signed in
      const live = await t.db.select().from(refreshTokens)
        .where(eq(refreshTokens.userId, uid));
      expect(live.some((r) => r.replacedAt === null)).toBe(true);
    }
  });

  it('5 s grace still kills a LATE theft replay (beyond the window)', async () => {
    await clearFamily();
    const a = await issueRefreshSession(t.db, uid);
    await rotateRefresh(t.db, a.refreshToken);
    await backdateReplacedAt(6); // replay 6 s later — outside the 5 s window

    env.REFRESH_REUSE_GRACE_MS = 5000;
    const stolen = await rotateRefresh(t.db, a.refreshToken);
    expect(stolen.ok).toBe(false); // window closed ⇒ strict theft behaviour returns
    const left = await t.db.select().from(refreshTokens).where(eq(refreshTokens.userId, uid));
    expect(left).toHaveLength(0);
  });
});
