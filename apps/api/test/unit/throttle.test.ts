import { describe, it, expect } from 'vitest';
import { throttleCheck, throttleRecordAttempt, throttleReset } from '../../src/lib/throttle';

describe('code entry throttle (§3.2: ≤5/min, then 15 min block)', () => {
  it('blocks after 5 attempts and releases after 15 minutes', () => {
    const key = 'test-ip';
    const t0 = 1_000_000_000_000;
    for (let i = 0; i < 4; i++) {
      throttleRecordAttempt(key, t0);
      expect(throttleCheck(key, t0).allowed).toBe(true);
    }
    throttleRecordAttempt(key, t0); // 5th attempt trips the block
    expect(throttleCheck(key, t0).allowed).toBe(false);
    // still blocked 14 minutes later
    expect(throttleCheck(key, t0 + 14 * 60_000).allowed).toBe(false);
    // released after 15 minutes
    expect(throttleCheck(key, t0 + 16 * 60_000).allowed).toBe(true);
  });

  it('window resets after a minute when under the limit', () => {
    const key = 'ip2';
    const t0 = Date.now();
    throttleRecordAttempt(key, t0);
    throttleRecordAttempt(key, t0);
    expect(throttleCheck(key, t0 + 61_000).allowed).toBe(true);
    throttleRecordAttempt(key, t0 + 61_000);
    expect(throttleCheck(key, t0 + 61_000).allowed).toBe(true);
  });

  it('reset clears state (successful redemption)', () => {
    const key = 'ip3';
    const t0 = Date.now();
    for (let i = 0; i < 5; i++) throttleRecordAttempt(key, t0);
    expect(throttleCheck(key, t0).allowed).toBe(false);
    throttleReset(key);
    expect(throttleCheck(key, t0).allowed).toBe(true);
  });
});
