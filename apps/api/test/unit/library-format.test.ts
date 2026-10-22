/**
 * The library's pure logic, without Telegram or Postgres.
 *
 * These are the guarantees the teacher is told about in the UI, so they belong in a test that
 * cannot be skipped by a missing database:
 *  • the local formatter composes only what the teacher wrote — her own instruction, the
 *    titles she chose, the messages she sent — in HER language, and it invents nothing;
 *  • a file suggestion never invents content, and a file without a name gets an honest label;
 *  • the text table has all three product languages and none of them empty;
 *  • the provider object carries no "read this file" capability at all.
 */
import { describe, it, expect } from 'vitest';
import { LOCAL_AI, localFormat, makeHomeworkAi } from '../../src/services/homework/ai.js';
import { suggestMaterialTitle } from '../../src/services/homework/library.js';
import { H, h, kindLabel, materialKindLabel } from '../../src/services/homework/texts.js';
import { MAX_EDIT_TEXT, MAX_MATERIAL_TITLE } from '../../src/services/homework/constants.js';
import type { HwAiRequest, HwLang } from '../../src/services/homework/types.js';

const PDF_BYTES = 'JVBERi0xLjUKJcOkw7zDtsOfCg'; // the first line of a real PDF, as it would look base64'd

function request(part: Partial<HwAiRequest> = {}): HwAiRequest {
  return {
    lang: 'ru' as HwLang,
    instruction: '',
    items: [],
    materials: [],
    ...part,
  };
}

describe('the local formatter with library materials', () => {
  it('writes the teacher’s instruction and the titles she chose, in her language', async () => {
    const res = await LOCAL_AI.format(request({
      instruction: 'Unit 2, Exercises 1–5.',
      materials: [{ title: 'English Grammar in Use', kind: 'book', fileName: 'egau.pdf' }],
    }));
    expect(res.status).toBe('ok');
    expect(res.formatted).toContain('ДОМАШНЕЕ ЗАДАНИЕ');
    expect(res.formatted).toContain('Материал: English Grammar in Use');
    expect(res.formatted).toContain('Задание:\nUnit 2, Exercises 1–5.');
    expect(res.title).toBe('Unit 2, Exercises 1–5.');
    // nothing appeared that the teacher did not write
    expect(res.formatted).not.toMatch(/страниц|дедлайн|до [0-9]/i);
    expect(res.questions).toEqual([]);
  });

  it('lists several materials and keeps their order', () => {
    const res = localFormat(request({
      instruction: 'Pages 24–27',
      materials: [
        { title: 'Book One', kind: 'book', fileName: 'one.pdf' },
        { title: 'Workbook Two', kind: 'workbook', fileName: 'two.docx' },
      ],
    }));
    expect(res.formatted).toContain('Материалы:\n• Book One\n• Workbook Two');
    expect(res.formatted.indexOf('Book One')).toBeLessThan(res.formatted.indexOf('Workbook Two'));
  });

  it('is the same shape in Uzbek and English — the teacher’s own language wins', () => {
    const uz = localFormat(request({
      lang: 'uz', instruction: 'Unit 2', materials: [{ title: 'Grammar', kind: 'book', fileName: 'g.pdf' }],
    }));
    expect(uz.formatted).toContain('UY VAZIFASI');
    expect(uz.formatted).toContain('Material: Grammar');
    expect(uz.formatted).toContain('Vazifa:');
    const en = localFormat(request({
      lang: 'en', instruction: 'Unit 2', materials: [{ title: 'Grammar', kind: 'book', fileName: 'g.pdf' }],
    }));
    expect(en.formatted).toContain('HOMEWORK');
    expect(en.formatted).toContain('Material: Grammar');
    expect(en.formatted).toContain('Task:');
  });

  it('warns that attachments go out unread, and only when there are attachments', () => {
    const withFile = localFormat(request({
      instruction: 'Unit 1',
      materials: [{ title: 'Cambridge IELTS 18', kind: 'book', fileName: 'ielts18.pdf' }],
    }));
    const warning = withFile.warnings.join(' ');
    expect(warning).toContain('содержимое не анализируется');
    expect(warning).toContain('Cambridge IELTS 18');

    const textOnly = localFormat(request({ items: [{
      id: '1', kind: 'text', text: 'Прочитать параграф 5', url: '', fileName: '',
      mimeType: '', caption: '', forwarded: false,
    }] }));
    expect(textOnly.warnings).toEqual([]);
  });

  it('never puts a byte of a file into the request it is given', () => {
    const req = request({
      instruction: 'Unit 9',
      materials: [{ title: 'A book', kind: 'book', fileName: 'book.pdf' }],
      items: [{
        id: '2', kind: 'document', text: '', url: '', fileName: 'book.pdf',
        mimeType: 'application/pdf', caption: '', forwarded: false,
      }],
    });
    const wire = JSON.stringify(req);
    expect(wire).not.toContain(PDF_BYTES);
    expect(wire).not.toContain('bytes');
    expect(Object.keys(req).sort()).toEqual(['instruction', 'items', 'lang', 'materials']);
    // and the local formatter's own output cannot be longer than the edit limit
    expect(localFormat(request({ instruction: 'x'.repeat(9_000) })).formatted.length)
      .toBeLessThanOrEqual(MAX_EDIT_TEXT);
  });

  it('exposes no file-reading capability on either provider', () => {
    // `none` is the default in tests: one method, format(). No vision, no download, no parser.
    expect(Object.keys(makeHomeworkAi())).toEqual(['format']);
    expect(Object.keys(LOCAL_AI)).toEqual(['format']);
  });
});

describe('naming an uploaded file', () => {
  it('takes the file name without its extension and cleans it up', () => {
    // underscores and plus signs are file-name noise; hyphens are part of a title
    expect(suggestMaterialTitle('English_Grammar_in_Use-5th_edition.pdf', false, 'ru'))
      .toBe('English Grammar in Use-5th edition');
    expect(suggestMaterialTitle('C:\\books\\IELTS 18.docx', false, 'en'))
      .toBe('IELTS 18');
  });

  it('gives an honest dated label when Telegram sent no name', () => {
    const now = new Date('2026-10-22T10:00:00Z');
    expect(suggestMaterialTitle('', true, 'ru', now)).toBe('Фото 2026-10-22');
    expect(suggestMaterialTitle('', false, 'uz', now)).toBe('Hujjat 2026-10-22');
    expect(suggestMaterialTitle('', false, 'en', now)).toBe('Document 2026-10-22');
  });

  it('caps a suggested title at the editable limit', () => {
    expect(suggestMaterialTitle(`${'a'.repeat(300)}.pdf`, false, 'ru').length)
      .toBe(MAX_MATERIAL_TITLE);
  });

  it('labels material types in all three languages', () => {
    for (const lang of ['ru', 'uz', 'en'] as const) {
      expect(materialKindLabel('book', lang)).not.toBe('');
      expect(materialKindLabel('workbook', lang)).not.toBe('');
      expect(materialKindLabel('other', lang)).not.toBe('');
    }
    expect(kindLabel('document', 'ru')).toBe('документ');
  });
});

describe('the homework text table', () => {
  it('has all three languages for every key, and none of them empty', () => {
    const keys = Object.keys(H);
    expect(keys.length).toBeGreaterThan(100);
    for (const key of keys) {
      const entry = H[key as keyof typeof H];
      for (const lang of ['ru', 'uz', 'en'] as const) {
        expect(entry[lang], `${key}.${lang}`).toBeTruthy();
        expect(typeof entry[lang]).toBe('string');
      }
    }
  });

  it('substitutes every placeholder it declares', () => {
    expect(h('libSaved', 'ru', { t: 'Book', g: 'IELTS B2' })).toContain('Book');
    expect(h('libSaved', 'ru', { t: 'Book', g: 'IELTS B2' })).toContain('IELTS B2');
    expect(h('fileUnavailable', 'ru', { m: 'Book' })).not.toContain('%{');
    expect(h('previewAttachmentFor', 'en', { g: 'B2', a: 'Book: Book One' })).toBe('📎 “B2” — Book: Book One');
  });

  it('says the library is never read by the AI — in the teacher’s own language', () => {
    expect(h('libraryHint', 'ru')).toContain('не анализируется');
    expect(h('libAskFile', 'ru', { n: 20 })).toContain('PDF');
    expect(h('fileUnavailable', 'ru', { m: 'X' })).toContain('Ничего не опубликовано');
  });
});
