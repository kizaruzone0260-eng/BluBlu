/**
 * Правка 2026-10-24, часть A — страховки вокруг самого переключателя панели стилей.
 *
 * Постановка требует «починить поведение, а не добавить вторую конфликтующую кнопку» и «не гонять
 * лишнюю мутацию в комнату на один клик кнопки». Ни то, ни другое нельзя проверить без DOM, а
 * браузер локально не запускается, поэтому здесь проверяется форма кода — так же, как это уже
 * делают `temp-password.test.ts` (один генератор пароля на все места) и
 * `excalidraw-styles-panel.test.ts` (класс панели жив). Эти проверки падают ровно в тот момент,
 * когда кто-то возвращает второй переключатель, меряет окно вместо рамки или начинает трогать
 * сцену ради видимости панели.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/** Путь от самого файла, не от `process.cwd()`: тесты запускают и из `apps/api`, и из корня (CI). */
const here = path.dirname(fileURLToPath(import.meta.url));   // apps/api/test/unit
const repoRoot = path.resolve(here, '../../../..');
const boardPath = path.join(repoRoot, 'apps', 'web', 'src', 'components', 'Board.tsx');
const raw = readFileSync(boardPath, 'utf8');

/**
 * Комментарии из этого файла убраны НАМЕРЕННО: в них по делу описано чужое поле `appState.openMenu`
 * и прежняя ошибка с `window.innerWidth`, и проверка «этого больше нет в коде» на полном тексте
 * ловила бы собственную документацию. Проверятся только исполняемые строки.
 */
const src = raw
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[ \t]*\/\/.*$/gm, '');

/** Тело `toggleStyles` — ровно то, что делает нажатие кнопки. */
const toggleBody = (() => {
  const start = src.indexOf('function toggleStyles()');
  expect(start, 'функция toggleStyles на месте').toBeGreaterThan(-1);
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    if (src[i] === '}') { depth--; if (depth === 0) return src.slice(open, i + 1); }
  }
  return '';
})();

describe('the styles-panel toggle is the only control and touches nothing but its own state', () => {
  it('there is exactly ONE toggle wired to the button', () => {
    expect(src.match(/onClick=\{toggleStyles\}/g)?.length).toBe(1);
    /*
     * Второй переключатель панели был бы конфликт: в библиотеке за «панель» отвечает
     * `appState.openMenu`, и трогать его нельзя — на десктопе он видимости не решает, а на
     * мобильном открыл бы меню, которое мы как раз прячем. Наше собственное контекстное меню
     * вкладки доски называется так же (`openMenu(page, anchor)`), поэтому проверяется именно
     * поле состояния библиотеки, а не слово вообще.
     */
    expect(src, 'панель не открывается через состояние библиотеки').not.toMatch(/appState\.openMenu|openMenu:\s*/);
  });

  it('the click changes one state and one preference key — no scene, no socket', () => {
    expect(toggleBody).toContain('setStylesOpen');
    expect(toggleBody).toContain('writeStoredStyles');
    for (const forbidden of ['apiRef', 'updateScene', 'addElements', 'send(', 'onChange', 'fetch(', 'localStorage.getItem']) {
      expect(toggleBody, `нажатие кнопки не должно трогать «${forbidden}»`).not.toContain(forbidden);
    }
  });

  it('button state is exposed as aria-expanded AND aria-pressed from the same value', () => {
    expect(src).toMatch(/aria-expanded=\{stylesOpen\}/);
    expect(src).toMatch(/aria-pressed=\{stylesOpen\}/);
    // и то же самое состояние — единственный переключатель CSS
    expect(src).toMatch(/data-styles=\{stylesOpen \? 'open' : 'closed'\}/);
  });

  it('the visible label is state-independent, the aria name and tooltip are not', () => {
    // длина видимой подписи двигала бы шапку полотна → проверяется zz20 (допуск 2 px)
    expect(src).toMatch(/\{t\('lesson\.boardStyles'\)\}/);
    expect(src).toMatch(/aria-label=\{t\(stylesLabels\.aria\)\}/);
    expect(src, 'подсказка обязана объяснять текущее состояние').toMatch(/title=\{canDraw \? t\(stylesLabels\.hint\)/);
  });

  it('the width that decides is the BOARD FRAME, measured — not the window', () => {
    expect(src).toMatch(/frameRef/);
    expect(src).toMatch(/ResizeObserver/);
    expect(src).toMatch(/STYLES_PANEL_MIN_FRAME/);
    // прежняя мера (окно + matchMedia на 1280) возвращать баг молча: ловим её повторное появление
    expect(src, 'окно больше не решает, есть ли место для панели').not.toMatch(/window\.innerWidth\s*>=\s*STYLES_PANEL_MIN/);
    expect(src, 'matchMedia-порог панели здесь не нужен').not.toMatch(/matchMedia\(`\(min-width: \$\{STYLES_PANEL/);
  });

  it('a narrow frame only CLOSES; the stored choice is read once per role', () => {
    // два разных эффекта вместо одного, который перечитывал память на каждое изменение ширины
    expect(src).toMatch(/setStylesOpen\(resolveStylesPanel\(\{[\s\S]{0,160}stored: readStoredStyles\(\),\s*\}\)\);/);
    const roleRead = src.match(/\}, \[stylesRole\]\);/);
    expect(roleRead, 'чтение памяти привязано к роли, а не к ширине').toBeTruthy();
    const narrow = src.match(/useEffect\(\(\) => \{([\s\S]{0,200}?)\}, \[frameWidth\]\);/);
    expect(narrow, 'правило узкой рамки найдено').toBeTruthy();
    expect(narrow![1]).toContain('setStylesOpen(false)');
    // и этот эффект не имеет права открывать панель обратно
    expect(narrow![1]).not.toMatch(/setStylesOpen\(true\)/);
    expect(narrow![1], 'эффект ширины не читает localStorage').not.toContain('readStoredStyles');
  });

  it('students without drawing permission still cannot open it (permission rules unchanged)', () => {
    expect(src).toMatch(/disabled=\{!canDraw\}/);
    expect(src, 'причине «не жмётся» читается в подсказке').toMatch(/t\('lesson\.boardNoPermission'\)/);
  });
});
