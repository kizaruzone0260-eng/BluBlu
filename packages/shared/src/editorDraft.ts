/**
 * Часть E (2026-10-16): черновик текстового редактора. ЧИСТЫЕ правила, без React и без DOM —
 * хранилище передаётся аргументом, поэтому же эти правила проверяются тестом.
 *
 * Зачем: редактор текста (tiptap/ProseMirror) был контролируемым — значение ходило по кругу
 * «печать → состояние страницы → рендер → обратная запись в документ». На медленной машине
 * окно между нажатием и эхом больше, и обратная запись возвращала документ назад: последние
 * символы терялись (это и был красный zz24 под CPU ×4). Дальше чинить гонку бессмысленно —
 * надо убрать класс: редактор неконтролируем, он принимает значение от родителя ТОЛЬКО когда
 * сменился идентификатор документа, а набранное немедленно пишется в черновик и отдельно,
 * с дебаунсом, уходит на сервер.
 *
 * Черновик — это не «копия для отладки», а единственный место, где живут ненабранные на сервер
 * символы. Поэтому: свой ключ на документ, срок хранения, и ясное правило, что делать при
 * открытии, когда сервер успел уехать вперёд (другая вкладка, другой человек).
 */

/** Префикс ключа в localStorage: отличим от данных приложения одним взглядом. */
export const DRAFT_PREFIX = 'klass.draft';
/** Черновик старше недели — уже не «неотправленное», а мусор забытой вкладки. */
export const DRAFT_TTL_MS = 7 * 24 * 3600_000;
/** Пустой документ tiptap; с ним сравниваем «есть ли что сохранять». */
export const EMPTY_DOC = '<p></p>';

export interface Draft {
  html: string;
  /** когда набрано (Date.now() в браузере) */
  at: number;
  /** версия серверной копии на момент набора; 0 = версия неизвестна */
  rev: number;
}

export const draftKey = (scope: string, docId: string): string => `${DRAFT_PREFIX}.${scope}.${docId}`;

/** Читает черновик из чего угодно, что умеет `getItem`. Мусор и просроченное — это «нет черновика». */
export function parseDraft(raw: string | null | undefined, now = Date.now()): Draft | null {
  if (!raw) return null;
  let v: unknown;
  try { v = JSON.parse(raw); } catch { return null; }
  if (!v || typeof v !== 'object') return null;
  const o = v as Partial<Draft>;
  if (typeof o.html !== 'string' || typeof o.at !== 'number' || !Number.isFinite(o.at)) return null;
  const rev = typeof o.rev === 'number' && Number.isFinite(o.rev) ? o.rev : 0;
  if (now - o.at > DRAFT_TTL_MS) return null;
  return { html: o.html, at: o.at, rev };
}

export const serializeDraft = (d: Draft): string => JSON.stringify({ html: d.html, at: d.at, rev: d.rev });

/** Есть ли в черновике что-то, кроме пустого документа. */
export function draftHasContent(d: Draft | null): boolean {
  return !!d && d.html !== EMPTY_DOC && d.html.trim() !== '';
}

export interface OpenDecision {
  /** чем initialize'ить документ */
  html: string;
  /** победил черновик (страница обязана показать это человеку) */
  usedDraft: boolean;
  /** черновик, который НЕ применён, но и не стёрт: сервер свежее */
  kept: Draft | null;
  /** сервер и черновик равны ⇒ черновик не нужен */
  drop: boolean;
}

/**
 * Что делать при открытии документа.
 *
 *  - черновика нет / он пуст ⇒ серверное значение;
 *  - черновик равен серверу ⇒ черновик убираем (он уже сохранён, копить его смысла нет);
 *  - сервер точно новее (`serverRev > draft.rev`) ⇒ показываем сервер, а локальный текст НЕ
 *    выбрасываем: он возвращается как `kept`, и страница предложит его человеку. Молча
 *    затереть чужие абзацы — худшее, что может сделать редактор;
 *  - во всех остальных случаях (включая «версия сервера неизвестна», rev = 0) побеждает
 *    черновик: это то, что человек набрал и что ещё не ушло на сервер.
 */
export function decideOnOpen(args: { serverHtml: string; serverRev: number; draft: Draft | null }): OpenDecision {
  const { serverHtml, serverRev, draft } = args;
  const server = serverHtml || EMPTY_DOC;
  if (!draftHasContent(draft)) return { html: server, usedDraft: false, kept: null, drop: true };
  const d = draft as Draft;
  if (d.html === server) return { html: server, usedDraft: false, kept: null, drop: true };
  if (d.rev > 0 && serverRev > d.rev) {
    return { html: server, usedDraft: false, kept: d, drop: false };
  }
  return { html: d.html, usedDraft: true, kept: null, drop: false };
}

/** Отправлять ли на сервер это значение (то же, что уже отправлено, — не отправляем). */
export function shouldSend(next: string, lastSent: string | null): boolean {
  return lastSent === null || next !== lastSent;
}
