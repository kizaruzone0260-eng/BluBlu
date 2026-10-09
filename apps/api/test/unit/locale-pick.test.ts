/**
 * Language precedence (task 1, 2026-10-09).
 *
 * The symptom was not a missing translation but an ORDER: the profile (which said 'ru' for
 * every account, because registration never carried a choice) was applied over everything at
 * login. These tests pin the target order — profile-if-chosen > this device > English — and the
 * product default itself, so nobody can quietly reintroduce a Russian fallback.
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_LOCALE, SUPPORTED_LOCALES, resolveLocale, shouldCarryStoredChoice,
} from '@klass/shared';

describe('language default and precedence (task 1)', () => {
  it('the product default is English', () => {
    expect(DEFAULT_LOCALE).toBe('en');
    expect(SUPPORTED_LOCALES).toContain(DEFAULT_LOCALE);
  });

  it('a visitor with no profile and no stored choice gets English', () => {
    expect(resolveLocale({})).toBe('en');
    expect(resolveLocale({ profileLocale: 'ru', profileExplicit: false })).toBe('en');
  });

  it('a profile nobody chose does NOT override the device', () => {
    // this is the exact regression: `users.locale` was 'ru' by default and won anyway
    expect(resolveLocale({ profileLocale: 'ru', profileExplicit: false, storedLocale: 'uz' })).toBe('uz');
    expect(resolveLocale({ profileLocale: 'ru', profileExplicit: null, storedLocale: 'en' })).toBe('en');
  });

  it('a profile that WAS chosen wins over the device', () => {
    expect(resolveLocale({ profileLocale: 'uz', profileExplicit: true, storedLocale: 'ru' })).toBe('uz');
    expect(resolveLocale({ profileLocale: 'en', profileExplicit: true, storedLocale: 'ru' })).toBe('en');
    // and on a device with no choice of its own the profile is the only source
    expect(resolveLocale({ profileLocale: 'uz', profileExplicit: true })).toBe('uz');
  });

  it('an unknown or corrupt value falls back to the default instead of breaking the UI', () => {
    expect(resolveLocale({ storedLocale: 'de' })).toBe('en');
    expect(resolveLocale({ profileLocale: 'de', profileExplicit: true, storedLocale: 'uz' })).toBe('uz');
    expect(resolveLocale({ profileLocale: 'de', profileExplicit: true })).toBe('en');
  });

  it('a device choice is carried into the account only while the account has none', () => {
    expect(shouldCarryStoredChoice({ profileLocale: 'ru', profileExplicit: false, storedLocale: 'uz' })).toBe(true);
    // nothing to carry when the account already says the same thing — otherwise every login
    // would PATCH and re-mark the profile
    expect(shouldCarryStoredChoice({ profileLocale: 'uz', profileExplicit: false, storedLocale: 'uz' })).toBe(false);
    expect(shouldCarryStoredChoice({ profileLocale: 'ru', profileExplicit: true, storedLocale: 'uz' })).toBe(false);
    expect(shouldCarryStoredChoice({ profileLocale: 'ru', profileExplicit: false })).toBe(false);
  });
});
