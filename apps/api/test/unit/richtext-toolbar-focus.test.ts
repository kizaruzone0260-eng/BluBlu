/**
 * Часть E (2026-10-17): панель формата не снимает фокус с редактора.
 *
 * Причина красных `zz24:91` и `zz24:143` в прогоне 39034112298 — пункт (а) разбора: браузер
 * отдаёт фокус кнопке на `mousedown`, до `onClick` с командой. Потеря выглядит побуквенно:
 * пропадает ПЕРВЫЙ символ после кнопки формата и он же всплывает в конце документа
 * (`…9чарли…0echo…` → `…9арли…0ho…ююч`).
 *
 * Тест без браузера — и честно говорит, что именно он может доказать. `preventDefault` на
 * `mousedown` и есть то, что в реальном браузере удерживает фокус; в jsdom перехода фокуса по
 * нажатию мыши нет вовсе (там `activeElement` не меняется ни до, ни после правки), так что
 * «клик не меняет activeElement» в jsdom был бы зелёным всегда — ложная проверка. Живое
 * доказательство остаётся в `zz24` (он возвращён в блокирующий набор), а здесь — три вещи,
 * которые можно проверить без браузера: обработчик дергает `preventDefault`, каждая кнопка обеих
 * панелей к нему привязана, и каждая команда начинается с `.focus()`.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { keepFocus } from '../../../../apps/web/src/lib/keepFocus';

// apps/api/test/unit → корень репозитория
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const webSrc = (rel: string) => readFileSync(join(repo, 'apps/web/src', rel), 'utf8');
const TOOLBARS = ['components/RichText.tsx', 'pages/Notes.tsx'];

/** Комментарии вырезаются: объяснение ловушки не должно само проходить проверки. */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');

/**
 * Кнопки, которые стоят рядом с открытым редактором и потому не имеют права снимать фокус:
 *  1) общий хелпер `btn` панели формата (у его `<button>` testid приходит переменной);
 *  2) любая кнопка с явным `data-testid="rt-…"` или `"draft-…"`.
 * Остальные кнопки страницы (список заметок, «удалить», «закрепить») тут ни при чём: они и должны
 * вести себя как обычные кнопки, и ловить их — значит повесить ложные находки.
 */
function focusStealingButtons(src: string): string[] {
  const bare = code(src);
  const bad: string[] = [];
  const helper = /const btn = \([\s\S]*?<button\b([\s\S]*?)>/.exec(bare);
  if (!helper) bad.push('нет общего хелпера `btn` — панель собрана в обход проверки');
  else if (!helper[1].includes('onMouseDown={keepFocus}')) {
    bad.push(`btn(): ${helper[1].replace(/\s+/g, ' ').trim().slice(0, 70)}`);
  }
  for (const m of bare.matchAll(/<button\b([\s\S]*?)>/g)) {
    if (!/data-testid=["'](rt-|draft-)/.test(m[1])) continue;
    if (!m[1].includes('onMouseDown={keepFocus}')) {
      bad.push(`literal: ${m[1].replace(/\s+/g, ' ').trim().slice(0, 70)}`);
    }
  }
  return bad;
}

/** Каждая команда `editor.chain()` обязана начинаться с `.focus()`. */
function chainsWithoutFocus(src: string): string[] {
  return [...code(src).matchAll(/editor\.chain\(\)((?:\.[A-Za-z]\w*(?:\([^()]*\))?)*)/g)]
    .filter((m) => !m[1].startsWith('.focus()'))
    .map((m) => `editor.chain()${m[1]}`);
}

describe('панель формата держит фокус редактора', () => {
  it('keepFocus отменяет действие по умолчанию (то и удерживает фокус в браузере)', () => {
    let prevented = false;
    keepFocus({ preventDefault: () => { prevented = true; } });
    expect(prevented, 'keepFocus обязан вызвать preventDefault').toBe(true);
  });

  it('обе панели привязывают keepFocus к каждой кнопке', () => {
    for (const file of TOOLBARS) {
      const src = webSrc(file);
      expect(src).toContain("import { keepFocus } from '../lib/keepFocus'");
      const bad = focusStealingButtons(src);
      expect(bad, `${file}: кнопка у редактора без onMouseDown={keepFocus} — клик снимет фокус: ${JSON.stringify(bad)}`)
        .toEqual([]);
    }
  });

  it('каждая команда панели идёт через chain().focus()', () => {
    for (const file of TOOLBARS) {
      const bad = chainsWithoutFocus(webSrc(file));
      expect(bad, `${file}: команда без .focus(): ${JSON.stringify(bad)}`).toEqual([]);
    }
  });

  it('отрицательный контроль: сканеры видят и снятый фокус, и команду без focus()', () => {
    const planted = `
      const btn = (label, fn) => (<button key={label} data-testid={label} onClick={fn}>{label}</button>);
      const a = () => (<button type="button" data-testid="rt-clear" onClick={fn}>U</button>);
      const b = () => (<button type="button" data-testid="note-pin" onClick={fn}>pin</button>);
      const c = () => (<button key="H" onClick={() => editor.chain().toggleHeading({ level: 2 }).run()}>H2</button>);
    `;
    expect(focusStealingButtons(planted)).toEqual([
      'btn(): key={label} data-testid={label} onClick={fn}',
      'literal: type="button" data-testid="rt-clear" onClick={fn}',
    ]);
    expect(chainsWithoutFocus(planted)).toEqual(['editor.chain().toggleHeading({ level: 2 }).run()']);
  });
});
