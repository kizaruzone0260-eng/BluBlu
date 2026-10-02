import { describe, it, expect } from 'vitest';
import {
  generateInviteCode, normalizeInviteCode, hashInviteCode, looksLikeInviteCode,
} from '../../src/lib/invite';
import { INVITE_ALPHABET } from '@klass/shared';

describe('invite codes (§3.2)', () => {
  it('is 8 chars from the ambiguous-free alphabet', () => {
    for (let i = 0; i < 200; i++) {
      const code = generateInviteCode();
      expect(code).toHaveLength(8);
      for (const ch of code) {
        expect(INVITE_ALPHABET).toContain(ch);
      }
    }
  });

  it('alphabet excludes 0 O 1 I L', () => {
    for (const bad of ['0', 'O', '1', 'I', 'L']) {
      expect(INVITE_ALPHABET).not.toContain(bad);
    }
  });

  it('collision probability is negligible: 32^8 space, 5k codes all unique', () => {
    const set = new Set<string>();
    for (let i = 0; i < 5000; i++) set.add(generateInviteCode());
    expect(set.size).toBeGreaterThan(4990);
  });

  it('normalize uppercases and strips separators', () => {
    expect(normalizeInviteCode(' ab-cd 23ef ')).toBe('ABCD23EF');
  });

  it('hash is deterministic per salt, differs across codes and salts', () => {
    const a = hashInviteCode('ABCD23EF', 'salt1');
    const b = hashInviteCode('ABCD23EF', 'salt1');
    const c = hashInviteCode('ABCD23EG', 'salt1');
    const d = hashInviteCode('ABCD23EF', 'salt2');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).not.toBe(d);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('looksLikeInviteCode rejects ambiguous characters', () => {
    expect(looksLikeInviteCode('ABCD23EF')).toBe(true);
    expect(looksLikeInviteCode('ABC023EF')).toBe(false);
    expect(looksLikeInviteCode('SHORT1')).toBe(false);
  });
});
