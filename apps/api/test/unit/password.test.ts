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
});
