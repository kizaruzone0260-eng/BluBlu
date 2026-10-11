/**
 * CI-гейт: в прогоне e2e не должно быть пропущенных тестов.
 *
 *   node scripts/ci-no-skips.mjs [путь к e2e-results.json]
 *
 * Зачем: у RTC-спеков (zz2, zz13, zz16, zz17, zz18) есть self-skip — если медиа-сервер не отвечает,
 * тест молча пропускается, а playwright выходит с нулём. Без этого гейта живой job с мёртвым
 * LiveKit-контейнером выглядел бы зелёным ровно так же, как job, где восемь RTC-проверок
 * действительно прогнались. Тот же класс ошибки, что и «проглоченный» git в security-scan.
 *
 * Файл отсутствует, пустой, без секции stats или с нулём ожидающих тестов — это тоже провал:
 * «не посмотрел» не бывает успехом.
 */
import fs from 'node:fs';
import path from 'node:path';

const file = process.argv[2] ?? path.join('apps', 'e2e', 'e2e-results.json');

function die(msg) {
  console.error(`ci-no-skips: ${msg}`);
  process.exit(2);
}

if (!fs.existsSync(file)) die(`нет отчёта ${file} — проверка не запускалась (json-репорт не написан?)`);
let report;
try { report = JSON.parse(fs.readFileSync(file, 'utf8')); }
catch (e) { die(`отчёт ${file} не читается как JSON: ${String(e.message).split('\n')[0]}`); }

const stats = report?.stats;
if (!stats || typeof stats.expected !== 'number') die('в отчёте нет секции stats — это не progon-отчёт playwright');

const skipped = [];
const walk = (node) => {
  for (const spec of node?.specs ?? []) {
    for (const t of spec.tests ?? []) {
      const st = (t.results ?? []).map((r) => r.status).join(',');
      if (st.includes('skipped')) skipped.push(`${spec.title}${spec.projectName ? ` [${spec.projectName}]` : ''}`);
    }
  }
  for (const s of node?.suites ?? []) walk(s);
};
for (const suite of report.suites ?? []) walk(suite);

const listed = skipped.length ? skipped.length : (stats.skipped ?? 0);
console.log(`ci-no-skips: expected=${stats.expected} skipped=${stats.skipped ?? 0} unexpected=${stats.unexpected ?? 0} flaky=${stats.flaky ?? 0}`);
if (stats.expected === 0) die('ни один тест не заявлен как ожидаемо проходящий — прогона не было');
if (listed > 0) {
  for (const s of skipped.slice(0, 20)) console.error(`  skipped: ${s}`);
  console.error(`ci-no-skips: FAIL — пропущено тестов: ${listed}. RTC-спеки пропускаются сами, когда недоступен медиа-сервер, и без этого гейта такой прогон был бы зелёным.`);
  process.exit(1);
}
console.log('ci-no-skips: PASS — пропущенных тестов нет.');
