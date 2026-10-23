/**
 * Task B (2026-10-23) — the contract behind «every auth error says something useful».
 *
 * A class registering behind one school IP used to be refused by the per-IP limiter, and the
 * refusal reached the screen as the string «Too Many Requests» — not a code, therefore not
 * translatable, therefore the generic «Something went wrong». The guard below is what keeps that
 * from coming back: every code the API is allowed to answer with must have a sentence in all
 * three languages, and a code it must NOT answer with (a library's own text, a driver's word)
 * must be folded to one that does.
 */
import { describe, it, expect } from 'vitest';
import { AUTH_ERROR_CODES, authErrorKey, isAuthErrorCode, CLIENT_ERROR_CODES } from '@klass/shared';
import { shouldSuggestBrowser, isLikelyWebView, cookiesUsable } from '@klass/shared';
import ru from '@klass/shared/locales/ru.json';
import uz from '@klass/shared/locales/uz.json';
import en from '@klass/shared/locales/en.json';
import { errorBody, newRequestId, REQUEST_ID_PATTERN } from '../../src/lib/requestId.js';
import { throttleCheck, throttleRecordAttempt, throttleReset } from '../../src/lib/throttle.js';

const DICTS = { ru, uz, en } as const;

describe('auth error vocabulary is translatable in all three languages', () => {
  it('every server auth code has a non-empty auth.* value in ru, uz and en', () => {
    for (const code of AUTH_ERROR_CODES) {
      for (const lang of ['ru', 'uz', 'en'] as const) {
        const value = (DICTS[lang] as Record<string, Record<string, string>>).auth[code];
        expect(value, `${lang}.auth.${code}`).toBeTruthy();
        expect(String(value).trim().length, `${lang}.auth.${code} is too short to help`).toBeGreaterThan(12);
      }
    }
  });

  it('the client-only codes are translated too', () => {
    for (const code of CLIENT_ERROR_CODES) {
      for (const lang of ['ru', 'uz', 'en'] as const) {
        expect((DICTS[lang] as Record<string, Record<string, string>>).auth[code], `${lang}.auth.${code}`).toBeTruthy();
      }
    }
  });

  it('an unknown code falls back to a key that exists, never to a bare string', () => {
    expect(authErrorKey('Too Many Requests')).toBe('auth.invalidInput');
    expect(authErrorKey('invalidCode')).toBe('auth.invalidCode');
    expect(isAuthErrorCode('connection refused')).toBe(false);
    expect(isAuthErrorCode('emailTaken')).toBe(true);
  });

  it('«email taken» does not state that an account exists, and offers signing in', () => {
    // the sentence is a condition («если вы уже регистрировались»), and the screen next to it
    // renders the sign-in link — asserted here on the wording, in the e2e/manual list on the UI
    for (const lang of ['ru', 'uz', 'en'] as const) {
      const text = String((DICTS[lang] as Record<string, Record<string, string>>).auth.emailTaken).toLowerCase();
      expect(text).not.toContain('already registered');
      expect(text).not.toContain('уже зарегистрирован');
    }
  });
});

describe('request id (the code a pupil can send)', () => {
  it('is 10 characters from a read-aloud alphabet and carries no personal data', () => {
    for (let i = 0; i < 200; i++) {
      const id = newRequestId();
      expect(REQUEST_ID_PATTERN.test(id), id).toBe(true);
      expect(id).not.toMatch(/[ilo]/); // never confused with 1/0/L when dictated
    }
  });

  it('every error body built through the helper has the id next to the code', () => {
    expect(errorBody('abc', 'invalidCode')).toEqual({ error: 'invalidCode', reqId: 'abc' });
    expect(errorBody(undefined, 'serverError').reqId).toBe('');
  });
});

describe('throttle keys are per credential, not per building', () => {
  const base = 1_000_000_000_000;
  it('five failures on ONE credential block that credential, and nothing else', () => {
    const a = 'cc:10.0.0.1:AAAA1111';
    const b = 'cc:10.0.0.1:BBBB2222';
    for (let i = 0; i < 5; i++) throttleRecordAttempt(a, base);
    expect(throttleCheck(a, base).allowed).toBe(false);
    expect(throttleCheck(a, base).retryAfterSec).toBeGreaterThan(0);
    expect(throttleCheck(b, base).allowed).toBe(true); // the next pupil is not guilty
    throttleReset(a);
    expect(throttleCheck(a, base).allowed).toBe(true);
  });

  it('the ceiling is configurable per key, so an address-wide counter can be looser', () => {
    const key = 'af:10.0.0.2';
    for (let i = 0; i < 5; i++) throttleRecordAttempt(key, base + i, 20);
    expect(throttleCheck(key, base + 5).allowed).toBe(true); // 5 of 20
    for (let i = 6; i <= 20; i++) throttleRecordAttempt(key, base + i, 20);
    expect(throttleCheck(key, base + 21).allowed).toBe(false);
    throttleReset(key);
  });
});

describe('in-app browser hint', () => {
  it('names the WebViews pupils actually arrive from, and a plain browser is left alone', () => {
    expect(isLikelyWebView('Mozilla/5.0 (iPhone) Telegram/9.9.0')).toBe(true);
    expect(isLikelyWebView('Mozilla/5.0 ... Instagram/250.0')).toBe(true);
    expect(isLikelyWebView('Mozilla/5.0 (Windows NT 10.0) Chrome/130')).toBe(false);
    expect(isLikelyWebView('')).toBe(false);
  });

  /** A cookie jar small enough to test: write honours `max-age=0` as an expiry. */
  function jar(initial = '') {
    const store = { value: initial };
    return {
      read: () => store.value,
      write: (next: string) => {
        const [pair = ''] = next.split(';');
        const name = pair.split('=')[0] ?? '';
        const expires = /max-age=0/.test(next);
        const rest = store.value.split('; ').filter((p) => p && p.split('=')[0] !== name);
        if (!expires && pair) rest.push(pair);
        store.value = rest.join('; ');
      },
    };
  }

  it('asks only when cookies really will not survive', () => {
    const keeping = jar();
    expect(cookiesUsable(keeping.read, keeping.write)).toBe(true);
    const refusing = { read: () => '', write: () => undefined };
    expect(cookiesUsable(refusing.read, refusing.write)).toBe(false);

    const inTelegram = { userAgent: 'Mozilla/5.0 (iPhone) Telegram/9.9.0' };
    expect(shouldSuggestBrowser({ ...inTelegram, cookieEnabled: false, read: () => '', write: () => undefined })).toBe(true);
    const working = jar();
    expect(shouldSuggestBrowser({ ...inTelegram, cookieEnabled: true, read: working.read, write: working.write })).toBe(false);
    // a real browser that will not keep cookies is not this hint's business — advice would be wrong
    expect(shouldSuggestBrowser({ userAgent: 'Chrome/130', cookieEnabled: false, read: () => '', write: () => undefined })).toBe(false);
  });
});
