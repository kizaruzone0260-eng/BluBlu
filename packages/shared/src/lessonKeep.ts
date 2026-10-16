/**
 * Часть A (2026-10-16): «урок не прерывается при переходах».
 *
 * Здесь только ТИХАЯ ЛОГИКА без React и без браузера — то, что можно проверить юнит-тестом и что
 * нельзя вывести из состояния страницы: срок жизни метки возврата, совпадение урока, арифметика
 * таймера мини-окна и удержание окна внутри вьюпорта. Сама комната, сокет и устройства живут в
 * `apps/web` (`pages/Lesson.tsx`), потому что они не существуют вне браузера.
 */

/** Сколько минут метка возврата считает «человек ещё в уроке». */
export const REJOIN_TTL_MS = 120_000;
/** Ключ sessionStorage. Никаких секретов: идентификатор урока, класс/событие и метка времени. */
export const SS_REJOIN = 'blublu.rejoin';
/** Позиция мини-окна (тоже sessionStorage: это про это окно браузера, а не про человека). */
export const SS_MINI = 'blublu.mini';
/** Размер мини-окна для расчёта границ (css `--mini-w`/`--mini-h` в styles.css, здесь та же пара). */
export const MINI_W = 268;
export const MINI_H = 184;

export interface RejoinMark {
  sessionId: string;
  eventId: string | null;
  classId: string;
  /** `Date.now()` на момент успешного входа в комнату */
  at: number;
}

export interface LessonRef {
  eventId?: string | null;
  classId?: string | null;
}

/** Метка ещё жива: не будущая, не просроченная, и у неё есть урок. */
export function isRejoinFresh(mark: RejoinMark | null | undefined, now: number, ttl: number = REJOIN_TTL_MS): boolean {
  if (!mark || typeof mark.at !== 'number' || !Number.isFinite(mark.at)) return false;
  if (!mark.sessionId) return false;
  if (mark.at > now) return false;          // часы разошлись — это не «только что вышел»
  return now - mark.at <= ttl;
}

/** Тот ли это урок. Сверка по параметрам адреса: вход по событию ищется по событию, вход по классу — по классу. */
export function sameLesson(mark: RejoinMark | null | undefined, ref: LessonRef): boolean {
  if (!mark) return false;
  if (ref.eventId) return mark.eventId === ref.eventId;
  return Boolean(ref.classId) && mark.classId === ref.classId;
}

/** Разбор сохранённой метки: мусор, отсутствующие поля и чужая форма → null, а не исключение. */
export function parseRejoin(raw: string | null | undefined): RejoinMark | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as Partial<RejoinMark>;
    if (typeof o.sessionId !== 'string' || !o.sessionId) return null;
    if (typeof o.at !== 'number' || !Number.isFinite(o.at)) return null;
    if (typeof o.classId !== 'string' || !o.classId) return null;
    return { sessionId: o.sessionId, classId: o.classId, eventId: o.eventId ?? null, at: o.at };
  } catch {
    return null;
  }
}

/** Сколько урок идёт, в миллисекундах; никогда не отрицательное (часы браузера ≠ часы сервера). */
export function lessonElapsedMs(startedAtIso: string | null | undefined, nowMs: number): number {
  if (!startedAtIso) return 0;
  const started = Date.parse(startedAtIso);
  if (!Number.isFinite(started)) return 0;
  return Math.max(0, nowMs - started);
}

/** Таймер мини-окна: `мм:чс`, после часа — `ч:мм:чс`. */
export function formatElapsed(ms: number): string {
  const total = Math.floor(Math.max(0, ms) / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

export interface MiniPos { x: number; y: number }

/**
 * Мини-окно обязано остаться внутри вьюпорта: человек может перетащить его за край, а на телефоне
 * вьюпорт сужается при повороте. Отрицательные размеры (окно меньше окна) не размазываются в NaN.
 */
export function clampMiniPos(pos: MiniPos, vw: number, vh: number, w: number = MINI_W, h: number = MINI_H): MiniPos {
  const maxX = Math.max(0, vw - w);
  const maxY = Math.max(0, vh - h);
  const nx = Math.min(Math.max(0, Number.isFinite(pos.x) ? pos.x : 0), maxX);
  const ny = Math.min(Math.max(0, Number.isFinite(pos.y) ? pos.y : 0), maxY);
  return { x: Math.round(nx), y: Math.round(ny) };
}

/** Разбор сохранённой позиции; то же правило: мусор → значение по умолчанию. */
export function parseMiniPos(raw: string | null | undefined, dflt: MiniPos): MiniPos {
  if (!raw) return dflt;
  try {
    const o = JSON.parse(raw) as Partial<MiniPos>;
    if (typeof o.x !== 'number' || typeof o.y !== 'number') return dflt;
    return { x: o.x, y: o.y };
  } catch {
    return dflt;
  }
}

/**
 * LiveKit отказывает второму окну с тем же `identity` («you are already the owner of this
 * identity»). Это не «нет устройства» и не «сервер недоступен»: человеку нужно сказать, что урок
 * уже открыт рядом, а не показывать сырое сообщение SDK.
 */
export function isDuplicateIdentityError(e: unknown): boolean {
  const msg = (e as { message?: string })?.message ?? '';
  return /already the owner of this identity|duplicate identity/i.test(msg);
}
