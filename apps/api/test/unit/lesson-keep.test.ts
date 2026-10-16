import { describe, expect, it } from 'vitest';
import {
  REJOIN_TTL_MS, clampMiniPos, formatElapsed, isDuplicateIdentityError, isRejoinFresh,
  lessonElapsedMs, parseMiniPos, parseRejoin, sameLesson, type RejoinMark,
} from '@klass/shared';

/*
 * Часть A (2026-10-16). Юнит-тест держит тихую логику возврата в урок и мини-окна: её нельзя
 * вывести из состояния страницы, а проверка браузером стоит RTC-комнаты. Срока возврата, порядка
 * сравнения урока и арифметики таймера в компоненте не видно — здесь они названы.
 */

const T0 = 1_700_000_000_000;
const mark = (over: Partial<RejoinMark> = {}): RejoinMark => ({
  sessionId: 's1', eventId: 'e1', classId: 'c1', at: T0, ...over,
});

describe('метка возврата в урок', () => {
  it('живёт ровно срок, а не «почти»', () => {
    expect(isRejoinFresh(mark(), T0 + 1_000)).toBe(true);
    expect(isRejoinFresh(mark(), T0 + REJOIN_TTL_MS)).toBe(true);      // предел включительно
    expect(isRejoinFresh(mark(), T0 + REJOIN_TTL_MS + 1)).toBe(false); // на миллисекунду позже — нет
  });

  it('отрицательная и будущая метка — это не «только что вышел»', () => {
    expect(isRejoinFresh(mark({ at: T0 + 60_000 }), T0)).toBe(false);
    expect(isRejoinFresh(mark({ at: -1 }), T0)).toBe(false);
    expect(isRejoinFresh(mark({ at: Number.NaN }), T0)).toBe(false);
  });

  it('пустого урока не бывает: без идентификатора метки нет', () => {
    expect(isRejoinFresh(mark({ sessionId: '' }), T0)).toBe(false);
    expect(isRejoinFresh(null, T0)).toBe(false);
    expect(isRejoinFresh(undefined, T0)).toBe(false);
  });

  it('срок можно сузить (тест и будущая настройка), не меняя смысл', () => {
    expect(isRejoinFresh(mark(), T0 + 5_000, 4_000)).toBe(false);
    expect(isRejoinFresh(mark(), T0 + 5_000, 6_000)).toBe(true);
  });

  it('сверка урока: событие важнее класса, вход по классу не притворяется входом по событию', () => {
    expect(sameLesson(mark(), { eventId: 'e1' })).toBe(true);
    expect(sameLesson(mark(), { eventId: 'e2' })).toBe(false);
    expect(sameLesson(mark(), { eventId: 'e2', classId: 'c1' })).toBe(false); // приоритет у события
    expect(sameLesson(mark(), { classId: 'c1' })).toBe(true);
    expect(sameLesson(mark(), { classId: 'c2' })).toBe(false);
    expect(sameLesson(mark({ eventId: null }), { classId: 'c1' })).toBe(true);
    expect(sameLesson(mark(), {})).toBe(false);
    expect(sameLesson(null, { eventId: 'e1' })).toBe(false);
  });

  it('разбор пережитого значения: любое исключение или мусор — это null, а не падение', () => {
    expect(parseRejoin(null)).toBeNull();
    expect(parseRejoin('')).toBeNull();
    expect(parseRejoin('{')).toBeNull();
    expect(parseRejoin('null')).toBeNull();
    expect(parseRejoin('[1,2]')).toBeNull();
    expect(parseRejoin(JSON.stringify({ sessionId: 's1', at: T0 }))).toBeNull();        // нет classId
    expect(parseRejoin(JSON.stringify({ classId: 'c1', at: T0 }))).toBeNull();          // нет sessionId
    expect(parseRejoin(JSON.stringify({ sessionId: 's1', classId: 'c1', at: 'T0' }))).toBeNull();
    expect(parseRejoin(JSON.stringify(mark()))).toEqual(mark());                        // круг замкнут
    expect(parseRejoin(JSON.stringify({ ...mark(), token: 'abc' }))).toEqual(mark());   // лишнее отбрасывается
  });

  it('в токене возврата секретов нет: только урок и время', () => {
    const raw = JSON.stringify(mark());
    expect(raw).not.toMatch(/token|ticket|jwt|password|secret/i);
  });
});

describe('таймер и мини-окно', () => {
  it('идёт от серверного `startedAt` и не становится отрицательным', () => {
    const started = new Date(T0 - 90_000).toISOString();
    expect(lessonElapsedMs(started, T0)).toBe(90_000);
    expect(lessonElapsedMs(new Date(T0 + 10_000).toISOString(), T0)).toBe(0);
    expect(lessonElapsedMs(undefined, T0)).toBe(0);
    expect(lessonElapsedMs('не дата', T0)).toBe(0);
  });

  it('формат: минуты-секунды, после часа — часы', () => {
    expect(formatElapsed(0)).toBe('00:00');
    expect(formatElapsed(65_000)).toBe('01:05');
    expect(formatElapsed(600_000)).toBe('10:00');
    expect(formatElapsed(3_661_000)).toBe('1:01:01');
    expect(formatElapsed(-5_000)).toBe('00:00');
  });

  it('окно не уходит за край вьюпорта, в том числе при повороте телефона', () => {
    expect(clampMiniPos({ x: -40, y: -10 }, 1280, 800)).toEqual({ x: 0, y: 0 });
    expect(clampMiniPos({ x: 1200, y: 900 }, 1280, 800)).toEqual({ x: 1280 - 268, y: 800 - 184 });
    // вьюпорт меньше окна — правый/нижний предел не становится отрицательным
    expect(clampMiniPos({ x: 500, y: 500 }, 200, 120)).toEqual({ x: 0, y: 0 });
    // бесконечность и NaN — это не «до самого низа», а мусор: окно встаёт в левый верхний угол
    expect(clampMiniPos({ x: Number.NaN, y: Number.POSITIVE_INFINITY }, 1280, 800)).toEqual({ x: 0, y: 0 });
    expect(clampMiniPos({ x: 12, y: 34 }, 390, 844)).toEqual({ x: 12, y: 34 });
  });

  it('позиция по умолчанию возвращается на любом мусоре', () => {
    expect(parseMiniPos(null, { x: 8, y: 8 })).toEqual({ x: 8, y: 8 });
    expect(parseMiniPos('{"x":"8"}', { x: 8, y: 8 })).toEqual({ x: 8, y: 8 });
    expect(parseMiniPos('[[9]]', { x: 1, y: 2 })).toEqual({ x: 1, y: 2 });
    expect(parseMiniPos('{"x":40,"y":60,"min":true}', { x: 8, y: 8 })).toEqual({ x: 40, y: 60 });
  });
});

describe('второе окно в том же уроке', () => {
  it('узнаёт отказ LiveKit про занятой идентификатор', () => {
    expect(isDuplicateIdentityError(new Error('you are already the owner of this identity: u1'))).toBe(true);
    expect(isDuplicateIdentityError({ message: 'Duplicate identity' })).toBe(true);
    expect(isDuplicateIdentityError(new Error('Could not get user media'))).toBe(false);
    expect(isDuplicateIdentityError(undefined)).toBe(false);
  });
});
