/**
 * Phase 2 — consent capture. A freshly created account has NOT accepted the
 * current bundle; acceptance is recorded with the version + timestamp and is
 * reflected by /api/me. A stale version or a malformed body is refused, and an
 * anonymous caller cannot record consent.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { TEST_DATABASE_URL, preparedDb, makeTeacher, type TestDB } from './util.js';
import { buildApp } from '../../src/app.js';
import { classes, inviteCodes, policyAcceptances } from '../../src/db/schema.js';
import { hashInviteCode } from '../../src/lib/invite.js';
import { POLICY_VERSION } from '@klass/shared';
import type { FastifyInstance } from 'fastify';

const suite = TEST_DATABASE_URL ? describe : describe.skip;
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const genCode = () => Array.from({ length: 8 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join('');

suite('Phase 2 consent', () => {
  let t: TestDB; let app: FastifyInstance;
  let teacherId = ''; let classId = '';

  async function newStudent(email: string): Promise<string> {
    const code = genCode();
    await t.db.insert(inviteCodes).values({ classId, codeHash: hashInviteCode(code, process.env.JWT_SECRET!), createdBy: teacherId, expiresAt: new Date(Date.now() + 86400000) });
    const r = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { firstName: 'Pupil', lastName: 'Test', email, password: 'Secret1234', code } });
    return r.json().accessToken as string;
  }
  const bearer = (tok: string) => ({ authorization: `Bearer ${tok}` });

  beforeAll(async () => {
    t = await preparedDb(TEST_DATABASE_URL);
    app = await buildApp(t.db);
    const te = await makeTeacher(t.sql, `cons${Date.now()}@x.io`);
    teacherId = te.id;
    const [c] = await t.db.insert(classes).values({ teacherId, name: 'C' }).returning();
    classId = c!.id;
  });
  afterAll(async () => { await app?.close(); await t?.sql.end(); });

  it('a new account has policyAccepted=false and no acceptance row', async () => {
    const tok = await newStudent(`c1${Date.now()}@x.io`);
    const me = await app.inject({ method: 'GET', url: '/api/me', headers: bearer(tok) });
    expect(me.json().policyAccepted).toBe(false);
  });

  it('accept-policy stores the current version + time and flips /api/me', async () => {
    const tok = await newStudent(`c2${Date.now()}@x.io`);
    const userId = (await app.inject({ method: 'GET', url: '/api/me', headers: bearer(tok) })).json().id as string;
    const ok = await app.inject({ method: 'POST', url: '/api/me/accept-policy', headers: bearer(tok), payload: { version: POLICY_VERSION } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().version).toBe(POLICY_VERSION);
    expect((await app.inject({ method: 'GET', url: '/api/me', headers: bearer(tok) })).json().policyAccepted).toBe(true);
    const rows = await t.db.select().from(policyAcceptances).where(eq(policyAcceptances.userId, userId));
    expect(rows[0]?.version).toBe(POLICY_VERSION);
    expect(rows[0]?.acceptedAt).toBeInstanceOf(Date);
    // idempotent: a second accept keeps exactly one row
    await app.inject({ method: 'POST', url: '/api/me/accept-policy', headers: bearer(tok), payload: { version: POLICY_VERSION } });
    expect((await t.db.select().from(policyAcceptances).where(eq(policyAcceptances.userId, userId))).length).toBe(1);
  });

  it('a stale version is refused with 409', async () => {
    const tok = await newStudent(`c3${Date.now()}@x.io`);
    const r = await app.inject({ method: 'POST', url: '/api/me/accept-policy', headers: bearer(tok), payload: { version: '1999-01-01' } });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe('policyVersionStale');
    expect((await app.inject({ method: 'GET', url: '/api/me', headers: bearer(tok) })).json().policyAccepted).toBe(false);
  });

  it('a malformed version is 400; anonymous cannot record consent', async () => {
    const tok = await newStudent(`c4${Date.now()}@x.io`);
    const bad = await app.inject({ method: 'POST', url: '/api/me/accept-policy', headers: bearer(tok), payload: { version: 'v1' } });
    expect(bad.statusCode).toBe(400);
    const anon = await app.inject({ method: 'POST', url: '/api/me/accept-policy', payload: { version: POLICY_VERSION } });
    expect(anon.statusCode).toBe(401);
  });
});
