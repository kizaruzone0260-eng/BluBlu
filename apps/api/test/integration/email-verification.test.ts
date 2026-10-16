/**
 * Часть F (2026-10-16): подтверждение почты при регистрации.
 *
 * Проверяется НАСТОЯЩИЙ тракт: маршруты, транзакция регистрации, таблица `email_verifications`
 * и транспорт `EmailTransport`, подставленный вместо провайдера. Именно для этого транспорт
 * входит в `buildApp`, а не читается из модульного синглтона: тест видит те же вызовы `send`,
 * что и живой процесс, и «письмо не отправилось» здесь — отказ транспорта, а не домысел.
 *
 * Разделение уровня не случайно: через HTTP идут сценарии, где важна ОТВЕТА (включатель,
 * полный путь, неотличимость занятого адреса, поведение при `none`), а остальное — уровнем
 * сервиса. Капальота на минуту (`RATE_CODE_MAX`, и счётчик попыток по IP) отдала бы такие
 * проверки в 429 раньше, чем они успели бы что-нибудь доказать про код.
 *
 * Пять обещаний, каждое своей проверкой: ответ о коде НЕ говорит, занят ли адрес; письмо,
 * которое не ушло, НЕ сжигает прежний код; списание атомарно (два прогона — один успех);
 * ошибочная регистрация откатывает списание; потолок попыток закрывает код даже верный.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { TEST_DATABASE_URL, preparedDb, makeTeacher, type TestDB } from './util.js';
import { buildApp } from '../../src/app.js';
import { classes, emailVerifications, inviteCodes, users } from '../../src/db/schema.js';
import { hashInviteCode } from '../../src/lib/invite.js';
import type { EmailMessage, EmailTransport } from '../../src/services/email.js';
import { registerStudentByCode } from '../../src/services/auth.js';
import {
  consumeEmailCode, hashEmailCode, precheckEmailCode, requestEmailCode, sweepEmailVerifications,
} from '../../src/services/emailVerify.js';
import { EMAIL_CODE_MAX_ATTEMPTS, EMAIL_CODE_TTL_MS } from '@klass/shared';

const suite = TEST_DATABASE_URL ? describe : describe.skip;

/** Запись вместо провайдера: тот же интерфейс, тот же путь кода, но видно всё. */
class RecordingTransport implements EmailTransport {
  readonly provider = 'console' as const;
  readonly sent: EmailMessage[] = [];
  mode: 'ok' | 'fail' = 'ok';
  async send(m: EmailMessage): Promise<void> {
    if (this.mode === 'fail') throw new Error('fictitious provider said no');
    this.sent.push(m);
  }
  /** код из последнего письма: он же ушёл бы человеку в `consoleLine` */
  lastCode(): string {
    const m = this.sent[this.sent.length - 1];
    const found = /\b(\d{6})\b/.exec(`${m?.consoleLine ?? ''} ${m?.text ?? ''}`);
    if (!found) throw new Error('в письме нет шестизначного кода');
    return found[1]!;
  }
}

/** Транспорт, который принимает всё и ничего не запоминает: нужен, где важен только факт отправки. */
const SILENT_OK: EmailTransport = { provider: 'console', send: async () => undefined };

const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const genCode = () => Array.from({ length: 8 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join('');

suite('подтверждение почты при регистрации (часть F)', () => {
  let t: TestDB;
  let app: FastifyInstance;
  let email: RecordingTransport;
  let teacherId = '';
  let classId = '';

  beforeAll(async () => {
    t = await preparedDb(TEST_DATABASE_URL);
    email = new RecordingTransport();
    app = await buildApp(t.db, { email });
    const teacher = await makeTeacher(t.sql, `f${Date.now()}t@x.io`);
    teacherId = teacher.id;
    const [c] = await t.db.insert(classes).values({ teacherId, name: 'F1' }).returning();
    classId = c!.id;
  });
  afterAll(async () => { await app?.close(); await t?.sql.end(); });

  async function newInvite(ttlMs = 3_600_000): Promise<string> {
    const code = genCode();
    await t.db.insert(inviteCodes).values({
      classId, codeHash: hashInviteCode(code, process.env.JWT_SECRET!), createdBy: teacherId,
      expiresAt: new Date(Date.now() + ttlMs),
    });
    return code;
  }
  const rowFor = async (addr: string) => (await t.db.select().from(emailVerifications)
    .where(eq(emailVerifications.email, addr)).limit(1))[0] ?? null;
  /** строка кода с заведомо известным значением: без этого нельзя проверить ни гонку, ни попытки */
  async function seedCode(addr: string, code: string, at = new Date()) {
    await t.db.insert(emailVerifications)
      .values({ email: addr, codeHash: hashEmailCode(code, addr), attempts: 0, sentAt: at, expiresAt: new Date(at.getTime() + EMAIL_CODE_TTL_MS) })
      .onConflictDoUpdate({
        target: emailVerifications.email,
        set: { codeHash: hashEmailCode(code, addr), attempts: 0, sentAt: at, expiresAt: new Date(at.getTime() + EMAIL_CODE_TTL_MS), usedAt: null },
      });
  }
  const reg = (addr: string, invite: string, emailCode?: string) => app.inject({
    method: 'POST', url: '/api/auth/register',
    payload: {
      firstName: 'Алия', lastName: 'Каримова', email: addr, password: 'Secret1234',
      code: invite, ...(emailCode ? { emailCode } : {}),
    },
  });

  it('включатель наружу: SPA узнаёт о требовании кода из /api/features', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/features' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ lessonPersist: true, emailVerification: true });
  });

  it('полный путь: письмо → код → аккаунт → вход', async () => {
    const addr = `f1${Date.now()}@x.io`;
    const invite = await newInvite();

    const sent = await app.inject({
      method: 'POST', url: '/api/auth/email-code',
      payload: { firstName: 'Алия', lastName: 'Каримова', email: addr, locale: 'ru' },
    });
    expect(sent.statusCode, sent.body).toBe(202);
    expect(sent.json()).toEqual({ ok: true });
    expect(email.sent).toHaveLength(1);
    // письмо обращение по имени и фамилии — то ради чего их просят ДО отправки кода
    expect(email.sent[0]!.text).toContain('Алия Каримова');
    const code = email.lastCode();

    // без кода регистрация не случается
    const noCode = await reg(addr, invite);
    expect(noCode.statusCode).toBe(400);
    expect(noCode.json()).toEqual({ error: 'emailCodeRequired' });

    const ok = await reg(addr, invite, code);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().user).toMatchObject({ email: addr, name: 'Алия', lastName: 'Каримова' });

    const row = await rowFor(addr);
    expect(row, 'строка кода остаётся различимой до уборки').not.toBeNull();
    expect(row!.usedAt, 'код списан').not.toBeNull();

    // и вход этим же логином работает — подтверждение НЕ гейтит login
    const li = await app.inject({
      method: 'POST', url: '/api/auth/login', payload: { email: addr, password: 'Secret1234' },
    });
    expect(li.statusCode).toBe(200);
    expect(li.json().accessToken).toBeTruthy();
  });

  it('ответ о занятом адресе неотличим от ответа об отправке, и письма не уходит', async () => {
    const addr = `f3${Date.now()}@x.io`;
    const invite = await newInvite();
    await app.inject({
      method: 'POST', url: '/api/auth/email-code',
      payload: { firstName: 'Алия', lastName: 'Каримова', email: addr, locale: 'ru' },
    });
    const before = email.sent.length;
    expect(await reg(addr, invite, email.lastCode())).toMatchObject({ statusCode: 200 });

    const again = await app.inject({
      method: 'POST', url: '/api/auth/email-code',
      payload: { firstName: 'Алия', lastName: 'Каримова', email: addr, locale: 'ru' },
    });
    expect(again.statusCode).toBe(202);
    expect(again.json(), 'тело обязано совпадать').toEqual({ ok: true });
    expect(email.sent, 'второго письма не было').toHaveLength(before);
    const row = await rowFor(addr);
    expect(row!.usedAt, 'списанный код не воскресает от запроса занятого адреса').not.toBeNull();
  });

  it('неверный код и ошибка класса откатывают списание: код остаётся живым', async () => {
    const addr = `f2${Date.now()}@x.io`;
    const invite = await newInvite();
    await seedCode(addr, '654321');

    const wrong = await registerStudentByCode(t.db, {
      firstName: 'Алия', lastName: 'Каримова', email: addr, password: 'Secret1234',
      code: invite, emailCode: '000000',
    });
    expect(wrong).toEqual({ ok: false, error: 'emailCodeInvalid' });
    const afterWrong = await rowFor(addr);
    expect(afterWrong!.attempts, 'попытка засчитана').toBe(1);
    expect(afterWrong!.usedAt, 'но НЕ списана').toBeNull();

    // не тот код класса: списание откатилось вместе с аккаунтом, попыток не прибавилось
    const badClass = await registerStudentByCode(t.db, {
      firstName: 'Алия', lastName: 'Каримова', email: addr, password: 'Secret1234',
      code: genCode(), emailCode: '654321',
    });
    expect(badClass).toEqual({ ok: false, error: 'invalidCode' });
    const afterClass = await rowFor(addr);
    expect(afterClass!.attempts, 'откат вернул счётчик попыток').toBe(1);
    expect(afterClass!.usedAt).toBeNull();

    // тем же кодом, без перевыпуска — успех
    const fine = await registerStudentByCode(t.db, {
      firstName: 'Алия', lastName: 'Каримова', email: addr, password: 'Secret1234',
      code: invite, emailCode: '654321',
    });
    expect(fine.ok).toBe(true);
  });

  it('сбой провайдера не списывает код: прежний остаётся живым, хэш и срок не тронуты', async () => {
    const addr = `f4${Date.now()}@x.io`;
    const now = new Date();
    expect(await requestEmailCode({
      db: t.db, transport: SILENT_OK, email: addr, firstName: 'Алия', lastName: 'Каримова',
      locale: 'en', now,
    })).toEqual({ ok: true, sent: true });
    const before = await rowFor(addr);
    expect(before!.expiresAt.getTime()).toBe(now.getTime() + EMAIL_CODE_TTL_MS);

    email.mode = 'fail';
    const failing = await requestEmailCode({
      db: t.db, transport: email, email: addr, firstName: 'Алия', lastName: 'Каримова',
      locale: 'en', now: new Date(now.getTime() + 61_000),   // пауза между письмами прошла
    });
    expect(failing.ok).toBe(false);
    if (!failing.ok && failing.error === 'provider') {
      expect(failing.reason, 'причина короткая и без секретов').toContain('fictitious');
    }

    const after = await rowFor(addr);
    expect(after!.codeHash, 'хэш прежнего кода не тронут').toBe(before!.codeHash);
    expect(after!.attempts, 'отказ провайдера — не попытка угадывания').toBe(0);
    expect(after!.expiresAt.getTime(), 'и срок тоже').toBe(before!.expiresAt.getTime());
    email.mode = 'ok';
  });

  it('потолок попыток: шестая не принимается, и верный код тоже', async () => {
    const addr = `f5${Date.now()}@x.io`;
    const now = new Date();
    await seedCode(addr, '123456', now);
    const row = await rowFor(addr);
    expect(row!.codeHash).not.toContain('123456');       // в базе только sha256
    expect(row!.codeHash.length).toBe(64);

    for (let i = 0; i < EMAIL_CODE_MAX_ATTEMPTS; i++) {
      expect(await precheckEmailCode(t.db, addr, '000000', now), `попытка ${i + 1}`).toBe('invalid');
    }
    const after = await rowFor(addr);
    expect(after!.attempts).toBe(EMAIL_CODE_MAX_ATTEMPTS);
    expect(await precheckEmailCode(t.db, addr, '123456', now), 'верный код после потолка').toBe('invalid');
    expect(await consumeEmailCode(t.db, addr, '123456', now), 'и на уровне списания тоже').toBe(false);
  });

  it('списание атомарно: из двух параллельных подтверждений проходит ровно одно', async () => {
    const addr = `f6${Date.now()}@x.io`;
    const now = new Date();
    await seedCode(addr, '654321', now);
    const both = await Promise.all([
      consumeEmailCode(t.db, addr, '654321', now),
      consumeEmailCode(t.db, addr, '654321', now),
    ]);
    expect(both.filter((x) => x === true), 'успех обязан быть ровно одним').toHaveLength(1);
    const after = await rowFor(addr);
    expect(after!.usedAt, 'строка помечена использованной ровно один раз').not.toBeNull();
  });

  it('истёкший код не принимается и не «добивается» попытками; уборка забирает только старые', async () => {
    const addr = `f7${Date.now()}@x.io`;
    const now = new Date();
    await seedCode(addr, '111111', now);
    const later = new Date(now.getTime() + EMAIL_CODE_TTL_MS + 1);
    expect(await consumeEmailCode(t.db, addr, '111111', later), 'по истечении — отказ').toBe(false);
    expect((await rowFor(addr))!.attempts, 'истёкший код не за что добивать попытками').toBe(0);

    // строка, истёкшая меньше суток назад, остаётся; старше суток — уходит
    expect(await sweepEmailVerifications(t.db, new Date(now.getTime() + EMAIL_CODE_TTL_MS + 60_000))).toBe(0);
    expect(await rowFor(addr)).not.toBeNull();
    expect(await sweepEmailVerifications(t.db, new Date(now.getTime() + EMAIL_CODE_TTL_MS + 24 * 3600_000 + 1000)))
      .toBeGreaterThanOrEqual(1);
    expect(await rowFor(addr)).toBeNull();
  });

  it('стёртый аккаунт не оставляет адрес в таблице кодов', async () => {
    const addr = `f8${Date.now()}@x.io`;
    const invite = await newInvite();
    await app.inject({
      method: 'POST', url: '/api/auth/email-code',
      payload: { firstName: 'Алия', lastName: 'Каримова', email: addr, locale: 'ru' },
    });
    const ok = await reg(addr, invite, email.lastCode());
    expect(ok.statusCode, ok.body).toBe(200);
    const removed = await app.inject({
      method: 'DELETE', url: '/api/me', headers: { authorization: `Bearer ${ok.json().accessToken}` },
    });
    expect(removed.statusCode).toBe(200);
    const [row] = await t.db.select({ id: users.id }).from(users).where(eq(users.email, addr)).limit(1);
    expect(row, 'пользователь анонимизирован').toBeUndefined();
    expect(await rowFor(addr), 'и его код вместе с ним').toBeNull();
  });

  it('при выключателе по умолчанию (none) маршрута подтверждения нет и регистрация не ждёт код', async () => {
    const plain = await buildApp(t.db);        // env.EMAIL_PROVIDER = none в тестах
    try {
      const feat = await plain.inject({ method: 'GET', url: '/api/features' });
      expect(feat.json()).toEqual({ lessonPersist: true, emailVerification: false });
      const code = await plain.inject({
        method: 'POST', url: '/api/auth/email-code',
        payload: { firstName: 'Алия', lastName: 'Каримова', email: `f9${Date.now()}@x.io` },
      });
      expect(code.statusCode).toBe(400);
      const invite = await newInvite();
      const r = await plain.inject({
        method: 'POST', url: '/api/auth/register',
        payload: {
          firstName: 'Алия', lastName: 'Каримова', email: `f9${Date.now()}@x.io`,
          password: 'Secret1234', code: invite,
        },
      });
      expect(r.statusCode, r.body).toBe(200);
    } finally {
      await plain.close();
    }
  });
});
