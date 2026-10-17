/**
 * Часть B (2026-10-17): поле даты и времени на ЯЗЫКЕ ИНТЕРФЕЙСА.
 *
 * Нативные `type="date"` / `type="datetime-local"` рисуют формат браузера и не слушают язык
 * приложения, поэтому весь разбор и форматирование живут в `@klass/shared/dateTimeField` (чистые
 * функции, у них есть юнит-тесты на трёх языках), а здесь только ввод, подсказка формата, ошибка и
 * всплывающий календарь на общем механизме `lib/popover.ts` (он же клампит меню к вьюпорту и
 * отнимает высоты прижатых к краям полос — см. zz23).
 *
 * Значение, которое получает вызывающий код, НЕ изменилось: `YYYY-MM-DD` / `YYYY-MM-DDTHH:mm`
 * (местное время устройства) либо `''`. Пустое поле для необязательного значения и негодное
 * значение дают одинаковый `''`, а человек видит понятную ошибку: обязательность поля решает
 * вызывающий код (у формы события это `disabled` на кнопке сохранения).
 */
import { useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import {
  addMonths, applyDayPick, dayLabel, dayNamesShort, formatDateFieldValue, monthCells, monthLabel,
  parseDateFieldValue, readFieldParts, todayParts,
  type DateFieldError, type DateFieldKind,
} from '@klass/shared';
import { usePopover } from '../lib/popover';
import { Icon, icons } from './Nav';

export interface DateTimeFieldProps {
  kind: DateFieldKind;
  /** каноническое значение: `YYYY-MM-DD` / `YYYY-MM-DDTHH:mm` / `''` */
  value: string;
  onChange: (value: string) => void;
  id?: string;
  testid?: string;
  label?: string;
  required?: boolean;
  disabled?: boolean;
  style?: CSSProperties;
}

export function DateTimeField({
  kind, value, onChange, id, testid, label, required, disabled, style,
}: DateTimeFieldProps) {
  const { t, i18n } = useTranslation();
  const autoId = useId();
  const inputId = id ?? `dt-${autoId}`;
  const hint = t(kind === 'date' ? 'common.dtFmtDate' : 'common.dtFmtDateTime');
  const errorId = `${inputId}-err`;

  // Пока человек печатает, показываем ЕГО текст: нормализовать на каждый символ — значит воевать
  // с курсором. На выходе (blur без ошибки) поле показывает каноническое значение по формату языка.
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<DateFieldError | null>(null);
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const today = todayParts();
  const parts = readFieldParts(value);
  const [view, setView] = useState(() => ({ year: parts?.year ?? today.year, month: parts?.month ?? today.month }));
  const [focusDay, setFocusDay] = useState<number | null>(null);
  const pop = usePopover({ open, anchor, align: 'start', onClose: () => setOpen(false) });
  const boxRef = useRef<HTMLElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const shown = draft ?? formatDateFieldValue(value, i18n.language, kind);

  function type(text: string) {
    setDraft(text);
    if (!text.trim()) {
      setError(null);
      onChange('');
      return;
    }
    const parsed = parseDateFieldValue(text, kind);
    if (!parsed.ok) {
      setError(parsed.reason === 'empty' ? null : parsed.reason);
      onChange('');
      return;
    }
    setError(null);
    onChange(parsed.value);
  }

  function openCalendar(day: number | null) {
    const p = readFieldParts(value);
    setView({ year: p?.year ?? today.year, month: p?.month ?? today.month });
    setFocusDay(day ?? p?.day ?? today.day);
    setOpen(true);
  }

  function pick(day: number) {
    const next = applyDayPick(value, view.year, view.month, day, kind);
    setDraft(null);
    setError(null);
    onChange(next);
    setOpen(false);
    // после выбора день исчезает из фокуса вместе с меню — возвращаем его в поле, где человек
    // правит время (или просто видит результат)
    inputRef.current?.focus();
  }

  /**
   * Первый день при открытии берёт фокус через `autoFocus` (React отдаёт его при монтировании).
   * Здесь — только случаи, когда кнопка УЖЕ в дереве и перемонтирования нет: стрелки сетки и
   * переход в другой месяц. Без этого флага эффект воевал бы с фокусом при каждом открытии.
   */
  const [wantFocus, setWantFocus] = useState(false);
  useEffect(() => {
    if (!open || !wantFocus) return;
    setWantFocus(false);
    boxRef.current?.querySelector<HTMLElement>(`[data-day="${focusDay ?? -1}"]`)?.focus();
  }, [open, wantFocus, focusDay, view]);

  /** ←/→ — день, ↑/↓ — неделя, Home/End — край недели, PageUp/PageDown — месяц. */
  function onGridKey(e: KeyboardEvent<HTMLDivElement>) {
    const cells = monthCells(view.year, view.month);
    const cur = focusDay !== null ? cells.indexOf(focusDay) : -1;
    const move = (index: number) => {
      const day = cells[index];
      if (day === null || day === undefined) return false;
      setFocusDay(day);
      setWantFocus(true);
      return true;
    };
    const shiftMonth = (delta: number) => {
      const next = addMonths(view.year, view.month, delta);
      const last = monthCells(next.year, next.month).filter((d) => d !== null).length;
      setView(next);
      setFocusDay(Math.min(focusDay ?? today.day, last));
      setWantFocus(true);
    };
    if (cur < 0) {
      setFocusDay(focusDay ?? today.day);
      return;
    }
    const steps: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 7, ArrowUp: -7 };
    if (e.key in steps) {
      e.preventDefault();
      if (!move(cur + steps[e.key]!)) shiftMonth(e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : -1);
      return;
    }
    if (e.key === 'Home') { e.preventDefault(); move(cur - (cur % 7)); return; }
    if (e.key === 'End') { e.preventDefault(); move(cur + (6 - (cur % 7))); return; }
    if (e.key === 'PageUp') { e.preventDefault(); shiftMonth(-1); return; }
    if (e.key === 'PageDown') { e.preventDefault(); shiftMonth(1); }
  }

  const errText = error === 'format' ? t('common.dtErrFormat')
    : error === 'day' ? t('common.dtErrDay')
      : error === 'time' ? t('common.dtErrTime') : '';

  const cells = monthCells(view.year, view.month);
  const isToday = (day: number) => day === today.day && view.month === today.month && view.year === today.year;
  const isSelected = (day: number) => parts !== null && parts.day === day && parts.month === view.month && parts.year === view.year;

  return (
    <div className="dt-field" style={style}>
      {label && <label htmlFor={inputId} style={{ margin: 0 }}>{label}</label>}
      <div className="dt-row">
        <input
          id={inputId}
          ref={inputRef}
          data-testid={testid}
          type="text"
          inputMode="text"
          autoComplete="off"
          disabled={disabled}
          placeholder={hint}
          value={shown}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          aria-required={required || undefined}
          onChange={(e) => type(e.target.value)}
          onBlur={() => { if (!error) setDraft(null); }}
          onFocus={() => setDraft(null)}
        />
        <button
          type="button"
          className="ghost dt-open"
          data-testid={testid ? `${testid}-open` : undefined}
          aria-label={t('common.dtCalendar')}
          aria-haspopup="dialog"
          aria-expanded={open}
          disabled={disabled}
          style={{ marginTop: 0 }}
          onClick={(e) => { setAnchor(e.currentTarget); if (open) setOpen(false); else openCalendar(parts?.day ?? null); }}
        >
          <Icon d={icons.calendar} size={18} />
        </button>
      </div>
      <p className="muted dt-hint">{hint}</p>
      {error && (
        <p className="error dt-error" id={errorId} role="alert" data-testid={testid ? `${testid}-error` : undefined}>
          {errText}
        </p>
      )}
      {open && (
        <div
          className="card dt-pop"
          role="dialog"
          aria-modal="false"
          data-dt-popover
          aria-label={monthLabel(view.year, view.month, i18n.language)}
          ref={(node) => { pop.ref(node); boxRef.current = node; }}
          style={pop.style}
        >
          <div className="dt-head">
            <button type="button" className="ghost" style={{ marginTop: 0 }} aria-label={t('common.dtPrevMonth')}
              onClick={() => setView(addMonths(view.year, view.month, -1))}>‹</button>
            <span className="dt-title">{monthLabel(view.year, view.month, i18n.language)}</span>
            <button type="button" className="ghost" style={{ marginTop: 0 }} aria-label={t('common.dtNextMonth')}
              onClick={() => setView(addMonths(view.year, view.month, 1))}>›</button>
          </div>
          <div className="dt-grid dt-dows" aria-hidden>
            {dayNamesShort(i18n.language).map((d) => <span key={d} className="dt-dow">{d}</span>)}
          </div>
          <div className="dt-grid" role="grid" onKeyDown={onGridKey}>
            {cells.map((day, i) => day === null
              ? <span key={`e${i}`} className="dt-cell is-empty" />
              : (
                <button
                  key={day}
                  type="button"
                  role="gridcell"
                  data-day={day}
                  data-dt-focus={day === focusDay || undefined}
                  autoFocus={day === focusDay}
                  className={`dt-cell${isSelected(day) ? ' is-sel' : ''}${isToday(day) ? ' is-today' : ''}`}
                  aria-label={dayLabel(view.year, view.month, day, i18n.language)}
                  aria-current={isToday(day) ? 'date' : undefined}
                  onClick={() => pick(day)}
                >
                  {day}
                </button>
              ))}
          </div>
          <button type="button" className="secondary dt-today" style={{ marginTop: 8 }} data-testid={testid ? `${testid}-today` : undefined}
            onClick={() => { const now = todayParts(); setView({ year: now.year, month: now.month }); pick(now.day); }}>
            {t('common.dtToday')}
          </button>
        </div>
      )}
    </div>
  );
}
