/**
 * Часть D (2026-10-18): пояс сцены обязан пересчитываться и когда сцена только переехала.
 *
 * Прогон 39089955091 (`4c7cd02`): `zz27` упал на 15-й конфигурации из 16 —
 * `пояс --scene-left отстал от сцены при 1920px, боковая true, панель true`, 4 px при допуске 1.
 * Механизм: колонка урока капирована `.container { max-width: 960px; margin: 0 auto }`, поэтому на
 * широком окне сворачивание рейки (232 px → 64 px) двигает `.lesson-main` на 84 px, НЕ меняя её
 * ширины. `ResizeObserver` сообщает только про размеры — значит единственного вызова пересчёта и не
 * было, пояс остался от прежнего состояния.
 *
 * Тест статический, как сосед `fixed-menu-ancestor.test.ts`: он проверяет ПРОВОДКУ (за рейкой
 * наблюдают, её класс и конец анимации ширину будят пересчёт, запись идемпотентна), а не следствие.
 * Следствие — «пояс не отстаёт от сцены» — живым браузером проверяет `zz27` (его проверка
 * `|пояс − край сцены| ≤ 1 px`), и только в CI: в jsdom раскладки нет, там такое утверждение было бы
 * ложно-зелёным.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// apps/api/test/unit → корень репозитория: test(1) → api(2) → apps(3) → корень(4)
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const bandPath = 'apps/web/src/lib/sceneBand.ts';
const read = (rel: string) => readFileSync(resolve(repo, rel), 'utf8');

/** Комментарии и строки-пояснения не должны сами наводить сканер на нужные слова. */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');

/** Что обязано стоять в хуке. Ключ — человекочитаемое имя проверки, значение — предикат. */
const WIRES: Record<string, (c: string) => boolean> = {
  'рейка найдена по testid, а не по классу': (c) => c.includes("'[data-testid=sidebar]'"),
  'рейка наблюдается тем же ResizeObserver, что и сцена': (c) =>
    /ro\.observe\(el\)/.test(c) && /ro\.observe\(rail\)/.test(c),
  'доставка ResizeObserver пишет пояс сразу, без rAF': (c) => /new ResizeObserver\(write\)/.test(c),
  'смена класса рейки будит пересчёт на следующем кадре': (c) =>
    /new MutationObserver\(schedule\)/.test(c) && /attributeFilter:\s*\[\s*'class'\s*\]/.test(c),
  'конец анимации ширины рейки будит пересчёт': (c) =>
    /addEventListener\('transitionend'/.test(c) && /propertyName === 'width'/.test(c),
  'запись идемпотентна: сначала сверка, потом setProperty': (c) =>
    /getPropertyValue\(name\)\s*!==\s*value/.test(c) && !/const write[\s\S]*?root\.style\.setProperty/.test(c),
  'обработчики и наблюдатели снимаются в cleanup': (c) =>
    /ro\.disconnect\(\)/.test(c) && /mo\?\.disconnect\(\)/.test(c) && /removeEventListener\('transitionend'/.test(c),
};

describe('пояс сцены следит и за рейкой (часть D)', () => {
  const src = code(read(bandPath));

  for (const [name, holds] of Object.entries(WIRES)) {
    it(name, () => {
      expect(holds(src), `в ${bandPath} нет проводки: ${name}`).toBe(true);
    });
  }

  it('отставание пояса закрыто именно наблюдением за рейкой, а не таймером', () => {
    // опрос по интервалу был бы подделкой проверки: он маскирует отсутствие события
    expect(src).not.toMatch(/setInterval\(/);
  });

  it('отрицательный контроль: прежняя проводка (только сцена) эти проверки не проходит', () => {
    const before = `
      const ro = new ResizeObserver(schedule);
      ro.observe(el);
      root.style.setProperty(LEFT, '0px');
      window.addEventListener('resize', schedule);
    `;
    const flagged = Object.entries(WIRES).filter(([, holds]) => !holds(code(before))).map(([n]) => n);
    expect(flagged.length, `прежний хук помечен как годный: ${flagged.join('; ')}`).toBeGreaterThan(3);
  });
});
