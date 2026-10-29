/**
 * SEC-05/SEC-06 (2026-10-28): поза базы — свойство журнала, а не действие памяти.
 *
 * Что было не так. `custom/secure-public.sql` (RLS + отзыв прав у Supabase-ролей) существовал
 * отдельным файлом вне журнала: ни `Dockerfile`, ни `server.ts` его не звали (`server.ts` применяет
 * только журнал). То есть таблица, созданная после последнего ручного `pnpm db:secure`, оставалась
 * без RLS и с дефолтными правами `anon`/`authenticated` — и ни один тест об этом бы не сказал.
 * Аудит назвал это CWE-1188: «небезопасное значение по умолчанию» приезжает вместе с новой
 * таблицей, а защита — только когда владелец вспомнит про скрипт.
 *
 * Что сделано. Те же операторы перенесены в журнал (`0038_secure_public.sql`) с проверкой ролей:
 * роли `anon`/`authenticated` создаёт только Supabase, на embedded-postgres и в CI их нет, и
 * безусловный REVOKE уронил бы проигрывание журнала с 0000 (ошибка 42704). Ручной скрипт оставлен
 * (он применяет защиту немедленно, без деплоя) и получил ту же проверку ролей; тест ниже следит,
 * чтобы два пути не разошлись.
 *
 * Что доказывается здесь:
 *  • шаг 0038 не потерян в журнале, его файл на месте, и журнал целиком применён к базе;
 *  • после него ни одной таблицы без RLS, ни одной политики и ни одной выдачи anon/authenticated
 *    или PUBLIC на таблицы, последовательности и функции;
 *  • повторный прогон тех же операторов (идемпотентность) ничего не ломает;
 *  • путь «роли существуют» (боевой Supabase) проверяется в транзакции, которая ОТКАТЫВАЕТСЯ:
 *    создаём роли, выдаём им всё, применяем миграцию — права снимаются, и таблица, созданная
 *    ПОСЛЕ миграции, уже закрыта (это и был главный пробел SEC-06). После отката ролей и
 *    пробных объектов в базе не остаётся;
 *  • `pnpm db:secure` на кластере без Supabase-ролей больше не падает, а сообщает «0 нарушений».
 *
 * Чего этот тест НЕ доказывает: поведение живого Supabase. Ролей и их дефолтных грантов здесь нет,
 * поэтому «как в бою» моделируется в транзакции теми же операторами. Живой прогон — `cloud-verify`
 * на боевой базе, это отдельное действие владельца (см. docs/DECISIONS.md, 2026-10-28).
 *
 * Граница, которую нельзя забывать (SEC-05): роль приложения — ВЛАДЕЛЕЦ таблиц и обходит RLS.
 * RLS без политик защищает только PostgREST-роли (anon/authenticated), а не приложение; утечка
 * `DATABASE_URL` = полный доступ без сопротивления. Это осознанная поза, записанная в
 * docs/DECISIONS.md; перевод на не-владеющую роль — отдельное решение с политиками, а не
 * побочный эффект этой миграции (`FORCE` не ставится).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { TEST_DATABASE_URL, preparedDb, type TestDB } from './util.js';

const suite = TEST_DATABASE_URL ? describe : describe.skip;

const MIGRATIONS = path.resolve('src/db/migrations');
const MIGRATION_FILE = path.join(MIGRATIONS, '0038_secure_public.sql');
const SCRIPT_FILE = path.join(MIGRATIONS, 'custom', 'secure-public.sql');
const JOURNAL_FILE = path.join(MIGRATIONS, 'meta', '_journal.json');

type Journal = { entries: Array<{ idx: number; tag: string }> };

function journal(): Journal {
  return JSON.parse(readFileSync(JOURNAL_FILE, 'utf8')) as Journal;
}

/** Журнал применяет SQL по кускам между разделителем; тест обязан резать так же. */
function statementsOf(file: string): string[] {
  return readFileSync(file, 'utf8')
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Семантика «что закрывается и у кого» — не текст файла. Один и тот же оператор записан в
 * журнале как EXECUTE '… FROM anon', а в ручном скрипте так же; сравнение по парам
 * «операция:роль» переживёт переносы строк и оформление, но поймает пропавший REVOKE.
 */
function securityOps(text: string): string[] {
  const patterns: Array<[string, RegExp]> = [
    ['schema', /REVOKE ALL ON SCHEMA public FROM ([^';]+)/g],
    ['tables', /REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ([^';]+)/g],
    ['sequences', /REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM ([^';]+)/g],
    ['functions', /REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM ([^';]+)/g],
    ['default_tables', /ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM ([^';]+)/g],
    ['default_sequences', /ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM ([^';]+)/g],
    ['default_functions', /ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM ([^';]+)/g],
  ];
  const out: string[] = [];
  for (const [op, re] of patterns) {
    for (const m of text.matchAll(re)) {
      for (const role of m[1]!.split(',').map((r) => r.trim()).filter(Boolean)) {
        out.push(`${op}:${role}`);
      }
    }
  }
  return [...new Set(out)].sort();
}

const ACL_LEAK = /(^|[{,])(anon|authenticated)?=/;

suite('SEC-06: защита схемы public — шаг журнала', () => {
  let t: TestDB;

  beforeAll(async () => {
    t = await preparedDb(TEST_DATABASE_URL);
  });

  afterAll(async () => {
    await t.sql.end({ timeout: 5 }).catch(() => undefined);
  });

  it('журнал содержит 0038, файл на месте, и миграция применена к базе', async () => {
    expect(existsSync(MIGRATION_FILE), 'файл миграции существует').toBe(true);
    const j = journal();
    // Шаг SEC-06 не обязан быть последним: после него приходят обычные миграции (0039 —
    // гостевые ссылки, 2026-10-28). Проверяется, что он не потерян и не переписан, а не что
    // журнал на нём остановился.
    expect(j.entries.some((e) => e.tag === '0038_secure_public'), 'шаг 0038 в журнале').toBe(true);
    const last = j.entries[j.entries.length - 1];
    // индекс растёт ровно на единицу: будущий `drizzle-kit generate` возьмёт idx+1, а не
    // перезапишет предыдущий шаг
    expect(last?.idx).toBe(j.entries[j.entries.length - 2]!.idx + 1);

    const applied = await t.sql`select count(*)::int as n from drizzle.__drizzle_migrations`;
    expect(applied[0]!.n, 'строк в журнале применения ровно столько же, сколько шагов').toBe(j.entries.length);
  });

  it('ни одной таблицы без RLS, ни одной политики, ни одной выдачи anon/authenticated/PUBLIC', async () => {
    const tables = await t.sql`
      select c.relname, c.relrowsecurity, c.relacl::text as acl
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind in ('r', 'p')
       order by c.relname`;
    expect(tables.length, 'таблицы существуют — проверка не вакуумная').toBeGreaterThan(30);
    const unguarded = tables.filter((r) => !r.relrowsecurity).map((r) => r.relname);
    expect(unguarded, 'таблицы без ROW LEVEL SECURITY').toEqual([]);

    const policies = await t.sql`select count(*)::int as n from pg_policies where schemaname = 'public'`;
    expect(policies[0]!.n, 'политик нет ⇒ не-владельцу не видно ни строки').toBe(0);

    const leaks = tables
      .filter((r) => r.acl && ACL_LEAK.test(r.acl))
      .map((r) => `${r.relname}: ${r.acl}`);
    expect(leaks, 'чужой роли выдано право на таблицу').toEqual([]);

    const seqs = await t.sql`
      select c.relname, c.relacl::text as acl
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'S'
       order by c.relname`;
    expect(seqs.length, 'последовательности есть').toBeGreaterThan(0);
    const seqLeaks = seqs.filter((r) => r.acl && ACL_LEAK.test(r.acl)).map((r) => `${r.relname}: ${r.acl}`);
    expect(seqLeaks, 'чужой роли выдано право на последовательность').toEqual([]);

    const fns = await t.sql`
      select p.proname, p.proacl::text as acl
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'`;
    const fnLeaks = fns.filter((r) => r.acl && ACL_LEAK.test(r.acl)).map((r) => `${r.proname}: ${r.acl}`);
    expect(fnLeaks, 'чужой роли выдано право на функцию').toEqual([]);
  });

  it('повторный прогон идемпотентен, а при отсутствии Supabase-ролей — успешный no-op', async () => {
    // На CI-кластере (`postgres:16-alpine`, POSTGRES_USER=klass) ролей Supabase нет вовсе —
    // это и есть тот путь, на котором безусловный REVOKE падал бы с 42704. На локальном
    // кластере роли могут существовать (они кластерные, а не «на базу»), поэтому отсутствие
    // моделируется переименованием внутри транзакции: guard видит ровно то же — ролей с этими
    // именами нет, — а откат возвращает имена и все зависимости.
    const known = (await t.sql`select rolname from pg_roles where rolname in ('anon', 'authenticated')`)
      .map((r) => String(r.rolname));

    for (const stmt of statementsOf(MIGRATION_FILE)) await t.sql.unsafe(stmt);
    for (const stmt of statementsOf(MIGRATION_FILE)) await t.sql.unsafe(stmt);

    if (known.length === 0) {
      const created = await t.sql`select count(*)::int as n from pg_roles where rolname in ('anon', 'authenticated')`;
      expect(created[0]!.n, 'миграция не создаёт ролей').toBe(0);
    } else {
      class Rollback extends Error {}
      await expect(t.sql.begin(async (tx) => {
        for (const role of known) await tx.unsafe(`alter role ${role} rename to zz_hidden_${role}`);
        const hidden = await tx`select count(*)::int as n from pg_roles where rolname in ('anon', 'authenticated')`;
        expect(hidden[0]!.n, 'guard не видит ролей').toBe(0);
        for (const stmt of statementsOf(MIGRATION_FILE)) await tx.unsafe(stmt);
        const stillHidden = await tx`select count(*)::int as n from pg_roles where rolname in ('anon', 'authenticated')`;
        expect(stillHidden[0]!.n, 'и не создаёт их').toBe(0);
        throw new Rollback('откат переименования');
      })).rejects.toBeInstanceOf(Rollback);
      const restored = await t.sql`select rolname from pg_roles where rolname in ('anon', 'authenticated')`;
      expect(restored.length, 'имена ролей восстановлены откатом').toBe(known.length);
    }

    const [row] = await t.sql`
      select count(*)::int as total,
             count(*) filter (where not c.relrowsecurity)::int as without_rls
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind in ('r', 'p')`;
    expect(row!.total).toBeGreaterThan(30);
    expect(row!.without_rls).toBe(0);
  });

  it('с ролями Supabase права снимаются, а таблица, созданная после миграции, уже закрыта', async () => {
    class Rollback extends Error {}
    let checks: Record<string, boolean> = {};
    const beforeRoles = (await t.sql`select rolname from pg_roles where rolname in ('anon', 'authenticated')`)
      .map((r) => String(r.rolname));

    await expect(t.sql.begin(async (tx) => {
      // ── модель боевой базы: роли есть, им выдан ВЕСЬ спектр прав, каким его создаёт Supabase.
      // На CI ролей нет — создаём; на локальном кластере они уже есть и переживут откат.
      for (const role of ['anon', 'authenticated'] as const) {
        if (!beforeRoles.includes(role)) await tx.unsafe(`create role ${role} nologin`);
      }
      await tx.unsafe(`grant all on schema public to anon, authenticated`);
      await tx.unsafe(`grant all on all tables in schema public to anon, authenticated`);
      await tx.unsafe(`grant all on all sequences in schema public to anon, authenticated`);
      await tx.unsafe(`alter default privileges in schema public grant all on tables to anon, authenticated`);
      await tx.unsafe(`alter default privileges in schema public grant all on sequences to anon, authenticated`);
      // функция: снимаем встроенный PUBLIC-EXECUTE, иначе «право anon» пришло бы через псевдороль
      await tx.unsafe(`create function public.zz_sec_probe() returns int language sql as 'select 1'`);
      await tx.unsafe(`revoke all on function public.zz_sec_probe() from public`);
      await tx.unsafe(`grant execute on function public.zz_sec_probe() to anon`);

      // положительный контроль: до миграции права ДЕЙСТВИТЕЛЬНО есть, иначе проверка вакуумна
      const before = await tx.unsafe(`select
        has_table_privilege('anon', 'public.users', 'select') as tab,
        has_sequence_privilege('anon', 'public.audit_log_id_seq', 'usage') as seq,
        has_function_privilege('anon', 'public.zz_sec_probe()', 'execute') as fn,
        has_schema_privilege('anon', 'public', 'create') as schema_create`);
      expect(before[0], 'до миграции anon имеет таблицу/последовательность/функцию/CREATE')
        .toEqual({ tab: true, seq: true, fn: true, schema_create: true });

      // ── та же миграция, что применяет журнал, и ещё раз для идемпотентности
      for (const stmt of statementsOf(MIGRATION_FILE)) await tx.unsafe(stmt);
      for (const stmt of statementsOf(MIGRATION_FILE)) await tx.unsafe(stmt);

      const after = await tx.unsafe(`select
        has_table_privilege('anon', 'public.users', 'select') as tab_a,
        has_table_privilege('authenticated', 'public.users', 'select') as tab_b,
        has_sequence_privilege('anon', 'public.audit_log_id_seq', 'usage') as seq_a,
        has_function_privilege('anon', 'public.zz_sec_probe()', 'execute') as fn_a,
        has_schema_privilege('anon', 'public', 'create') as create_a`);
      checks = { ...(after[0] as Record<string, boolean>) };

      // главный пробел SEC-06: объекты, созданные ПОСЛЕ миграции, закрыты дефолтными правами
      await tx.unsafe(`create table public.zz_sec_after (id int)`);
      await tx.unsafe(`create sequence public.zz_sec_after_seq`);
      const fresh = await tx.unsafe(`select
        has_table_privilege('anon', 'public.zz_sec_after', 'select') as t_a,
        has_table_privilege('authenticated', 'public.zz_sec_after', 'select') as t_b,
        has_sequence_privilege('anon', 'public.zz_sec_after_seq', 'usage') as s_a,
        has_sequence_privilege('authenticated', 'public.zz_sec_after_seq', 'usage') as s_b`);
      checks = { ...checks, ...(fresh[0] as Record<string, boolean>) };

      throw new Rollback('откат: роли и выдачи — только внутри этого теста');
    })).rejects.toBeInstanceOf(Rollback);

    expect(checks).toEqual({
      tab_a: false, tab_b: false, seq_a: false, fn_a: false, create_a: false,
      t_a: false, t_b: false, s_a: false, s_b: false,
    });

    // откат действительно вернул базу: пробных объектов нет, а состав ролей — тот же, что был
    // до теста (на CI их 0, на локальном кластере они могли существовать и раньше)
    const leftover = await t.sql`
      select (select count(*)::int from pg_roles where rolname in ('anon', 'authenticated')) as roles,
             (select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
               where n.nspname = 'public' and c.relname in ('zz_sec_after', 'zz_sec_after_seq')) as objects`;
    expect(leftover[0]).toEqual({ roles: beforeRoles.length, objects: 0 });
  });

  it('ручной скрипт и журнал не расходятся ни в одном операторе', () => {
    const fromMigration = securityOps(readFileSync(MIGRATION_FILE, 'utf8'));
    const fromScript = securityOps(readFileSync(SCRIPT_FILE, 'utf8'));
    // 7 видов операций × 2 роли — и полный список, и порядок не имеют значения
    expect(fromMigration).toHaveLength(14);
    expect(fromScript).toEqual(fromMigration);
    // и цикл включения RLS тоже общий: без него «миграция» могла бы отзывать права, но не
    // включать позу на забытой таблице
    for (const text of [readFileSync(MIGRATION_FILE, 'utf8'), readFileSync(SCRIPT_FILE, 'utf8')]) {
      expect(text).toMatch(/ALTER TABLE public\.%I ENABLE ROW LEVEL SECURITY/);
      expect(text).toContain(`FROM pg_roles WHERE rolname = 'anon'`);
      expect(text).toContain(`FROM pg_roles WHERE rolname = 'authenticated'`);
    }
  });

  it('ручной pnpm db:secure завершается успешно, и все таблицы после него под RLS', () => {
    // Скрипт читает DATABASE_URL (боевой) — подставляем тестовую базу. Это тот самый ручной
    // путь из docs/CLOUD_DEMO.md. На этой машине роли Supabase есть; на CI-кластере их нет —
    // там этот же тест доказывает, что guard превращает REVOKE в no-op, а не в ошибку 42704.
    const out = execFileSync(process.execPath, ['scripts/secure-db.mjs'], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
      encoding: 'utf8',
      timeout: 60_000,
    });
    const m = /applied: (\d+)\/(\d+) tables RLS-enabled/.exec(out);
    expect(m, `вывод скрипта: ${out}`).not.toBeNull();
    expect(Number(m![1]), 'все таблицы под RLS').toBe(Number(m![2]));
  });
});
