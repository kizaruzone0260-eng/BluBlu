/**
 * Part 3 — forgotten password & sessions. Proves the full lifecycle:
 *  • a teacher resets a student's password → the student gets mustChangePassword
 *    on login and is forced to change it before the app unlocks;
 *  • changing your own password verifies the CURRENT one (wrong → 403, weak →
 *    400), clears the flag, revokes every OTHER refresh session and re-issues a
 *    fresh one for the device that just acted;
 *  • "logout-all" revokes ALL refresh sessions and clears the cookie;
 *  • a password change / reset never logs the plaintext anywhere (audit target
 *    carries no password).
 * The per-class rights (teacher cannot reset a foreign class → 404) are asserted
 * in rights.test.ts; here we focus on the mechanics.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { TEST_DATABASE_URL, preparedDb, makeTeacher, type TestDB } from './util.js';
import { buildApp } from '../../src/app.js';
import { env } from '../../src/env.js';
import { users, classes, classMembers, inviteCodes, refreshTokens, auditLog } from '../../src/db/schema.js';
import { hashPassword, TEMP_ALPHABET, TEMP_PASSWORD_LENGTH } from '../../src/lib/password.js';
import { hashInviteCode } from '../../src/lib/invite.js';
import type { FastifyInstance } from 'fastify';

const suite = TEST_DATABASE_URL ? describe : describe.skip;
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const genCode = () => Array.from({ length: 8 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join('');
const PW = 'Passw0rd123';

suite('Part 3: passwords & sessions', () => {
  let t: TestDB; let app: FastifyInstance;

  async function loginAs(email: string, password: string) {
    const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } });
    const cookie = r.headers['set-cookie'];
    return {
      res: r,
      accessToken: (r.json().accessToken as string) ?? '',
      user: r.json().user as { id: string; mustChangePassword: boolean },
      cookie: Array.isArray(cookie) ? cookie.map((c) => String(c).split(';')[0]).join('; ') : String(cookie ?? '').split(';')[0],
    };
  }
  const bearer = (tok: string) => ({ authorization: `Bearer ${tok}` });

  beforeAll(async () => {
    t = await preparedDb(TEST_DATABASE_URL);
    env.RATE_LOGIN_MAX = 500; // many intentional logins in this file — relax the per-IP cap
    app = await buildApp(t.db);
  });
  afterAll(async () => { await app?.close(); await t?.sql.end(); });

  it('/api/me + login expose mustChangePassword=false for a normal account', async () => {
    const te = await makeTeacher(t.sql, `p3a${Date.now()}@x.io`);
    const l = await loginAs(te.email, PW);
    expect(l.res.statusCode).toBe(200);
    expect(l.user.mustChangePassword).toBe(false);
    const me = await app.inject({ method: 'GET', url: '/api/me', headers: bearer(l.accessToken) });
    expect(me.json().mustChangePassword).toBe(false);
  });

  it('teacher reset issues a temp password → student mustChangePassword=true on login', async () => {
    const te = await makeTeacher(t.sql, `p3r${Date.now()}@x.io`);
    const l = await loginAs(te.email, PW);
    const [cls] = await t.db.insert(classes).values({ teacherId: te.id, name: 'Reset class' }).returning();
    // create a student directly (row insert) and add membership
    const stuId = crypto.randomUUID();
    const stuEmail = `p3s${Date.now()}@x.io`;
    await t.sql`insert into users (id, role, name, last_name, email, password_hash, locale, tz, created_at)
                values (${stuId}, 'student', 'Sam', 'Test', ${stuEmail}, ${await hashPassword(PW)}, 'ru', 'Asia/Tashkent', now())`;
    await t.db.insert(classMembers).values({ classId: cls!.id, userId: stuId });

    const reset = await app.inject({
      method: 'POST', url: `/api/classes/${cls!.id}/members/${stuId}/reset-password`,
      headers: bearer(l.accessToken),
    });
    expect(reset.statusCode).toBe(200);
    const temp = reset.json().tempPassword as string;
    expect(typeof temp).toBe('string');
    // B3 (2026-10-16): длина перестала быть «не короче 8» — генератор теперь один
    // (`lib/password.ts::tempPassword`, 12 знаков, алфавит без неоднозначных), и им пользуются
    // и маршрут учителя, и скрипт владельца. Раньше это были две функции с разной длиной
    // (10 и 12), и тест этого не замечал.
    expect(temp).toHaveLength(TEMP_PASSWORD_LENGTH);
    expect([...temp].every((c) => TEMP_ALPHABET.includes(c)), `неалфавитный знак в «${temp}»`).toBe(true);

    // the old password no longer works; the temp one does, and flags the gate
    const old = await loginAs(stuEmail, PW);
    expect(old.res.statusCode).toBe(401);
    const nu = await loginAs(stuEmail, temp);
    expect(nu.res.statusCode).toBe(200);
    expect(nu.user.mustChangePassword).toBe(true);
    const me = await app.inject({ method: 'GET', url: '/api/me', headers: bearer(nu.accessToken) });
    expect(me.json().mustChangePassword).toBe(true);

    // audit records the reset WITHOUT the plaintext temp password anywhere
    const rows = await t.db.select().from(auditLog).where(eq(auditLog.action, 'reset_password'));
    const forStudent = rows.find((r) => (r.target as { userId?: string }).userId === stuId);
    expect(forStudent).toBeTruthy();
    expect(JSON.stringify(rows)).not.toContain(temp);
  });

  it('change-password: wrong current → 403 wrongPassword', async () => {
    const te = await makeTeacher(t.sql, `p3w${Date.now()}@x.io`);
    const l = await loginAs(te.email, PW);
    const r = await app.inject({
      method: 'POST', url: '/api/me/change-password', headers: bearer(l.accessToken),
      payload: { current: 'notthepassword', next: 'FreshPassword9' },
    });
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toBe('wrongPassword');
  });

  it('change-password: weak new password → 400 passwordTooWeak (policy, not just length)', async () => {
    const te = await makeTeacher(t.sql, `p3q${Date.now()}@x.io`);
    const l = await loginAs(te.email, PW);
    const r = await app.inject({
      method: 'POST', url: '/api/me/change-password', headers: bearer(l.accessToken),
      payload: { current: PW, next: 'short' },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe('passwordTooWeak');
  });

  it('change-password success: clears flag, revokes other sessions, keeps this device signed in', async () => {
    const te = await makeTeacher(t.sql, `p3ok${Date.now()}@x.io`);
    // session on "device A"
    const a = await loginAs(te.email, PW);
    // another refresh session on "device B"
    const b = await loginAs(te.email, PW);
    const sessionsBefore = await t.db.select().from(refreshTokens).where(eq(refreshTokens.userId, te.id));
    expect(sessionsBefore.length).toBeGreaterThanOrEqual(2);

    const ch = await app.inject({
      method: 'POST', url: '/api/me/change-password', headers: bearer(a.accessToken),
      payload: { current: PW, next: 'FreshPassword9' },
    });
    expect(ch.statusCode).toBe(200);
    expect(ch.json()).toEqual({ ok: true });

    // the change deletes ALL prior refresh rows, then re-issues exactly ONE for
    // this device. Assert the count BEFORE the verification logins below add
    // their own sessions.
    const rowsAfterChange = await t.db.select().from(refreshTokens).where(eq(refreshTokens.userId, te.id));
    expect(rowsAfterChange.filter((r) => !r.replacedAt).length).toBe(1);

    // the new password works; mustChangePassword is now false
    const after = await loginAs(te.email, 'FreshPassword9');
    expect(after.res.statusCode).toBe(200);
    expect(after.user.mustChangePassword).toBe(false);
    // the OLD password is dead
    expect((await loginAs(te.email, PW)).res.statusCode).toBe(401);

    // audit logs the change without the new plaintext
    const aud = JSON.stringify(await t.db.select().from(auditLog).where(eq(auditLog.action, 'password_changed')));
    expect(aud).not.toContain('FreshPassword9');
    expect(b.cookie).toBeTruthy(); // sanity: the other login did obtain a cookie
  });

  it('logout-all revokes every refresh session and clears the cookie', async () => {
    const te = await makeTeacher(t.sql, `p3la${Date.now()}@x.io`);
    await loginAs(te.email, PW);
    const l = await loginAs(te.email, PW);
    expect((await t.db.select().from(refreshTokens).where(eq(refreshTokens.userId, te.id))).length).toBeGreaterThanOrEqual(2);

    const out = await app.inject({ method: 'POST', url: '/api/auth/logout-all', headers: bearer(l.accessToken) });
    expect(out.statusCode).toBe(200);
    expect(out.json()).toEqual({ ok: true });
    // every session is gone
    expect(await t.db.select().from(refreshTokens).where(eq(refreshTokens.userId, te.id))).toHaveLength(0);
    // cookie cleared
    const sc = out.headers['set-cookie'];
    const cleared = Array.isArray(sc) ? sc.some((c) => /klass_rt=;/.test(String(c))) : /klass_rt=;/.test(String(sc ?? ''));
    expect(cleared).toBe(true);
  });

  it('a fresh invite-code registration is NOT flagged mustChangePassword (only resets are)', async () => {
    const te = await makeTeacher(t.sql, `p3reg${Date.now()}@x.io`);
    const [cls] = await t.db.insert(classes).values({ teacherId: te.id, name: 'Reg' }).returning();
    const code = genCode();
    await t.db.insert(inviteCodes).values({
      classId: cls!.id, codeHash: hashInviteCode(code, process.env.JWT_SECRET!),
      createdBy: te.id, expiresAt: new Date(Date.now() + 86400000),
    });
    const r = await app.inject({
      method: 'POST', url: '/api/auth/register',
      payload: { firstName: 'New', lastName: 'Pupil', email: `p3nu${Date.now()}@x.io`, password: 'Secret12345', code },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().user.mustChangePassword).toBe(false);
  });

  it('users table: must_change_password defaults false (column exists)', async () => {
    const te = await makeTeacher(t.sql, `p3col${Date.now()}@x.io`);
    const [u] = await t.db.select().from(users).where(eq(users.id, te.id));
    expect(u!.mustChangePassword).toBe(false);
  });

  it('owner reset-teacher.mjs resets a teacher to a random temp + forces change', async () => {
    const te = await makeTeacher(t.sql, `p3own${Date.now()}@x.io`);
    // run the ACTUAL owner script against this migrated DB
    const out = execFileSync(
      process.execPath,
      ['scripts/reset-teacher.mjs', te.email],
      { cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'), env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL }, encoding: 'utf8' },
    );
    const lines = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    const temp = lines[1]; // "Temporary password for …", <pw>, "(shown once…)"
    expect(typeof temp).toBe('string');
    expect(temp.length).toBeGreaterThanOrEqual(10);

    // the DB row is flagged and the old password is dead
    const [u] = await t.db.select().from(users).where(eq(users.id, te.id));
    expect(u!.mustChangePassword).toBe(true);
    expect((await loginAs(te.email, PW)).res.statusCode).toBe(401);
    const l = await loginAs(te.email, temp);
    expect(l.res.statusCode).toBe(200);
    expect(l.user.mustChangePassword).toBe(true);

    // an owner_reset_password audit row exists and never carries the plaintext
    const aud = JSON.stringify(await t.db.select().from(auditLog).where(eq(auditLog.action, 'owner_reset_password')));
    expect(aud).toContain(te.id);
    expect(aud).not.toContain(temp);
  });
});
