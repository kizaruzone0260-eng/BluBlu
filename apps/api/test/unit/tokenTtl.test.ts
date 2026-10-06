/**
 * Part 4а — LiveKit lesson-token TTL helpers. Proves the unit grammar
 * ('6h'/'90m'/'45s'/bare-seconds) and the production floor (never < 2 h).
 */
import { describe, it, expect } from 'vitest';
import { ttlSeconds, effectiveTokenTtl } from '../../src/lib/tokenTtl.js';

describe('tokenTtl (Part 4а)', () => {
  it('parses the TTL grammar into whole seconds', () => {
    expect(ttlSeconds('6h')).toBe(6 * 3600);
    expect(ttlSeconds('90m')).toBe(90 * 60);
    expect(ttlSeconds('45s')).toBe(45);
    expect(ttlSeconds('2d')).toBe(2 * 86400);
    expect(ttlSeconds('120')).toBe(120); // bare number ⇒ seconds
    expect(ttlSeconds('  3h ')).toBe(3 * 3600); // tolerant of whitespace
    expect(ttlSeconds(3600)).toBe(3600); // numeric input passes through
  });

  it('returns 0 for anything it cannot understand', () => {
    expect(ttlSeconds('')).toBe(0);
    expect(ttlSeconds('soon')).toBe(0);
    expect(ttlSeconds('1w')).toBe(0); // unsupported unit
    expect(ttlSeconds(-5)).toBe(0);
    expect(ttlSeconds('NaN')).toBe(0);
  });

  it('floors the PRODUCTION TTL at 2 h but never touches it', () => {
    expect(effectiveTokenTtl('1h', 'production')).toBe('2h');
    expect(effectiveTokenTtl('90m', 'production')).toBe('2h');
    expect(effectiveTokenTtl('30m', 'production')).toBe('2h');
    expect(effectiveTokenTtl('2h', 'production')).toBe('2h'); // exactly at the floor
    expect(effectiveTokenTtl('6h', 'production')).toBe('6h'); // above the floor
    expect(effectiveTokenTtl('3h', 'production')).toBe('3h');
  });

  it('returns the configured value verbatim OUTSIDE production', () => {
    // so the tests can dial a tiny TTL to simulate a lesson outliving it
    expect(effectiveTokenTtl('1s', 'development')).toBe('1s');
    expect(effectiveTokenTtl('5m', 'test')).toBe('5m');
  });

  it('the shipped default (6 h) is comfortably above the 2 h prod floor', () => {
    expect(ttlSeconds('6h')).toBeGreaterThanOrEqual(2 * 3600);
  });
});
