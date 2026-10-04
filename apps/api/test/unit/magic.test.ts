import { describe, it, expect } from 'vitest';
import { detectFileType, isInlineSafe } from '../../src/lib/magic.js';

const pdf = Buffer.from('%PDF-1.7 ...');
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0]);
const exe = Buffer.from([0x4d, 0x5a, 0x90, 0x00]); // MZ — disguised as .pdf
const id3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(10)]);
const ftypMp4 = Buffer.concat([Buffer.from([0, 0, 0, 32]), Buffer.from('ftyp'), Buffer.from('isom'), Buffer.alloc(20)]);
const ftypM4a = Buffer.concat([Buffer.from([0, 0, 0, 32]), Buffer.from('ftyp'), Buffer.from('M4A '), Buffer.alloc(20)]);

describe('magic bytes (§3.3)', () => {
  it('accepts by content', () => {
    expect(detectFileType(pdf, 'doc.pdf').group).toBe('pdf');
    expect(detectFileType(png, 'pic.png').group).toBe('image');
    expect(detectFileType(jpg, 'pic.jpg').group).toBe('image');
    expect(detectFileType(zip, 'doc.docx')).toMatchObject({ group: 'office', ext: 'docx' });
    expect(detectFileType(id3, 'sound.mp3').group).toBe('audio');
    expect(detectFileType(ftypMp4, 'lesson.mp4').group).toBe('video');
    expect(detectFileType(ftypM4a, 'audio.m4a').group).toBe('audio');
  });

  it('rejects a disguised executable (.pdf that is PE)', () => {
    expect(detectFileType(exe, 'invoice.pdf').group).toBe('unknown');
    expect(detectFileType(exe, 'evil.exe').group).toBe('unknown');
  });

  it('rejects generic zip without office extension (no svg/html/exe smuggling)', () => {
    expect(detectFileType(zip, 'payload.zip').group).toBe('unknown');
    expect(detectFileType(zip, 'x.html').group).toBe('unknown');
  });

  it('accepts printable text .txt, rejects NUL-containing', () => {
    expect(detectFileType(Buffer.from('Privet, BluBlu!'), 'notes.txt').group).toBe('text');
    expect(detectFileType(Buffer.from('ab\0cd'), 'bad.txt').group).toBe('unknown');
  });

  it('inline preview policy: media/pdf/text inline-safe, office not', () => {
    expect(isInlineSafe('application/pdf')).toBe(true);
    expect(isInlineSafe('video/mp4')).toBe(true);
    expect(isInlineSafe('application/vnd.openxmlformats-officedocument.wordprocessingml.document')).toBe(false);
    expect(isInlineSafe('image/svg+xml')).toBe(false);
  });
});
