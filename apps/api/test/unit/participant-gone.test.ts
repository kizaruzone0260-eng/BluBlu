/**
 * Часть 1 (2026-10-13): ушедший ученик не имеет права блокировать конец лекции.
 *
 * Причина, по которой функция вообще появилась: CI-прогон 38407412645, третий спек zz19. Ученик
 * отвалился от комнаты ровно в тот момент, когда маршрут выключал лекцию, LiveKit ответил
 * 404 `not_found`, вызов попал в `failed`, и учитель получил 502 с `lectureMode: true` — лекция
 * не выключилась из-за человека, который уже вышел и которому возвращать было нечего.
 *
 * Граница, которую здесь держат: 404 по участнику — «его нет», а всё остальное (таймаут, 5xx,
 * отказ соединения) — «медиа-сервер недоступен», и тогда состояние не меняется. Ослаблять вторую
 * сторону нельзя: 502 без записи проверяет `test/integration/lecture-restore.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import { isParticipantGone } from '../../src/services/lessons.js';

describe('isParticipantGone — «участник вышел» против «медиа-сервер лежит»', () => {
  it('a 404 from LiveKit means the participant is gone', () => {
    expect(isParticipantGone({ status: 404, code: 'not_found', message: 'participant does not exist' })).toBe(true);
    // `code` достаточно и без status: SDK отдаёт их парой, но форма поля не гарантирована
    expect(isParticipantGone({ code: 'not_found' })).toBe(true);
  });

  it('a real media-server failure is NOT "gone": the route must still answer 502', () => {
    expect(isParticipantGone({ status: 500, code: 'internal' })).toBe(false);
    expect(isParticipantGone(new Error('fetch failed'))).toBe(false);
    expect(isParticipantGone({ status: 412, code: 'failed_precondition' })).toBe(false);
    expect(isParticipantGone(undefined)).toBe(false);
    expect(isParticipantGone(null)).toBe(false);
  });

  it('any 404 inside the loop counts as "gone", because the room itself was listed one call earlier', () => {
    /*
     * Различать «нет участника» и «нет комнаты» по одному `status` нельзя, и здесь это не нужно:
     * список участников маршрут получает ДО цикла, и отказ списка — это 502 ещё до первого
     * `updateParticipant`. Значит до цикла доходит только 404 про того, кто вышел. Комната,
     * исчезнувшая посреди цикла, тоже безопасна: её участники уже отключены, а права они получат
     * заново по токену входа, где `lectureMode` к этому моменту уже `false`.
     */
    expect(isParticipantGone({ status: 404 })).toBe(true);
    expect(isParticipantGone({ status: 403, code: 'permission_denied' })).toBe(false);
  });
});
