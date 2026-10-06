/**
 * Logical backup without pg_dump (portable fallback used by backup.sh/restore.sh
 * when client tools are unavailable, e.g. embedded-postgres). Serializes each
 * table to JSON lines through the driver; restore re-applies versioned
 * migrations first, then re-inserts every table. Tables are DISCOVERED at
 * runtime from the catalog, so a table added by a later migration is backed up
 * automatically — no hand-maintained list to forget. v1 is school-scale, so the
 * row-by-row driver path is fine; on the server pg_dump in compose mode stays
 * the primary path.
 *   node scripts/logical-backup.mjs out=backups/dump
 *   node scripts/logical-backup.mjs restore in=backups/dump url=postgres://…/klass_r
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import postgres from 'postgres';

/** Every base table in the public schema (excludes the drizzle ledger). */
async function listTables(sql) {
  const rows = await sql`
    select c.relname as t
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r','p')
      and c.relname <> '__drizzle_migrations'
    order by c.relname`;
  return rows.map((r) => r.t);
}

const arg = (name, dflt) => {
  const a = process.argv.slice(2).find((x) => x.startsWith(name + '='));
  return a ? a.slice(name.length + 1) : dflt;
};

async function dump() {
  const url = process.env.DATABASE_URL ?? 'postgres://klass:klass@127.0.0.1:5433/klass';
  const out = arg('out', 'backups/dump');
  mkdirSync(out, { recursive: true });
  const sql = postgres(url, { max: 1 });
  for (const table of await listTables(sql)) {
    const rows = await sql.unsafe(`select * from "${table}"`);
    writeFileSync(path.join(out, `${table}.jsonl`), rows.map((r) => JSON.stringify(r)).join('\n'));
    console.log(`dumped ${table} (${rows.length})`);
  }
  await sql.end();
  console.log(`[logical-dump] OK → ${out}`);
}

async function restore() {
  const url = arg('url', process.env.DATABASE_URL ?? 'postgres://klass:klass@127.0.0.1:5433/klass');
  const dir = arg('in', 'backups/dump');
  if (!existsSync(dir)) { console.error('no dump dir', dir); process.exit(1); }
  const { migrate } = await import('drizzle-orm/postgres-js/migrator');
  const { drizzle } = await import('drizzle-orm/postgres-js');
  const sql = postgres(url, { max: 1 });
  const db = drizzle(sql);
  await migrate(db, { migrationsFolder: 'src/db/migrations' });
  const tables = await listTables(sql);
  // FK-order-independent restore: defer triggers for the session (a restore runs
  // as the schema owner/superuser — like pg_dump --disable-triggers), so insert
  // order never violates a parent/child FK. If the role isn't privileged we fall
  // back to inserting in the catalog (name) order, which for this schema is safe.
  try { await sql`set session_replication_role = 'replica'`; } catch { /* not privileged */ }
  for (const table of tables) {
    await sql.unsafe(`delete from "${table}"`);
  }
  for (const table of tables) {
    const file = path.join(dir, `${table}.jsonl`);
    if (!existsSync(file)) continue;
    const rows = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    if (!rows.length) { console.log(`skip empty ${table}`); continue; }
    const cols = Object.keys(rows[0]);
    const quoted = cols.map((c) => `"${c}"`).join(',');
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(',');
    const insertSql = `insert into "${table}" (${quoted}) values (${placeholders})`;
    for (const row of rows) {
      const vals = cols.map((c) => {
        const v = row[c];
        return (v !== null && typeof v === 'object') ? JSON.stringify(v) : v; // jsonb → text
      });
      await sql.unsafe(insertSql, vals);
    }
    console.log(`restored ${table} (${rows.length})`);
  }
  try { await sql`set session_replication_role = 'origin'`; } catch { /* ignore */ }
  await sql.end();
  console.log('[logical-restore] OK');
}

const run = process.argv[2] === 'restore' ? restore() : dump();
run.catch((e) => { console.error(e); process.exit(1); });
