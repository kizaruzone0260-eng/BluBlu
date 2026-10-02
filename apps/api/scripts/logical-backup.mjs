/**
 * Logical backup without pg_dump (portable fallback used by backup.sh/restore.sh
 * when client tools are unavailable, e.g. embedded-postgres). Serializes each
 * table to JSON lines through the driver; restore re-applies versioned
 * migrations first, then inserts in FK-safe chunks. v1 tables are small (school
 * scale) — this is equivalent data-wise; on the server pg_dump in compose mode
 * remains the primary path.
 *   node scripts/logical-dump.mjs out=backups/dump
 *   node scripts/logical-restore.mjs in=backups/dump url=postgres://…/klass_r
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import postgres from 'postgres';

export const TABLE_ORDER = [
  'users', 'classes', 'class_members', 'invite_codes', 'refresh_tokens', 'audit_log',
  'posts', 'files', 'teacher_notes', 'events', 'ics_tokens', 'lesson_sessions',
  'whiteboards', 'student_notes', 'telegram_links', 'telegram_tokens',
  'class_telegram_chats', 'class_link_tokens', 'notification_prefs', 'class_notify_prefs', 'notifications',
];

const arg = (name, dflt) => {
  const a = process.argv.slice(2).find((x) => x.startsWith(name + '='));
  return a ? a.slice(name.length + 1) : dflt;
};

if (process.argv[2] === 'tables') {
  console.log(TABLE_ORDER.join(' '));
  process.exit(0);
}

async function dump() {
  const url = process.env.DATABASE_URL ?? 'postgres://klass:klass@127.0.0.1:5433/klass';
  const out = arg('out', 'backups/dump');
  mkdirSync(out, { recursive: true });
  const sql = postgres(url, { max: 1 });
  for (const table of TABLE_ORDER) {
    const exists = await sql`select 1 from pg_tables where schemaname='public' and tablename=${table}`;
    if (!exists.length) continue;
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
  // clean target (idempotent restore) in reverse FK order
  for (const table of [...TABLE_ORDER].reverse()) {
    const exists = await sql`select 1 from pg_tables where schemaname='public' and tablename=${table}`;
    if (exists.length) await sql.unsafe(`delete from "${table}"`);
  }
  for (const table of TABLE_ORDER) {
    const file = path.join(dir, `${table}.jsonl`);
    if (!existsSync(file)) continue;
    const rows = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    if (!rows.length) { console.log(`skip empty ${table}`); continue; }
    const cols = Object.keys(rows[0]);
    for (const row of rows) {
      const clean = {};
      for (const [k, v] of Object.entries(row)) {
        clean[k] = (v !== null && typeof v === 'object' && !Array.isArray(v)) || Array.isArray(v) ? JSON.stringify(v) : v;
      }
      await sql`insert into ${sql(table)} ${sql(clean, cols)}`;
    }
    console.log(`restored ${table} (${rows.length})`);
  }
  await sql.end();
  console.log('[logical-restore] OK');
}

const run = process.argv[2] === 'restore' ? restore() : dump();
run.catch((e) => { console.error(e); process.exit(1); });
