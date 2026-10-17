/**
 * Часть D (2026-10-17): у предка фиксированного меню не может быть трансформации.
 *
 * Прогон 38997323161: восемь красных спеков (zz18 ×3, zz19 ×2, zz2 и unstable zz19:312) с
 * одинаковым логом — `element is visible, enabled and stable → done scrolling → element is
 * outside of the viewport`. Причина: полоса урока получила `transform: translateX(-50%)` для
 * центрирования по сцене, а любой ненулевой `transform` (как и `filter`, `backdrop-filter`,
 * `perspective`, `will-change: transform`, `contain: paint|layout|strict|content`) делает элемент
 * содержащим блоком для ЕГО ЖЕ `position: fixed` потомков. Меню полосы («Ещё», выбор устройств,
 * выход) позиционируются фиксированно через `lib/popover.ts` и живут ВНУТРИ полосы, поэтому их
 * координаты, посчитанные от окна, применялись от прямоугольника полосы и уводили меню за экран.
 *
 * Тест статический: он читает CSS и падает на самой ловушке, а не на следствии. Следствие в
 * живом браузере проверяет zz23 (`boundingBox` меню внутри вьюпорта + кликабельность пунктов),
 * но zz23 исполняется только в CI, а ловушка стоит дешевле — её надо ловить до пуша.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// apps/api/test/unit → корень репозитория: test(1) → api(2) → apps(3) → корень(4)
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const cssPath = 'apps/web/src/styles.css';
const barPath = 'apps/web/src/components/LessonBar.tsx';
const bandPath = 'apps/web/src/lib/sceneBand.ts';
const read = (rel: string) => readFileSync(resolve(repo, rel), 'utf8');

interface Rule { selector: string; body: string; line: number }

/** Комментарии вырезаются первыми: в них этот самый CSS объясняет, что такое `transform`. */
function rules(css: string): Rule[] {
  // комментарий заменяется пробелами той же длины: смещения и номера строк остаются настоящими
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '));
  const out: Rule[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  for (let m = re.exec(bare); m; m = re.exec(bare)) {
    const start = m.index + (m[1].length - m[1].replace(/^\s+/, '').length);
    out.push({
      selector: m[1].trim().replace(/\s+/g, ' '),
      body: m[2],
      line: bare.slice(0, start).split('\n').length,
    });
  }
  return out;
}

/** Комментарии и из TS: объяснение ловушки не должно само на неё натравливать сканер. */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');

/** Классы, чей предок обязан оставаться «плоским» для `position: fixed` потомков. */
const CHAINS: { menu: string; hosts: string[] }[] = [
  { menu: '.bar-menu (микрофон, камера, «Ещё», «Выйти»)', hosts: ['.bar-band', '.lesson-bar', '.bar-slot', '.lesson-shell'] },
  { menu: '.menu-pop (язык в рейке, вкладки доски)', hosts: ['.sidebar', '.lesson-shell'] },
];

/**
 * Исключение: уехавшая за экран полоса. Меню в этот момент закрыто — `hidden` в LessonBar.tsx
 * держит условие `menu === ''` (проверяется ниже), так что фиксированному потомку не из чего
 * выпадать. Отдельно `transform: none` ловушкой не считается: это значение по умолчанию.
 */
const ALLOWED = new Set(['.lesson-bar.bar-hidden']);

const TRAP_PROPS = ['transform', 'translate', 'rotate', 'scale', 'perspective', 'filter', 'backdrop-filter'];

/** Причина, по которой объявление делает элемент содержащим блоком, или null. */
function trapOf(prop: string, value: string): string | null {
  const v = value.trim().toLowerCase();
  if (TRAP_PROPS.includes(prop)) return v === 'none' ? null : `${prop}: ${v}`;
  if (prop === 'will-change') {
    const hit = v.split(',').map((s) => s.trim()).filter((s) => /transform|translate|rotate|scale|filter|perspective/.test(s));
    return hit.length ? `will-change: ${hit.join(', ')}` : null;
  }
  if (prop === 'contain') {
    const hit = v.split(/\s+/).filter((s) => /paint|layout|strict|content/.test(s));
    return hit.length ? `contain: ${hit.join(' ')}` : null;
  }
  return null;
}

/** Все ловушки в CSS для данного набора хостов: «строка:селектор → причина». */
function findTraps(css: string, hosts: string[]): string[] {
  const found: string[] = [];
  for (const rule of rules(css)) {
    if (ALLOWED.has(rule.selector)) continue;
    const classes = new Set((rule.selector.match(/\.[-A-Za-z0-9_]+/g) ?? []).map((c) => c.slice(1)));
    const host = hosts.find((h) => classes.has(h.slice(1)));
    if (!host) continue;
    for (const decl of rule.body.split(';')) {
      const [prop, ...rest] = decl.split(':');
      if (!prop || rest.length === 0) continue;
      const reason = trapOf(prop.trim().toLowerCase(), rest.join(':'));
      if (reason) found.push(`${rule.line}: .${host.slice(1)} { ${reason} } — меню внутри него уезжает за вьюпорт`);
    }
  }
  return found;
}

describe('предок fixed-меню не имеет трансформации (ловушка части D)', () => {
  const css = read(cssPath);

  it('ни один хост меню не создаёт containing block для своих fixed-потомков', () => {
    const hosts = CHAINS.flatMap((c) => c.hosts);
    expect(findTraps(css, hosts)).toEqual([]);
  });

  it('отрицательный контроль: тот же сканер видит каждую из ловушек', () => {
    const bad = `
      .lesson-bar { transform: translateX(-50%); }
      .bar-slot { will-change: transform; }
      .lesson-shell { backdrop-filter: blur(2px); }
      .sidebar { contain: paint; }
      .lesson-bar.bar-hidden { transform: translateY(100%); }
      .bar-slot { filter: none; }
    `;
    expect(findTraps(bad, CHAINS.flatMap((c) => c.hosts))).toEqual([
      '2: .lesson-bar { transform: translatex(-50%) } — меню внутри него уезжает за вьюпорт',
      '3: .bar-slot { will-change: transform } — меню внутри него уезжает за вьюпорт',
      '4: .lesson-shell { backdrop-filter: blur(2px) } — меню внутри него уезжает за вьюпорт',
      '5: .sidebar { contain: paint } — меню внутри него уезжает за вьюпорт',
    ]);
    // «none» и состояние скрытой полосы — не ловушки: иначе сканер врал бы на каждом проекте
    expect(findTraps(bad, CHAINS.flatMap((c) => c.hosts)).some((v) => v.includes('filter: none'))).toBe(false);
    expect(findTraps(bad, CHAINS.flatMap((c) => c.hosts)).some((v) => v.includes('bar-hidden'))).toBe(false);
  });

  it('полосу центрирует пояс сцены, а сама полоса стоит на месте', () => {
    const band = rules(css).find((r) => r.selector === '.bar-band');
    expect(band, 'правило `.bar-band` — фиксированный пояс сцены').toBeTruthy();
    expect(band!.body).toMatch(/position:\s*fixed/);
    expect(band!.body).toMatch(/left:\s*var\(--scene-left/);
    expect(band!.body).toMatch(/right:\s*var\(--scene-right/);
    expect(band!.body).toMatch(/justify-content:\s*center/);

    const bar = rules(css).find((r) => r.selector === '.lesson-bar');
    expect(bar, 'правило `.lesson-bar`').toBeTruthy();
    // полоса — flex-элемент пояса: у неё нет ни left/right, ни transform, ни margin-inline: auto
    expect(bar!.body).not.toMatch(/(^|;)\s*(left|right)\s*:/);
    expect(bar!.body).not.toMatch(/(^|;)\s*transform\s*:/);
    expect(bar!.body).not.toMatch(/margin-inline:\s*auto/);

    // хук пишет те же две величины: иначе CSS ссылается на то, чего никто не считает
    // (комментарии вырезаны: в них старое имя упомянуто намеренно, как объяснение ловушки)
    const band2 = code(read(bandPath));
    expect(band2).toContain("'--scene-left'");
    expect(band2).toContain("'--scene-right'");
    expect(band2).not.toContain('--scene-center');
  });

  it('скрытие полосы возможно только при закрытом меню — обоснование исключения', () => {
    const src = read(barPath);
    expect(src, 'hidden обязан учитывать открытое меню, иначе transform скрытой полосы уводил бы меню за экран')
      .toMatch(/const hidden = [^;]*menu === ''/);
  });
});
