/**
 * Apply the Supabase hardening SQL (RLS + privilege revokes) to DATABASE_URL.
 * Idempotent — safe to rerun after adding new tables.
 *   node scripts/secure-db.mjs   (DATABASE_URL or --url=... ; password never printed)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

const here = path.dirname(fileURLToPath(import.meta.url));
const sqlFile = path.join(here, '..', 'src', 'db', 'migrations', 'custom', 'secure-public.sql');
const argUrl = process.argv.find((a) => a.startsWith('--url='))?.slice(6);
const url = argUrl ?? process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL (or --url=) required'); process.exit(1); }

const sql = postgres(url, { max: 1 });
try {
  await sql.unsafe(fs.readFileSync(sqlFile, 'utf8'));
  const tables = await sql`select count(*)::int as n from pg_tables where schemaname='public'`;
  const guarded = await sql`
    select count(*)::int as n from pg_tables t
    join pg_class c on c.relname = t.tablename and c.relnamespace = 'public'::regnamespace
    where t.schemaname='public' and c.relrowsecurity = true`;
  console.log(`secure-public applied: ${guarded[0].n}/${tables[0].n} tables RLS-enabled`);
  process.exitCode = 0;
} catch (e) {
  console.error('secure-public failed:', e.message ?? e); // never print the URL
  process.exit(1);
} finally {
  await sql.end({ timeout: 5 }).catch(() => undefined);
}
