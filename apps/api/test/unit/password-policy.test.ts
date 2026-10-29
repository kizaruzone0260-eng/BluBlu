/**
 * SEC-12 (аудит 2026-10-28): политика пароля требует ДВА вида символов из четырёх.
 *
 * Прежнее правило («≥10, хотя бы одна строчная буква, без пробелов») пропускало `aaaaaaaaaa` —
 * именно этот пример назван в аудите. Здесь зафиксировано, что одноалфавитные строки больше не
 * проходят, что классы считаются по Unicode (пароль на кириллице не отвергается из-за алфавита),
 * что пробел не может изображать «второй вид», и что список ходовых паролей по-прежнему
 * проверяется ПОСЛЕ формы — иначе «password123» объяснялся бы не той причиной.
 *
 * Вход существующих аккаунтов этим не затрагивается: `loginPassword` политику не применяет,
 * поэтому пароли, созданные до ужесточения, продолжают работать до смены.
 */
import { describe, it, expect } from 'vitest';
import { passwordClassCount, passwordIssueCode, passwordPolicy } from '@klass/shared';

const code = (value: string) => {
  const r = passwordPolicy.safeParse(value);
  return r.success ? null : passwordIssueCode(r.error.issues[0]);
};

describe('passwordPolicy: два вида символов (SEC-12)', () => {
  it('отклоняет одноалфавитные строки, даже когда прежняя форма их пропускала', () => {
    for (const weak of ['aaaaaaaaaa', 'ZZZZZZZZZZ', '1234567890', '!!!!!!!!!!', 'парольпароль']) {
      expect(code(weak), weak).toBe('passwordTooSimple');
    }
  });

  it('пропускает любые два класса: строчные+цифры, заглавные+цифры, строчные+заглавные, знаки', () => {
    for (const ok of [
      'aaaaaaaaa1', // строчные + цифры
      'AAAAAAAAA1', // заглавные + цифры
      'aaaaaaaaaA', // строчные + заглавные
      'aaaaaaaaa!', // строчные + знаки
      'Пароль2026', // кириллица: классы по Unicode, не по ASCII
      'PupilTemp2026',
      'Pupil2026!',
    ]) {
      expect(code(ok), ok).toBeNull();
    }
  });

  it('пробел не считается вторым видом и вообще запрещён', () => {
    expect(code('Passw0rd 1')).toBe('passwordTooSimple');
    expect(code('Passw0rd\u00a01')).toBe('passwordTooSimple'); // неразрывный пробел
  });

  it('денлист проверяется после формы и не ослаблен', () => {
    // два вида символов есть, но значение — из списка ходовых
    expect(code('password123')).toBe('passwordTooCommon');
    expect(code('1234567890ab')).toBeNull(); // не в списке и проходит форму
  });

  it('границы длины прежние: 10 знаков — минимум', () => {
    expect(code('Aa1234567')).toBe('passwordTooShort');
    expect(code('Aa12345678')).toBeNull();
    expect(passwordPolicy.safeParse('x'.repeat(129)).success).toBe(false);
  });

  it('passwordClassCount считает четыре независимых класса', () => {
    expect(passwordClassCount('aaaaaaaaaa')).toBe(1);
    expect(passwordClassCount('aaaaaaaaa1')).toBe(2);
    expect(passwordClassCount('Aaaaaaaaa1')).toBe(3);
    expect(passwordClassCount('Aaaaaaaaa1!')).toBe(4);
    expect(passwordClassCount('１２３４５６７８９０')).toBe(1); // полноширинные цифры — один класс
  });
});
