/**
 * Windows quirk: embedded-postgres.initialise() lets initdb pick the machine
 * ANSI codepage (WIN1251 on Russian Windows) — then any character outside it
 * (emoji, and Uzbek ʻ U+02BB!) fails INSERT/UPDATE with error 22P05.
 * Production uses the official PostgreSQL image (UTF8), so this ONLY affects
 * the local embedded clusters: demo, integration tests, e2e stack.
 *
 * Init the fresh cluster ourselves with the package's native initdb, forcing
 * the production encoding. Falls back to the library default on any error.
 *
 * Usage:
 *   const ok = await initUtf8Cluster(import.meta.url, dataDir);
 *   if (!ok) await pg.initialise();
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

export async function initUtf8Cluster(importMetaUrl, dataDir, { user = 'klass', password = 'klass' } = {}) {
  if (process.platform !== 'win32') return false;
  try {
    const reqHere = createRequire(importMetaUrl);
    const reqNative = createRequire(reqHere.resolve('embedded-postgres'));
    const nativeEntry = reqNative.resolve('@embedded-postgres/windows-x64');
    const { initdb } = await import(pathToFileURL(nativeEntry).href);
    const pwFile = path.join(path.dirname(dataDir), '.pginit-pw.tmp');
    fs.writeFileSync(pwFile, password);
    execFileSync(initdb, [
      '-D', dataDir, '-U', user, '-A', 'password', '--pwfile', pwFile,
      '--locale=C', '-E', 'UTF8',
    ], { stdio: 'inherit' });
    fs.rmSync(pwFile, { force: true });
    return true;
  } catch (e) {
    console.warn('[pg-init] UTF-8 initdb failed (%s) — falling back to embedded-postgres default', (e && e.message) || e);
    return false;
  }
}
