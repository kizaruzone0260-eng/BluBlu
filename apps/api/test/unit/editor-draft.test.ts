import { describe, expect, it } from 'vitest';
import {
  DRAFT_PREFIX, DRAFT_TTL_MS, EMPTY_DOC,
  decideOnOpen, draftHasContent, draftKey, parseDraft, serializeDraft, shouldSend,
  type Draft,
} from '@klass/shared';

/*
 * Часть E (2026-10-16). Правила черновика текстового редактора вынесены в `@klass/shared`
 * именно потому, что они чистые: хранилище и React здесь не нужны, и проверяется СМЫСЛ, а не
 * разметка. Прогон против `apps/e2e/tests/zz24-richtext-race.spec.ts`: тот держит поведение
 * человека (набрал — увидели — сохранилось), а этот держит решения, из которых поведение
 * собирается, и ловит их на машине, где браузер не запускается вовсе.
 */

const NOW = 1_800_000_000_000;
const draft = (html: string, at = NOW, rev = 0): Draft => ({ html, at, rev });
const S = '<p>сервер</p>';
const D = '<p>локальный текст</p>';

describe('ключ и срок черновика', () => {
  it('ключ собирается из области и документа и отличается у разных областей', () => {
    expect(draftKey('note', 'a')).toBe(`${DRAFT_PREFIX}.note.a`);
    expect(draftKey('note', 'a')).not.toBe(draftKey('post', 'a'));
    expect(draftKey('note', 'a')).not.toBe(draftKey('note', 'b'));
  });

  it('срок — неделя, а не «навсегда»', () => {
    expect(DRAFT_TTL_MS).toBe(7 * 24 * 3600_000);
  });
});

describe('parseDraft: мусор — это «черновика нет», а не падение', () => {
  it('пустое, не-JSON и JSON не-объект дают null', () => {
    expect(parseDraft(null, NOW)).toBeNull();
    expect(parseDraft('', NOW)).toBeNull();
    expect(parseDraft('{обрезало', NOW)).toBeNull();
    expect(parseDraft('"строка вместо объекта"', NOW)).toBeNull();
    expect(parseDraft('42', NOW)).toBeNull();
  });

  it('объект без html или без внятного `at` — тоже null', () => {
    expect(parseDraft(JSON.stringify({ at: NOW }), NOW)).toBeNull();
    expect(parseDraft(JSON.stringify({ html: D }), NOW)).toBeNull();
    expect(parseDraft(JSON.stringify({ html: D, at: 'вчера' }), NOW)).toBeNull();
  });

  it('просроченный хотя бы на миллисекунду — null; свежий на миллисекунду — есть', () => {
    expect(parseDraft(serializeDraft(draft(D, NOW - DRAFT_TTL_MS)), NOW + 1)).toBeNull();
    expect(parseDraft(serializeDraft(draft(D, NOW - DRAFT_TTL_MS + 1)), NOW)).not.toBeNull();
  });

  it('отсутствующая или мусорная `rev` читается как 0, а не ломает чтение', () => {
    expect(parseDraft(JSON.stringify({ html: D, at: NOW }), NOW)?.rev).toBe(0);
    expect(parseDraft(JSON.stringify({ html: D, at: NOW, rev: 'q' }), NOW)?.rev).toBe(0);
    expect(parseDraft(JSON.stringify({ html: D, at: NOW, rev: Number.NaN }), NOW)?.rev).toBe(0);
  });

  it('серелизованный черновик читается обратно побайтово по полям', () => {
    const d = draft(D, NOW - 5_000, 123);
    expect(parseDraft(serializeDraft(d), NOW)).toEqual(d);
  });
});

describe('draftHasContent', () => {
  it('пустой документ tiptap и пробелы — это «нечего сохранять»', () => {
    expect(draftHasContent(null)).toBe(false);
    expect(draftHasContent(draft(EMPTY_DOC))).toBe(false);
    expect(draftHasContent(draft(''))).toBe(false);
    expect(draftHasContent(draft('   '))).toBe(false);
    expect(draftHasContent(draft('<p>а</p>'))).toBe(true);
  });
});

describe('decideOnOpen: чем открывать документ', () => {
  it('черновика нет ⇒ серверное значение, ключ убирается', () => {
    expect(decideOnOpen({ serverHtml: S, serverRev: 10, draft: null }))
      .toEqual({ html: S, usedDraft: false, kept: null, drop: true });
  });

  it('пустой черновик не побеждает: открываем сервер и убираем ключ', () => {
    const dec = decideOnOpen({ serverHtml: S, serverRev: 10, draft: draft(EMPTY_DOC) });
    expect(dec.html).toBe(S);
    expect(dec.usedDraft).toBe(false);
    expect(dec.drop).toBe(true);
  });

  it('черновик равен серверу ⇒ он уже сохранён, ключ не нужен', () => {
    const dec = decideOnOpen({ serverHtml: S, serverRev: 10, draft: draft(S, NOW, 10) });
    expect(dec).toEqual({ html: S, usedDraft: false, kept: null, drop: true });
  });

  it('пустое серверное значение читается как пустой документ, а не как «сервер новее»', () => {
    const dec = decideOnOpen({ serverHtml: '', serverRev: 0, draft: draft(D, NOW, 0) });
    expect(dec.html).toBe(D);
    expect(dec.usedDraft).toBe(true);
  });

  it('сервер ДОКАЗАЛ, что новее: показываем сервер, локальный текст сохраняем и отдаём page', () => {
    const d = draft(D, NOW - 60_000, 100);
    const dec = decideOnOpen({ serverHtml: S, serverRev: 200, draft: d });
    expect(dec.html).toBe(S);
    expect(dec.usedDraft).toBe(false);
    expect(dec.drop).toBe(false);
    expect(dec.kept).toEqual(d);
  });

  it('«версия неизвестна» (rev = 0) — сервер никогда не объявляется новым', () => {
    const dec = decideOnOpen({ serverHtml: S, serverRev: 9e15, draft: draft(D, NOW, 0) });
    expect(dec.html).toBe(D);
    expect(dec.usedDraft).toBe(true);
    expect(dec.kept).toBeNull();
  });

  it('равные версии — не «сервер новее»: побеждает локальный текст', () => {
    const dec = decideOnOpen({ serverHtml: S, serverRev: 100, draft: draft(D, NOW, 100) });
    expect(dec.usedDraft).toBe(true);
  });

  /*
   * Отрицательный контроль по главному риску части E: молча затереть абзацы человека — худшее,
   * что может сделать редактор. Перебираем все комбинации «черновик с содержимым отличается от
   * сервера» и требуем, чтобы ни в одной из них черновик не был ВЫБРОСЕН: он либо показан,
   * либо возвращён как `kept`.
   */
  it('ненабранный черновик не выбрасывается ни при какой паре версий', () => {
    const revs = [0, 1, 100];
    for (const draftRev of revs) {
      for (const serverRev of revs) {
        const dec = decideOnOpen({ serverHtml: S, serverRev, draft: draft(D, NOW, draftRev) });
        expect(dec.drop, `draft.rev=${draftRev} server.rev=${serverRev}`).toBe(false);
        const survived = dec.usedDraft || dec.kept !== null;
        expect(survived, `draft.rev=${draftRev} server.rev=${serverRev}`).toBe(true);
        // и ровно один из двух исходов: либо показали, либо сохранили для кнопки
        expect(dec.usedDraft !== (dec.kept !== null), `draft.rev=${draftRev} server.rev=${serverRev}`).toBe(true);
      }
    }
  });
});

describe('shouldSend: на сервер — только то, что ещё не уходило', () => {
  it('первая отдача проходит всегда, повтор — нет', () => {
    expect(shouldSend(D, null)).toBe(true);
    expect(shouldSend(D, D)).toBe(false);
    expect(shouldSend(D, S)).toBe(true);
    expect(shouldSend(EMPTY_DOC, null)).toBe(true);
  });
});
