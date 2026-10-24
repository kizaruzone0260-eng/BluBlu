/**
 * Единый учёт промахов по токену приглашения (задача 2026-10-24).
 *
 * Дефект, который здесь проверяется, был не «слишком мягкий лимит», а ОБХОД: счётчик промахов
 * вело только `preview`. `register` промах засчитывать не умел вовсе, а `join` не спрашивал
 * привратника даже когда адрес уже закрыт. Значит перебор выглядел так: семь промахов в
 * `preview`, семь в `register`, шесть в `join` — и ни один маршрут не считает их вместе, то есть
 * порог не наступает никогда, хотя адрес сделал ровно двадцать ставок наугад.
 *
 * Все тесты идут в РЕЖИМЕ ПРОДА (`env.NODE_ENV = 'production'`), и вот почему: вне прода потолок
 * специально поднят до 500 в минуту (тесты и e2e производят промахи пачками с одного адреса), и
 * проверять «сработал ли порог» было бы невозможно детерминированно и долго. В проде потолок —
 * `PROD_IP_FAILURE_MAX_PER_MIN = 20`, а блок — 15 минут; цифры берутся из тех же констант, что
 * их применяют, а не переписаны здесь.
 *
 * Каждый тест живёт на СВОЁМ адресе (`remoteAddress`): лимиты считают по IP, и делить бакен с
 * предыдущей проверкой означало бы ловить её остатки.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { TEST_DATABASE_URL, preparedDb, makeTeacher, type TestDB } from './util.js';
import { buildApp } from '../../src/app.js';
import { env } from '../../src/env.js';
import { inviteCodes } from '../../src/db/schema.js';
import { PROD_IP_FAILURE_MAX_PER_MIN } from '../../src/lib/prodConfig.js';
import { CODE_BLOCK_MINUTES } from '@klass/shared';
import type { FastifyInstance } from 'fastify';

const suite = TEST_DATABASE_URL ? describe : describe.skip;
const PAGE_ORIGIN = 'https://blublu.example';
const PW = 'PupilPass2026';
const MAX = PROD_IP_FAILURE_MAX_PER_MIN;

suite('A: промахи по токену считаются вместе на preview, register и join', () => {
  let t: TestDB;
  let app: FastifyInstance;
  let teacherTok = '';
  let classId = '';

  const snapshot = {
    NODE_ENV: env.NODE_ENV, TRUST_PROXY: env.TRUST_PROXY, PUBLIC_URL: env.PUBLIC_URL,
    PUBLIC_WEB_ORIGIN: env.PUBLIC_WEB_ORIGIN, DOMAIN: env.DOMAIN,
    RATE_IP_MAX: env.RATE_IP_MAX, RATE_IP_FAIL_MAX: env.RATE_IP_FAIL_MAX,
  };

  let ipSeq = 0;
  /** Новый адрес на каждую проверку: бакен лимита привязан к IP. */
  const freshIp = () => `10.90.${Math.floor(++ipSeq / 254) % 254}.${ipSeq % 254}`;
  /** Мусорный, но ПРАВИЛЬНОЙ ФОРМЫ токен: 32 знака, которых нет в базе. */
  const junk = (n: number) => `j${String(n).padStart(4, '0')}`.padEnd(32, 'x').slice(0, 32);

  const preview = (token: string, ip: string) => app.inject({
    method: 'POST', url: '/api/invitations/preview', remoteAddress: ip, payload: { token },
  });
  const register = (body: Record<string, unknown>, ip: string) => app.inject({
    method: 'POST', url: '/api/invitations/register', remoteAddress: ip, payload: body,
  });
  const join = (authTok: string, token: string, ip: string) => app.inject({
    method: 'POST', url: '/api/invitations/join', remoteAddress: ip,
    headers: { authorization: `Bearer ${authTok}` }, payload: { token },
  });

  async function newLink(ip = freshIp()) {
    const r = await app.inject({
      method: 'POST', url: `/api/classes/${classId}/invites/link`, remoteAddress: ip,
      headers: { authorization: `Bearer ${teacherTok}` }, payload: { ttlDays: 7 },
    });
    expect(r.statusCode, r.body).toBe(201);
    return { id: r.json().id as string, token: (r.json().url as string).split('#')[1] ?? '' };
  }

  beforeAll(async () => {
    t = await preparedDb(TEST_DATABASE_URL);
    env.NODE_ENV = 'production';
    env.TRUST_PROXY = true;
    env.PUBLIC_URL = PAGE_ORIGIN;
    env.PUBLIC_WEB_ORIGIN = PAGE_ORIGIN;
    env.DOMAIN = undefined;
    // прод обязан ИГНОРИТЬ эти ослабления — ставим абсурдно высоко именно чтобы это доказать
    env.RATE_IP_MAX = 100_000;
    env.RATE_IP_FAIL_MAX = 100_000;
    app = await buildApp(t.db);

    const te = await makeTeacher(t.sql, `thr-t-${Date.now()}@x.io`);
    const login = await app.inject({
      method: 'POST', url: '/api/auth/login', payload: { email: te.email, password: 'Passw0rd123' },
    });
    teacherTok = login.json().accessToken as string;
    const cls = await app.inject({
      method: 'POST', url: '/api/classes', headers: { authorization: `Bearer ${teacherTok}` },
      payload: { name: 'Throttle class' },
    });
    classId = cls.json().id as string;
  });

  afterAll(async () => {
    try { await app?.close(); } catch { /* already closed */ }
    Object.assign(env, snapshot);
    await t?.sql.end();
  });

  it('прод не слушает ослаблений: порог ровно PROD_IP_FAILURE_MAX_PER_MIN', () => {
    // env.RATE_IP_FAIL_MAX стоит 100 000, и прод обязан его игнорировать
    expect(MAX).toBe(20);
  });

  it('20 промахов в preview закрывают адрес, 21-й отвечает 429 codeRateLimited', async () => {
    const ip = freshIp();
    for (let i = 1; i <= MAX; i++) {
      const r = await preview(junk(i), ip);
      expect(r.statusCode, `промах ${i}`).toBe(400);
      expect(r.json().error).toBe('inviteInvalid');
    }
    const blocked = await preview(junk(99), ip);
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().error).toBe('codeRateLimited');
    expect(Number(blocked.headers['retry-after']), 'блок на четверть часа').toBeGreaterThan(600);
    expect(blocked.json().reqId).toMatch(/^[0-9a-z]{10}$/);
  });

  /**
   * ГЛАВНАЯ регрессия. До правки этот тест давал 400: семь ставок в `preview` были единственными
   * засчитанными, а `register` и `join` не считали вообще, — то есть двадцать промахов по
   * факту не набирались ни на одном маршруте.
   */
  it('смена маршрута не обходит блок: 20 промахов на трёх эндпоинтах закрывают все три', async () => {
    const ip = freshIp();
    const studentTok = (await register({
      token: (await newLink(ip)).token, firstName: 'Mix', lastName: 'Route',
      email: `thr-mix-${Date.now()}@x.io`, password: PW,
    })).json().accessToken as string;

    const statuses: number[] = [];
    for (let i = 1; i <= 7; i++) statuses.push((await preview(junk(i), ip)).statusCode);
    for (let i = 8; i <= 14; i++) {
      statuses.push((await register({
        token: junk(i), firstName: 'Guess', lastName: 'Er',
        email: `thr-g-${i}-${Date.now()}@x.io`, password: PW,
      }, ip)).statusCode);
    }
    for (let i = 15; i <= 20; i++) statuses.push((await join(studentTok, junk(i), ip)).statusCode);
    expect(statuses.every((s) => s === 400), `промахи: ${statuses.join(',')}`).toBe(true);

    // и закрывается НЕ только тот маршрут, который считал, — блок общий
    expect((await preview(junk(101), ip)).statusCode).toBe(429);
    const reg = await register({
      token: junk(102), firstName: 'Guess', lastName: 'Er', email: `thr-x-${Date.now()}@x.io`, password: PW,
    }, ip);
    expect(reg.statusCode, 'register не обязан быть вежливым к уже закрытому адресу').toBe(429);
    expect(reg.json().error).toBe('codeRateLimited');
    const j = await join(studentTok, junk(103), ip);
    expect(j.statusCode, 'join спрашивает привратника, а не лезет в базу').toBe(429);
    expect(j.json().error).toBe('codeRateLimited');
  });

  it('register считает промахи сам по себе, без единого preview', async () => {
    const ip = freshIp();
    for (let i = 1; i <= MAX; i++) {
      const r = await register({
        token: junk(i), firstName: 'Only', lastName: 'Register',
        email: `thr-reg-${i}-${Date.now()}@x.io`, password: PW,
      }, ip);
      expect(r.statusCode, `ставка ${i}`).toBe(400);
      expect(r.json().error).toBe('inviteInvalid');
    }
    expect((await register({
      token: junk(120), firstName: 'Only', lastName: 'Register',
      email: `thr-reg-last-${Date.now()}@x.io`, password: PW,
    }, ip)).statusCode).toBe(429);
  });

  it('join считает промахи и не лезет в базу за закрытым адресом', async () => {
    const ip = freshIp();
    const studentTok = (await register({
      token: (await newLink(ip)).token, firstName: 'Join', lastName: 'Er',
      email: `thr-join-${Date.now()}@x.io`, password: PW,
    })).json().accessToken as string;

    for (let i = 1; i <= MAX; i++) {
      expect((await join(studentTok, junk(i), ip)).statusCode, `ставка ${i}`).toBe(400);
    }
    const blocked = await join(studentTok, junk(200), ip);
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().error).toBe('codeRateLimited');
    // 429 ДО обращения к базе: просроченный/использованный токен теперь не различим — и не должен
    expect(blocked.json().error).not.toBe('inviteUsed');
  });

  it('истёкший, отозванный и использованный токен — тоже промах, а не «ничего не было»', async () => {
    const ip = freshIp();
    const expired = await newLink(ip);
    await t.db.update(inviteCodes).set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(inviteCodes.id, expired.id));
    const revoked = await newLink(ip);
    await app.inject({
      method: 'POST', url: `/api/classes/${classId}/invites/${revoked.id}/revoke`,
      headers: { authorization: `Bearer ${teacherTok}` },
    });
    const used = await newLink(ip);
    expect((await register({
      token: used.token, firstName: 'Was', lastName: 'Used', email: `thr-used-${Date.now()}@x.io`, password: PW,
    }, ip)).statusCode).toBe(200);

    const seen: string[] = [];
    for (let i = 0; i < 7; i++) seen.push((await preview(expired.token, ip)).json().error);
    for (let i = 0; i < 7; i++) seen.push((await preview(revoked.token, ip)).json().error);
    for (let i = 0; i < 6; i++) seen.push((await preview(used.token, ip)).json().error);
    expect(seen.slice(0, 7).every((e) => e === 'inviteExpired')).toBe(true);
    expect(seen.slice(7, 14).every((e) => e === 'inviteRevoked')).toBe(true);
    expect(seen.slice(14).every((e) => e === 'inviteUsed')).toBe(true);

    const after = await preview(expired.token, ip);
    expect(after.statusCode, 'двадцать стуков в закрытые двери — это двадцать ставок').toBe(429);
    expect(after.json().error).toBe('codeRateLimited');
  });

  it('занятая почта при ХОРОШЕМ токене не считается промахом и не копит счётчик', async () => {
    const ip = freshIp();
    const taken = `thr-taken-${Date.now()}@x.io`;
    const other = await makeTeacher(t.sql, taken);
    expect(other.id).toBeTruthy();
    const link = await newLink(ip);

    // больше порога отказов по почте — и все они про токен хорошие
    for (let i = 1; i <= MAX + 5; i++) {
      const r = await register({
        token: link.token, firstName: 'Has', lastName: 'Mail', email: taken, password: PW,
      }, ip);
      expect(r.statusCode, `отказ ${i}`).toBe(409);
      expect(r.json().error).toBe('emailTaken');
    }
    // приглашение при этом не израсходовано и адрес не закрыт
    expect((await preview(link.token, ip)).statusCode, 'счётчик не разрастался').toBe(200);
    const ok = await register({
      token: link.token, firstName: 'Free', lastName: 'Mail', email: `thr-free-${Date.now()}@x.io`, password: PW,
    }, ip);
    expect(ok.statusCode, ok.body).toBe(200);
  });

  it('слабый пароль и кривые поля формы не портят счётчик токена', async () => {
    const ip = freshIp();
    const link = await newLink(ip);
    for (let i = 1; i <= MAX + 5; i++) {
      const weak = await register({
        token: link.token, firstName: 'Weak', lastName: 'Pw', email: `thr-weak-${i}-${Date.now()}@x.io`,
        password: 'Ab1',
      }, ip);
      expect(weak.statusCode, `опечатка ${i}`).toBe(400);
      expect(weak.json().error).toBe('passwordTooShort');
      const noName = await register({
        token: link.token, firstName: 'X', lastName: 'Pw', email: `thr-noname-${i}-${Date.now()}@x.io`,
        password: PW,
      }, ip);
      expect(noName.statusCode).toBe(400);
      expect(noName.json().error).toBe('invalidInput');
    }
    const ok = await register({
      token: link.token, firstName: 'Real', lastName: 'Pupil', email: `thr-real-${Date.now()}@x.io`, password: PW,
    }, ip);
    expect(ok.statusCode, 'тридцать опечаток в имени — не перебор токенов').toBe(200);
  });

  it('ошибка аутентификации на join не считается промахом по токену', async () => {
    const ip = freshIp();
    const studentTok = (await register({
      token: (await newLink(ip)).token, firstName: 'Auth', lastName: 'Erfail',
      email: `thr-auth-${Date.now()}@x.io`, password: PW,
    })).json().accessToken as string;

    for (let i = 1; i <= MAX + 5; i++) {
      // ни заголовка, и мусорный: до привратника и до токена дело не доходит
      const noAuth = await app.inject({ method: 'POST', url: '/api/invitations/join', remoteAddress: ip, payload: { token: junk(i) } });
      expect(noAuth.statusCode, `без входа ${i}`).toBe(401);
    }
    const link = await newLink(ip);
    const ok = await join(studentTok, link.token, ip);
    expect(ok.statusCode, '401 не накапливает ставки наугад').toBe(200);
    expect(ok.json().classId).toBe(classId);
  });

  it('успешная проверка обнуляет счётчик: человек, который всё делает верно, не наказуем', async () => {
    const ip = freshIp();
    const link = await newLink(ip);
    for (let i = 1; i < MAX; i++) expect((await preview(junk(i), ip)).statusCode).toBe(400);
    expect((await preview(link.token, ip)).statusCode, 'верная ссылка — сброс').toBe(200);
    // столько же промахов снова, и порога всё ещё нет: они начались с нуля
    for (let i = 1; i < MAX; i++) {
      const r = await preview(junk(500 + i), ip);
      expect(r.statusCode, `вторая серия ${i}`).toBe(400);
    }
    expect((await preview(link.token, ip)).statusCode).toBe(200);
  });

  it('блок не сжигает приглашение: после него ссылка всё ещё расходуется один раз', async () => {
    const ip = freshIp();
    const link = await newLink(ip);
    for (let i = 1; i <= MAX; i++) await preview(junk(i), ip);
    expect((await preview(link.token, ip)).statusCode).toBe(429);
    const [before] = await t.db.select().from(inviteCodes).where(eq(inviteCodes.id, link.id));
    expect(before.usedAt, 'закрытый адрес не израсходовал чужую ссылку').toBeNull();
    // с нового адреса та же ссылка работает как обычно, и ровно один раз
    const ok = await register({
      token: link.token, firstName: 'After', lastName: 'Block', email: `thr-after-${Date.now()}@x.io`, password: PW,
    }, freshIp());
    expect(ok.statusCode, ok.body).toBe(200);
    const twice = await preview(link.token, freshIp());
    expect(twice.statusCode, 'одноразовость целая и нетронутая').toBe(400);
    expect(twice.json().error).toBe('inviteUsed');
  });

  it('блок длится четверть часа, а не до конца процесса', () => {
    expect(CODE_BLOCK_MINUTES).toBe(15);
  });
});
