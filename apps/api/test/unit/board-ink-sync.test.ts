/**
 * Страховки вокруг синхронизации чернил доски (правка 2026-10-24).
 *
 * Разбор красных `zz20` дал два дефекта, и оба живут на границе «локальная сцена ↔ сервер»,
 * где без браузера проверить можно только ФОРМУ кода — по той же причине, по которой в этом
 * наборе уже стоят `board-styles-toggle.test.ts` и `excalidraw-styles-panel.test.ts`:
 *
 *  1. `sentRef` — карта «что сервер уже имеет». Она наполняется снимком страницы, а не
 *     очищается перед ним. Очищенная карта заставляла следующий `onChange` отправлять НАРУЖУ
 *     ВСЮ сцену: ученик, ничего не трогавший, предлагал серверу учительский элемент, получал
 *     отказ (`boardForeign`), отказ отвечал новым `current`, новый `current` снова очищал
 *     карту — цикл, в замере 2026-10-24 дававший один обмен каждые 250 мс, пока доска открыта,
 *     плюс ложный тост человеку.
 *  2. `current` переставляет полотно ЦЕЛИКОМ, поэтому снимок обязан содержать уже принятые
 *     правки этого же кадра — иначе автор видит, как его собственный штрих исчезает с его
 *     экрана (это и есть второй симптом zz20: метка у учителя есть, чернила дошли, а на
 *     полотне автора их нет).
 *  3. Смещение холста: Excalidraw считает координаты указателя как `clientY - state.offsetTop`
 *     и перечитывает `offsetTop` только на смену РАЗМЕРА контейнера, на `resize` и на скролл
 *     окна. Урок двигает доску, не меняя её размера, — и штрих рождается в 744 px выше
 *     курсора, за видимой областью.
 *
 * Эти проверки падают ровно в тот момент, когда кто-то возвращает `sentRef.current.clear()`
 * перед `replaceScene`, убирает фильтрацию `locked`, переставляет `mergeElements` обратно после
 * `sendSceneTo` или оставляет полотно без перечитывания смещения.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/** Путь от самого файла: тесты запускают и из `apps/api`, и из корня (CI). */
const here = path.dirname(fileURLToPath(import.meta.url));   // apps/api/test/unit
const repoRoot = path.resolve(here, '../../../..');
const boardPath = path.join(repoRoot, 'apps', 'web', 'src', 'components', 'Board.tsx');
const routePath = path.join(repoRoot, 'apps', 'api', 'src', 'routes', 'board.ts');

/** Комментарии убраны намеренно: они описывают и прежнюю ошибку тоже, и ловили бы сами себя. */
const strip = (raw: string) => raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
const board = strip(readFileSync(boardPath, 'utf8'));
const route = strip(readFileSync(routePath, 'utf8'));

describe('board ink sync: sentRef means "what the server already has"', () => {
  it('replaceScene records the incoming versions instead of forgetting them', () => {
    const start = board.indexOf('function replaceScene(');
    expect(start, 'replaceScene на месте').toBeGreaterThan(-1);
    const body = board.slice(start, board.indexOf('\n  }', start));
    expect(body, 'снимок страницы записывается в sentRef').toContain('rememberAsSent(elements, true)');
    expect(body, 'полотно переставляется тем же снимком').toContain('updateScene');
  });

  it('no WS branch empties the map right before replacing the scene', () => {
    // `sentRef.current.clear()` имеет право звучать только там, где сцену НЕ переставляют
    // (сообщение `pages` без массива элементов) — иначе следующий onChange шлёт всю страницу
    expect(board, 'карта не очищается перед init').not.toMatch(/sentRef\.current\.clear\(\);\s*\n\s*replaceScene/);
    expect(board.match(/sentRef\.current\.clear\(\)/g) ?? [],
      'единственный clear — ветка pages без elements').toHaveLength(1);
  });

  it('a merged incoming frame is recorded too', () => {
    const start = board.indexOf('function mergeIncoming(');
    expect(start, 'mergeIncoming на месте').toBeGreaterThan(-1);
    const body = board.slice(start, board.indexOf('\n  }', start));
    expect(body, 'версии из приехавшего кадра запоминаются').toContain('rememberAsSent(incoming)');
  });

  it('elements the server marked foreign to this client are never offered back', () => {
    const start = board.indexOf('function onChange(');
    expect(start, 'onChange на месте').toBeGreaterThan(-1);
    const body = board.slice(start, board.indexOf('\n  }', start));
    expect(body, 'чужой (locked) элемент не уходит в edits').toMatch(/if\s*\(el\.locked === true\)\s*continue;/);
    // и именно ДО диффа, иначе он всё равно попадёт в `changed`
    expect(body.indexOf('el.locked === true'), 'фильтр стоит до сравнения версий')
      .toBeLessThan(body.indexOf('sentRef.current.get(el.id)'));
  });
});

describe('board ink sync: the server snapshot must contain what it just accepted', () => {
  it('accepted edits are merged before the authoritative frame is sent back', () => {
    const merge = route.indexOf('mergeElements(r.elements, gate.accepted)');
    const snapshot = route.indexOf('sendSceneTo(r, socket, who)');
    expect(merge, 'merge принятых правок на месте').toBeGreaterThan(-1);
    expect(snapshot, 'ответный снимок страницы на месте').toBeGreaterThan(-1);
    expect(snapshot, 'снимок отправляется ПОСЛЕ merge, иначе автор теряет свой штрих')
      .toBeGreaterThan(merge);
    expect(route, 'и право рисовать по-прежнему решает gateEdits').toContain('gateEdits({');
    expect(route, 'отказ не потерялся').toContain("'boardForeign'");
  });
});

describe('board ink sync: the canvas must know where it stands', () => {
  it('a layout move that keeps the size still refreshes the canvas offsets', () => {
    expect(board, 'эффект перечитывания смещения на месте').toContain('apiRef.current?.refresh()');
    const start = board.indexOf('const check = () =>');
    expect(start, 'сравнение геометрии кадра на месте').toBeGreaterThan(-1);
    const body = board.slice(start, board.indexOf('const schedule', start));
    for (const coord of ['top', 'left', 'width', 'height']) {
      expect(body, `сверяется смещение ${coord}`).toContain(`r.${coord}`);
    }
    expect(board, 'перерисовка планировки урока ловится через MutationObserver')
      .toContain('new MutationObserver(schedule)');
    expect(board, 'проверка не делается на каждую мутацию — только раз на кадр')
      .toContain('requestAnimationFrame(check)');
  });

  it('the refresh is not wired into onChange (React #185 guard)', () => {
    const start = board.indexOf('function onChange(');
    const body = board.slice(start, board.indexOf('\n  }', start));
    expect(body, 'из onChange состояние поднимать нельзя').not.toContain('refresh()');
  });
});
