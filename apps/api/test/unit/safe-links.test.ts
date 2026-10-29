/**
 * SEC-22 (аудит 2026-10-28): ссылка-вложение не должна вести браузер ученика в петлю или
 * link-local. Сервер эти адреса не запрашивает никогда (отдельная проба в phase1-xss), но
 * сохранённый `http://127.0.0.1:…` открывает уже ЧЕЛОВЕК, и с его компьютера это локальная сеть
 * или метаданные облака.
 *
 * Проверка одна на API и форму (`@klass/shared::links`) — здесь она и проверяется, чтобы обе
 * стороны не разъехались. WHATWG-парсер нормализует десятичную/шестнадцатеричную запись IPv4,
 * поэтому тесты бьют и по ней: «2130706433» — это 127.0.0.1, а не безобидное имя.
 */
import { describe, it, expect } from 'vitest';
import { safeExternalUrl, classifyAttachmentUrl } from '@klass/shared';

const rejected = [
  'http://127.0.0.1:80/',
  'http://127.8.9.10/',
  'http://2130706433/', // 127.0.0.1 в десятичной записи
  'http://0x7f000001/', // она же в шестнадцатеричной
  'http://127.1/', // короткая запись
  'http://0.0.0.0/',
  'http://0.1.2.3/',
  'http://169.254.169.254/latest/meta-data',
  'http://169.254.0.1/',
  'http://[::1]/',
  'http://[::ffff:127.0.0.1]/',
  'http://localhost./', // хвостовая точка не превращает петлю в другое имя
  'http://app.localhost./', // спека резолвит *.localhost в петлю без DNS
];

describe('safeExternalUrl: что вообще может стать ссылкой', () => {
  it('принимает абсолютный http(s) с точкой в хосте и обрезает пробелы', () => {
    expect(safeExternalUrl('https://example.com/a?b=1')).toBe('https://example.com/a?b=1');
    expect(safeExternalUrl('  https://example.com/a  ')).toBe('https://example.com/a');
    expect(safeExternalUrl('http://8.8.8.8/')).toBe('http://8.8.8.8/');
    expect(safeExternalUrl('https://m.youtube.com/watch?v=x')).toBe('https://m.youtube.com/watch?v=x');
  });

  it('отклоняет всё, что не абсолютный http(s) или не имеет хоста с точкой', () => {
    for (const bad of [
      'javascript:alert(1)', 'data:text/html,<script>', 'file:///etc/passwd', 'ftp://example.com/x',
      '//example.com/x', 'example.com', 'http://localhost:9/admin', 'http://intranet/',
    ]) {
      expect(safeExternalUrl(bad), bad).toBeNull();
    }
  });

  it('SEC-22: отклоняет литеральную петлю, «эту сеть» и link-local', () => {
    for (const bad of rejected) {
      expect(safeExternalUrl(bad), `${bad} не должен становиться ссылкой`).toBeNull();
    }
  });

  it('длина результата ограничена 2000 знаками', () => {
    const long = `https://example.com/${'a'.repeat(3000)}`;
    expect(safeExternalUrl(long)).toHaveLength(2000);
  });
});

describe('classifyAttachmentUrl: вид ссылки', () => {
  it('узнаёт YouTube и Google Drive, остальное — обычная ссылка', () => {
    expect(classifyAttachmentUrl('https://youtu.be/dQw4w9WgXcQ')).toBe('youtube');
    expect(classifyAttachmentUrl('https://www.youtube.com/watch?v=x')).toBe('youtube');
    expect(classifyAttachmentUrl('https://m.youtube.com/watch?v=x')).toBe('youtube');
    expect(classifyAttachmentUrl('https://drive.google.com/file/d/1/view')).toBe('drive');
    expect(classifyAttachmentUrl('https://docs.google.com/document/d/1')).toBe('drive');
    expect(classifyAttachmentUrl('https://wikipedia.org')).toBe('link');
    expect(classifyAttachmentUrl('не url')).toBe('link');
  });
});
