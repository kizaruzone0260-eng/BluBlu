/**
 * Потолки размера запроса и размера коллекций (задача 2026-10-27, часть A).
 *
 * Повод — консультация по Zod GHSA-mrhx-c7xc-m3w5: на «oversized constrained collections» Zod
 * до 4.6.6 исчерпывал память. Сам пакет поднят до 4.6.7, но класс задачи от версии не зависит:
 * публичный вход обязан иметь ИЗМЕРИМЫЙ потолок, и потолки эти обязаны быть видны в коде, а не
 * «получаться сами» из дефолтов фреймворка.
 *
 * Здесь проверяются чистые схемы и константы — без базы и без HTTP, потому что через HTTP
 * гигантский массив подать нельзя (тело раньше отрежет транспорт), а значит, и поведение схемы
 * на таком входе иначе не увидеть. Транспортные пределы (413) покрыты интеграционным
 * `body-limits.test.ts`.
 *
 * Отдельно держится граница «не сломать легитимное»: реальный класс, реальная страница доски и
 * реальный набор уведомлений обязаны проходить. Предел, после которого продукт не работает,
 * хуже отсутствия предела — его просто отключат.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardPageSaveSchema, MAX_BOARD_PAGES, MAX_BOARD_TITLE_INPUT } from '../../src/routes/board.js';
import { MAX_BOARD_ELEMENTS, MAX_STUDENT_ELEMENTS } from '../../src/services/board.js';
import { JSON_BODY_LIMIT, BOARD_PUBLISH_BODY_LIMIT } from '../../src/lib/bodyLimits.js';
import { MAX_NOTIFY_KIND_KEYS } from '../../src/routes/telegram.js';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src');

/** Минимальный элемент Excalidraw: схема требует только `id`, остальное обязано пройти насквозь. */
const el = (id: string, extra: Record<string, unknown> = {}) => ({ id, ...extra });

describe('Пределы тела запроса', () => {
  it('общий предел — ровно прежний молчаливый дефолт Fastify, то есть поведение маршрутов не изменилось', () => {
    expect(JSON_BODY_LIMIT).toBe(1_048_576);
  });

  it('единственное исключение покрывает контракт публикации доски, а не «примерно побольше»', () => {
    // Схема publish принимает dataUrl до 12 000 000 символов; тело — это она же плюс JSON-обёртка
    // ({"dataUrl":"","kind":"png","title":…} и до 200 символов заголовка). Предел обязан впускать
    // максимально легитимное тело целиком, иначе схема обещает одно, а транспорт режет другое —
    // ровно та поломка, из-за которой исключение и появилось.
    expect(BOARD_PUBLISH_BODY_LIMIT).toBeGreaterThanOrEqual(12_000_000 + 4_096);
    // И обязано оставаться исключением: сопоставимый вход в продукте уже шире (загрузка материала
    // до MAX_FILE_MB = 100 МБ), поэтому «поднять всё» не требуется.
    expect(BOARD_PUBLISH_BODY_LIMIT).toBeLessThan(100 * 1_048_576);
  });

  it('в исходниках нет других негласных пределов тела: глобальный + одно названное исключение', () => {
    // Опция Fastify называется `bodyLimit`. Мест, где она задана, должно остаться ровно два:
    // `app.ts` (глобально, на весь сервер) и `routes/board.ts` (публикация доски). Третий файл
    // означал бы, что предел появился «по месту» — без названия, без обоснования и без теста.
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = path.join(dir, name);
        if (statSync(p).isDirectory()) { walk(p); continue; }
        if (!p.endsWith('.ts')) continue;
        if (/bodyLimit\s*:/.test(readFileSync(p, 'utf8'))) {
          hits.push(path.relative(SRC, p).split(path.sep).join('/'));
        }
      }
    };
    walk(SRC);
    expect(hits.sort()).toEqual(['app.ts', 'routes/board.ts']);
  });
});

describe('boardPageSaveSchema: легитимная страница доски проходит', () => {
  it('принимает реальную страницу и сохраняет поля элемента, которых схема не перечисляет', () => {
    const elements = Array.from({ length: MAX_STUDENT_ELEMENTS }, (_, i) => el(`e${i}`, {
      type: 'draw', x: i, y: i, strokeColor: '#123456', points: [[0, 0], [1, 1]],
    }));
    const r = boardPageSaveSchema.safeParse({ pageNo: 1, title: 'Урок 1', elements });
    expect(r.success, JSON.stringify(r.success ? '' : r.error.issues)).toBe(true);
    if (!r.success) return;
    expect(r.data.elements).toHaveLength(MAX_STUDENT_ELEMENTS);
    // z.looseObject (в Zod 3 — .passthrough()): элемент Excalidraw несёт десятки полей, и потеря
    // любого из них вернула бы учителю рисунок без цвета или толщины.
    expect(r.data.elements[0]).toMatchObject({ id: 'e0', strokeColor: '#123456' });
  });

  it('принимает крайние допустимые номера страниц и длину заголовка', () => {
    expect(boardPageSaveSchema.safeParse({ pageNo: 1, elements: [] }).success).toBe(true);
    expect(boardPageSaveSchema.safeParse({ pageNo: MAX_BOARD_PAGES, elements: [] }).success).toBe(true);
    expect(boardPageSaveSchema.safeParse({
      pageNo: 2, title: 'x'.repeat(MAX_BOARD_TITLE_INPUT), elements: [],
    }).success, 'ровно потолок длины заголовка — ещё можно').toBe(true);
  });
});

describe('boardPageSaveSchema: oversized и кривой вход — это отказ схемы, а не падение', () => {
  it('отвергает коллекцию больше потолка и делает это быстро', () => {
    const over = Array.from({ length: MAX_BOARD_ELEMENTS + 1 }, (_, i) => el(`e${i}`));
    const t0 = performance.now();
    const r = boardPageSaveSchema.safeParse({ pageNo: 1, elements: over });
    const ms = performance.now() - t0;
    expect(r.success, 'элементов больше MAX_BOARD_ELEMENTS').toBe(false);
    expect(ms, 'потолок длины проверяется до разбора содержимого').toBeLessThan(5_000);
  });

  it('РЕГРЕССИЯ GHSA-mrhx-c7xc-m3w5: гигантский массив отвергается без исчерпания памяти', () => {
    // Ровно тот вход из консультации: массив, который в product-коде появиться не может, а в
    // запросе — может. Одна и та же ссылка на объект, чтобы тест не измерял собственную память.
    const huge = new Array(200_000).fill(el('boom'));
    const t0 = performance.now();
    const r = boardPageSaveSchema.safeParse({ pageNo: 1, elements: huge });
    const ms = performance.now() - t0;
    expect(r.success).toBe(false);
    expect(ms, 'отказ по длине, а не разбор 200 000 элементов').toBeLessThan(20_000);
  });

  it('отвергает вложенное невалидное значение и показывает, в каком именно элементе', () => {
    const r = boardPageSaveSchema.safeParse({
      pageNo: 1,
      elements: [el('ok'), { type: 'draw' }, { id: 42 }, 'element-as-string'],
    });
    expect(r.success).toBe(false);
    if (r.success) return;
    // Путь до ошибки обязан указывать на индекс: клиент подсвечивает элемент, а не «всё тело».
    // В Zod 4 `path` — это PropertyKey[], отсюда сравнение по String().
    const paths = r.error.issues.map((i) => i.path.map(String).join('.'));
    expect(paths).toContain('elements.1.id');
    expect(paths).toContain('elements.2.id');
    expect(paths).toContain('elements.3');
  });

  it('отвергает невалидные pageNo, title и elements как тип', () => {
    for (const body of [
      { pageNo: 0, elements: [] },
      { pageNo: MAX_BOARD_PAGES + 1, elements: [] },
      { pageNo: 1.5, elements: [] },
      { pageNo: '1', elements: [] },
      { pageNo: 1, title: 'x'.repeat(MAX_BOARD_TITLE_INPUT + 1), elements: [] },
      { pageNo: 1, elements: {} },
      { pageNo: 1, elements: 'nope' },
      { pageNo: 1, elements: [null] },
      {},
    ]) {
      const r = boardPageSaveSchema.safeParse(body);
      expect(r.success, JSON.stringify(body)).toBe(false);
    }
  });
});

describe('Предел словаря настроек уведомлений', () => {
  it('вмещает все существующие виды уведомлений с запасом и не пускает мегабайты ключей', () => {
    // Продукт знает пять видов (`KIND_KEYS` в services/bot.ts: reminder24h, reminder1h,
    // reminder10m, lessonStarted, materialNew). Словарь намеренно НЕ сужен до этого списка —
    // прежний клиент мог прислать свой ключ, и отказ здесь только про размер.
    expect(MAX_NOTIFY_KIND_KEYS).toBeGreaterThanOrEqual(5);
    expect(MAX_NOTIFY_KIND_KEYS).toBeLessThanOrEqual(64);
  });
});
