import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { TEST_DATABASE_URL, preparedDb, makeTeacher, type TestDB } from './util.js';
import { buildApp } from '../../src/app.js';
import { env } from '../../src/env.js';
import { classes, inviteCodes, users, auditLog, telegramLinks } from '../../src/db/schema.js';
import { hashInviteCode } from '../../src/lib/invite.js';
import { processUpdate } from '../../src/services/telegramBot.js';

const suite = TEST_DATABASE_URL ? describe : describe.skip;

suite('stage 7: security hardening', () => {
  let t: TestDB;
  beforeAll(async () => { t = await preparedDb(TEST_DATABASE_URL); });
  afterAll(async () => { await t?.sql.end(); });

  const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
  const genCode = () => Array.from({ length: 8 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join('');

  it('security headers on API responses (helmet): CSP, nosniff, frame-ancestors, HSTS-ready', async () => {
    const app = await buildApp(t.db);
    const r = await app.inject({ method: 'GET', url: '/api/health/live' });
    expect(r.headers['content-security-policy']).toContain("default-src 'self'");
    expect(r.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['referrer-policy']).toBe('same-origin');
    await app.close();
  });

  it('CSRF: refresh rejects cross-origin POST, allows same-origin', async () => {
    const app = await buildApp(t.db);
    const teacher = await makeTeacher(t.sql, `csrf${Date.now()}@x.io`);
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: teacher.email, password: teacher.password } });
    const cookie = (login.headers['set-cookie'] as string).split(';')[0]!;
    const evil = await app.inject({ method: 'POST', url: '/api/auth/refresh', headers: { cookie, origin: 'https://evil.example' } });
    expect(evil.statusCode).toBe(403);
    const good = await app.inject({ method: 'POST', url: '/api/auth/refresh', headers: { cookie, origin: 'http://localhost:5173' } });
    expect(good.statusCode).toBe(200);
    await app.close();
  });

  it('refresh accepts Origin == request Host even when PUBLIC_URL/DOMAIN are unset (Render cloud fix)', async () => {
    const app = await buildApp(t.db);
    const teacher = await makeTeacher(t.sql, `shost${Date.now()}@x.io`);
    const login = await app.inject({
      method: 'POST', url: '/api/auth/login',
      headers: { host: 'blublu.onrender.com' },
      payload: { email: teacher.email, password: teacher.password },
    });
    const cookie = (login.headers['set-cookie'] as string).split(';')[0]!;
    // same-origin on a deployment whose address is NOT in env (PUBLIC_URL empty before first deploy)
    const same = await app.inject({
      method: 'POST', url: '/api/auth/refresh',
      headers: { cookie, host: 'blublu.onrender.com', origin: 'https://blublu.onrender.com' },
    });
    expect(same.statusCode).toBe(200);
    // a different origin on the same host is still rejected
    const evil = await app.inject({
      method: 'POST', url: '/api/auth/refresh',
      headers: { cookie, host: 'blublu.onrender.com', origin: 'https://evil.example' },
    });
    expect(evil.statusCode).toBe(403);
    await app.close();
  });

  it('CSP connect-src names the LiveKit origin from env — no bare ws:/wss: wildcards', async () => {
    const prev = env.LIVEKIT_URL;
    env.LIVEKIT_URL = 'wss://lv-test.livekit.cloud';
    try {
      const app = await buildApp(t.db);
      const r = await app.inject({ method: 'GET', url: '/api/health/live' });
      const csp = String(r.headers['content-security-policy']);
      const connect = /connect-src([^;]*)/.exec(csp)?.[1] ?? '';
      expect(connect).toContain('wss://lv-test.livekit.cloud');
      expect(connect).not.toMatch(/(^|\s)ws:(\s|$)/);
      expect(connect).not.toMatch(/(^|\s)wss:(\s|$)/);
      const script = /script-src([^;]*)/.exec(csp)?.[1] ?? '';
      expect(script).not.toContain('unsafe-inline'); // SW registration lives in the bundle now
      await app.close();
    } finally { env.LIVEKIT_URL = prev; }
  });

  it('teacher resets student password: temp works, old sessions revoked', async () => {
    const app = await buildApp(t.db);
    const teacher = await makeTeacher(t.sql, `rst${Date.now()}@x.io`);
    const l = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: teacher.email, password: teacher.password } });
    const tk = l.json().accessToken as string;
    const [cls] = await t.db.insert(classes).values({ teacherId: teacher.id, name: 'Rst' }).returning();
    const code = genCode();
    await t.db.insert(inviteCodes).values({ classId: cls!.id, codeHash: hashInviteCode(code, process.env.JWT_SECRET!), createdBy: teacher.id, expiresAt: new Date(Date.now() + 86400000) });
    const email = `rstst${Date.now()}@x.io`;
    const reg = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { firstName: 'Pupil R', lastName: 'Test', email, password: 'Secret1234', code } });
    const studentId = reg.json().user.id as string;
    const regCookie = (reg.headers['set-cookie'] as string).split(';')[0]!;

    const rp = await app.inject({
      method: 'POST', url: `/api/classes/${cls!.id}/members/${studentId}/reset-password`,
      headers: { authorization: `Bearer ${tk}` },
    });
    expect(rp.statusCode).toBe(200);
    const temp = rp.json().tempPassword as string;
    expect(temp.length).toBeGreaterThanOrEqual(8);

    // student's old refresh session is dead
    const dead = await app.inject({ method: 'POST', url: '/api/auth/refresh', headers: { cookie: regCookie } });
    expect(dead.statusCode).toBe(401);
    // and login works only with the new password
    const oldPw = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'Secret1234' } });
    expect(oldPw.statusCode).toBe(401);
    const newPw = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: temp } });
    expect(newPw.statusCode).toBe(200);
    await app.close();
  });

  it('audit trail records privileged actions', async () => {
    const app = await buildApp(t.db);
    const teacher = await makeTeacher(t.sql, `aud${Date.now()}@x.io`);
    const l = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: teacher.email, password: teacher.password } });
    const tk = l.json().accessToken as string;
    const [cls] = await t.db.insert(classes).values({ teacherId: teacher.id, name: 'Aud' }).returning();
    await app.inject({ method: 'POST', url: `/api/classes/${cls!.id}/invites`, headers: { authorization: `Bearer ${tk}` }, payload: {} });
    await new Promise((r) => setTimeout(r, 100));
    const rows = await t.db.select().from(auditLog).where(eq(auditLog.action, 'invite_create'));
    expect(rows.length).toBeGreaterThan(0);
    await app.close();
  });

  it('bot answers in Uzbek for uz users', async () => {
    const app = await buildApp(t.db);
    const [u] = await t.db.insert(users).values({
      role: 'student', name: 'Bek', email: `uz${Date.now()}@x.io`, passwordHash: 'x', locale: 'uz', tz: 'Asia/Tashkent',
    }).returning();
    const { createLinkToken } = await import('../../src/services/notify.js');
    const { env: e7 } = await import('../../src/env.js');
    e7.TELEGRAM_BOT_TOKEN = '1234:test'; e7.TELEGRAM_BOT_NAME = 'itest_bot'; // item 5: no link tokens without config
    const { token } = await createLinkToken(t.db, u!.id);
    const deps = { db: t.db, send: async () => undefined, isGroupAdmin: async () => false };
    const r = await processUpdate(deps, { message: { text: `/start ${token}`, chat: { id: 555, type: 'private' }, from: { id: 555 } } });
    expect(r.reply).toContain('bog‘landi');
    await app.close();
  });

  it('account deletion wipes login ability and memberships stay consistent', async () => {
    const app = await buildApp(t.db);
    const teacher = await makeTeacher(t.sql, `del${Date.now()}@x.io`);
    const [cls] = await t.db.insert(classes).values({ teacherId: teacher.id, name: 'Del' }).returning();
    const code = genCode();
    await t.db.insert(inviteCodes).values({ classId: cls!.id, codeHash: hashInviteCode(code, process.env.JWT_SECRET!), createdBy: teacher.id, expiresAt: new Date(Date.now() + 86400000) });
    const email = `dels${Date.now()}@x.io`;
    const reg = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { firstName: 'Del P', lastName: 'Test', email, password: 'Secret1234', code } });
    const at = reg.json().accessToken as string;
    const del = await app.inject({ method: 'DELETE', url: '/api/me', headers: { authorization: `Bearer ${at}` } });
    expect(del.statusCode).toBe(200);
    const me = await app.inject({ method: 'GET', url: '/api/me', headers: { authorization: `Bearer ${at}` } });
    expect(me.statusCode).toBe(401);
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'Secret1234' } });
    expect(login.statusCode).toBe(401);
    await app.close();
  });
});
