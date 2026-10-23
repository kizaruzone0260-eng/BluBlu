/**
 * Юнит входа по фрагменту URL (задача 2026-10-23, §8).
 *
 * Здесь две половины, и вторая важнее первой: правила разбора — обычная функция, а вот
 * «токен обязан исчезнуть из адреса ДО первой запроски» держится инлайн-скриптом в
 * `apps/web/index.html`. Если этот скрипт однажды переставят ниже `<link rel="preload">` или
 * уберут в модуль, толк от фрагмента пропадает молча: страница продолжит работать, а ключ
 * приглашения начнёт уезжать в access-лог и в `Referer`. Проверка по тексту shell-страницы —
 * тот guard, который не даёт этому случиться (тот же приём, что у excalidraw-панели).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { generateInviteToken } from '../../src/lib/inviteLink.js';
import {
  readJoinToken, takeJoinToken, consumeJoinToken, isJoinPath, JOIN_TOKEN_KEY, JOIN_PATH,
} from '@klass/shared';

const token = () => generateInviteToken();

describe('readJoinToken: разбор фрагмента', () => {
  it('на /join забирает токен и требует чистки адреса', () => {
    const t = token();
    expect(readJoinToken(`#${t}`, '/join')).toEqual({ token: t, clean: true });
    expect(readJoinToken(t, '/join')).toEqual({ token: t, clean: true });
    expect(readJoinToken(` #${t} `, '/join/').token).toBe(t);
  });

  it('на чужом пути фрагмент не трогает: это не приглашение', () => {
    const t = token();
    for (const where of ['/', '/login', '/classes', '/joinee', '/join-me']) {
      expect(readJoinToken(`#${t}`, where), where).toEqual({ token: null, clean: false });
    }
    // якорь оглавления на своей странице — тоже не наша забота
    expect(readJoinToken('#contents', '/privacy')).toEqual({ token: null, clean: false });
  });

  it('на /join убирает ЛЮБОЙ фрагмент, даже непригласительный', () => {
    for (const bad of ['#', '#short', '#a'.repeat(34), `#${token()}?x=1`, '#здесь-не-токен']) {
      const r = readJoinToken(bad, '/join');
      expect(r.token, bad).toBeNull();
      expect(r.clean, bad).toBe(true);
    }
  });

  it('isJoinPath не зависит от слэшей', () => {
    for (const p of ['/join', 'join', '/join/', '//join']) expect(isJoinPath(p), p).toBe(true);
    for (const p of ['/joinus', '/join/extra', '/', '/classes/1']) expect(isJoinPath(p), p).toBe(false);
    expect(isJoinPath(undefined)).toBe(false);
  });
});

describe('takeJoinToken / consumeJoinToken: очистка адреса', () => {
  /** replaceState — единственная запись, которую делает функция; её и слушаем. */
  function fakeHistory() {
    const calls: string[] = [];
    return { calls, replaceState: (_d: unknown, _t: string, url: string | URL) => calls.push(String(url)) };
  }

  it('фрагмент стирается, query остаётся', () => {
    const t = token();
    const h = fakeHistory();
    const got = takeJoinToken({ hash: `#${t}`, pathname: '/join', search: '?lang=ru' }, h);
    expect(got).toBe(t);
    expect(h.calls).toEqual(['/join?lang=ru']);
  });

  it('на чужом пути replaceState не вызывается вообще', () => {
    const h = fakeHistory();
    expect(takeJoinToken({ hash: '#whatever', pathname: '/privacy' }, h)).toBeNull();
    expect(h.calls, 'ни одного обращения к истории').toEqual([]);
  });

  it('без токена в фрагменте адрес всё равно чистится на /join', () => {
    const h = fakeHistory();
    expect(takeJoinToken({ hash: '#oops', pathname: '/join' }, h)).toBeNull();
    expect(h.calls).toEqual(['/join']);
  });

  it('значение, оставленное инлайн-скриптом, важнее пустого адреса', () => {
    const t = token();
    const h = fakeHistory();
    // так выглядит реальная загрузка: скрипт в head уже стёр фрагмент, до React его нет
    expect(consumeJoinToken({ hash: '', pathname: '/join', search: '' }, h, t)).toBe(t);
    expect(h.calls, 'стирать уже нечего — истории не тронута').toEqual([]);
  });

  it('поддельное оставленное значение игнорируется и читается адрес', () => {
    const t = token();
    const h = fakeHistory();
    expect(consumeJoinToken({ hash: `#${t}`, pathname: '/join' }, h, 'not-a-token')).toBe(t);
    expect(h.calls).toEqual(['/join']);
  });

  it('ключ оставленного значения совпадает с тем, что пишет index.html', () => {
    expect(JOIN_TOKEN_KEY).toBe('__blubluJoinToken');
    expect(JOIN_PATH).toBe('/join');
  });
});

describe('shell-страница: токен уходит из адреса раньше первой запроски', () => {
  const html = readFileSync(path.resolve(__dirname, '../../../web/index.html'), 'utf8');
  const head = html.slice(0, html.indexOf('</head>'));

  it('инлайн-скрипт стоит в head и он классический, а не модуль', () => {
    const m = /<script>\s*\(function \(\)\s*\{/.exec(head);
    expect(m, 'в head есть инлайн-IIFE до загрузки модуля').toBeTruthy();
    expect(html).toMatch(/window\.__blubluJoinToken\s*=\s*h/);
    expect(html).toMatch(/history\.replaceState\(null, '', location\.pathname \+ \(location\.search \|\| ''\)\)/);
  });

  /** Смысл всего механизма: до шрифтов, манифеста и модуля в адресе уже нет ключа. */
  it('скрипт идёт ПЕРЕД preload-шрифтов, манифестом и модулем приложения', () => {
    const scriptAt = head.indexOf('<script>');
    expect(scriptAt).toBeGreaterThan(-1);
    for (const needle of ['<link rel="preload"', '<link rel="manifest"', 'type="module"', '<title>']) {
      const at = html.indexOf(needle);
      expect(at, `«${needle}» есть в документе`).toBeGreaterThan(-1);
      expect(at, `«${needle}» обязан стоять ПОСЛЕ скрипта`).toBeGreaterThan(scriptAt);
    }
  });

  it('в shell нет ни одного стороннего адреса, куда фрагмент мог бы уехать', () => {
    const external = [...html.matchAll(/https?:\/\/[^\s"'<>]+/g)].map((m) => m[0]);
    expect(external, `сторонние ссылки: ${external.join(', ')}`).toEqual([]);
  });

  it('скрипт проверяет форму ключа ровно так же, как приложение', () => {
    const pattern = /\/\^(\[A-Za-z0-9_-\]\{32\})\$\/\.test\(h\)/.exec(html);
    expect(pattern, 'тот же класс символов и та же длина, что у `isInviteToken`').toBeTruthy();
    expect(new RegExp(`^${pattern![1]}$`).test(generateInviteToken())).toBe(true);
  });
});
