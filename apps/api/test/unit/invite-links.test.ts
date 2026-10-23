/**
 * Юниты одноразовых ссылок-приглашений (задача 2026-10-23, §8).
 *
 * Всё, что можно проверить без сервера и без браузера: форма токена, его хеширование, разбор
 * фрагмента URL, сборка публичной ссылки, коды состояний и политика пароля — в том числе для
 * сброса учителем. Интеграция (`test/integration/invite-links.test.ts`) проверяет поведение
 * маршрутов, а здесь проверяются правила, на которых они стоят.
 */
import { describe, it, expect } from 'vitest';
import {
  generateInviteToken, hashInviteToken, looksLikeInviteToken,
} from '../../src/lib/inviteLink.js';
import { hashInviteCode } from '../../src/lib/invite.js';
import { tempPassword } from '../../src/lib/password.js';
import {
  INVITE_TOKEN_BYTES, INVITE_TOKEN_LENGTH, isInviteToken, parseInviteToken, inviteUrlFor,
  INVITE_LINK_TTL_DAYS, INVITE_LINK_DEFAULT_TTL_DAYS, INVITE_LABEL_MAX,
  inviteLinkCreateSchema, inviteRegisterSchema, invitePreviewSchema, memberResetPasswordSchema,
  passwordPolicy, passwordIssueCode, AUTH_ERROR_CODES, isAuthErrorCode,
} from '@klass/shared';
import { inviteStateCode } from '../../src/services/invites.js';

const BASE64URL = /^[A-Za-z0-9_-]+$/;

describe('токен приглашения: генерация', () => {
  it('32 символа base64url из 24 байт и проходит собственную проверку формы', () => {
    const token = generateInviteToken();
    expect(token.length).toBe(INVITE_TOKEN_LENGTH);
    expect(INVITE_TOKEN_LENGTH).toBe(INVITE_TOKEN_BYTES * 4 / 3); // 24 байта → 32 знака без паддинга
    expect(BASE64URL.test(token)).toBe(true);
    expect(token, 'символов ordinary-base64 (`+`, `/`, `=`) тут быть не должно').toMatch(/^[^+/=]*$/);
    expect(isInviteToken(token)).toBe(true);
    expect(looksLikeInviteToken(token)).toBe(true);
    expect(parseInviteToken(token)).toBe(token);
  });

  it('значения не повторяются и не предсказуемы по соседству', () => {
    const seen = new Set(Array.from({ length: 500 }, () => generateInviteToken()));
    expect(seen.size).toBe(500);
    const a = generateInviteToken();
    const b = generateInviteToken();
    expect(a.slice(0, 8)).not.toBe(b.slice(0, 8));
  });
});

describe('токен приглашения: хеширование', () => {
  const PEPPER = 'test-pepper';
  it('детерминировано, не обратимо и длиной ровно в sha256-hex', () => {
    const token = generateInviteToken();
    const h = hashInviteToken(token, PEPPER);
    expect(h).toBe(hashInviteToken(token, PEPPER));
    expect(h.length).toBe(64);
    expect(/^[0-9a-f]{64}$/.test(h)).toBe(true);
    expect(h).not.toContain(token);
  });

  it('pepper меняет хеш: база без секрета бесполезна', () => {
    const token = generateInviteToken();
    expect(hashInviteToken(token, 'a')).not.toBe(hashInviteToken(token, 'b'));
  });

  /** Доменная разметка — то, из-за чего ссылка и код живут в ОДНОЙ таблице. */
  it('ветка `link.` никогда не совпадает с веткой `code.` на одном входе', () => {
    const value = 'AbCdEf1234567890AbCdEf1234567890';
    expect(hashInviteToken(value, PEPPER)).not.toBe(hashInviteCode(value, PEPPER));
    // и наоборот: код класса не читается как токен ссылки
    const code = 'ABCDEF12';
    expect(hashInviteCode(code, PEPPER)).not.toBe(hashInviteToken(code, PEPPER));
  });
});

describe('разбор фрагмента и сборка URL', () => {
  it('`#` и пробелы съедаются, всё остальное — null', () => {
    const token = generateInviteToken();
    expect(parseInviteToken(`#${token}`)).toBe(token);
    expect(parseInviteToken(token)).toBe(token);
    expect(parseInviteToken(`  #${token}  `)).toBe(token);
    const bad = ['', null, undefined, '#', 'short', 'a'.repeat(31), 'a'.repeat(33),
      `${token}?x=1`, `${token}/`, 'a'.repeat(31) + '=', 'a'.repeat(31) + '+', 'a'.repeat(31) + '/',
      'a'.repeat(31) + ' '];
    for (const value of bad) {
      expect(parseInviteToken(value as string | null), `принимаем на вход «${JSON.stringify(value)}»`).toBeNull();
    }
  });

  /** Токен живёт в фрагменте: сервер его не видит, и в `?` ему делать нечего. */
  it('ссылка строится как <база>/join#<токен>, без слэша-дубля и без query', () => {
    const token = generateInviteToken();
    expect(inviteUrlFor('https://school.example', token)).toBe(`https://school.example/join#${token}`);
    expect(inviteUrlFor('https://school.example/', token), 'хвостовой слэш в PUBLIC_URL — норма').toBe(`https://school.example/join#${token}`);
    expect(inviteUrlFor('  https://school.example///  ', token)).toBe(`https://school.example/join#${token}`);
    const url = inviteUrlFor('https://school.example', token);
    expect(url).not.toContain(`?token=`);
    expect(new URL(url).search, 'в query нет ничего, что могло бы попасть в access-лог').toBe('');
    expect(new URL(url).hash).toBe(`#${token}`);
  });
});

describe('схемы приглашения', () => {
  it('срок — только 1, 7 или 30, по умолчанию неделя; подпись ограничена и необязательна', () => {
    expect(INVITE_LINK_TTL_DAYS).toEqual([1, 7, 30]);
    expect(INVITE_LINK_DEFAULT_TTL_DAYS).toBe(7);
    expect(inviteLinkCreateSchema.parse({}).ttlDays).toBe(7);
    expect(inviteLinkCreateSchema.parse({ label: 'Aziza', ttlDays: 30 })).toEqual({ label: 'Aziza', ttlDays: 30 });
    for (const ttl of [0, 2, 8, 31, -1, 7.5]) {
      expect(inviteLinkCreateSchema.safeParse({ ttlDays: ttl }).success, `ttl=${ttl}`).toBe(false);
    }
    expect(inviteLinkCreateSchema.safeParse({ label: 'x'.repeat(INVITE_LABEL_MAX + 1) }).success).toBe(false);
    expect(inviteLinkCreateSchema.safeParse({ label: 'x'.repeat(INVITE_LABEL_MAX) }).success).toBe(true);
  });

  it('предпросмотр и вход требуют токена правильной формы', () => {
    expect(invitePreviewSchema.safeParse({ token: 'nope' }).success).toBe(false);
    expect(invitePreviewSchema.safeParse({}).success).toBe(false);
    const token = generateInviteToken();
    expect(invitePreviewSchema.parse({ token, extraIgnored: 1 }).token).toBe(token);
    expect(isInviteToken(token)).toBe(true);
  });

  it('регистрация по ссылке собирает имя, фамилию, почту и пароль — и НИКОГДА не код из письма', () => {
    const token = generateInviteToken();
    const ok = inviteRegisterSchema.safeParse({
      token, firstName: 'Aziza', lastName: 'Karimova', email: 'a@b.io', password: 'PupilPass2026', locale: 'uz',
    });
    expect(ok.success, JSON.stringify(ok.error?.issues)).toBe(true);
    // поля класса в запросе ученика нет: класс знает сервер по токену
    expect(Object.keys(inviteRegisterSchema.shape)).toEqual(['token', 'firstName', 'lastName', 'email', 'password', 'locale']);
    expect('emailCode' in inviteRegisterSchema.shape, 'подтверждение почты не включено и не должно всплыть здесь').toBe(false);
    for (const body of [
      { token, firstName: 'A', lastName: 'Karimova', email: 'a@b.io', password: 'PupilPass2026' },
      { token, firstName: 'Aziza', lastName: 'K', email: 'a@b.io', password: 'PupilPass2026' },
      { token, firstName: 'Aziza', lastName: 'Karimova', email: 'not-an-email', password: 'PupilPass2026' },
      { token, firstName: 'Aziza', lastName: 'Karimova', email: 'a@b.io', password: 'short' },
    ]) {
      expect(inviteRegisterSchema.safeParse(body).success, JSON.stringify(body)).toBe(false);
    }
  });
});

describe('коды состояний токена', () => {
  it('четыре плохих состояния называются по отдельности и все есть в словаре кодов', () => {
    const codes = (['invalid', 'expired', 'revoked', 'used'] as const).map((s) => inviteStateCode(s));
    expect(new Set(codes).size, 'состояния не схлопываются в один ответ').toBe(4);
    for (const code of codes) {
      expect(isAuthErrorCode(code)).toBe(true);
      expect(AUTH_ERROR_CODES).toContain(code);
    }
    expect(inviteStateCode('invalid')).toBe('inviteInvalid');
    expect(inviteStateCode('expired')).toBe('inviteExpired');
    expect(inviteStateCode('revoked')).toBe('inviteRevoked');
    expect(inviteStateCode('used')).toBe('inviteUsed');
  });

  it('«уже участник» и «сервис недоступен» тоже известные коды', () => {
    for (const code of ['alreadyMember', 'registrationUnavailable'] as const) {
      expect(isAuthErrorCode(code)).toBe(true);
    }
  });
});

describe('политика пароля при сбросе учителем (часть C)', () => {
  it('десять знаков, буквы, без пробелов и без ходовых паролей', () => {
    expect(passwordPolicy.safeParse('12345678').success, 'самый популярный пароль запрещён').toBe(false);
    expect(passwordPolicy.safeParse('password').success).toBe(false);
    expect(passwordPolicy.safeParse('Ab1').success).toBe(false);
    expect(passwordPolicy.safeParse('short1234').success).toBe(false);
    expect(passwordPolicy.safeParse('PupilTemp2026').success).toBe(true);
    expect(passwordPolicy.safeParse('пароль Ученика 2026').success, 'последнее слово без буквы — отказ').toBe(false);
    // сгенерированный сервером пароль обязан проходить ту же проверку
    for (let i = 0; i < 20; i++) {
      expect(passwordPolicy.safeParse(tempPassword()).success, 'tempPassword не должен родить слабый пароль').toBe(true);
    }
  });

  it('сброс принимает пароль учителя, но не обязан его принимать: без поля работает прежняя генерация', () => {
    expect(memberResetPasswordSchema.parse({})).toEqual({});
    expect(memberResetPasswordSchema.parse({ password: 'PupilTemp2026' }).password).toBe('PupilTemp2026');
    expect(memberResetPasswordSchema.safeParse({ password: '12345678' }).success).toBe(false);
    expect(memberResetPasswordSchema.safeParse({ password: '' }).success).toBe(false);
  });

  it('расшифровка отказа одна на все маршруты, и чужая причина не выдумывается', () => {
    const issuesOf = (value: string) => {
      const r = passwordPolicy.safeParse(value);
      return r.success ? undefined : r.error.issues[0];
    };
    expect(passwordIssueCode(issuesOf('Ab1'))).toBe('passwordTooShort');
    expect(passwordIssueCode(issuesOf('password123'))).toBe('passwordTooCommon');
    // «1234567890» есть в списке ходовых, но до списка схема не доходит: сначала форма
    // (нет ни одной буквы), и это правильный порядок — про пароли человек слышит одну причину
    expect(passwordIssueCode(issuesOf('1234567890'))).toBe('passwordTooSimple');
    expect(passwordIssueCode(issuesOf('qwertyuiop 1'))).toBe('passwordTooSimple');
    expect(passwordIssueCode(issuesOf('x'.repeat(200)))).toBeNull();
    expect(passwordIssueCode(undefined)).toBeNull();
  });
});
