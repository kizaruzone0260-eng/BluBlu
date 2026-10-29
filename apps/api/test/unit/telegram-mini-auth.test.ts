/**
 * Task F: the Mini App launch is the ONLY trust boundary between Telegram and BluBlu.
 *
 * These are the properties that make it a boundary rather than a hint:
 *  • the signature covers the decoded, sorted `key=value` lines with `hash` excluded — exactly
 *    the string Telegram signs; a single changed byte anywhere invalidates it;
 *  • the comparison is constant-time and the hash must be 64 hex characters;
 *  • `auth_date` older than a day (Telegram's own recommendation) or meaningfully in the future
 *    is refused, so a captured initData cannot be replayed forever;
 *  • the Telegram user is read from the SIGNED payload, only from there;
 *  • the session minted for the Mini App is signed with a DIFFERENT derived key and carries
 *    `aud`/`scope`, so it is neither accepted by the regular API nor by a forged cookie token.
 */
import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { SignJWT } from 'jose';
import {
  INIT_DATA_FUTURE_SKEW_SEC, INIT_DATA_MAX_AGE_SEC,
  MINI_SESSION_TTL_SEC, dataCheckString, miniSessionExpiresAt,
  signMiniToken, verifyMiniToken, verifyTelegramInitData,
} from '../../src/lib/telegramMiniAuth.js';
import { signAccessToken, verifyAccessToken } from '../../src/lib/tokens.js';
import { env } from '../../src/env.js';

const BOT_TOKEN = '7000000001:unit-test-bot-token';
const USER = { id: 555_000_111, first_name: 'Азиза', username: 'aziza_t', language_code: 'uz' };
const NOW = new Date('2026-10-28T12:00:00Z');

/**
 * An independent signer (the test must not build its signature with the code under test):
 * decoded values, sorted by key, `hash` last and excluded from the check string.
 */
function signInitData(fields: Record<string, string>, token = BOT_TOKEN): string {
  const check = Object.keys(fields)
    .filter((k) => k !== 'hash')
    .sort()
    .map((k) => `${k}=${fields[k]}`)
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  const hash = createHmac('sha256', secret).update(check).digest('hex');
  const params = new URLSearchParams({ ...fields, hash });
  return params.toString();
}

const seconds = (d: Date) => String(Math.floor(d.getTime() / 1000));

function validFields(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    auth_date: seconds(NOW),
    query_id: 'AAH-test-query',
    user: JSON.stringify(USER),
    ...overrides,
  };
}

describe('Telegram initData verification', () => {
  it('accepts a launch signed with the bot token and reads the user from the signed payload', () => {
    const raw = signInitData(validFields());
    const r = verifyTelegramInitData(raw, { botToken: BOT_TOKEN, now: NOW });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.user.id).toBe(USER.id);
    expect(r.data.user.first_name).toBe('Азиза');
    expect(r.data.authDate.toISOString()).toBe(NOW.toISOString());
    expect(r.data.queryId).toBe('AAH-test-query');
    expect(r.data.inlineMode).toBe(false);
  });

  it('flags a launch from the inline/attachment menu without weakening the signature check', () => {
    const raw = signInitData(validFields({ chat_type: 'inline', chat_instance: '42' }));
    const r = verifyTelegramInitData(raw, { botToken: BOT_TOKEN, now: NOW });
    expect(r.ok && r.data.inlineMode).toBe(true);
  });

  it('refuses every tampering: changed value, changed user, another bot token, broken hash', () => {
    const raw = signInitData(validFields());
    const params = new URLSearchParams(raw);

    const changedValue = new URLSearchParams(params);
    changedValue.set('auth_date', String(Number(params.get('auth_date')) - 5));
    expect(verifyTelegramInitData(changedValue.toString(), { botToken: BOT_TOKEN, now: NOW }))
      .toEqual({ ok: false, error: 'initDataHashInvalid' });

    const changedUser = new URLSearchParams(params);
    changedUser.set('user', JSON.stringify({ ...USER, id: 1 }));
    expect(verifyTelegramInitData(changedUser.toString(), { botToken: BOT_TOKEN, now: NOW }))
      .toEqual({ ok: false, error: 'initDataHashInvalid' });

    expect(verifyTelegramInitData(raw, { botToken: '7000000002:other-token', now: NOW }))
      .toEqual({ ok: false, error: 'initDataHashInvalid' });

    const notHex = new URLSearchParams(params);
    notHex.set('hash', 'z'.repeat(64));
    expect(verifyTelegramInitData(notHex.toString(), { botToken: BOT_TOKEN, now: NOW }))
      .toEqual({ ok: false, error: 'initDataHashInvalid' });

    const noHash = new URLSearchParams(params);
    noHash.delete('hash');
    expect(verifyTelegramInitData(noHash.toString(), { botToken: BOT_TOKEN, now: NOW }))
      .toEqual({ ok: false, error: 'initDataHashMissing' });
  });

  it('refuses a stale launch and one from the far future, and accepts the boundary cases', () => {
    const stale = signInitData(validFields({
      auth_date: seconds(new Date(NOW.getTime() - (INIT_DATA_MAX_AGE_SEC + 1) * 1000)),
    }));
    expect(verifyTelegramInitData(stale, { botToken: BOT_TOKEN, now: NOW }))
      .toEqual({ ok: false, error: 'initDataExpired' });

    const future = signInitData(validFields({
      auth_date: seconds(new Date(NOW.getTime() + (INIT_DATA_FUTURE_SKEW_SEC + 1) * 1000)),
    }));
    expect(verifyTelegramInitData(future, { botToken: BOT_TOKEN, now: NOW }))
      .toEqual({ ok: false, error: 'initDataFromFuture' });

    // A device clock a few minutes ahead must not lock the teacher out.
    const slightlyAhead = signInitData(validFields({
      auth_date: seconds(new Date(NOW.getTime() + 4 * 60 * 1000)),
    }));
    expect(verifyTelegramInitData(slightlyAhead, { botToken: BOT_TOKEN, now: NOW }).ok).toBe(true);

    // Exactly 24h old is still a launch; the recommendation is "no longer than a day".
    const exactlyADay = signInitData(validFields({
      auth_date: seconds(new Date(NOW.getTime() - INIT_DATA_MAX_AGE_SEC * 1000)),
    }));
    expect(verifyTelegramInitData(exactlyADay, { botToken: BOT_TOKEN, now: NOW }).ok).toBe(true);
  });

  it('requires a valid signed Telegram user: none, broken JSON, non-numeric or bot ids', () => {
    for (const user of [
      undefined,
      'not-json{',
      JSON.stringify({ first_name: 'no id' }),
      JSON.stringify({ id: String(USER.id) }),
      JSON.stringify({ id: 1.5 }),
      JSON.stringify({ id: 0 }),
      JSON.stringify({ id: -7 }),
      JSON.stringify({ id: 999, is_bot: true }),
    ]) {
      const fields = validFields();
      if (user === undefined) delete fields.user;
      else fields.user = user;
      const raw = signInitData(fields);
      expect(verifyTelegramInitData(raw, { botToken: BOT_TOKEN, now: NOW }), String(user))
        .toEqual({ ok: false, error: 'initDataUserMissing' });
    }
  });

  it('answers missing/malformed for an empty launch, a missing auth_date and duplicate keys', () => {
    expect(verifyTelegramInitData('   ', { botToken: BOT_TOKEN, now: NOW }))
      .toEqual({ ok: false, error: 'initDataMissing' });

    const fields = validFields();
    delete fields.auth_date;
    expect(verifyTelegramInitData(signInitData(fields), { botToken: BOT_TOKEN, now: NOW }))
      .toEqual({ ok: false, error: 'initDataMalformed' });

    const duplicate = `${signInitData(validFields())}&auth_date=1`;
    expect(verifyTelegramInitData(duplicate, { botToken: BOT_TOKEN, now: NOW }))
      .toEqual({ ok: false, error: 'initDataMalformed' });
  });
});

describe('dataCheckString', () => {
  it('sorts by key, decodes values and never includes the hash', () => {
    const params = new URLSearchParams('b=two%20words&a=%D0%B0&hash=deadbeef');
    expect(dataCheckString(params)).toBe('a=а\nb=two words');
  });

  it('rejects a repeated key instead of picking one of the two values', () => {
    expect(() => dataCheckString(new URLSearchParams('a=1&a=2&hash=x')))
      .toThrow('duplicate initData key');
  });
});

describe('Mini App session token', () => {
  it('round-trips the signed teacher claims', async () => {
    const token = await signMiniToken({
      sub: '11111111-1111-4111-8111-111111111111', role: 'teacher', locale: 'uz', tg: USER.id,
    });
    expect(await verifyMiniToken(token)).toEqual({
      sub: '11111111-1111-4111-8111-111111111111',
      role: 'teacher',
      locale: 'uz',
      tg: USER.id,
    });
  });

  it('is not a regular access token and does not accept one', async () => {
    const mini = await signMiniToken({
      sub: '11111111-1111-4111-8111-111111111111', role: 'teacher', locale: 'ru', tg: 42,
    });
    expect(await verifyAccessToken(mini)).toBeNull();

    const regular = await signAccessToken({
      sub: '11111111-1111-4111-8111-111111111111', role: 'teacher', locale: 'ru',
    });
    expect(await verifyMiniToken(regular)).toBeNull();
  });

  it('refuses a token forged with the plain JWT secret, even with the right shape', async () => {
    const forged = await new SignJWT({ role: 'teacher', locale: 'ru', tg: 42, scope: 'mini' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('11111111-1111-4111-8111-111111111111')
      .setAudience('blublu-mini')
      .setIssuedAt()
      .setExpirationTime('8h')
      .sign(new TextEncoder().encode(env.JWT_SECRET));
    expect(await verifyMiniToken(forged)).toBeNull();
  });

  it('mints an 8-hour expiry from the same constant', () => {
    const expires = miniSessionExpiresAt(NOW);
    expect(new Date(expires).getTime() - NOW.getTime()).toBe(MINI_SESSION_TTL_SEC * 1000);
  });
});
