import { describe, expect, it } from 'vitest';
import { hasAnyOptionalCap, missingCapNotices, showsSpeakerPicker, type MediaCaps } from '@klass/shared';

/*
 * B1 (2026-10-16). Решаёт не браузер, а список: «что спрятать и чем объяснить». Проверка
 * держит три вещи, на которых такие фичи обычно и ломаются: порядок строк, полное молчание,
 * когда всё умеют, и то, что объяснение даётся на КАЖДУЮ отнятую возможность, а не на первую.
 */

const ALL: MediaCaps = { screen: true, fullscreen: true, sink: true };
const PHONE: MediaCaps = { screen: false, fullscreen: true, sink: false };

describe('объяснения недоступных возможностей', () => {
  it('всё умеют — объяснений нет', () => {
    expect(missingCapNotices(ALL)).toEqual([]);
  });

  it('мобильный Safari:нет показа экрана и нет выбора динамика, и это две разные строки', () => {
    expect(missingCapNotices(PHONE)).toEqual(['lesson.capNoScreen', 'lesson.speakerUnsupported']);
  });

  it('порядок совпадает с порядком в меню: экран → полный экран → динамик', () => {
    expect(missingCapNotices({ screen: false, fullscreen: false, sink: false })).toEqual([
      'lesson.capNoScreen', 'lesson.capNoFullscreen', 'lesson.speakerUnsupported',
    ]);
  });

  it('каждая отнятая возможность объясняется отдельно, а не одной общей фразой', () => {
    expect(missingCapNotices({ screen: true, fullscreen: false, sink: true })).toEqual(['lesson.capNoFullscreen']);
    expect(missingCapNotices({ screen: true, fullscreen: true, sink: false })).toEqual(['lesson.speakerUnsupported']);
  });

  it('список динамиков показывается только там, где `setSinkId` есть', () => {
    expect(showsSpeakerPicker(ALL)).toBe(true);
    expect(showsSpeakerPicker(PHONE)).toBe(false);
  });

  it('«хотя бы одна опция есть» — ложь только когда нечего показать вообще', () => {
    expect(hasAnyOptionalCap(ALL)).toBe(true);
    expect(hasAnyOptionalCap(PHONE)).toBe(true);
    expect(hasAnyOptionalCap({ screen: false, fullscreen: false, sink: false })).toBe(false);
  });

  it('названия ключей живут в словарях: опечатка здесь = сырой ключ человеку', () => {
    // тот же класс дефекта, что ловит locale-usage.test.ts для apps/web, но для строк,
    // которые компонент получает из функции, а не пишет буквально
    for (const k of missingCapNotices({ screen: false, fullscreen: false, sink: false })) {
      expect(k).toMatch(/^lesson\.[a-zA-Z]+$/);
    }
  });
});
