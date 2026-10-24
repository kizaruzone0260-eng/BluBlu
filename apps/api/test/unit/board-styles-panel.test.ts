/**
 * Часть A (2026-10-23) + правка 2026-10-24 — чистые правила панели стилей доски.
 *
 * Симптом был живой, а проверка без браузера другой и не бывает: всё, что доказывается без
 * полотна, живёт здесь — «по умолчанию закрыто», «раздельная память учителя и ученика», «узкая
 * РАМКА закрывает панель, но не портит сохранённый выбор», «у двух состояний разные подписи на
 * трёх языках».
 *
 * Правка 2026-10-24 поменяла МЕРЯЕМУЮ величину: порог сравнивался с шириной ОКНА, теперь — с
 * шириной рамки доски. Тест обязан ловить именно это, иначе возвращается прежний ложный случай:
 * окно 1280 px при рамке ~926 px («места хватает», а панель легла на три четверти холста).
 */
import { describe, it, expect } from 'vitest';
import {
  STYLES_PANEL_MIN_FRAME, EXCALIDRAW_MOBILE_MAX_HEIGHT_LANDSCAPE, EXCALIDRAW_MOBILE_MAX_WIDTH,
  EXCALIDRAW_MOBILE_MAX_WIDTH_LANDSCAPE, boardStylesRole, excalidrawMobileChrome, resolveStylesPanel,
  stylesPanelKey, stylesPanelLabels, stylesPanelStored,
} from '@klass/shared';
import ru from '@klass/shared/locales/ru.json';
import uz from '@klass/shared/locales/uz.json';
import en from '@klass/shared/locales/en.json';

const DICTS = { ru, uz, en } as const;
type Lesson = Record<string, Record<string, string>>;
const lessonOf = (lang: 'ru' | 'uz' | 'en') => (DICTS[lang] as unknown as Lesson).lesson;
/** широкая рамка: столько даёт `.container { max-width: 960px }` минус свои отступы */
const WIDE = 900;

describe('board styles panel defaults', () => {
  it('the panel is closed on a wide board until somebody presses the button', () => {
    // первый заход: сохранённого выбора нет ни у ученика, ни у учителя
    expect(resolveStylesPanel({ width: WIDE, stored: null })).toBe(false);
    expect(resolveStylesPanel({ width: WIDE, stored: '0' })).toBe(false);
    expect(resolveStylesPanel({ width: WIDE, stored: '1' })).toBe(true);
  });

  it('a narrow BOARD FRAME closes the panel whatever was remembered', () => {
    // имя говорит про рамку, и значение обязано быть в её масштабе: шире 960 px рамка не бывает
    expect(STYLES_PANEL_MIN_FRAME).toBeLessThan(960);
    expect(STYLES_PANEL_MIN_FRAME).toBeGreaterThan(390);
    expect(resolveStylesPanel({ width: STYLES_PANEL_MIN_FRAME - 1, stored: '1' })).toBe(false);
    expect(resolveStylesPanel({ width: STYLES_PANEL_MIN_FRAME, stored: '1' })).toBe(true);
    // телефон из standing constraint (390 px)
    expect(resolveStylesPanel({ width: 390, stored: '1' })).toBe(false);
    /*
     * Ложный случай, из-за которого правка и была: окно 1280 px — старый порог говорил
     * «широко», и панель разрешалось держать открытой поверх ~926-пиксельной рамки. Теперь
     * решение принимается по рамке: 926 px ещё позволяют, 500 px — уже нет (островок стилей
     * весит ~190 px, то есть больше трети полотна).
     */
    expect(resolveStylesPanel({ width: 926, stored: '1' })).toBe(true);
    expect(resolveStylesPanel({ width: 500, stored: '1' }), 'меньше трети холста под панелью').toBe(false);
    // мусор вместо значения (чужая запись в localStorage) не открывает панель
    expect(resolveStylesPanel({ width: WIDE, stored: 'yes' })).toBe(false);
    expect(resolveStylesPanel({ width: Number.NaN, stored: '1' })).toBe(false);
    expect(resolveStylesPanel({ width: Number.POSITIVE_INFINITY, stored: '1' })).toBe(false);
    expect(resolveStylesPanel({ width: 0, stored: '1' }), 'пока рамка не померена — закрыто').toBe(false);
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
      expect(resolveStylesPanel({ width: WIDE, stored: stylesPanelStored(open) })).toBe(open);
    }
  });

  it('the two states have different labels, and both exist in every language', () => {
    const open = stylesPanelLabels(true);
    const closed = stylesPanelLabels(false);
    expect(open.aria).not.toBe(closed.aria);
    expect(open.hint).not.toBe(closed.hint);
    /*
     * Открытой панели подписью служит ДЕЙСТВИЕ «скрыть», закрытой — «показать»: имена ключей
     * называют действие (`ActionHide` / `ActionShow`), а подсказки — состояние (`HintOpen` /
     * `HintClose`). Перепутать их местами значит заставить кнопку врать скринридеру.
     */
    expect(open.aria).toBe('lesson.boardStylesActionHide');
    expect(closed.aria).toBe('lesson.boardStylesActionShow');
    expect(open.hint).toBe('lesson.boardStylesHintOpen');
    expect(closed.hint).toBe('lesson.boardStylesHintClose');
    for (const lang of ['ru', 'uz', 'en'] as const) {
      const lesson = lessonOf(lang);
      for (const key of [open.aria, open.hint, closed.aria, closed.hint]) {
        expect(key.startsWith('lesson.'), `ключ обязан указывать в раздел lesson: ${key}`).toBe(true);
        const text = lesson[key.slice('lesson.'.length)];
        expect(text, `${lang}.${key}`).toBeTruthy();
        expect(text.trim().length, `${lang}.${key} is too short to be a label`).toBeGreaterThan(2);
      }
      // подпись открытой панели обязана предлагать убрать, закрытой — вернуть
      expect(lesson[open.aria.slice(7)].toLowerCase()).not.toBe(lesson[closed.aria.slice(7)].toLowerCase());
    }
    /*
     * Видимый текст кнопки остаётся ОДНИМ и тем же: длина подписи двигала бы шапку полотна
     * (это измеряет блокирующий zz20 с допуском 2 px), поэтому состояние живёт в aria-атрибутах
     * и в подсказке, а не в том, что нарисовано на кнопке.
     */
  });

  it('the button has a name in all three languages, and no state-less leftovers', () => {
    for (const lang of ['ru', 'uz', 'en'] as const) {
      const lesson = lessonOf(lang);
      for (const key of ['boardStyles', 'boardStylesActionHide', 'boardStylesActionShow',
        'boardStylesHintOpen', 'boardStylesHintClose']) {
        expect(lesson[key], `${lang}.lesson.${key}`).toBeTruthy();
        expect(lesson[key].trim().length, `${lang}.lesson.${key} is too short to be a label`).toBeGreaterThan(2);
      }
      // прежних «одной строкой на оба состояния» больше нет: они и позволяли кнопке молчать
      for (const gone of ['boardStylesAria', 'boardStylesHint', 'boardStylesAriaOpen', 'boardStylesAriaClose']) {
        expect(lesson, `${lang}.lesson.${gone} обязан быть удалён`).not.toHaveProperty(gone);
      }
    }
    // подпись кнопки должна оставаться короткой: она живёт в шапке полотна рядом с остальными
    expect(lessonOf('ru').boardStyles).toBe('Стили');
    expect(lessonOf('en').boardStyles).toBe('Styles');
  });
});

/*
 * Правка 2026-10-24 (та же часть A, второй слой). Оказалось, что «панель» у Excalidraw — не один
 * узел: библиотека сама решает, какой раскладкой рисовать, по размеру СВОЕГО контейнера, и в
 * мобильной раскладке панели форматирования в DOM нет вовсе, пока полотно не попросит её своей
 * кнопкой. Прежний код знал про это один рычаг (CSS), поэтому на коротком полотне «Стили» жалась
 * в пустоту. Здесь зафиксирован расчёт раскладки — та самая ветка, которую в Board.tsx выбирает
 * эффект-примиритель.
 */
describe('which chrome the canvas will draw', () => {
  it('the lesson board at 1280×720 is the MOBILE chrome — that is the case the toggle used to miss', () => {
    // сетка урока: min(60vh, 100dvh − 420px) при 720 px = 300 px высоты, ширина ~912 px
    expect(excalidrawMobileChrome(912, 300)).toBe(true);
    // и «сцена» той же страницы: 40vh = 288 px
    expect(excalidrawMobileChrome(912, 288)).toBe(true);
  });

  it('a tall board is the desktop chrome, where CSS alone owns the panel', () => {
    expect(excalidrawMobileChrome(912, 620)).toBe(false);
    // широкое полотно остаётся десктопным даже при короткой рамке
    expect(excalidrawMobileChrome(1200, 300)).toBe(false);
  });

  it('the thresholds are the library’s own, and the border belongs to the library', () => {
    expect(EXCALIDRAW_MOBILE_MAX_WIDTH).toBe(730);
    expect(EXCALIDRAW_MOBILE_MAX_HEIGHT_LANDSCAPE).toBe(500);
    expect(EXCALIDRAW_MOBILE_MAX_WIDTH_LANDSCAPE).toBe(1000);
    // ровно на границе библиотека мобильной раскладку НЕ считает (`<`, не `<=`)
    expect(excalidrawMobileChrome(730, 600)).toBe(false);
    expect(excalidrawMobileChrome(729, 600), 'портрет — всегда мобильная').toBe(true);
    expect(excalidrawMobileChrome(999, 500)).toBe(false);
    expect(excalidrawMobileChrome(999, 499), 'короткое полотно шире 730 px — всё ещё мобильная').toBe(true);
    expect(excalidrawMobileChrome(1000, 300), 'на 1000 px ширины высота уже не решает').toBe(false);
  });

  it('an unmeasured or broken box never claims a chrome', () => {
    // 0 — это «ещё не померено»: примиритель не имеет права ничего нажимать до первого замера
    expect(excalidrawMobileChrome(0, 0)).toBe(false);
    expect(excalidrawMobileChrome(912, 0)).toBe(false);
    expect(excalidrawMobileChrome(Number.NaN, 300)).toBe(false);
    expect(excalidrawMobileChrome(-1, -1)).toBe(false);
  });
});
