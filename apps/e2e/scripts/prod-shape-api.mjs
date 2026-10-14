/**
 * Boot (and stop) an API process in the DEPLOYED shape, for zz9-prod-shape.spec.ts only.
 *
 * Why it is owned by the spec instead of by e2e-stack.mjs: a second API + pg-boss worker
 * running for the whole 8-minute suite costs real CPU on a small dev box, and the
 * timing-tight specs (material's scheduled post) start to time out because of that load,
 * not because of the product. The deployed shape is only interesting for one scenario, so
 * exactly that scenario pays for it.
 *
 * The process gets its OWN database (klass_prod, created by the stack) — two API processes
 * on one database would both claim the pg-boss jobs and race on drizzle migrations, which is
 * a test artefact: production runs one process. The empty database is also the proof that
 * NODE_ENV=production really reads dist/db/migrations (lib/prodConfig.effectiveMigrationsFolder).
 */
import { readPolicyVersion } from './policyVersion.mjs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import postgres from 'postgres';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '../../..');
export const PROD_PORT = 3124;
const PGPORT = 5455;
export const PROD_BASE = `http://127.0.0.1:${PROD_PORT}`;

/** Seed the accounts the spec needs, once the migrations of this run exist. */
async function seed(url, teacherHash) {
  const admin = postgres(url, { max: 2 });
  try {
    await admin.unsafe(`
      insert into users (id, role, name, last_name, email, password_hash, locale, locale_explicit, tz, created_at, profile_completed_at)
      values ('00000000-0000-4000-8000-00000000e2e1', 'teacher', 'E2E Teacher', 'E2E', 'owner@e2e.io',
              '${teacherHash}', 'ru', true, 'Asia/Tashkent', now(), now())
      on conflict (email) do update set last_name = 'E2E', profile_completed_at = now()`);
    const POLICY_VERSION = readPolicyVersion();
    await admin`
      insert into policy_acceptances (user_id, version, accepted_at)
      select id, ${POLICY_VERSION}, now() from users
      on conflict (user_id) do update set version = ${POLICY_VERSION}, accepted_at = now()`;
  } finally { await admin.end({ timeout: 5 }); }
}

/** @returns {{ stop: () => Promise<void> }} */
export async function startProdShapeApi(teacherPassword = 'Passw0rd123') {
  const url = `postgres://klass:klass@127.0.0.1:${PGPORT}/klass_prod`;
  // hash the known test password with the API's own argon2id implementation
  const { hashPassword } = await import(pathToFileURL(path.join(ROOT, 'apps/api/dist/lib/password.js')).href);
  const teacherHash = await hashPassword(teacherPassword);

  const child = spawn('node', ['dist/server.js'], {
    cwd: path.join(ROOT, 'apps/api'),
    stdio: ['ignore', 'inherit', 'inherit'],
    env: {
      ...process.env,
      NODE_ENV: 'production',        // the branch no other suite ever reaches
      TRUST_PROXY: '1',              // Render/Caddy sit behind a proxy
      PORT: String(PROD_PORT),
      HOST: '127.0.0.1',
      DATABASE_URL: url,
      WEB_DIST: path.join(ROOT, 'apps/web/dist'),
      STORAGE_DIR: path.join(ROOT, 'apps/e2e/files-prod'),
      JWT_SECRET: 'e2e-secret-e2e-secret-e2e-secret-0123456789',
      LIVEKIT_API_KEY: process.env.LIVEKIT_API_KEY ?? 'e2ekey',
      LIVEKIT_API_SECRET: process.env.LIVEKIT_API_SECRET ?? 'e2esecrete2esecrete2esecrete2esecret',
      LIVEKIT_WS_URL: process.env.LIVEKIT_WS_URL ?? 'ws://127.0.0.1:7880',
      ...(process.env.LIVEKIT_URL ? { LIVEKIT_URL: process.env.LIVEKIT_URL } : {}),
      LIVEKIT_INTERNAL_URL: 'http://127.0.0.1:7880',
      TELEGRAM_TRANSPORT: 'log',
      // PUBLIC_URL == the address the page is served from (the cloud config the outage had)
      PUBLIC_URL: PROD_BASE,
      PUBLIC_WEB_ORIGIN: PROD_BASE,
    },
  });
  const exited = new Promise((_, rej) => child.on('exit', (c) => rej(new Error(`prod-shaped api exited (${c})`))));
  try {
    for (let i = 0; i < 90; i++) {
      await Promise.race([
        new Promise((r) => setTimeout(r, 1000)),
        exited.then(() => Promise.reject(new Error('exited'))),
      ]);
      try { if ((await fetch(`${PROD_BASE}/api/health`)).ok) break; } catch { /* not yet */ }
    }
  } finally { /* keep child running until stop() */ }

  const h = await fetch(`${PROD_BASE}/api/health/live`).catch(() => null);
  if (!h?.ok) throw new Error('production-shaped api never became healthy');
  await seed(url, teacherHash);

  return {
    base: PROD_BASE,
    port: PROD_PORT,
    async stop() {
      child.kill();
      await new Promise((r) => { child.on('exit', r); setTimeout(r, 3000); });
    },
  };
}
