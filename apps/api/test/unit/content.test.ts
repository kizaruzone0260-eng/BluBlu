import { describe, it, expect } from 'vitest';
import { noteHasContent, notePlainText } from '@klass/shared';

describe('note emptiness (§2 shared rule)', () => {
  it('title alone or body text alone is content', () => {
    expect(noteHasContent('Тема', '')).toBe(true);
    expect(noteHasContent('', '<p>текст</p>')).toBe(true);
  });

  it('whitespace / empty tags are NOT content', () => {
    expect(noteHasContent('', '')).toBe(false);
    expect(noteHasContent('   ', '')).toBe(false);
    expect(noteHasContent('', '<p></p>')).toBe(false);
    expect(noteHasContent(' \n\t ', '<p>&nbsp;</p><p>   </p>')).toBe(false);
  });

  it('a drawing with ≥1 stroke IS content even without text', () => {
    const enc = encodeURIComponent(JSON.stringify({ strokes: [{ c: '#000', w: 2, pts: [[0, 0], [5, 5]] }] }));
    expect(noteHasContent('', `<div class="note-drawing" data-note-drawing="${enc}"></div>`)).toBe(true);
    const empty = encodeURIComponent(JSON.stringify({ strokes: [] }));
    expect(noteHasContent('', `<div class="note-drawing" data-note-drawing="${empty}"></div>`)).toBe(false);
    expect(noteHasContent('', '<div class="note-drawing" data-note-drawing="garbage"></div>')).toBe(false);
  });

  it('notePlainText strips tags and entities', () => {
    expect(notePlainText('<h2>Привет&nbsp;мир</h2><p>x</p>')).toBe('Привет мир x');
  });
});
