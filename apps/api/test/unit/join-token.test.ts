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

describe('shell и точка входа: ключ уходит из адреса до первого рендера', () => {
  const webRoot = path.resolve(__dirname, '../../../web');
  const html = readFileSync(path.join(webRoot, 'index.html'), 'utf8');
  const main = readFileSync(path.join(webRoot, 'src/main.tsx'), 'utf8');
  const primed = readFileSync(path.join(webRoot, 'src/lib/joinToken.ts'), 'utf8');

  /**
   * CSP приложения — `script-src 'self'` (см. helmet в apps/api/src/app.ts), и она отбрасывает
   * ЛЮБОЙ инлайн-скрипт на served-сборке. Это не теоретическая опасность: ровно по этой причине
   * здесь однажды уже оказался мёртвый код, и проверка стоит, чтобы инлайн-скрипт не вернулся
   * «временно, для отладки» — он бы молча не выполнился, и фрагмент остался бы в адресе.
   */
  it('в shell нет ни одного инлайн-скрипта (CSP их всё равно отбросила бы)', () => {
    expect(html).not.toMatch(/<script>(?!\s*<\/script>)/);
    expect(html, 'модуль подключается только тегом src').toMatch(/<script type="module" src=/);
  });

  /** Сторонних ресурсов в shell нет — «не грузить их до очистки фрагмента» выполняется само. */
  it('в shell нет ни одного стороннего адреса, куда фрагмент мог бы уехать', () => {
    const external = [...html.matchAll(/https?:\/\/[^\s"'<>]+/g)].map((m) => m[0]);
    expect(external, `сторонние ссылки: ${external.join(', ')}`).toEqual([]);
    expect(html.match(/<link[^>]+href="https?:\/\//g) ?? [], 'только свои origin').toEqual([]);
  });

  /** Единственный порядок, который имеет значение: prime до темы, до ReactDOM и до любого fetch. */
  it('main.tsx чистит адрес первым делающим оператором, до ReactDOM.render', () => {
    const at = main.indexOf('primeJoinToken(window');
    expect(at, 'вызов есть').toBeGreaterThan(-1);
    for (const needle of ['applyTheme(', 'ReactDOM.createRoot(', 'serviceWorker']) {
      const later = main.indexOf(needle);
      expect(later, `«${needle}» присутствует`).toBeGreaterThan(-1);
      expect(later, `«${needle}» обязан идти ПОСЛЕ очистки адреса`).toBeGreaterThan(at);
    }
  });

  it('подготовка ключа оставляет его там же, где читает страница', () => {
    expect(primed).toMatch(/import \{ JOIN_TOKEN_KEY, takeJoinToken \} from '@klass\/shared'/);
    expect(primed).toMatch(/win\[JOIN_TOKEN_KEY\] = token/);
    expect(primed, 'очистка без записи ключа потеряла бы приглашение').toMatch(/if \(token\)/);
  });

  /** Чтобы правило «нет инлайн-скриптов» имело причину, а не была случайностью. */
  it('причина правила живёт в CSP сервера: script-src без unsafe-inline', () => {
    const app = readFileSync(path.resolve(__dirname, '../../src/app.ts'), 'utf8');
    const m = /scriptSrc: \[([^\]]*)\]/.exec(app);
    expect(m, 'директива scriptSrc есть в helmet-конфиге').toBeTruthy();
    expect(m![1]).toContain("'self'");
    expect(m![1], 'появление unsafe-inline означало бы, что инлайн-скрипт снова разрешён').not.toMatch(/unsafe-inline|unsafe-eval/);
  });
});
