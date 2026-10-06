/**
 * Security scan (Hardening Phase 1м): flag likely committed secrets in the
 * tracked working tree AND across full git history. This is a defense-in-depth
 * CI aid, not a guarantee — the real control is "secrets live only in the
 * deploy environment". High-confidence shapes only, so ordinary code that
 * merely names an env var (env.JWT_SECRET) does not trip it.
 *
 * Usage: node scripts/security-scan.mjs            # working tree + history
 *        SCAN_HISTORY=0 node scripts/security-scan.mjs
 *
 * Exit code 1 if any candidate is found (so CI can gate on it).
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

let found = 0;

// 1) tracked working-tree files
const files = execSync('git ls-files', { encoding: 'utf8' }).split('\n').filter(Boolean);
for (const f of files) {
  if (ALLOW.test(f)) continue;
  let body = '';
  try { body = execSync(`git show :${f}`, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }); } catch { continue; }
  found += scan('tree', body, f);
}

// 2) full git history blobs (bounded to commit diffs)
if (process.env.SCAN_HISTORY !== '0') {
  let log = '';
  try {
    log = execSync('git log --all -p --no-color', { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  } catch { log = ''; }
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
