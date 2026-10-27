/**
 * C4 (2026-10-16): блокирующий аудит production-зависимостей.
 *
 * Почему это не может быть шагом `pnpm audit --prod --audit-level=high` (как было раньше):
 * замер CI-прогона 38844444987 — таблица с high-находкой `braces` напечатана, шаг закончился
 * кодом 0, job зелёный. То есть уровень фильтрации в этом pnpm фильтрует ВЫВОД, а не исход, и
 * «проверка» не проверяла ничего. Здесь решение принимает скрипт: high и critical блокируют,
 * кроме явно перечисленных ниже (причина + срок пересмотра), а непрочитанный аудит — это
 * отдельная, красная ветка (2), чтобы «не посмотрели» снова не стало «чисто».
 *
 * Запуск:
 *   node scripts/audit-gate.mjs              # как в CI
 *   node scripts/audit-gate.mjs --strict     # игнорировать список известных (для доказательства)
 * Значения зависимостей и путей в вывод не печатаются секретными быть не могут, но и здесь
 * вывод — только идентификаторы advisories, пакеты и пути в дереве.
 */
import { spawnSync } from 'node:child_process';

/**
 * Известные и принятые high/critical находки. Каждая обязана иметь причину и срок пересмотра;
 * просроченная запись роняет CI, а не живёт вечно.
 */
const KNOWN = [
  // GHSA-vfj7-8cjw-p6xm (braces, high) здесь был и удалён 2026-10-27, а не «потому что надоело».
  // Запись появилась, когда у пакета не было патчера; сейчас в lock-файле braces@3.0.3 — это
  // ровно запатчиванная версия, и `pnpm audit --prod` больше не выдаёт этой находки (`принято 0`).
  // Мёртвая запись в списке известных опасна не «захламлённостью», а обратным: она молча приняла
  // бы будущую находку на braces, которая обязана блокировать. Поэтому в KNOWN живёт только то,
  // что реально приходится нести.
  {
    id: 'GHSA-238p-pmpm-9mq7',
    severity: 'low',
    package: 'katex',
    // Listed because the owner named it; severity "low" never blocks this gate. Reached through
    // @excalidraw/mermaid-to-excalidraw → mermaid → katex, i.e. math rendering inside the board.
    reason: 'названа владельцем; severity low — гейт на high/critical её не блокирует; путь через mermaid в доске',
    reviewBy: '2027-01-15',
  },
];
const BLOCKS = new Set(['high', 'critical']);

const strict = process.argv.includes('--strict');
/*
 * Windows: `pnpm` — .cmd-обёртка. Node ≥ 18.19 отказывается запускать .cmd без shell (EINVAL),
 * а shell с массивом аргументов печатает DEP0190 (аргументы склеиваются, а не экранируются).
 * Аргумента три, все литеральные и без пробелов, поэтому на Windows команда собирается строкой,
 * а на Linux остаётся массивом без shell.
 */
const AUDIT_ARGS = ['audit', '--prod', '--json'];
const OPTS = { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 };
const run = process.platform === 'win32'
  ? spawnSync(['pnpm', ...AUDIT_ARGS].join(' '), { ...OPTS, shell: true })
  : spawnSync('pnpm', AUDIT_ARGS, OPTS);
if (run.error) {
  console.error(`audit-gate: не удалось запустить pnpm audit — ${run.error.message}`);
  process.exit(2);
}
let parsed;
try {
  parsed = JSON.parse(run.stdout);
} catch {
  // Network failure, registry 5xx, unparseable body: none of these is "no vulnerabilities".
  console.error('audit-gate: pnpm audit не вернул читаемый JSON — проверка не состоялась');
  console.error((run.stderr || run.stdout || '').slice(0, 500));
  process.exit(2);
}
const advisories = parsed.advisories ?? {};
const ids = Object.keys(advisories);
if (ids.length === 0 && (parsed.metadata?.vulnerabilities?.total ?? 0) > 0) {
  console.error('audit-gate: metadata говорит об уязвимостях, а список advisories пуст — вывод нечитаем');
  process.exit(2);
}

const known = new Map(KNOWN.map((k) => [k.id, k]));
const today = new Date().toISOString().slice(0, 10);
const blocking = [];
const accepted = [];
const ignored = [];
for (const a of Object.values(advisories)) {
  const label = `${a.github_advisory_id ?? a.module_name} ${a.severity} ${a.module_name}`;
  if (!BLOCKS.has(a.severity)) { ignored.push(label); continue; }
  const k = known.get(a.github_advisory_id);
  if (!strict && k && k.severity === a.severity && k.package === a.module_name) {
    if (k.reviewBy < today) blocking.push(`${label}: срок пересмотра ${k.reviewBy} прошёл — пересмотреть запись или обновить пакет`);
    else accepted.push(`${label} (принято до ${k.reviewBy})`);
  } else {
    blocking.push(`${label} — ${a.title} ${a.url ?? ''}`.trim());
  }
}

console.log(`audit-gate: production-зависимостей ${parsed.metadata?.totalDependencies ?? '?'}, advisories ${ids.length}`);
for (const line of accepted) console.log(`  принято: ${line}`);
for (const line of ignored) console.log(`  ниже порога high: ${line}`);
if (blocking.length) {
  for (const line of blocking) console.error(`  БЛОКИРУЕТ: ${line}`);
  console.error('audit-gate: high/critical без принятой записи — обновите зависимость или внесите её в KNOWN с причиной и сроком пересмотра');
  process.exit(1);
}
console.log(`audit-gate: блокирующих high/critical нет (принято ${accepted.length}, ниже порога ${ignored.length})`);
