/**
 * Part 3b — owner tool: reset a TEACHER's password to a random temporary one.
 * The teacher is forced to change it on next login (must_change_password). All
 * their refresh sessions are revoked. The temporary password is printed ONCE and
 * never logged elsewhere.
 *
 * Usage: pnpm --filter @klass/api reset-teacher -- <email>
 *        (DATABASE_URL from env / .env)
 */
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..'); // repo root
const email = (process.argv.slice(2).find((a) => a.includes('@')) ?? '').trim().toLowerCase();
if (!email) { console.error('usage: reset-teacher -- <email>'); process.exit(2); }

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL is required'); process.exit(2); }

const { hashPassword } = await import(pathToFileURL(path.join(root, 'apps/api/dist/lib/password.js')).href);

const TEMP_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
function tempPassword(len = 12) {
  const b = randomBytes(len);
  let s = '';
  for (let i = 0; i < len; i++) s += TEMP_ALPHABET[b[i] % TEMP_ALPHABET.length];
  return s;
}

const sql = postgres(url, { max: 1 });
try {
  const [u] = await sql`select id, role, email from users where email = ${email} and deleted_at is null limit 1`;
  if (!u) { console.error('no such active account'); process.exit(1); }
  const pw = tempPassword();
  const hash = await hashPassword(pw);
  await sql`update users set password_hash = ${hash}, must_change_password = true where id = ${u.id}`;
  await sql`delete from refresh_tokens where user_id = ${u.id}`;
  // one audit row (actor = the account itself; this is an owner action)
  await sql`insert into audit_log (actor_id, action, target) values (${u.id}, 'owner_reset_password', ${JSON.stringify({ userId: u.id, role: u.role })})`;
  console.log(`Temporary password for ${u.email}:`);
  console.log(pw);
  console.log('(shown once; the user must change it at next login)');
} finally {
  await sql.end();
}
