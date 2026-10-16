/**
 * C3 (2026-10-16): одноразовая сверка находок сканера с настоящими секретами окружения.
 *
 * Зачем: allowlist gitleaks фильтрует значения по ФОРМЕ. Если когда-нибудь фикстура совпадёт с
 * настоящим ключом из облака, «зелёный скан» будет врать по другой причине: не потому, что секрета в
 * репозитории нет, а потому, что настоящий секрет выглядит точно как фикстура. Этот скрипт отвечает на один
 * вопрос: есть ли пересечение по SHA-256 между найденными строками и значениями из файла
 * окружения. Значения НЕ печатаются никогда — ни свои, ни чужие; наружу идут только имена
 * ключей, которых нет в пересечении, количество и правило/файл находки (значения в отчёте
 * gitleaks под красной цензурой, поэтому для сверки отчёт надо снимать без --redact).
 *
 * Отчёт gitleaks — временный файл ВНЕ репозитория, после сверки удаляется:
 *   gitleaks git --no-banner --report-format json --report-path "$TMP/gl.json" -c .gitleaks.toml .
 *   node scripts/gitleaks-crosscheck.mjs --report "%TEMP%\gl.json"
 *
 * Исходы: 0 — пересечений нет; 1 — пересечение найдено (стоп, докладывать владельцу);
 * 2 — вход не прочитан (тогда «чисто» ничего не значит).
 */
import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';

const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

/** Значения из файла окружения: только строки KEY=VALUE, без комментария и кавычек вокруг. */
function envValues(file) {
  const text = readFileSync(file, 'utf8');
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (value.length >= 6) out.push({ key: line.slice(0, eq).trim(), value });
  }
  return out;
}

function secretsFromReport(file) {
  const json = JSON.parse(readFileSync(file, 'utf8'));
  const arr = Array.isArray(json) ? json : Object.values(json);
  return arr
    .map((f) => ({ secret: f.Secret ?? f.secret, rule: f.RuleID ?? f.ruleId, where: f.File ?? f.file }))
    .filter((f) => typeof f.secret === 'string' && f.secret.length > 0);
}

/** Одно пересечение: совпал SHA-256 находки с SHA-256 значения из окружения. */
function intersect(secrets, values) {
  const byHash = new Map(values.map((v) => [sha256(v.value), v.key]));
  const hits = [];
  for (const s of secrets) {
    const key = byHash.get(sha256(s.secret));
    if (key) hits.push({ rule: s.rule, where: s.where, key });
  }
  return hits;
}

function selftest() {
  // Fixture-проверка без настоящих секретов: значение из синтетического окружения обязано
  // быть пойманным, а другое — нет. Печатаются только факты, ни одно значение не печатается.
  const dir = mkdtempSync(path.join(os.tmpdir(), 'gxx-'));
  try {
    const envFile = path.join(dir, 'env');
    writeFileSync(envFile, 'A_SECRET=fixture-alpha-value-1\nB_SECRET=fixture-beta-value-2\n');
    const values = envValues(envFile);
    if (values.length !== 2) { console.error('selftest: парсер окружения видел не 2 значения'); process.exit(2); }
    const hit = intersect([{ secret: 'fixture-beta-value-2', rule: 'r', where: 'w' }], values);
    const miss = intersect([{ secret: 'fixture-gamma-value-3', rule: 'r', where: 'w' }], values);
    const redacted = intersect([{ secret: 'REDACTED', rule: 'r', where: 'w' }], values);
    if (hit.length !== 1 || hit[0].key !== 'B_SECRET') { console.error('selftest: совпадение не поймано'); process.exit(2); }
    if (miss.length !== 0) { console.error('selftest: ложное срабатывание'); process.exit(2); }
    if (redacted.length !== 0) { console.error('selftest: redacted-заглушка не должна совпадать'); process.exit(2); }
    console.log('selftest: совпадение ловится (1), чужое значение — нет (0), REDACTED — нет (0). Значения не печатались.');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv.includes('--selftest')) {
  selftest();
  process.exit(0);
}

const argOf = (name) => {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : undefined;
};
const reportFile = argOf('--report');
const envFile = argOf('--env-file') ?? (existsSync('cloud.env') ? 'cloud.env' : existsSync('.env') ? '.env' : '');

if (!reportFile) {
  console.error('нужен --report <json отчёта gitleaks, снятый БЕЗ --redact>');
  process.exit(2);
}
if (!existsSync(reportFile)) { console.error(`отчёт не найден: ${reportFile}`); process.exit(2); }
if (!envFile || !existsSync(envFile)) {
  console.error('файл окружения не найден (cloud.env или .env) — сверять не с чем, «чисто» ничего не значит');
  process.exit(2);
}

const secrets = secretsFromReport(reportFile);
const values = envValues(envFile);
console.log(`сверка: находок в отчёте ${secrets.length}, значений окружения ${values.length} (длинной ≥6), файл ${envFile}`);
if (secrets.length === 0) {
  console.log('пересечений нет: находок нет. Значения не читаны и не напечатаны.');
  process.exit(0);
}
const hits = intersect(secrets, values);
if (hits.length) {
  // Ни одного значения не выводим: только где лежит и как называется ключ окружения.
  for (const h of hits) console.error(`СОВПАДЕНИЕ: правило ${h.rule} в файле ${h.where} = ключ окружения ${h.key}`);
  console.error('Стоп: найденное совпадает с настоящим значением окружения. Докладывать владельцу, в репозиторий это не коммитить.');
  process.exit(1);
}
console.log(`пересечений нет: ${secrets.length} находок не совпадают ни с одним значением окружения.`);
