/**
 * Часть A (2026-10-23) — страховка вокруг CSS-рычага панели стилей.
 *
 * Скрыть панель Excalidraw можно только по классу её контейнера: в 0.18.1 нет ни пропса, ни
 * пункта `UIOptions` для неё, а `appState.openMenu` на десктопе видимость не решает (в собранном
 * коде контейнер рисуется по предикату «есть чего показать», `O && N()`). CSS по чужому классу
 * жив, ровно пока класс жив — поэтому этот тест читает УСТАНОВЛЕННУЮ библиотеку и падает, если
 * имя исчезло или если наш CSS разошёлся с тем, что реально рендерит Excalidraw. Это и есть
 * ответ на требование «тест, падающий, если класс исчезнет».
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Пути считаются от самого файла, а не от `process.cwd()`: тесты запускают и из `apps/api`, и из
 * корня репозитория (CI), и с другой машиной в пути. Отсюда `../../../..` — от
 * `apps/api/test/unit` до корня репозитория.
 */
const here = path.dirname(fileURLToPath(import.meta.url));      // apps/api/test/unit
const repoRoot = path.resolve(here, '../../../..');
const webDir = path.join(repoRoot, 'apps', 'web');

/**
 * Путь к установленной копии — та же, что видит сборка `apps/web`. `package.json` у Excalidraw в
 * `exports` не открыт, поэтому идём от точки входа (`dist/prod/index.js`) на два уровня вверх.
 */
const requireFromWeb = createRequire(path.join(webDir, 'package.json'));
const pkgDir = path.resolve(path.dirname(requireFromWeb.resolve('@excalidraw/excalidraw')), '../..');
const version: string = JSON.parse(readFileSync(path.join(pkgDir, 'package.json'), 'utf8')).version;

/** Собираем всё, что библиотека реально отдаёт в браузер: JS бандл и его CSS. */
const bundleJs = readFileSync(path.join(pkgDir, 'dist/prod/index.js'), 'utf8');
const cssFiles = ['dist/prod/index.css']
  .map((rel) => path.join(pkgDir, rel))
  .filter((p) => existsSync(p));
const bundleCss = cssFiles.map((p) => readFileSync(p, 'utf8')).join('\n');

/** Те же имена, что стоят в нашем правиле `.board-frame[data-styles="closed"] …`. */
const OUR_CSS = readFileSync(path.join(webDir, 'src/styles.css'), 'utf8');
/** Компонент, который этим CSS-рычагом пользуется, — заодно проверяем его договор с библиотекой. */
const BOARD_TSX = readFileSync(path.join(webDir, 'src/components/Board.tsx'), 'utf8');

describe('the styles-panel CSS hook matches the installed Excalidraw', () => {
  it('the package the app builds against is resolved from apps/web', () => {
    expect(pkgDir).toContain('@excalidraw');
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it(`Excalidraw ${version} still renders the desktop styles panel as .selected-shape-actions`, () => {
    // строка класса должна остаться В JS: именно он решает, что появится в DOM. `.panelColumn`
    // для этой проверки не годится — он описывает содержимое, а не контейнер, и встречается
    // в чужих местах (мобильное меню).
    expect(bundleJs, 'the styles-panel container class vanished from the bundle').toContain('selected-shape-actions');
    expect(bundleJs).toContain('selectedShapeActions'); // заголовок того же островка
  });

  it(`Excalidraw ${version} still renders the narrow-screen styles menu as .App-mobile-menu`, () => {
    expect(bundleJs).toContain('App-mobile-menu');
    // этот контейнер библиотека ещё и сама стилует: значит `display:none` обязан его перекрывать,
    // и мы это делаем `!important` (см. styles.css)
    expect(bundleCss).toContain('App-mobile-menu');
  });

  it('our stylesheet hides exactly those containers, by the same names', () => {
    /*
     * `(?![\w-])` — не случайность: без границы имени класса проверка `.selected-shape-actions`
     * прошла бы и на `.selected-shape-actionsX`, то есть правило можно было бы испортить тихо.
     * Негативный контроль (переименовать класс в styles.css) обязан ронять именно этот тест.
     */
    expect(OUR_CSS).toMatch(/\.board-frame\[data-styles="closed"\]\s+\.selected-shape-actions(?![\w-])/);
    expect(OUR_CSS).toMatch(/\.board-frame\[data-styles="closed"\]\s+\.App-mobile-menu(?![\w-])/);
    // и ничего лишнего: правило обязано быть `display:none`, иначе панель остаётся поверх полотна
    const rule = OUR_CSS.match(/\.board-frame\[data-styles="closed"\][^}]*\{[^}]*\}/);
    expect(rule, 'the hide rule is missing').toBeTruthy();
    expect(rule![0]).toMatch(/display:\s*none\s*!important/);
  });

  it(`Excalidraw ${version} still renders the bottom-bar styles trigger our effect clicks`, () => {
    /*
     * Правка 2026-10-24: в мобильной раскладке панели в DOM нет, пока полотно не переведёт
     * `appState.openMenu` в «shape», а записать это поле снаружи нечем — у императивного API
     * 0.18.1 есть `getAppState`, но нет `setAppState`. Остался единственный рычаг: клик по
     * кнопке нижнего бара, которую нажимает человек. Распознаём её по aria-метке из
     * `buttons.edit` и по контейнеру `App-toolbar-content` — если библиотека переименует что-то
     * из этого, тест падает здесь, а не молча «теряя» панель на уроке.
     */
    expect(bundleJs).toContain('App-bottom-bar');
    expect(bundleJs).toContain('App-toolbar-content');
    expect(bundleJs).toMatch(/name:"toggleEditMenu"/);
    expect(bundleJs, 'кнопка потеряла aria-метку, по которой её находит Board.tsx')
      .toMatch(/"aria-label":\s*[A-Za-z_$]+\("buttons\.edit"\)/);
    /*
     * Метка печатается на языке, которого у нашей кнопки нет: `<Excalidraw>` в Board.tsx не
     * получает `langCode`, поэтому `buttons.edit` остаётся «Edit» и локатор `[aria-label="Edit"]`
     * честен. Как только сюда придёт локализация полотна, локатор обязан стать списком меток.
     */
    expect(BOARD_TSX, 'полотно локализовали — локатор переключателя в Board.tsx больше не точен')
      .not.toMatch(/langCode=\{/);
  });

  it(`Excalidraw ${version} still decides its chrome by «width < X or (height < Y and width < Z)»`, () => {
    /*
     * Тот самый предикат, который мы повторяем в `excalidrawMobileChrome` (730 / 500 / 1000 —
     * константы того же бандла). Проверяется ФОРМА, а не числа: минификатор меняет имена, а вот
     * если библиотека поменяет саму логику («только ширина»), наш расчёт раскладки станет ложью,
     * и панель снова начнёт исчезать не по кнопке.
     */
    const fn = bundleJs.match(/"isMobileBreakpoint",\((\w+),(\w+)\)=>(.{0,80}?)\);/);
    expect(fn, 'предикат раскладки исчез из бандла').toBeTruthy();
    expect(fn![3], 'форма предиката раскладки изменилась').toMatch(/^\w+<\w+\|\|\w+<\w+&&\w+<\w+$/);
  });

  it('the class still labels the shape-actions panel, not something else', () => {
    /*
     * Само по себе вхождение строки ничего не значит: класс мог уехать на другой контейнер. Садим
     * его РЯДОМ с ЗАГОЛОВКОМ панели (`selectedShapeActions` — подпись того же островка для
     * скринридера), потому что именно пара «заголовок + контейнер» и есть панель стилей. Расстояние
     * с запасом: имена переменных минификатор меняет, соседство строк — нет. Оба порядка, потому
     * что порядок аргументов в JSX тоже не наш.
     */
    const near = /selected-shape-actions[\s\S]{0,400}selectedShapeActions|selectedShapeActions[\s\S]{0,400}selected-shape-actions/;
    expect(near.test(bundleJs), 'the class no longer sits next to the shape-actions heading').toBe(true);
    // `.panelColumn` — содержимое панели: оно тоже обязано остаться, иначе прятать нечего
    expect(bundleJs).toContain('panelColumn');
  });
});
