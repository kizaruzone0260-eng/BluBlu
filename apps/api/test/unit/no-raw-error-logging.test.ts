/**
 * Task 7 item 4 — the inventory, enforced.
 *
 * The question this answers is not "is there console.*" (there is, and at boot there is nothing else
 * to print with) but "can an exception or a request object reach it whole". Every one of the leaks
 * in this family started the same way: a line that looked fine and a formatter that was never
 * called. So the rule is mechanical and lives in the test run:
 *
 *  1. a `console.*` call that mentions an error at all must route it through the shared formatter
 *     (`describeError`, `errorLine`, `botErrorLine`, `safeErrorMessage`, `redactSecrets`);
 *  2. no `console.*` call may contain `.message` or `inspect(` — those are the two shapes that put
 *     a driver's message or a grammY payload into the log;
 *  3. only the files on the allowlist print to stdout/stderr at all.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const SRC = path.resolve(__dirname, '../../src');
const ALLOWED_FILES = new Set([
  'env.ts', // names the rejected config keys, never their values
  'server.ts', // boot lines: class+code or a redacted message
  'lib/crashGuards.ts', // the two process handlers
  'lib/errorObservers.ts', // the default log sink of attachErrorLogging
  'services/seed.ts', // the seeded operator account (an email the admin configured)
  'scripts/seed-teacher.ts',
  'scripts/seed-demo.ts',
]);
const FORMATTERS = ['describeError', 'errorLine', 'botErrorLine', 'safeErrorMessage', 'redactSecrets'];

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) out.push(...tsFiles(p));
    else if (name.endsWith('.ts')) out.push(p);
  }
  return out;
}

/** The argument text of a `console.x(…)` call, matched by paren depth (strings ignored). */
function consoleCalls(src: string): { line: number; text: string }[] {
  const found: { line: number; text: string }[] = [];
  const re = /console\.(?:log|info|warn|error|debug)\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    let depth = 1; let i = m.index + m[0].length; let inStr = '';
    for (; i < src.length && depth > 0; i++) {
      const c = src[i];
      if (inStr) { if (c === '\\') i++; else if (c === inStr) inStr = ''; continue; }
      if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
      if (c === '(') depth++;
      else if (c === ')') depth--;
    }
    found.push({ line: src.slice(0, m.index).split('\n').length, text: src.slice(m.index, i) });
  }
  return found;
}

const files = tsFiles(SRC);
const offenders: string[] = [];
let total = 0;
for (const file of files) {
  const rel = path.relative(SRC, file).replace(/\\/g, '/');
  const src = readFileSync(file, 'utf8');
  const calls = consoleCalls(src);
  total += calls.length;
  for (const call of calls) {
    // the method name itself is `console.error` — the rule is about the ARGUMENTS
    const args = call.text.replace(/^console\.\w+\(/, '');
    const mentionsError = /\b(err|error|e)\b/.test(args);
    const formatted = FORMATTERS.some((f) => args.includes(f));
    const label = `${rel}:${call.line}`;
    if (args.includes('.message') || args.includes('inspect(')) offenders.push(`${label} prints a raw message/inspect`);
    else if (mentionsError && !formatted) offenders.push(`${label} passes an error without the formatter: ${call.text.slice(0, 80)}`);
    if (!ALLOWED_FILES.has(rel)) offenders.push(`${label} is in a file that must not print (${rel})`);
  }
}

describe('console.* inventory in apps/api/src (task 7)', () => {
  it('reports the count so the CI log shows the inventory', () => {
    // eslint-disable-next-line no-console -- this is the report the task asked for
    process.stdout.write(`\n[console inventory] ${total} call sites in ${files.length} files; `
      + `allowed files: ${[...ALLOWED_FILES].join(', ')}\n`);
    expect(total).toBeGreaterThan(0); // the scan actually finds something
  });

  it('has no console call that can receive an error or a request object whole', () => {
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('keeps the count from growing silently (a new boot line is fine, a new error print is not)', () => {
    // 20 sites existed after task 5; the number is a tripwire, not a target — if a legitimate new
    // boot line is added, this test says so and the expectation moves with a review.
    // 22 → 25 (часть A4/A5, 2026-10-16): три строки в серверном проводе — `notify: удалено рядов
    // старше 30 дн.`, `telegram: добито незавершённых обновлений` и `telegram reprocess skipped`.
    // Все три — статус процесса, печатаются раз за цикл/при старте, причина падения идёт через
    // errorLine(), ни одна не передаёт объект ошибки или строку запроса целиком.
    expect(total).toBeLessThanOrEqual(25);
  });
});
