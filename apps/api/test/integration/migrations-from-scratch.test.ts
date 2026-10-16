import { describe, expect, test } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import path from 'node:path';
import { TEST_DATABASE_URL } from './util.js';

/**
 * The whole journal, applied to an EMPTY database — the one path no other test walks.
 *
 * Why it exists: CI's `build-test` job failed on 2026-10-09 with SQLSTATE 55P04
 * («New enum values must be committed before they can be used») on migration 0024. Every local
 * database already had `app_locale` with 'en' in it, so only a replay from 0000 hit it — drizzle
 * applies the whole journal inside ONE transaction, and 0007 adds the enum value that 0024 then
 * tries to use. A fresh production database (or a new Render service) would have failed the same
 * way at boot. This test is that replay, so the class of bug cannot come back quietly.
 */

const scratchDb = `klass_scratch_${Date.now().toString(36)}`;
/**
 * Defaults to the journal the app itself applies. The override exists for the fail-before
 * demonstration of the 55P04 fix: point it at a copy of the pre-fix migrations and the same test
 * turns red with the exact CI error, which is how the fix is shown to be the cause of the change.
 */
const migrationsFolder = process.env.SCRATCH_MIGRATIONS_FOLDER
  ?? path.join(process.cwd(), 'src', 'db', 'migrations');

/** postgres://user:pw@host:port/<db> with the database name swapped out */
function urlWithDb(url: string, db: string): string {
  const i = url.lastIndexOf('/');
  return `${url.slice(0, i + 1)}${db}`;
}

async function q(url: string, fn: (sql: postgres.Sql) => Promise<void>) {
  const sql = postgres(url, { max: 1 });
  try { await fn(sql); } finally { await sql.end({ timeout: 5 }); }
}

describe('migrations from an empty database (fresh install / CI replay)', () => {
  test('the whole journal applies, and the language + lesson-comment + lecture-snapshot posture lands', async () => {
    expect(TEST_DATABASE_URL, 'DATABASE_URL_TEST is required').toBeTruthy();
    // the name is built two lines up from a timestamp, so it can never carry a quote
    expect(/^[a-z0-9_]+$/.test(scratchDb)).toBe(true);

    // 1. an empty database owned by the same role
    await q(urlWithDb(TEST_DATABASE_URL, 'postgres'), async (sql) => {
      await sql.unsafe(`CREATE DATABASE ${scratchDb}`);
    });

    try {
      // 2. the app's own boot path, on a database that has never seen a migration
      await q(urlWithDb(TEST_DATABASE_URL, scratchDb), async (sql) => {
        await migrate(drizzle(sql), { migrationsFolder });

        // 3. what the two parts of the task promised
        const localeDefault = await sql`
          select pg_get_expr(d.adbin, d.adrelid) as def
            from pg_attrdef d
            join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
           where a.attrelid = 'users'::regclass and a.attname = 'locale'`;
        expect(String(localeDefault[0]?.def ?? '')).toContain("'en'");

        const enums = await sql`
          select e.enumlabel from pg_type t
            join pg_enum e on e.enumtypid = t.oid
           where t.typname = 'comments_mode' order by e.enumsortorder`;
        expect(enums.map((r) => r.enumlabel)).toEqual(['on', 'off', 'slow']);

        // every new table: RLS enabled, no policies, nothing granted to a non-owner
        const tables = await sql`
          select c.relname, c.relrowsecurity, c.relacl,
                 (select count(*) from pg_policies p where p.tablename = c.relname) as policies
            from pg_class c
            join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public'
             and c.relname in ('lesson_comments', 'lesson_comment_mutes', 'lesson_comment_reads')
           order by c.relname`;
        expect(tables.map((r) => r.relname)).toEqual(
          ['lesson_comment_mutes', 'lesson_comment_reads', 'lesson_comments'],
        );
        for (const t of tables) {
          expect(t.relrowsecurity, `${t.relname}: ROW LEVEL SECURITY`).toBe(true);
          expect(Number(t.policies), `${t.relname}: no policies, so no rows for a non-owner`).toBe(0);
          // NULL acl ⇒ the owner alone holds any privilege. A non-null one must not name a role
          // the Data API can assume, and must not carry a PUBLIC ('=' / '*') grant.
          const acl = t.relacl == null ? '' : (Array.isArray(t.relacl) ? t.relacl.join(',') : String(t.relacl));
          expect(acl).not.toMatch(/(^|,)\s*(\*|=|anon|authenticated)[=*]/);
        }

        // 4. the session column really is the enum, with the default the routes rely on
        const mode = await sql`
          select t.typname, pg_get_expr(d.adbin, d.adrelid) as def
            from pg_attribute a
            join pg_type t on t.oid = a.atttypid
            left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
           where a.attrelid = 'lesson_sessions'::regclass and a.attname = 'comments_mode'`;
        expect(mode[0]?.typname).toBe('comments_mode');
        expect(String(mode[0]?.def ?? '')).toContain("'on'");

        // 5. migration 0028 adds a COLUMN to an existing table, so the posture has to be proven
        //    for that column, not assumed: the snapshot of "what was on before the lecture" says
        //    who spoke, and the Data API roles must not be able to read it.
        const snapshot = await sql`
          select c.relrowsecurity as rls, c.relacl as acl, a.attnotnull as not_null,
                 pg_get_expr(d.adbin, d.adrelid) as def
            from pg_attribute a
            join pg_class c on c.oid = a.attrelid
            left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
           where a.attrelid = 'lesson_sessions'::regclass and a.attname = 'lecture_pre_devices'`;
        expect(snapshot.length, 'the column exists after a replay from 0000').toBe(1);
        expect(snapshot[0]?.not_null).toBe(true);
        expect(String(snapshot[0]?.def ?? '')).toContain("'{}'::jsonb");
        expect(snapshot[0]?.rls, 'lesson_sessions keeps ROW LEVEL SECURITY').toBe(true);
        // NULL acl ⇒ owner only; a non-null one must not name a Data API role or carry PUBLIC
        const acl = snapshot[0]?.relacl == null ? ''
          : (Array.isArray(snapshot[0].relacl) ? snapshot[0].relacl.join(',') : String(snapshot[0].relacl));
        expect(acl).not.toMatch(/(^|,)\s*(\*|=|anon|authenticated)[=*]/);

        // 5б. migration 0029 adds the drawing permission and the author map as COLUMNS on the two
        //     existing tables. «Who may draw» and «who drew this» are both personal enough to
        //     prove the posture per column, not per table.
        const drawCols = await sql`
          select (c.relname || '.' || a.attname) as col, c.relrowsecurity as rls, c.relacl as acl,
                 a.attnotnull as not_null, pg_get_expr(d.adbin, d.adrelid) as def
            from pg_attribute a
            join pg_class c on c.oid = a.attrelid
            left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
           where (a.attrelid = 'lesson_sessions'::regclass
                    and a.attname in ('board_draw_all', 'board_draw_students'))
              or (a.attrelid = 'whiteboards'::regclass and a.attname = 'authors')
           order by a.attname`;
        expect(drawCols.map((r) => r.col)).toEqual(
          ['whiteboards.authors', 'lesson_sessions.board_draw_all', 'lesson_sessions.board_draw_students'],
        );
        for (const row of drawCols) {
          const r = row as { col: string; rls: boolean; acl: unknown; not_null: boolean; def: string };
          expect(r.not_null, `${r.col}: NOT NULL`).toBe(true);
          expect(r.rls, `${r.col}: the table keeps ROW LEVEL SECURITY`).toBe(true);
          const a = r.acl == null ? '' : (Array.isArray(r.acl) ? r.acl.join(',') : String(r.acl));
          expect(a, `${r.col}: no grant to a Data API role or PUBLIC`).not.toMatch(/(^|,)\s*(\*|=|anon|authenticated)[=*]/);
          expect(String(r.def ?? ''), `${r.col}: a default the routes rely on`).toMatch(/(false|'\{\}'::jsonb)/);
        }

        // 5в. migration 0030 adds a TABLE (кто когда был на уроке) and a COLUMN (переключатель
        //     класса «показывать архив досок ученикам»). Присутствие — это персональные данные:
        //     время прихода и ухода конкретного человека. Поза доказывается здесь, на чистой базе,
        //     а не «по аналогии с 0025».
        const attendance = await sql`
          select c.relrowsecurity as rls, c.relacl as acl,
                 (select count(*) from pg_policies p where p.tablename = c.relname) as policies
            from pg_class c
            join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relname = 'lesson_attendance'`;
        expect(attendance.length, 'lesson_attendance создана проигрыванием журнала с 0000').toBe(1);
        expect(attendance[0]?.rls, 'lesson_attendance: ROW LEVEL SECURITY включён').toBe(true);
        expect(Number(attendance[0]?.policies), 'lesson_attendance: политик нет ⇒ чужой роли не видно ни строки').toBe(0);
        const attAcl = attendance[0]?.relacl == null ? ''
          : (Array.isArray(attendance[0].relacl) ? attendance[0].relacl.join(',') : String(attendance[0].relacl));
        expect(attAcl, 'lesson_attendance: ни одной выдачи не-владельцу').not.toMatch(/(^|,)\s*(\*|=|anon|authenticated)[=*]/);

        const archiveSwitch = await sql`
          select c.relrowsecurity as rls, c.relacl as acl, a.attnotnull as not_null,
                 pg_get_expr(d.adbin, d.adrelid) as def
            from pg_attribute a
            join pg_class c on c.oid = a.attrelid
            left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
           where a.attrelid = 'classes'::regclass and a.attname = 'board_archive_public'`;
        expect(archiveSwitch.length, 'classes.board_archive_public существует').toBe(1);
        expect(archiveSwitch[0]?.not_null).toBe(true);
        expect(String(archiveSwitch[0]?.def ?? ''), 'по умолчанию — выключено').toContain('false');
        expect(archiveSwitch[0]?.rls, 'classes keeps ROW LEVEL SECURITY').toBe(true);
        const swAcl = archiveSwitch[0]?.relacl == null ? ''
          : (Array.isArray(archiveSwitch[0].relacl) ? archiveSwitch[0].relacl.join(',') : String(archiveSwitch[0].relacl));
        expect(swAcl).not.toMatch(/(^|,)\s*(\*|=|anon|authenticated)[=*]/);

        // 5г. Часть A (2026-10-16) добавляет ДВЕ Метки в enum очереди и по КОЛОНКЕ в две
        //     существующие таблицы. Это тот самый случай, где поза не «по аналогии», а
        //     проверенная по столбцам: `locked_at`/`starts_at` говорят, кто и когда забрал
        //     уведомление, `payload` хранит текст, который человек написал боту.
        const nstatus = await sql`
          select e.enumlabel from pg_type t
            join pg_enum e on e.enumtypid = t.oid
           where t.typname = 'notification_status' order by e.enumsortorder`;
        expect(nstatus.map((r) => r.enumlabel)).toEqual(
          ['pending', 'sending', 'sent', 'failed', 'blocked', 'skipped', 'expired'],
        );

        const queueCols = await sql`
          select (c.relname || '.' || a.attname) as col, c.relrowsecurity as rls, c.relacl as acl,
                 a.attnotnull as not_null, a.atttypid::regtype::text as typ
            from pg_attribute a
            join pg_class c on c.oid = a.attrelid
           where (a.attrelid = 'notifications'::regclass and a.attname in ('locked_at', 'starts_at'))
              or (a.attrelid = 'bot_updates'::regclass and a.attname in ('payload', 'processed_at'))
           order by c.relname, a.attname`;
        expect(queueCols.map((r) => (r as { col: string }).col)).toEqual(
          ['bot_updates.payload', 'bot_updates.processed_at', 'notifications.locked_at', 'notifications.starts_at'],
        );
        for (const rowQ of queueCols) {
          const r = rowQ as { col: string; rls: boolean; acl: unknown; not_null: boolean; typ: string };
          expect(r.rls, `${r.col}: таблица осталась под ROW LEVEL SECURITY`).toBe(true);
          expect(r.not_null, `${r.col}: колонка nullable — ряды до миграции не ломаются`).toBe(false);
          const a = r.acl == null ? '' : (Array.isArray(r.acl) ? r.acl.join(',') : String(r.acl));
          expect(a, `${r.col}: ни одной выдачи не-владельцу`).not.toMatch(/(^|,)\s*(\*|=|anon|authenticated)[=*]/);
        }
        expect((queueCols as { typ: string }[]).map((r) => r.typ)).toEqual(
          ['jsonb', 'timestamp with time zone', 'timestamp with time zone', 'timestamp with time zone'],
        );

        // has_column_privilege ERRORS on a missing role, and only Supabase creates these two
        const roles = await sql`select rolname from pg_roles where rolname in ('anon', 'authenticated')`;
        const have = new Set(roles.map((r) => String((r as { rolname: string }).rolname)));
        for (const role of ['anon', 'authenticated'] as const) {
          if (!have.has(role)) continue;
          const p = await sql`
            select pg_catalog.has_column_privilege(${role}, 'lesson_sessions', 'lecture_pre_devices', 'select') as snap_s,
                   pg_catalog.has_column_privilege(${role}, 'lesson_sessions', 'lecture_pre_devices', 'update') as snap_u,
                   pg_catalog.has_column_privilege(${role}, 'lesson_sessions', 'board_draw_all', 'select') as all_s,
                   pg_catalog.has_column_privilege(${role}, 'lesson_sessions', 'board_draw_students', 'update') as stu_u,
                   pg_catalog.has_column_privilege(${role}, 'whiteboards', 'authors', 'select') as auth_s,
                   pg_catalog.has_column_privilege(${role}, 'whiteboards', 'authors', 'update') as auth_u,
                   pg_catalog.has_column_privilege(${role}, 'classes', 'board_archive_public', 'select') as arch_s,
                   pg_catalog.has_column_privilege(${role}, 'classes', 'board_archive_public', 'update') as arch_u,
                   pg_catalog.has_column_privilege(${role}, 'lesson_attendance', 'joined_at', 'select') as att_s,
                   pg_catalog.has_column_privilege(${role}, 'lesson_attendance', 'user_id', 'insert') as att_i,
                   pg_catalog.has_column_privilege(${role}, 'notifications', 'locked_at', 'select') as lock_s,
                   pg_catalog.has_column_privilege(${role}, 'notifications', 'locked_at', 'update') as lock_u,
                   pg_catalog.has_column_privilege(${role}, 'notifications', 'starts_at', 'select') as st_s,
                   pg_catalog.has_column_privilege(${role}, 'bot_updates', 'payload', 'select') as pay_s,
                   pg_catalog.has_column_privilege(${role}, 'bot_updates', 'payload', 'insert') as pay_i,
                   pg_catalog.has_column_privilege(${role}, 'bot_updates', 'processed_at', 'update') as proc_u`;
          const q = (p[0] ?? {}) as Record<string, boolean>;
          for (const [key, label] of Object.entries({
            snap_s: 'the device snapshot, select', snap_u: 'the device snapshot, update',
            all_s: '«разрешить всем», select', stu_u: 'the student list, update',
            auth_s: 'the author map, select', auth_u: 'the author map, update',
            arch_s: 'переключатель архива, select', arch_u: 'переключатель архива, update',
            att_s: 'присутствие, select', att_i: 'присутствие, insert',
            lock_s: 'захват ряда очереди, select', lock_u: 'захват ряда очереди, update',
            st_s: 'время события у напоминания, select',
            pay_s: 'текст обновления бота, select', pay_i: 'текст обновления бота, insert',
            proc_u: 'отметка обработки, update',
          }) as [string, string][]) {
            expect(q[key], `${role} cannot touch ${label}`).toBe(false);
          }
        }
      });
    } finally {
      await q(urlWithDb(TEST_DATABASE_URL, 'postgres'), async (sql) => {
        await sql.unsafe(`DROP DATABASE IF EXISTS ${scratchDb} WITH (FORCE)`);
      });
    }
  }, 180_000);
});
