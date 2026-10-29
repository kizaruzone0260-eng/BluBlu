/**
 * Migrations on a clean database (no admin rights, no Docker, no production).
 *
 * `preparedDb()` migrates the shared test database once and then truncates it, so it never
 * proves that 0001…00NN apply from scratch — and it certainly does not prove that the newest
 * migration is installable on a server that has never seen the schema. This script creates a
 * separate database next to the test one, runs every migration in it, checks the shape the
 * Telegram modules rely on, and drops it again.
 *
 *   node scripts/with-postgres.mjs node scripts/migrations-fresh.mjs
 *
 * It needs DATABASE_URL_TEST (set by the wrapper) and only ever touches a database named
 * `mig_fresh_check` on that server.
 */
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const url = process.env.DATABASE_URL_TEST ?? '';
if (!url) {
  console.error('[migrations-fresh] DATABASE_URL_TEST is not set — run me through scripts/with-postgres.mjs');
  process.exit(1);
}

const FRESH_DB = 'mig_fresh_check';
const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(here, '../src/db/migrations');

const root = new URL(url);
const adminUrl = `${root.protocol}//${root.username}:${root.password}@${root.host}/postgres`;
const admin = postgres(adminUrl, { max: 1 });

// a leftover from an interrupted run must not decide what we check
await admin.unsafe(`drop database if exists ${FRESH_DB}`);
await admin.unsafe(`create database ${FRESH_DB}`);
await admin.end();

const target = postgres(`${root.protocol}//${root.username}:${root.password}@${root.host}/${FRESH_DB}`, { max: 5 });
try {
  await migrate(drizzle(target), { migrationsFolder });

  const tables = await target`select count(*)::int as n from pg_tables where schemaname = 'public'`;
  const migrations = await target`select count(*)::int as n from drizzle.__drizzle_migrations`;
  const names = await target`select tablename from pg_tables where schemaname = 'public' order by tablename`;
  const have = new Set(names.map((r) => r.tablename));

  const required = [
    'tg_operators', 'tg_groups', 'tg_bind_tokens', 'tg_drafts', 'tg_draft_targets',
    'tg_draft_items', 'tg_publications', 'tg_callback_tokens',
    'tg_materials', 'tg_material_groups', 'tg_draft_materials',
    // 0039 (2026-10-28): гостевая ссылка и заявки — на чистой базе они обязаны появиться
    // вместе со всеми остальными, а не только при догоняющей миграции живой базы
    'lesson_guest_links', 'lesson_guest_requests',
  ];
  const missing = required.filter((t) => !have.has(t));
  if (missing.length) throw new Error(`missing tables after migration: ${missing.join(', ')}`);

  const guardedNames = [
    'tg_materials', 'tg_material_groups', 'tg_draft_materials',
    'lesson_guest_links', 'lesson_guest_requests',
  ];
  const guarded = await target`
    select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and c.relname in ${target(guardedNames)}
       and c.relrowsecurity
       and not exists (select 1 from pg_policies p where p.tablename = c.relname)`;
  if (guarded.length !== guardedNames.length) {
    throw new Error(`tables are not RLS-guarded with zero policies: ${guardedNames.join(', ')}`);
  }

  const enumValues = await target`
    select e.enumlabel from pg_enum e join pg_type t on t.oid = e.enumtypid
     where t.typname = 'tg_draft_status' order by e.enumsortorder`;
  const labels = enumValues.map((r) => r.enumlabel);
  for (const need of ['choosing_materials', 'awaiting_instruction', 'collecting', 'published']) {
    if (!labels.includes(need)) throw new Error(`tg_draft_status is missing ${need}`);
  }

  const columns = await target`
    select column_name from information_schema.columns
     where table_schema = 'public' and table_name = 'tg_drafts' and column_name = 'instruction'`;
  if (!columns.length) throw new Error('tg_drafts.instruction was not added');

  /*
   * 0040 (task F): the Mini App creates a draft without any Telegram message, so the source
   * message of an item may be absent, and every draft records where it came from. These are
   * columns, not conventions — a clean database must carry them from the first boot, otherwise
   * the first Mini App launch on a new server fails at INSERT time.
   */
  const miniDraftCols = await target`
    select column_name, is_nullable, column_default from information_schema.columns
     where table_schema = 'public' and table_name = 'tg_drafts'
       and column_name in ('origin', 'due_at') order by column_name`;
  const origin = miniDraftCols.find((c) => c.column_name === 'origin');
  const due = miniDraftCols.find((c) => c.column_name === 'due_at');
  if (!origin || origin.is_nullable !== 'NO'
    || String(origin.column_default ?? '').replace(/::text$/, '') !== `'bot'`) {
    throw new Error('tg_drafts.origin must be NOT NULL DEFAULT \'bot\'');
  }
  if (!due || due.is_nullable !== 'YES') throw new Error('tg_drafts.due_at must be nullable');

  const [sourceMessage] = await target`
    select is_nullable from information_schema.columns
     where table_schema = 'public' and table_name = 'tg_draft_items'
       and column_name = 'source_message_id'`;
  if (sourceMessage?.is_nullable !== 'YES') {
    throw new Error('tg_draft_items.source_message_id must be nullable for Mini App items');
  }

  const draftIndexes = await target`
    select indexname from pg_indexes
     where schemaname = 'public' and indexname = 'tg_drafts_owner_origin_idx'`;
  if (!draftIndexes.length) throw new Error('tg_drafts_owner_origin_idx is missing');

  // and the shape the flow depends on: a library file_id is unique per teacher, a draft keeps
  // its own snapshot copy of a material even after the library row is gone
  const [snapshotFk] = await target`
    select confdeltype from pg_constraint c
      join pg_class t on t.oid = c.conrelid
     where t.relname = 'tg_draft_materials' and contype = 'f'
       and c.confrelid = 'tg_materials'::regclass`;
  if (String(snapshotFk?.confdeltype) !== 'n') throw new Error('deleting a material must SET NULL, not cascade');

  /*
   * Task G (2026-10-29): an UPGRADE, not only a creation. 0041 adds columns to tables that
   * already hold rows on a live server. Building the schema from zero creates those columns
   * together with the tables and therefore proves nothing about the ALTERs. So: put the three
   * touched tables back into their pre-0041 shape, insert a row that predates the migration,
   * replay exactly the 0041 statements and check what they produced.
   */
  const upgradeUser = '00000000-0000-4000-8000-00000000a041';
  await target.unsafe(`
    alter table "policy_acceptances" drop column "privacy_version", drop column "terms_version",
      drop column "locale", drop column "context";
    alter table "tg_bind_tokens" drop column "id", drop column "used_chat_id";
    alter table "tg_materials" drop column "storage_key";
  `);
  await target`
    insert into users (id, role, name, last_name, email, password_hash, locale, locale_explicit, tz, created_at, profile_completed_at)
    values (${upgradeUser}, 'teacher', 'Upgrade', 'Check', 'upgrade@check.local',
            'not-a-real-hash', 'ru', true, 'Asia/Tashkent', now(), now())`;
  await target`
    insert into policy_acceptances (user_id, version, accepted_at)
    values (${upgradeUser}, '2026-10-06', now())`;
  await target`
    insert into tg_bind_tokens (token_hash, owner_id, expires_at)
    values ('upgrade-check-hash', ${upgradeUser}, now() + interval '30 minutes')`;

  const file0041 = readFileSync(path.join(migrationsFolder, '0041_task_g_mini_app.sql'), 'utf8');
  for (const statement of file0041.split('--> statement-breakpoint')) {
    if (statement.trim()) await target.unsafe(statement);
  }

  const [upgraded] = await target`
    select privacy_version, terms_version, context, locale
      from policy_acceptances where user_id = ${upgradeUser}`;
  if (upgraded?.privacy_version !== '2026-10-06' || upgraded?.terms_version !== '2026-10-06') {
    throw new Error('0041 must backfill both document versions from the legacy version');
  }
  if (upgraded?.context !== 'legacy') throw new Error('0041 must mark backfilled rows as legacy');
  if (upgraded?.locale !== null) throw new Error('0041 must not invent an acceptance locale');

  const [bindUpgraded] = await target`
    select id, used_chat_id from tg_bind_tokens where token_hash = 'upgrade-check-hash'`;
  if (!bindUpgraded?.id) throw new Error('0041 must give an existing bind code a public id');
  if (bindUpgraded?.used_chat_id !== null) throw new Error('an old bind code was never spent in a group');
  const [bindUnique] = await target`
    select count(*)::int as n from pg_indexes where indexname = 'tg_bind_tokens_id_unique'`;
  if (bindUnique?.n !== 1) throw new Error('tg_bind_tokens.id must stay unique after the upgrade');

  const [storageKey] = await target`
    select is_nullable from information_schema.columns
     where table_schema = 'public' and table_name = 'tg_materials' and column_name = 'storage_key'`;
  if (storageKey?.is_nullable !== 'YES') {
    throw new Error('tg_materials.storage_key must be nullable: bot-era rows have no bytes');
  }

  console.log(`[migrations-fresh] ok: ${migrations[0].n} migrations, ${tables[0].n} tables, `
    + `${required.length} required tables present, RLS on the library and guest tables, draft statuses, `
    + `the snapshot key, and the 0041 upgrade replayed on a row that predates it`);
} finally {
  await target.end({ timeout: 5 });
  const cleaner = postgres(adminUrl, { max: 1 });
  await cleaner.unsafe(`drop database if exists ${FRESH_DB}`);
  await cleaner.end();
}
