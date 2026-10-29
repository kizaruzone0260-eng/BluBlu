import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword } from '../../src/lib/password';

describe('argon2id passwords (§3.1)', () => {
  it('round-trips and rejects wrong password', async () => {
    const hash = await hashPassword('Sükro123!пароль');
    expect(hash).toMatch(/^\$argon2id\$/);
    expect(await verifyPassword(hash, 'Sükro123!пароль')).toBe(true);
    expect(await verifyPassword(hash, 'wrong')).toBe(false);
  });

  it('handles empty/garbage stored hash safely', async () => {
    expect(await verifyPassword('not-a-hash', 'x')).toBe(false);
  });

  /*
   * SEC-14 (аудит 2026-10-28). `argon2.verify` берёт m/t/p из строки хеша, поэтому фиктивная
   * проверка «нет такого аккаунта» обязана идти с ТЕМИ ЖЕ параметрами, что настоящая: иначе
   * после перенастройки env промах отвечал бы быстрее, чем существующий аккаунт с неверным
   * паролем, — то есть снова выдавал бы наличие аккаунта по времени.
   */
  it('the dummy hash is generated with the same parameters as real password hashes', async () => {
    const { dummyPasswordHash } = await import('../../src/services/auth.js');
    const params = (h: string) => h.split('$')[3]; // m=…,t=…,p=…
    const dummy = await dummyPasswordHash();
    const real = await hashPassword('SomeRealPassword1');
    expect(dummy).toMatch(/^\$argon2id\$/);
    expect(params(dummy)).toBe(params(real));
    // выдаётся один раз на процесс и не является известным литералом
    expect(await dummyPasswordHash()).toBe(dummy);
    expect(await verifyPassword(dummy, 'password')).toBe(false);
  });
});
