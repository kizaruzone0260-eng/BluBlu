/**
 * Часть A (2026-10-23) — чистые правила панели стилей доски.
 *
 * Симптом был живой, а проверка нет: браузерные спеки локально запрещены, поэтому всё, что можно
 * доказать без полотна, живёт здесь — «по умолчанию закрыто», «раздельная память учителя и
 * ученика» и «узкое окно закрывает панель, но не портит сохранённый выбор».
 */
import { describe, it, expect } from 'vitest';
import {
  STYLES_PANEL_MIN_WIDTH, boardStylesRole, resolveStylesPanel, stylesPanelKey, stylesPanelStored,
} from '@klass/shared';
import ru from '@klass/shared/locales/ru.json';
import uz from '@klass/shared/locales/uz.json';
import en from '@klass/shared/locales/en.json';

const DICTS = { ru, uz, en } as const;
type Lesson = Record<string, Record<string, string>>;

describe('board styles panel defaults', () => {
  it('the panel is closed on a wide screen until somebody presses the button', () => {
    // первый заход: сохранённого выбора нет ни у ученика, ни у учителя
    expect(resolveStylesPanel({ width: 1440, stored: null })).toBe(false);
    expect(resolveStylesPanel({ width: 1440, stored: '0' })).toBe(false);
    expect(resolveStylesPanel({ width: 1440, stored: '1' })).toBe(true);
  });

  it('a narrow viewport closes the panel whatever was remembered — and 1280 px is the line', () => {
    expect(STYLES_PANEL_MIN_WIDTH).toBe(1280);
    expect(resolveStylesPanel({ width: STYLES_PANEL_MIN_WIDTH - 1, stored: '1' })).toBe(false);
    expect(resolveStylesPanel({ width: STYLES_PANEL_MIN_WIDTH, stored: '1' })).toBe(true);
    // телефон из standing constraint (390 px)
    expect(resolveStylesPanel({ width: 390, stored: '1' })).toBe(false);
    // мусор вместо значения (чужая запись в localStorage) не открывает панель
    expect(resolveStylesPanel({ width: 1440, stored: 'yes' })).toBe(false);
    expect(resolveStylesPanel({ width: Number.NaN, stored: '1' })).toBe(false);
  });

  it('the teacher’s choice and the pupil’s choice are stored apart', () => {
    expect(stylesPanelKey('teacher')).not.toBe(stylesPanelKey('student'));
    expect(stylesPanelKey('teacher')).toContain('teacher');
    expect(stylesPanelKey('student')).toContain('student');
    expect(boardStylesRole('teacher')).toBe('teacher');
    expect(boardStylesRole('student')).toBe('student');
    // роль, которой нет в словаре прав, — ученик: шире прав это не делает
    expect(boardStylesRole(undefined)).toBe('student');
    expect(boardStylesRole('admin')).toBe('student');
  });

  it('what is written is exactly what is read back', () => {
    expect(stylesPanelStored(true)).toBe('1');
    expect(stylesPanelStored(false)).toBe('0');
    for (const open of [true, false]) {
      expect(resolveStylesPanel({ width: 1440, stored: stylesPanelStored(open) })).toBe(open);
    }
  });

  it('the button has a name in all three languages', () => {
    for (const lang of ['ru', 'uz', 'en'] as const) {
      const lesson = (DICTS[lang] as unknown as Lesson).lesson;
      for (const key of ['boardStyles', 'boardStylesAria', 'boardStylesHint']) {
        expect(lesson[key], `${lang}.lesson.${key}`).toBeTruthy();
        expect(lesson[key].trim().length, `${lang}.lesson.${key} is too short to be a label`).toBeGreaterThan(2);
      }
    }
    // подпись кнопки должна оставаться короткой: она живёт в шапке полотна рядом с остальными
    expect((DICTS.ru as unknown as Lesson).lesson.boardStyles).toBe('Стили');
    expect((DICTS.en as unknown as Lesson).lesson.boardStyles).toBe('Styles');
  });
});
