/**
 * CI-файл — это тоже код, который исполняет чужое (2026-10-28, аудит SEC-07).
 *
 * Две стороны одной находки жили не в приложении, а в `.github/workflows/ci.yml`:
 *
 *  CWE-269. У файла не было блока `permissions` вообще — каждый job получал scope
 *  из настроек репозитория, а «по умолчанию» там умеет быть read-write. Опасность не в том,
 *  что кто-то этим воспользуется завтра, а в том, что ни один существующий тест об этом
 *  не сказал бы: CI был зелёным и с минимальными правами, и с максимальными.
 *
 *  CWE-1104. Сторонние действия были закреплены на мутабельный тег `@v4`. Тег —
 *  указатель, который владелец чужого репозитория двигает в любую минуту: следующий релиз
 *  приезжает в CI сам, без решения владельца BluBlu и без изменения этого файла.
 *
 * Теперь оба свойства зафиксированы здесь. Тест намеренно проверяет не «в файле написано
 * `contents: read`», а инварианты, которые переживут правки:
 *   – каждый `uses:` — сорок hex-символов плюс комментарий с версией (человеку нужно видеть,
 *     что именно закреплено, иначе обновление превращается в археологию);
 *   – write-права есть ровно у тех job'ов, которые грузят артефакты, и ни у одного другого;
 *   – `workflow_dispatch` остаётся (без него нельзя перезапустить прогон на том же хэше —
 *     а именно этим доказывается, что зелёный RTC-прогон не был везением);
 *   – `pull_request_target` отсутствует: на PR из форка этот триггер отдаёт контекст с
 *     секретами и правом записи, и одного его добавления достаточно, чтобы весь пиннинг
 *     перестал что-либо значить.
 *
 * Почему разбор текстовый, а не через YAML-парсер: в окружении нет ни actionlint, ни yaml-,
 * ни js-yaml-пакета, доступного этому workspace'у по строгому layout pnpm, а добавлять
 * зависимость ради проверки lockfile'а — менять то, что проверяешь. Поэтому здесь проверяется
 * ровно то, что можно доказать текстом. Полную синтаксическую валидность YAML подтвердит
 * только сам GitHub при запуске — это ограничение честно записано в отчёте фазы.
 *
 * У каждого утверждения есть негативный контроль: мутация того же файла обязана ломать
 * проверку. Иначе «зелёный» означал бы «функция ничего не нашла», а не «в файле всё верно» —
 * ровно та ошибка, из-за которой прежний CI и молчал.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// от apps/api/test/unit — четыре уровня вверх до корня монорепозитория
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const WORKFLOW_PATH = path.join(ROOT, '.github', 'workflows', 'ci.yml');
// CRLF → LF: на Windows checkout файла идёт с \r\n, а мутации в негативных контролях записаны
// через \n. Переводы строк не предмет проверки — предметом являются права и закрепления.
const RAW = readFileSync(WORKFLOW_PATH, 'utf8').replace(/\r\n/g, '\n');

const EXPECTED_JOBS = [
  'backup-restore', 'build-test', 'docker-image', 'e2e', 'e2e-unstable', 'phone-shots', 'runtime-smoke',
] as const;

/**
 * Действия, пиннинг которых проверен осознанно. Новое имя здесь — это не «добавь строку»,
 * а «посмотри, что оно делает, на каком коммите стоит и зачем нужно»: без такого шага
 * стороннее действие попадает в CI мимо любого ревью.
 */
const KNOWN_ACTIONS = new Set([
  'actions/checkout',
  'actions/setup-node',
  'actions/upload-artifact',
  'pnpm/action-setup',
]);

const UPLOAD_ACTION = 'actions/upload-artifact';

interface Pin { action: string; sha: string; version: string | null; line: number }

interface Permissions { entries: Record<string, string>; line: number }

/** Негативный контроль не должен печатать весь файл: только первую строку проблемы. */
function firstLine(problems: string[]): string {
  return problems[0] ?? '';
}

function parsePermissions(lines: string[], headerIndent: number): Permissions | null {
  const header = `${' '.repeat(headerIndent)}permissions:`;
  const idx = lines.findIndex((l) => l.trimEnd() === header);
  if (idx === -1) return null;
  const entries: Record<string, string> = {};
  for (let i = idx + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim()) continue;
    const m = new RegExp(`^${' '.repeat(headerIndent + 2)}([a-z-]+):\\s*(\\S+)\\s*$`).exec(line);
    if (!m) break; // блок кончился: следующая строка с другим отступом
    entries[m[1]!] = m[2]!;
  }
  return { entries, line: idx + 1 };
}

function parsePins(lines: string[]): { pins: Pin[]; problems: string[] } {
  const pins: Pin[] = [];
  const problems: string[] = [];
  lines.forEach((line, i) => {
    if (!/\buses:/.test(line)) return;
    // шаг бывает двух форм: `- uses: …` и `- name: …` со следующим `uses:` без дефиса
    const m = /^\s*(?:-\s+)?uses:\s*(\S+)\s*(?:#\s*(.*))?$/.exec(line);
    if (!m) {
      problems.push(`строка ${i + 1}: не удалось разобрать uses — «${line.trim()}»`);
      return;
    }
    const ref = m[1]!;
    const comment = (m[2] ?? '').trim();
    const at = ref.lastIndexOf('@');
    const action = at > 0 ? ref.slice(0, at) : ref;
    const sha = at > 0 ? ref.slice(at + 1) : '';
    if (!/^[0-9a-f]{40}$/.test(sha)) {
      problems.push(`строка ${i + 1}: «${ref}» не закреплён на commit SHA (нужны 40 hex-символов)`);
    }
    // версия в комментарии — для человека: без неё обновление SHA превращается в археологию
    const version = /^v?\d+\.\d+\.\d+/.test(comment) ? comment.split(/\s+/)[0]! : null;
    if (!version) {
      problems.push(`строка ${i + 1}: у «${action}» нет комментария с версией (# vX.Y.Z)`);
    }
    pins.push({ action, sha, version, line: i + 1 });
  });
  return { pins, problems };
}

function checkWorkflow(text: string): string[] {
  const problems: string[] = [];
  const lines = text.split(/\r?\n/);

  // ── верхний уровень ──────────────────────────────────────────────────────────
  const top = parsePermissions(lines, 0);
  if (!top) {
    problems.push('нет явного блока permissions верхнего уровня — job’ы получат scope из настроек репозитория');
  } else {
    if (top.entries.contents !== 'read') {
      problems.push(`верхний permissions.contents = «${top.entries.contents ?? '—'}», ожидается read`);
    }
    const writes = Object.entries(top.entries).filter(([, v]) => v === 'write').map(([k]) => k);
    if (writes.length) problems.push(`верхний permissions даёт write: ${writes.join(', ')}`);
  }

  if (!lines.some((l) => l.trimEnd() === '  workflow_dispatch:')) {
    problems.push('нет workflow_dispatch: прогон на том же хэше не перезапустить');
  }
  if (lines.some((l) => /^\s*pull_request_target\s*:/.test(l))) {
    problems.push('pull_request_target: контекст с секретами и записью отдаётся PR из форка');
  }
  if (/\bwrite-all\b/.test(text)) {
    problems.push('write-all: права выдаются целиком, а не по необходимости');
  }

  // ── закрепление сторонних действий ───────────────────────────────────────────
  const { pins, problems: pinProblems } = parsePins(lines);
  problems.push(...pinProblems);

  const seen = new Map<string, Pin>();
  for (const pin of pins) {
    if (!KNOWN_ACTIONS.has(pin.action)) {
      problems.push(`строка ${pin.line}: «${pin.action}» — новое действие, его нужно осознанно проверить и внести в KNOWN_ACTIONS`);
    }
    const prev = seen.get(pin.action);
    if (prev && prev.sha !== pin.sha) {
      problems.push(`«${pin.action}» закреплён разными SHA: ${prev.sha} (строка ${prev.line}) и ${pin.sha} (строка ${pin.line})`);
    }
    if (prev && prev.version !== pin.version) {
      problems.push(`«${pin.action}» подписан разными версиями: ${prev.version} и ${pin.version}`);
    }
    seen.set(pin.action, pin);
  }
  for (const action of KNOWN_ACTIONS) {
    if (![...seen.keys()].includes(action)) problems.push(`«${action}» больше не используется — уберите его из KNOWN_ACTIONS`);
  }

  // ── job’ы ────────────────────────────────────────────────────────────────────
  const jobsAt = lines.findIndex((l) => l === 'jobs:');
  if (jobsAt === -1) {
    problems.push('нет блока jobs:');
    return problems;
  }
  const starts: Array<{ id: string; at: number }> = [];
  for (let i = jobsAt + 1; i < lines.length; i++) {
    const m = /^  ([a-z][a-z0-9-]*):\s*$/.exec(lines[i]!);
    if (m) starts.push({ id: m[1]!, at: i });
  }
  const ids = starts.map((s) => s.id);
  for (const id of EXPECTED_JOBS) {
    if (!ids.includes(id)) problems.push(`job «${id}» исчез из CI`);
  }
  for (const id of ids) {
    if (!(EXPECTED_JOBS as readonly string[]).includes(id)) problems.push(`в CI появился неизвестный job «${id}»`);
  }
  if (new Set(ids).size !== ids.length) problems.push('идентификаторы job’ов повторяются — YAML молча оставит последний');

  starts.forEach((job, k) => {
    const block = lines.slice(job.at, starts[k + 1]?.at ?? lines.length);
    const body = block.join('\n');
    if (!/^    runs-on:/m.test(body)) problems.push(`job «${job.id}»: нет runs-on`);

    const uploads = body.match(new RegExp(`^\\s*uses:\\s*${UPLOAD_ACTION}@`, 'gm'))?.length ?? 0;
    const jobPerm = parsePermissions(block, 4);
    const grantsWrite = jobPerm ? Object.values(jobPerm.entries).includes('write') : false;

    if (uploads > 0) {
      if (!jobPerm) {
        problems.push(`job «${job.id}» грузит артефакты, но не просит actions: write — загрузка упадёт`);
      } else {
        if (jobPerm.entries.actions !== 'write') {
          problems.push(`job «${job.id}» грузит артефакты, но permissions.actions = «${jobPerm.entries.actions ?? '—'}»`);
        }
        if (jobPerm.entries.contents !== 'read') {
          problems.push(`job «${job.id}»: permissions.contents должен быть явно read`);
        }
      }
    } else if (grantsWrite) {
      problems.push(`job «${job.id}» не грузит артефакты, но просит write — право без потребителя`);
    }
  });

  return problems;
}

describe('ci.yml: права и закрепление действий (SEC-07)', () => {
  it('в настоящем файле нет ни одного нарушения', () => {
    const problems = checkWorkflow(RAW);
    expect(problems, problems.join('\n')).toEqual([]);
  });

  it('ни одно действие не стоит на мутабельном указателе', () => {
    const tags = [...RAW.matchAll(/uses:\s*(\S+@(?![0-9a-f]{40}\b)\S*)/g)].map((m) => m[1]!);
    expect(tags, tags.join('\n')).toEqual([]);
  });

  it('write-права есть ровно у трёх job’ов, которые грузят артефакты', () => {
    const lines = RAW.split(/\r?\n/);
    const withWrite: string[] = [];
    const jobStarts: Array<{ id: string; at: number }> = [];
    const jobsAt = lines.findIndex((l) => l === 'jobs:');
    for (let i = jobsAt + 1; i < lines.length; i++) {
      const m = /^  ([a-z][a-z0-9-]*):\s*$/.exec(lines[i]!);
      if (m) jobStarts.push({ id: m[1]!, at: i });
    }
    jobStarts.forEach((job, k) => {
      const block = lines.slice(job.at, jobStarts[k + 1]?.at ?? lines.length);
      if (parsePermissions(block, 4)?.entries.actions === 'write') withWrite.push(job.id);
    });
    expect(withWrite.sort()).toEqual(['e2e', 'e2e-unstable', 'phone-shots']);
  });

  it('негативные контроли: каждая мутация обязана быть поймана', () => {
    const controls: Array<[string, string, string]> = [
      [
        'мутабельный тег вместо SHA',
        RAW.replace(/actions\/checkout@[0-9a-f]{40}/, 'actions/checkout@v4'),
        'не закреплён на commit SHA',
      ],
      [
        'SHA без комментария версии',
        RAW.replace('@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0', '@11d5960a326750d5838078e36cf38b85af677262'),
        'нет комментария с версией',
      ],
      [
        'write у job’а без загрузки артефактов',
        RAW.replace(
          '  build-test:\n    runs-on: ubuntu-latest\n',
          '  build-test:\n    runs-on: ubuntu-latest\n    permissions:\n      contents: read\n      actions: write\n',
        ),
        'право без потребителя',
      ],
      [
        'нет actions: write у job’а с загрузкой артефактов',
        RAW.replace('      actions: write\n', ''),
        'грузит артефакты, но permissions.actions',
      ],
      [
        'нет верхнего permissions',
        RAW.replace('permissions:\n  contents: read\n', ''),
        'нет явного блока permissions',
      ],
      [
        'верхний permissions выдаёт write',
        RAW.replace('permissions:\n  contents: read\n', 'permissions:\n  contents: read\n  actions: write\n'),
        'верхний permissions даёт write',
      ],
      [
        'исчез workflow_dispatch',
        RAW.replace('  workflow_dispatch:\n', ''),
        'нет workflow_dispatch',
      ],
      [
        'добавлен pull_request_target',
        RAW.replace('  pull_request:\n', '  pull_request:\n  pull_request_target:\n'),
        'pull_request_target',
      ],
      [
        'два разных SHA у одного действия',
        RAW.replace(
          'actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4.4.0',
          'actions/setup-node@0123456789abcdef0123456789abcdef01234567 # v4.4.0',
        ),
        'закреплён разными SHA',
      ],
      [
        'неизвестное стороннее действие',
        RAW.replace(
          '      - uses: pnpm/action-setup@',
          '      - uses: evil/action@0123456789abcdef0123456789abcdef01234567 # v1.0.0\n      - uses: pnpm/action-setup@',
        ),
        'новое действие',
      ],
      [
        'исчез job',
        RAW.replace('  backup-restore:\n', '  backup-restore-renamed:\n'),
        'исчез из CI',
      ],
    ];

    const missed: string[] = [];
    for (const [name, mutated, expected] of controls) {
      expect(mutated, `мутация «${name}» ничего не изменила — контроль пустой`).not.toBe(RAW);
      const problems = checkWorkflow(mutated);
      // вторая мутация в третьем контроле меняет и верхний блок, и валидатор обязан сказать
      // именно про job; поэтому проверяем не «ровно одна», а «среди найденных есть нужная»
      if (!problems.some((p) => p.includes(expected))) {
        missed.push(`«${name}» → ожидали «${expected}», получили: ${problems.length ? problems.join(' | ') : 'ничего'}`);
      }
    }
    expect(missed, missed.join('\n')).toEqual([]);
  });

  it('в workflow остался весь набор джоб, и ни один не назван дважды', () => {
    const keys = [...RAW.matchAll(/^  ([a-z][a-z0-9-]*):\s*$/gm)].map((m) => m[1]!);
    // Двухпробельные ключи — это ровно триггеры в `on:` и идентификаторы job’ов: steps, services
    // и env живут глубже и под этот узор не попадают. Значит длина списка после фильтра — это
    // ещё и проверка на повтор: одинаковое имя второй раз YAML молча перезапишет.
    const jobs = keys.filter((k) => !['push', 'pull_request', 'workflow_dispatch'].includes(k));
    expect(jobs.length, 'каждый job назван один раз').toBe(EXPECTED_JOBS.length);
    expect([...new Set(jobs)].sort()).toEqual([...EXPECTED_JOBS].sort());
  });
});
