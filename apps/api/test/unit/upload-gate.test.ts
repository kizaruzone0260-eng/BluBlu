/**
 * SEC-10 (2026-10-28): счётчик одновременных тяжёлых загрузок.
 *
 * Здесь проверяется сам механизм, на котором держится 429: потолок, отдача слота и то, что лишний
 * `release` не делает счётчик отрицательным. Интеграционная сторона (маршрут реально отвечает 429
 * с `Retry-After` и освобождает слот при 4xx) — в `test/integration/upload-limits.test.ts`.
 *
 * Модуль читает `env.MAX_CONCURRENT_UPLOADS` один раз при импорте, поэтому тест не полагается на
 * значение из окружения: он временно задаёт свой потолок и возвращает исходный в `afterEach`.
 */
import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import {
  tryAcquireUploadSlot, releaseUploadSlot, activeUploads, setUploadSlotLimit,
} from '../../src/lib/uploadGate.js';

describe('upload gate (SEC-10)', () => {
  let original = 2;

  beforeAll(() => {
    original = setUploadSlotLimit(2);
  });
  afterEach(() => {
    while (activeUploads() > 0) releaseUploadSlot();
    setUploadSlotLimit(original);
  });

  it('держит не больше потолка и отдаёт место после release', () => {
    setUploadSlotLimit(2);
    expect(tryAcquireUploadSlot()).toBe(true);
    expect(tryAcquireUploadSlot()).toBe(true);
    expect(tryAcquireUploadSlot(), 'третий при потолке 2 не проходит').toBe(false);
    expect(activeUploads()).toBe(2);
    releaseUploadSlot();
    expect(tryAcquireUploadSlot()).toBe(true);
    expect(activeUploads()).toBe(2);
  });

  it('потолок 1 — ровно один; 0 и отрицательное поднимаются до 1', () => {
    expect(setUploadSlotLimit(1)).toBe(2);
    expect(tryAcquireUploadSlot()).toBe(true);
    expect(tryAcquireUploadSlot()).toBe(false);
    releaseUploadSlot();
    expect(setUploadSlotLimit(0), 'ноль слотов не бывает: это вечный 429').toBe(1);
    expect(tryAcquireUploadSlot()).toBe(true);
    expect(tryAcquireUploadSlot()).toBe(false);
    releaseUploadSlot();
    expect(setUploadSlotLimit(-5), 'отрицательный потолок тоже поднимается до одного').toBe(1);
    expect(tryAcquireUploadSlot()).toBe(true);
  });

  it('лишний release не уводит счётчик в минус', () => {
    setUploadSlotLimit(2);
    releaseUploadSlot();
    releaseUploadSlot();
    expect(activeUploads()).toBe(0);
    expect(tryAcquireUploadSlot(), 'после лишних release слоты всё ещё выдаются').toBe(true);
    expect(activeUploads()).toBe(1);
  });

  it('дробный потолок округляется вниз, но не ниже одного', () => {
    expect(setUploadSlotLimit(2.9)).toBe(2);
    expect(tryAcquireUploadSlot()).toBe(true);
    expect(tryAcquireUploadSlot()).toBe(true);
    expect(tryAcquireUploadSlot()).toBe(false);
  });
});
