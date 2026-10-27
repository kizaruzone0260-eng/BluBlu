/**
 * PATCH не должен приносить значения по умолчанию (2026-10-27, миграция на Zod 4).
 *
 * Это регрессия, которую поймал весь прогон, а не человек: `classUpdateSchema` была
 * `classCreateSchema.partial()`, и пока Zod был третьей версией, `.partial()` делал поле
 * опциональным ДО срабатывания `default()` — то есть отсутствующий ключ в PATCH честно
 * оставался отсутствующим. В Zod 4 (проверено на 4.6.7) `.partial()` дефолт СОХРАНЯЕТ, и
 * `parse({name:'X'})` начинает отдавать
 * `{name:'X', description:'', color:'#4f46e5', botPublicSchedule:false, boardArchivePublic:false}`.
 *
 * Для POST это невидимо. Для PATCH — это «учитель переименовал класс, а сервер в тот же
 * момент очистил описание, вернул цвет по умолчанию и выключил оба переключателя приватности».
 * Отдельно маршруту становится нечего проверять: прежняя защита «пустое обновление — это 400,
 * а не UPDATE без SET» переставала срабатывать, потому что объект пустым больше не был.
 *
 * Поэтому `classUpdateSchema` собрана явно, а этот тест держит обе половины: что PATCH больше
 * не додумывает, и что создание класса по-прежнему получает свои defaults. Третья часть —
 * negative control: она фиксирует сам факт ловушки, чтобы через полгода никто не «упростил»
 * схему обратно до `.partial()`.
 */
import { describe, it, expect } from 'vitest';
import { classCreateSchema, classUpdateSchema } from '@klass/shared';

const keys = (r: { success: boolean; data?: unknown }) =>
  Object.keys((r.success ? r.data ?? {} : {}) as Record<string, unknown>).sort();

describe('classUpdateSchema: отсутствие поля значит «не трогать»', () => {
  it('PATCH с одним полем возвращает ровно это поле', () => {
    const r = classUpdateSchema.safeParse({ name: '7-Б' });
    expect(r.success, JSON.stringify(r.success ? '' : r.error.issues)).toBe(true);
    expect(keys(r)).toEqual(['name']);
    expect(r.success && r.data.description).toBeUndefined();
    expect(r.success && r.data.color).toBeUndefined();
    expect(r.success && r.data.botPublicSchedule).toBeUndefined();
    expect(r.success && r.data.boardArchivePublic).toBeUndefined();
  });

  it('пустой PATCH остаётся пустым — именно на этом маршруте стоит защита от UPDATE без SET', () => {
    const r = classUpdateSchema.safeParse({});
    expect(r.success).toBe(true);
    expect(keys(r), 'ни одного «подставленного» значения').toEqual([]);
  });

  it('политика полей не разехалась с созданием: тот же объём, тот же цвет, те же length-границы', () => {
    expect(classUpdateSchema.safeParse({ description: 'x'.repeat(2001) }).success).toBe(false);
    expect(classUpdateSchema.safeParse({ color: 'red' }).success).toBe(false);
    expect(classUpdateSchema.safeParse({ color: '#0a1b2c' }).success).toBe(true);
    expect(classUpdateSchema.safeParse({ name: '7' }).success, 'min(2) как у создания').toBe(false);
    expect(classUpdateSchema.safeParse({ botPublicSchedule: true, boardArchivePublic: true }).success).toBe(true);
  });

  it('создание класса свои значения по умолчанию НЕ теряет', () => {
    const r = classCreateSchema.safeParse({ name: '7-Б' });
    expect(r.success, JSON.stringify(r.success ? '' : r.error.issues)).toBe(true);
    expect(r.success && r.data).toMatchObject({
      description: '', color: '#4f46e5', botPublicSchedule: false, boardArchivePublic: false,
    });
  });

  it('negative control: ловушка реальна — `.partial()` в Zod 4 действительно подставляет defaults', () => {
    // Если этот тест однажды станет зелёным без правки — значит, поведение Zod изменилось и
    // явную схему можно убирать. Пока он красный на OLD-поведении, а зелёный как доказательство:
    // именно так `classCreateSchema.partial()` и ломал PATCH.
    const trap = classCreateSchema.partial().safeParse({ name: '7-Б' });
    expect(trap.success).toBe(true);
    expect(keys(trap), 'Zod 4 вернул defaults под .partial()').not.toEqual(['name']);
    expect(trap.success && trap.data.description).toBe('');
  });
});
