/**
 * Part 1(б) — backup encryption + restore-to-empty verification.
 *
 * End-to-end against the embedded cluster via the driver logical path that
 * backup.sh/restore.sh fall back to when pg_dump is unavailable. Proves:
 *  • a populated source DB is dumped to disk;
 *  • the archive is encrypted with backup.sh's exact openssl recipe
 *    (aes-256-cbc -pbkdf2) — ciphertext differs, carries the "Salted__" header,
 *    decrypts back byte-for-byte with the right passphrase, and does NOT recover
 *    the plaintext with a wrong one;
 *  • the decrypted dump restores into a BRAND-NEW EMPTY database (the restore
 *    applies migrations itself) and EVERY base table's row count matches source.
 *
 * The production backup runs the same scripts against the real Postgres
 * (docs/HARDENING.md §о); this validates the full pipeline offline.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import postgres from 'postgres';
import { TEST_DATABASE_URL, preparedDb, makeTeacher, type TestDB } from './util.js';

const suite = TEST_DATABASE_URL ? describe : describe.skip;
const PHRASE = 'unit-test-passphrase-xyz';
const apiDir = process.cwd(); // apps/api under with-postgres

function openssl(mode: 'enc' | 'dec', inFile: string, outFile: string, passphrase: string, cwd: string) {
  const a = mode === 'enc'
    ? ['enc', '-aes-256-cbc', '-pbkdf2', '-salt', '-pass', `pass:${passphrase}`, '-in', inFile, '-out', outFile]
    : ['enc', '-d', '-aes-256-cbc', '-pbkdf2', '-pass', `pass:${passphrase}`, '-in', inFile, '-out', outFile];
  execFileSync('openssl', a, { cwd });
}

suite('Part 1(б): backup encryption + restore-to-empty', () => {
  let t: TestDB;
  beforeAll(async () => { t = await preparedDb(TEST_DATABASE_URL); });
  afterAll(async () => { await t?.sql.end(); });

  it('dumps → encrypts → decrypts → restores into an empty DB with matching counts', async () => {
    // seed a few tables so the round-trip has real rows
    const te = await makeTeacher(t.sql, `bk-t${Date.now()}@x.io`);
    await t.sql`insert into classes (teacher_id, name) values (${te.id}, ${'Backup class'})`;
    await t.sql`insert into login_attempts (email, fail_count) values (${'bk-probe@x.io'}, 2)`;

    const tmp = mkdtempSync(path.join(tmpdir(), 'bkp-'));
    const dumpDir = path.join(tmp, 'dump');
    const targetDb = `klass_verify_${crypto.randomBytes(6).toString('hex')}`; // [0-9a-f] only
    const admin = postgres(TEST_DATABASE_URL, { max: 1 });
    try {
      // 1) dump (node handles absolute Windows paths)
      execFileSync(process.execPath, ['scripts/logical-backup.mjs', `out=${dumpDir}`],
        { cwd: apiDir, env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL }, stdio: 'pipe' });

      // 2) tar + encrypt — run in `tmp` with BARE names (avoids tar's drive/colon parsing)
      execFileSync('tar', ['-czf', 'dump.tar.gz', 'dump'], { cwd: tmp });
      const plain = readFileSync(path.join(tmp, 'dump.tar.gz'));
      openssl('enc', 'dump.tar.gz', 'dump.tar.gz.enc', PHRASE, tmp);
      const cipher = readFileSync(path.join(tmp, 'dump.tar.gz.enc'));
      expect(cipher.equals(plain)).toBe(false);
      expect(cipher.subarray(0, 8).toString('latin1')).toBe('Salted__');

      // 3) wrong passphrase must not recover the plaintext
      let recovered = true;
      try { openssl('dec', 'dump.tar.gz.enc', 'bad.gz', 'wrong-passphrase', tmp); recovered = readFileSync(path.join(tmp, 'bad.gz')).equals(plain); }
      catch { recovered = false; } // openssl threw → correct: no plaintext leak
      expect(recovered, 'a wrong passphrase must not yield the original archive').toBe(false);

      // 4) correct decrypt + extract
      openssl('dec', 'dump.tar.gz.enc', 'dec.tar.gz', PHRASE, tmp);
      expect(readFileSync(path.join(tmp, 'dec.tar.gz')).equals(plain)).toBe(true);
      const extract = path.join(tmp, 'extract'); mkdirSync(extract);
      execFileSync('tar', ['-xzf', 'dec.tar.gz', '-C', 'extract'], { cwd: tmp });
      const restoreDir = path.join(extract, 'dump');

      // 5) restore into a BRAND-NEW EMPTY database (created here; restore applies migrations)
      await admin.unsafe(`create database ${targetDb}`);
      const url = new URL(TEST_DATABASE_URL); url.pathname = `/${targetDb}`;
      const targetUrl = url.toString();
      execFileSync(process.execPath, ['scripts/logical-backup.mjs', 'restore', `in=${restoreDir}`, `url=${targetUrl}`],
        { cwd: apiDir, env: { ...process.env, DATABASE_URL: targetUrl }, stdio: 'pipe' });

      // 6) every base table count matches source ↔ freshly-restored empty DB
      const tgt = postgres(targetUrl, { max: 1 });
      const tables = await admin`
        select c.relname as t from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r' and c.relname <> '__drizzle_migrations'`;
      let checked = 0;
      for (const { t: name } of tables) {
        const s = await t.sql.unsafe(`select count(*)::int as n from "${name}"`);
        const r = await tgt.unsafe(`select count(*)::int as n from "${name}"`);
        expect(r[0].n, `${name} row count restored`).toBe(s[0].n);
        checked++;
      }
      expect(checked).toBeGreaterThan(20);
      // the seeded class really arrived
      const arrived = await tgt`select name from classes where name = ${'Backup class'}`;
      expect(arrived.length).toBe(1);
      await tgt.end();
    } finally {
      await admin.unsafe(`drop database if exists ${targetDb}`).catch(() => undefined);
      await admin.end();
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
