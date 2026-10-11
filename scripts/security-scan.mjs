/**
 * Security scan (Hardening Phase 1м): flag likely committed secrets in the
 * tracked working tree AND across full git history. This is a defense-in-depth
 * CI aid, not a guarantee — the real control is "secrets live only in the
 * deploy environment". High-confidence shapes only, so ordinary code that
 * merely names an env var (env.JWT_SECRET) does not trip it.
 *
 * Usage: node scripts/security-scan.mjs            # working tree + history
 *        SCAN_HISTORY=0 node scripts/security-scan.mjs
 *        node scripts/security-scan.mjs --selftest  # detector positive control
 *
 * Exit code 1 if any candidate is found (so CI can gate on it), 2 if the scan could not actually
 * read the tree or the history — a scan that saw nothing is not a clean scan.
 */
import { execSync } from 'node:child_process';

const PATTERNS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'private key block'],
  [/\bsk-[A-Za-z0-9]{20,}\b/, 'Stripe/OpenAI-style secret key'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'AWS access key id'],
  [/\bghp_[A-Za-z0-9]{36}\b|\bgithub_pat_[A-Za-z0-9_]{40,}\b/, 'GitHub token'],
  [/\bglpat-[A-Za-z0-9_-]{20}\b/, 'GitLab token'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, 'Slack token'],
  [/\b[0-9]{8,10}:AA[A-Za-z0-9_-]{30,}\b/, 'Telegram bot token'],
  [/\beyJhbGciOi[A-Za-z0-9_.-]{20,}\b/, 'raw JWT'],
];

// files/paths that legitimately contain look-alikes (fixtures, examples)
const ALLOW = /(\.example$|\/test\/|\.test\.|e2e-stack|camera-repro|security-scan|node_modules|\.min\.)/i;

function scan(label, text, where) {
  const hits = [];
  for (const [re, why] of PATTERNS) {
    const m = re.exec(text);
    if (m) hits.push(`${why}`);
  }
  if (hits.length) console.log(`  [${label}] ${where}: ${hits.join(', ')}`);
  return hits.length;
}

/**
 * `--selftest` — a positive control for the detector itself. The history half of this script has
 * been blind on Windows since the day it was added (2026-10-06), and nothing noticed, because
 * "clean" and "blind" printed the same line. Here every shape is planted in a string and
 * must be caught, and a benign file that only *names* the shapes must not be.
 */
if (process.argv.includes('--selftest')) {
  const samples = {
    'private key block': '-----BEGIN RSA PRIVATE KEY-----\nZm9v\n-----END RSA PRIVATE KEY-----',
    'Stripe/OpenAI-style secret key': `sk-${'a'.repeat(24)}`,
    'AWS access key id': `AKIA${'A'.repeat(16)}`,
    'GitHub token': `ghp_${'b'.repeat(36)}`,
    'GitLab token': `glpat-${'c'.repeat(20)}`,
    'Slack token': `xoxb-${'d'.repeat(12)}`,
    'Telegram bot token': `123456789:AA${'e'.repeat(30)}`,
    'raw JWT': `eyJhbGciOi${'f'.repeat(20)}`,
  };
  const benign = 'export const JWT_SECRET = process.env.JWT_SECRET; // docs mention sk-, ghp_, AKIA shapes';
  let bad = 0;
  for (const [re, why] of PATTERNS) {
    if (!(samples[why] && re.test(samples[why]))) { console.error(`selftest: ${why} is NOT detected`); bad += 1; }
    if (re.test(benign)) { console.error(`selftest: ${why} fires on the benign file`); bad += 1; }
  }
  if (Object.keys(samples).length !== PATTERNS.length) { console.error('selftest: sample list and PATTERNS are out of sync'); bad += 1; }
  console.log(bad === 0
    ? `security-scan selftest: ${PATTERNS.length} shapes detected, benign text clean.`
    : `security-scan selftest: ${bad} problem(s).`);
  process.exit(bad === 0 ? 0 : 1);
}

let found = 0;

/**
 * A check that could not read anything must not report "clean". Both git calls below used to be
 * wrapped in `catch { … = '' }`, and on Windows that is exactly how the history half went blind:
 * Git for Windows ships a global `diff.astextplain.textconv`, which is fed every binary blob in
 * the diff — including the deleted `.docx` upload fixtures under `apps/api/test/.files/` — and
 * aborts the whole `git log -p` with exit 128 ("unsupported filetype" + "unable to read files to
 * diff"). `--no-textconv` diffs blobs as raw bytes instead, which is what a secret scanner wants.
 */
function die(msg) {
  console.error(`security-scan: ${msg} — refusing to report "clean".`);
  process.exit(2);
}

// 1) tracked working-tree files
const files = execSync('git ls-files', { encoding: 'utf8' }).split('\n').filter(Boolean);
let unreadable = 0;
for (const f of files) {
  if (ALLOW.test(f)) continue;
  let body = null;
  try { body = execSync(`git show :${f}`, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }); }
  catch { unreadable += 1; console.error(`security-scan: cannot read tracked file ${f}`); continue; }
  found += scan('tree', body, f);
}
if (unreadable > 0) die(`${unreadable} tracked file(s) could not be read`);

// 2) full git history blobs (bounded to commit diffs)
if (process.env.SCAN_HISTORY !== '0') {
  let log = '';
  try {
    log = execSync('git log --all -p --no-color --no-textconv', { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  } catch (e) {
    die(`git log -p failed (${String(e.message).split('\n')[0]}) — the history was not scanned`);
  }
  if (log.length < 1000) die(`git history diff is ${log.length} bytes — that is not a real scan`);
  console.log(`security-scan: history diff read, ${(log.length / 1024 / 1024).toFixed(2)} MB.`);
  // dedupe: only report the first occurrence per shape
  for (const [re, why] of PATTERNS) {
    if (ALLOW.test(why)) continue;
    if (re.test(log)) { console.log(`  [history] shape present: ${why} (investigate — may be a test fixture)`); found += 1; }
  }
}

if (found === 0) {
  console.log('security-scan: no secret-shaped strings found in tracked tree or history.');
  process.exit(0);
} else {
  console.log(`security-scan: ${found} candidate(s) — review above before trusting this signal.`);
  process.exit(1);
}
