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
  it('there is exactly ONE toggle wired to the button, and it never writes the library state', () => {
    expect(src.match(/onClick=\{toggleStyles\}/g)?.length).toBe(1);
    /*
     * Второй переключатель панели был бы конфликт. У библиотеки за мобильную панель отвечает
     * `appState.openMenu`, но записать его снаружи нечем: в императивном API 0.18.1 нет
     * `setAppState` (страховка — в excalidraw-styles-panel.test.ts). Поэтому поле читается и
     * меняется ТОЛЬКО тем же жестом, что делает человек, — нажатием кнопки нижнего бара. Значит
     * у нас не может появиться «вторая кнопка»: есть одна, и она отражает состояние полотна.
     */
    expect(src, 'состояние библиотеки отсюда не пишется').not.toMatch(/setAppState/);
    expect(src, 'openMenu только читается, ему никогда не присваивается').not.toMatch(/openMenu\s*=[^=]/);
    // наше собственное контекстное меню вкладки доски называется так же — не должно утечь сюда
    expect(src).not.toMatch(/appState\.openMenu\s*=(?!=)/);
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
    // рамка меряется ДВУМЕРНО: высота нужна, чтобы отличить десктопную раскладку полотна от мобильной
    expect(src).toMatch(/getBoundingClientRect\(\)/);
    expect(src).toMatch(/excalidrawMobileChrome\(frameBox\.w, frameBox\.h\)/);
    // прежняя мера (окно + matchMedia на 1280) возвращать баг молча: ловим её повторное появление
    expect(src, 'окно больше не решает, есть ли место для панели').not.toMatch(/window\.innerWidth\s*>=\s*STYLES_PANEL_MIN/);
    expect(src, 'matchMedia-порог панели здесь не нужен').not.toMatch(/matchMedia\(`\(min-width: \$\{STYLES_PANEL/);
  });

  it('a narrow frame only CLOSES; the stored choice is read once per role', () => {
    // два разных эффекта вместо одного, который перечитывал память на каждое изменение ширины
    expect(src).toMatch(/setStylesOpen\(resolveStylesPanel\(\{[\s\S]{0,160}stored: readStoredStyles\(\),\s*\}\)\);/);
    const roleRead = src.match(/\}, \[stylesRole\]\);/);
    expect(roleRead, 'чтение памяти привязано к роли, а не к ширине').toBeTruthy();
    const narrow = src.match(/useEffect\(\(\) => \{([\s\S]{0,200}?)\}, \[frameBox\.w\]\);/);
    expect(narrow, 'правило узкой рамки найдено').toBeTruthy();
    expect(narrow![1]).toContain('setStylesOpen(false)');
    // и этот эффект не имеет права открывать панель обратно
    expect(narrow![1]).not.toMatch(/setStylesOpen\(true\)/);
    expect(narrow![1], 'эффект ширины не читает localStorage').not.toContain('readStoredStyles');
  });

  it('the mobile chrome is reconciled by ONE click, and only while the two states disagree', () => {
    /*
     * Примирение с раскладкой полотна (правка 2026-10-24): в мобильной ветке панель создаётся
     * полем `openMenu`, и без этого нажатие «Стили» прячет узел, которого нет, — ровно тот
     * «ненадёжный» симптом. `reconcileMenu` обязана:
     *  • работать только в мобильной раскладке и только там, где есть право рисовать;
     *  • сначала свериться с полотном (`shown === stylesOpenRef` → выход), иначе клик породит петлю;
     *  • искать кнопку нижнего бара по её aria-метке: рядом `duplicate`/`delete`, и промахнуться
     *    по ним значит удалить ученический рисунок.
     */
    const rec = src.match(/function reconcileMenu\(\): void \{([\s\S]{0,900}?)\n  \}/);
    expect(rec, 'примирение с раскладкой полотна потеряно').toBeTruthy();
    const body = rec![1];
    expect(body).toMatch(/if \(!mobileChrome \|\| !canDraw\) return;/);
    expect(body, 'без сверки с полотном цикл вернётся').toMatch(/if \(shown === stylesOpenRef\.current\) return;/);
    expect(body).toMatch(/getAppState\(\)\.openMenu === 'shape'/);
    expect(body).toMatch(/\.App-bottom-bar \.App-toolbar-content button\[aria-label="Edit"\]/);
    expect(body).toMatch(/\)\?\.click\(\);/);
    // и никаких прямых записей в полотно/сцену
    expect(body).not.toMatch(/updateScene|send\(|addElements|setAppState/);
    // вызов из фазы React — ровно один, и только по нашим состояниям (не по каждому рендеру)
    expect(src.match(/reconcileMenu\(\);/g)?.length, 'примирение зовётся из эффекта и из наблюдения').toBe(2);
    const fx = src.match(/useEffect\(\(\) => \{\s*reconcileMenu\(\);[\s\S]{0,200}?\}, \[mobileChrome, stylesOpen, canDraw\]\);/);
    expect(fx, 'эффект примирения потерян или висит на чужих зависимостях').toBeTruthy();
  });

  it('the canvas is observed, but state is raised OUTSIDE the commit phase — once, and only on change', () => {
    /*
     * Если человек нажал собственную кнопку нижнего бара, а мы сделали вид, что не заметили,
     * `aria-expanded` соврёт, и следующее примирение вернёт панель туда, где её уже не было.
     * Поэтому `onChange` обязан читать `openMenu` — но только в мобильной раскладке: на десктопе
     * это поле принадлежит меню «canvas» и к панели отношения не имеет.
     *
     * И главное, из-за чего прогон 40062924647 упал экраном 500 (React #185, «maximum update
     * depth»): библиотека вызывает `onChange` из своего `componentDidUpdate` на КАЖДЫЙ рендер
     * полотна. `setState` прямо оттуда перерисовывает родителя, родитель перерисовывает полотно,
     * полотно зовёт `onChange` снова — петля. Значит наблюдение обязано осесть в ref, а
     * `setState` уйти в микрозадачу И произойти только если наблюдение изменилось.
     */
    const change = src.match(/function onChange\([\s\S]{0,2600}?\n  \}/);
    expect(change, 'onChange не найден').toBeTruthy();
    const body = change![0];
    expect(body).toMatch(/if \(canDraw && mobileChrome && appState\) \{/);
    expect(body).toMatch(/const open = appState\.openMenu === 'shape';/);
    // сигнал «есть что форматировать»: без него панель не появлялась бы после выбора инструмента
    expect(body).toMatch(/const can = draws \|\| Object\.keys\(appState\.selectedElementIds \?\? \{\}\)\.length > 0;/);
    expect(body, 'без сверки с предыдущим наблюдением петля вернётся')
      .toMatch(/if \(!prev \|\| prev\.open !== open \|\| prev\.can !== can\) \{/);
    expect(body).toMatch(/menuObservedRef\.current = \{ open, can \};/);
    // «закрыто» принимается только если панель этим переключателем уже открывалась: иначе первый
    // же onChange после загрузки стёр бы сохранённый выбор учителя
    expect(body).toMatch(/if \(open\) menuSeenRef\.current = true;/);
    const deferred = body.indexOf('queueMicrotask(');
    expect(deferred, 'состояние поднимается синхронно из коммит-фазы React — это петля').toBeGreaterThanOrEqual(0);
    for (const call of ['setStylesOpen(', 'reconcileMenu();']) {
      const at = body.indexOf(call);
      expect(at, `${call} не найден`).toBeGreaterThanOrEqual(0);
      expect(at, `${call} обязан вызываться из микрозадачи`).toBeGreaterThan(deferred);
    }
    expect(body).toMatch(/if \(seen\.open !== stylesOpenRef\.current && \(seen\.open \|\| menuSeenRef\.current\)\) \{/);
    // наблюдение не имеет права трогать сеть до того, как отработает throttle отправки чернил
    const mirrored = body.indexOf('menuObservedRef.current = { open, can };');
    const throttled = body.indexOf('lastSentRef.current = now');
    expect(mirrored, 'наблюдение за полотном не записано в ref').toBeGreaterThanOrEqual(0);
    expect(throttled, 'отправка изменений с полотна потерялась').toBeGreaterThanOrEqual(0);
    expect(mirrored).toBeLessThan(throttled);
  });

  it('students without drawing permission still cannot open it (permission rules unchanged)', () => {
    expect(src).toMatch(/disabled=\{!canDraw\}/);
    expect(src, 'причине «не жмётся» читается в подсказке').toMatch(/t\('lesson\.boardNoPermission'\)/);
  });
});
