/**
 * Language storage (task 1, 2026-10-09) — what the server records about a language.
 *
 * The UI order lives in test/unit/locale-pick.test.ts; this file pins the parts only the
 * database can answer: the column default, the one-time data step of migration 0024, when
 * `locale_explicit` flips, and the privilege posture the migration must not change.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { TEST_DATABASE_URL, preparedDb, type TestDB } from './util.js';
import { buildApp } from '../../src/app.js';
import { classes, users } from '../../src/db/schema.js';
import { hashPassword } from '../../src/lib/password.js';
import { DEFAULT_LOCALE } from '@klass/shared';
import type { FastifyInstance } from 'fastify';

const suite = TEST_DATABASE_URL ? describe : describe.skip;

suite('language storage and migration 0024 (task 1)', () => {
  let t: TestDB;
  let app: FastifyInstance;
  let teacherTok = '';
  let teacherId = '';
  let classId = '';
  const PW = 'Passw0rd123';

  beforeAll(async () => {
    t = await preparedDb(TEST_DATABASE_URL);
    app = await buildApp(t.db);
    const hash = await hashPassword(PW);
    const [teacher] = await t.db.insert(users).values({
      role: 'teacher', name: 'LangTeacher', email: 'langt@x.io', passwordHash: hash, locale: 'ru', localeExplicit: true,
    }).returning();
    teacherId = teacher!.id;
    const [cls] = await t.db.insert(classes).values({ teacherId, name: 'Класс языка' }).returning();
    classId = cls!.id;
    const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'langt@x.io', password: PW } });
    teacherTok = `Bearer ${r.json().accessToken}`;
  });
  afterAll(async () => { await app?.close(); await t?.sql.end(); });

  /** a fresh invite code, through the real endpoint (the table stores only its hash) */
  async function code(): Promise<string> {
    const r = await app.inject({ method: 'POST', url: `/api/classes/${classId}/invites`, headers: { authorization: teacherTok }, payload: {} });
    expect(r.statusCode, `invite ${r.statusCode}`).toBe(201);
    return String(((await r.json()) as { code: string }).code);
  }
  async function register(payload: Record<string, unknown>) {
    const r = await app.inject({ method: 'POST', url: '/api/auth/register', payload: payload as object });
    expect(r.statusCode, `register ${JSON.stringify(await r.json())}`).toBe(200);
    return r.json() as { accessToken: string; user: { locale: string; localeExplicit?: boolean } };
  }
  const email = () => `stu${Math.random().toString(36).slice(2, 10)}@x.io`;

  it('an account created without a language gets the product default, marked as not chosen', async () => {
    const mail = email();
    const j = await register({ firstName: 'Без', lastName: 'Выбора', email: mail, password: PW, code: await code() });
    expect(j.user.locale, 'registration no longer takes the old Russian default').toBe(DEFAULT_LOCALE);
    expect(j.user.localeExplicit, 'nobody chose anything here').toBe(false);
    const [row] = await t.db.select({ locale: users.locale, explicit: users.localeExplicit })
      .from(users).where(eq(users.email, mail.toLowerCase())).limit(1);
    expect(row).toMatchObject({ locale: 'en', explicit: false });
  });

  it('a language picked on the register screen lands in the account and counts as chosen', async () => {
    const j = await register({ firstName: 'Узбек', lastName: 'Тил', email: email(), password: PW, code: await code(), locale: 'uz' });
    expect(j.user.locale).toBe('uz');
    expect(j.user.localeExplicit, 'a click on a language IS a choice').toBe(true);
  });

  it('PATCH /api/me/profile marks the language chosen only when it actually changes', async () => {
    const j = await register({ firstName: 'Смена', lastName: 'Теста', email: email(), password: PW, code: await code() });
    const tok = `Bearer ${j.accessToken}`;
    const a = { authorization: tok };
    const meRes = await app.inject({ method: 'GET', url: '/api/me', headers: a });
    expect(meRes.statusCode, `GET /api/me ${JSON.stringify(await meRes.json())}`).toBe(200);
    const me = (await meRes.json()) as
      { name: string; locale: string; tz: string; localeExplicit: boolean };
    expect(me.localeExplicit, 'a fresh account has not chosen anything').toBe(false);

    // re-sending the stored value (the timezone sync does exactly this) must not fake a choice
    const same = await app.inject({ method: 'PATCH', url: '/api/me/profile', headers: a, payload: { name: me.name, locale: me.locale, tz: 'Europe/Berlin' } });
    expect(((await same.json()) as { tz: string; localeExplicit: boolean }).localeExplicit).toBe(false);

    const changed = await app.inject({ method: 'PATCH', url: '/api/me/profile', headers: a, payload: { name: me.name, locale: 'ru', tz: 'Europe/Berlin' } });
    const c = (await changed.json()) as { locale: string; localeExplicit: boolean };
    expect(c.locale).toBe('ru');
    expect(c.localeExplicit, 'a different locale in a profile PATCH is a person choosing').toBe(true);

    const after = (await (await app.inject({ method: 'GET', url: '/api/me', headers: a })).json()) as { locale: string; localeExplicit: boolean };
    expect(after).toMatchObject({ locale: 'ru', localeExplicit: true });
  });

  it('the database column itself defaults to English, and the data step moves un-chosen rows', async () => {
    const def = await t.sql`
      select pg_get_expr(d.adbin, d.adrelid) as def
        from pg_attrdef d join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
       where a.attrelid = 'users'::regclass and a.attname = 'locale'`;
    expect(String((def[0] as { def: string }).def), 'a raw INSERT without a locale gets English')
      .toContain("'en'");

    // the one-time step of 0024, re-executed verbatim on a synthetic row: an old account that
    // never chose must end up English, one that chose must keep its language
    const hash = await hashPassword(PW);
    const [legacy] = await t.db.insert(users).values({ role: 'student', name: 'Legacy', lastName: 'Ru', email: email(), passwordHash: hash, locale: 'ru' }).returning();
    const [chosen] = await t.db.insert(users).values({ role: 'student', name: 'Chosen', lastName: 'Ru', email: email(), passwordHash: hash, locale: 'ru', localeExplicit: true }).returning();
    await t.sql`UPDATE "users" SET "locale" = 'en' WHERE "locale_explicit" = false`;
    const [l1] = await t.db.select({ locale: users.locale }).from(users).where(eq(users.id, legacy!.id)).limit(1);
    const [l2] = await t.db.select({ locale: users.locale }).from(users).where(eq(users.id, chosen!.id)).limit(1);
    expect(l1!.locale, 'an un-chosen row moves to the new default').toBe('en');
    expect(l2!.locale, 'a chosen row is left alone').toBe('ru');
  });

  it('migration 0024 changed no privilege posture: RLS on, anon/authenticated hold nothing', async () => {
    const rows = await t.sql`select relrowsecurity, relforcerowsecurity from pg_class where relname = 'users'`;
    expect((rows[0] as { relrowsecurity: boolean }).relrowsecurity, 'users still has RLS enabled').toBe(true);

    const roles = await t.sql`select rolname from pg_roles where rolname in ('anon', 'authenticated')`;
    const have = new Set(roles.map((r) => String((r as { rolname: string }).rolname)));
    if (have.has('anon')) {
      const p = await t.sql`
        select pg_catalog.has_table_privilege('anon', 'users', 'select') as s,
               pg_catalog.has_column_privilege('anon', 'users', 'locale_explicit', 'select') as c`;
      const q = (p[0] ?? {}) as Record<string, boolean>;
      expect(q.s, 'anon cannot read users').toBe(false);
      expect(q.c, 'and not the new column either').toBe(false);
    }
    if (have.has('authenticated')) {
      const p = await t.sql`
        select pg_catalog.has_table_privilege('authenticated', 'users', 'select') as s,
               pg_catalog.has_table_privilege('authenticated', 'users', 'update') as u,
               pg_catalog.has_column_privilege('authenticated', 'users', 'locale_explicit', 'select') as c`;
      const q = (p[0] ?? {}) as Record<string, boolean>;
      expect(q.s, 'authenticated cannot read users').toBe(false);
      expect(q.u, 'and cannot update it (nobody may set their own flag through PostgREST)').toBe(false);
      expect(q.c).toBe(false);
    }
  });
});
