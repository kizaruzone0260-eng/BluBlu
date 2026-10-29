/**
 * Задача 2026-10-28, часть 3 — чистые правила гостевой ссылки.
 *
 * Здесь только то, что можно доказать без базы и без медиа-сервера:
 *  • форма токена (43 символа base64url = 256 бит) и разбор фрагмента — та же арифметика, что у
 *    приглашений в класс, и та же причина хранить токен во фрагменте, а не в query;
 *  • токен не восстанавливается из хеша, а ключ гостя привязан к ссылке (одинаковый ключ в двух
 *    ссылках даёт разные хеши — иначе заявка одного урока читалась бы в другом);
 *  • порядок состояний двери: закончившийся урок важнее отзыва, отзыв важнее срока. Это контракт
 *    ответов `guestLinkState`/`effectiveGuestState`, и в интеграционных тестах он проверяется
 *    снаружи — здесь же видно, почему именно такой порядок.
 */
import { describe, it, expect } from 'vitest';
import {
  GUEST_NAME_MAX, GUEST_PATH, GUEST_TOKEN_KEY, GUEST_TOKEN_LENGTH,
  consumeGuestToken, guestUrlFor, isGuestKey, isGuestPath, isGuestToken, parseGuestToken,
  readGuestToken, takeGuestToken,
} from '@klass/shared';
import { generateGuestToken, hashGuestKey, hashGuestToken } from '../../src/lib/guestLink.js';
import { effectiveGuestState, guestLinkState } from '../../src/services/lessonGuests.js';

const PEPPER = 'test-secret-test-secret-test-secret-0123456789';

/** Та же проверка формы, что у ключа гостя в продукте: браузер генерирует 32 байта base64url. */
const key = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');

describe('токен гостевой ссылки: форма и разбор', () => {
  it('32 случайных байта → 43 символа base64url, и они не повторяются', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const t = generateGuestToken();
      expect(t).toHaveLength(GUEST_TOKEN_LENGTH);
      expect(t).toMatch(/^[A-Za-z0-9_-]+$/);
      seen.add(t);
    }
    expect(seen.size).toBe(500);
  });

  it('parseGuestToken терпит пробелы и «#», но не подделки', () => {
    const t = generateGuestToken();
    expect(parseGuestToken(t)).toBe(t);
    expect(parseGuestToken(`#${t}`)).toBe(t);
    expect(parseGuestToken(`  ${t}  `)).toBe(t);
    for (const bad of [null, undefined, '', '#', 'short', 'A'.repeat(42), 'A'.repeat(44), `${t}!`, 'токен']) {
      expect(parseGuestToken(bad), String(bad)).toBeNull();
    }
    expect(isGuestToken(t)).toBe(true);
  });

  it('ссылка — /guest#<токен>, база без лишних слэшей', () => {
    const t = generateGuestToken();
    expect(guestUrlFor('https://school.uz', t)).toBe(`https://school.uz${GUEST_PATH}#${t}`);
    expect(guestUrlFor('https://school.uz///', t)).toBe(`https://school.uz${GUEST_PATH}#${t}`);
    // токен НЕ попадает в query: сервер его не увидит ни в логе, ни в Referer
    expect(guestUrlFor('https://school.uz', t)).not.toContain('?');
    expect(GUEST_PATH).toBe('/guest');
  });

  it('isGuestPath не зависит от слэшей, но не путает /guest с /guests', () => {
    for (const p of ['/guest', 'guest', '/guest/', '//guest']) expect(isGuestPath(p), p).toBe(true);
    for (const p of ['/guest/extra', '/guests', '/', '/guestbook', undefined]) expect(isGuestPath(p), p).toBe(false);
  });
});

describe('фрагмент адреса: очистка и хранение в памяти вкладки', () => {
  function fakeHistory() {
    const calls: string[] = [];
    return { calls, replaceState: (_d: unknown, _t: string, url: string | URL) => calls.push(String(url)) };
  }

  it('на /guest токен забирается, а адрес чистится', () => {
    const t = generateGuestToken();
    const h = fakeHistory();
    expect(takeGuestToken({ hash: `#${t}`, pathname: '/guest', search: '?lang=uz' }, h)).toBe(t);
    expect(h.calls).toEqual(['/guest?lang=uz']);
  });

  it('на чужой странице фрагмент не трогается: там он может быть якорем', () => {
    const t = generateGuestToken();
    expect(readGuestToken(`#${t}`, '/privacy')).toEqual({ token: null, clean: false });
    expect(readGuestToken('#contents', '/privacy')).toEqual({ token: null, clean: false });
    const h = fakeHistory();
    expect(takeGuestToken({ hash: '#contents', pathname: '/' }, h)).toBeNull();
    expect(h.calls).toEqual([]);
  });

  it('на /guest чистится ЛЮБОЙ фрагмент, даже непригодный', () => {
    for (const bad of ['#', '#short', '#a'.repeat(44), `#${generateGuestToken()}?x=1`]) {
      const h = fakeHistory();
      const r = readGuestToken(bad, '/guest');
      expect(r.token, bad).toBeNull();
      expect(r.clean, bad).toBe(true);
      expect(takeGuestToken({ hash: bad, pathname: '/guest' }, h)).toBeNull();
      expect(h.calls).toHaveLength(1);
    }
  });

  it('сохранённый токен важнее адреса; подделка в памяти не принимается', () => {
    const t = generateGuestToken();
    const h = fakeHistory();
    expect(consumeGuestToken({ hash: '', pathname: '/guest', search: '' }, h, t)).toBe(t);
    expect(h.calls, 'стирать нечего — историю не трогаем').toEqual([]);
    const h2 = fakeHistory();
    expect(consumeGuestToken({ hash: `#${t}`, pathname: '/guest' }, h2, 'not-a-token')).toBe(t);
    expect(h2.calls).toEqual(['/guest']);
  });

  it('ключи памяти совпадают с теми, что читает страница', () => {
    expect(GUEST_TOKEN_KEY).toBe('__blubluGuestToken');
    expect(GUEST_NAME_MAX).toBe(60);
    // ключ гостя браузерный (не ссылка): base64url, разумная длина
    expect(isGuestKey(key())).toBe(true);
    expect(isGuestKey('short')).toBe(false);
    expect(isGuestKey('A'.repeat(129))).toBe(false);
    expect(isGuestKey(`${'A'.repeat(20)}+`)).toBe(false);
  });
});

describe('хеши: токен и ключ не восстанавливаются, ключ привязан к ссылке', () => {
  it('хеш токена детерминирован, но не содержит токен', () => {
    const t = generateGuestToken();
    const h1 = hashGuestToken(t, PEPPER);
    const h2 = hashGuestToken(t, PEPPER);
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
    expect(h1).not.toContain(t);
    expect(hashGuestToken(generateGuestToken(), PEPPER)).not.toBe(h1);
    expect(hashGuestToken(t, `${PEPPER}x`), 'смена секрета меняет хеш').not.toBe(h1);
  });

  it('один и тот же ключ гостя в РАЗНЫХ ссылках даёт разные хеши', () => {
    const k = key();
    const a = hashGuestKey(k, 'link-a', PEPPER);
    const b = hashGuestKey(k, 'link-b', PEPPER);
    expect(a).not.toBe(b);
    expect(a).toBe(hashGuestKey(k, 'link-a', PEPPER));
    expect(a).not.toContain(k);
  });
});

describe('состояние двери: урок > отзыв > срок', () => {
  const future = new Date(Date.now() + 60_000);
  const past = new Date(Date.now() - 60_000);

  it('порядок проверок — часть контракта', () => {
    const alive = { endedAt: null };
    // всё плохо сразу — побеждает самый честный ответ
    expect(guestLinkState({ revokedAt: past, expiresAt: past }, { endedAt: past })).toBe('ended');
    expect(guestLinkState({ revokedAt: past, expiresAt: past }, alive)).toBe('revoked');
    expect(guestLinkState({ revokedAt: null, expiresAt: past }, alive)).toBe('expired');
    expect(guestLinkState({ revokedAt: null, expiresAt: future }, alive)).toBe('ok');
  });

  it('решение учителя действует, только пока дверь открыта', () => {
    expect(effectiveGuestState({ revokedAt: null, expiresAt: future }, { endedAt: null }, 'approved')).toBe('approved');
    expect(effectiveGuestState({ revokedAt: null, expiresAt: future }, { endedAt: null }, 'rejected')).toBe('rejected');
    // «pending» и любое неожиданное значение — ожидание, а не разрешение
    expect(effectiveGuestState({ revokedAt: null, expiresAt: future }, { endedAt: null }, 'pending')).toBe('pending');
    expect(effectiveGuestState({ revokedAt: null, expiresAt: future }, { endedAt: null }, 'approved-ish')).toBe('pending');
    // закрытая дверь перекрывает одобрение: старый «approved» после отзыва не открывает ничего
    expect(effectiveGuestState({ revokedAt: past, expiresAt: future }, { endedAt: null }, 'approved')).toBe('revoked');
    expect(effectiveGuestState({ revokedAt: null, expiresAt: past }, { endedAt: null }, 'approved')).toBe('expired');
    expect(effectiveGuestState({ revokedAt: null, expiresAt: future }, { endedAt: past }, 'approved')).toBe('ended');
  });
});
