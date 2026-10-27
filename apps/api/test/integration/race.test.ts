import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { TEST_DATABASE_URL, preparedDb, makeTeacher, type TestDB } from './util';
import { createInviteLink, redeemInviteLink, revokeInviteLink } from '../../src/services/invites';
import { generateInviteToken, hashInviteToken } from '../../src/lib/inviteLink';
import { env } from '../../src/env';
import { classes, inviteCodes } from '../../src/db/schema';

/**
 * ACCEPTANCE STAGE 1: одноразовое приглашение нельзя израсходовать дважды.
 * 20 параллельных расходов ОДНОЙ ссылкой — победить обязан ровно один.
 * Requires a real Postgres (Docker): export DATABASE_URL_TEST, else skipped.
 *
 * 2026-10-27. Сюжет этот файл держал на примитиве расхода восьмизначного кода класса
 * (`createInviteCode` / `redeemInviteCode` / `revokeInviteCode`) — способ выведен из продукта
 * вместе с `lib/invite.ts`, и импорт его был бы ошибкой сборки. Проверка переставлена на
 * ВЫЖИВШИЙ примитив расхода, `redeemInviteLink`, потому что атомарность живёт именно в нём:
 * `UPDATE … WHERE used_at IS NULL AND revoked_at IS NULL AND expires_at > now() RETURNING` —
 * та же одна команда, что держала гонку кодов, и строку блокирует сам UPDATE. Строки создаёт
 * `createInviteLink` (переживший сервис, тот же, что зовёт маршрут учителя), а не прямая
 * вставка: тогда тест смотрит на тот же путь, которым приглашение появляется в продукте.
 *
 * Сила утверждений не снижена: к «ok === false» добавилось ИМЯ причины отказа, потому что у
 * токена ссылки четыре состояния называются прямо (кодовый «один ответ на всё» умер вместе с
 * кодом).
 */
const suite = TEST_DATABASE_URL ? describe : describe.skip;

suite('invite link redemption atomicity', () => {
  let t: TestDB;
  let classId = '';
  let teacherId = '';
  const userIds: string[] = [];

  beforeAll(async () => {
    t = await preparedDb(TEST_DATABASE_URL);
    const teacher = await makeTeacher(t.sql);
    teacherId = teacher.id;
    const [cls] = await t.db.insert(classes)
      .values({ teacherId, name: 'R11', description: '', color: '#000000' })
      .returning();
    classId = cls!.id;
    for (let i = 0; i < 20; i++) {
      const id = crypto.randomUUID();
      userIds.push(id);
      await t.sql`insert into users (id, role, name, email, password_hash, locale, tz, created_at)
                  values (${id}, 'student', ${'S' + i}, ${`s${i}@x.io`}, 'x', 'ru', 'UTC', now())`;
    }
  });

  afterAll(async () => { await t?.sql.end(); });

  /** ссылка этого класса: ровно тот способ, которым её создаёт учитель, только без HTTP */
  const newLink = (ttlDays = 7) => createInviteLink(t.db, classId, teacherId, { label: '', ttlDays });

  it('exactly one of 20 concurrent redemptions succeeds', async () => {
    const inv = await newLink();
    const attempts = await Promise.all(userIds.map(async (u) => ({ u, r: await redeemInviteLink(t.db, inv.token, u) })));
    const winners = attempts.filter((x) => x.r.ok);
    expect(winners).toHaveLength(1);
    const win = winners[0]!.r;
    expect(win.ok ? win.classId : null).toBe(classId);
    expect(win.ok ? win.inviteId : null).toBe(inv.id);

    // 21-я попытка тоже отказывает — и словом «уже использовано», а не «токена не существует»
    const again = await redeemInviteLink(t.db, inv.token, userIds[0]!);
    expect(again.ok).toBe(false);
    expect(!again.ok && again.state).toBe('used');

    const [row] = await t.db.select().from(inviteCodes).where(eq(inviteCodes.id, inv.id)).limit(1);
    expect(row.usedBy, 'расход записан ровно на одного победителя').toBe(winners[0]!.u);
    expect(row.usedAt).toBeTruthy();
    expect(row.revokedAt, 'расход не помечает ссылку отозванной').toBeNull();
  });

  it('expired link never redeems', async () => {
    const inv = await newLink(1);
    await t.sql`update invite_codes set expires_at = now() - interval '1 hour' where id = ${inv.id}`;
    const r = await redeemInviteLink(t.db, inv.token, userIds[0]!);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.state, 'истёкшая ссылка отличается от чужой: ученику нужно сказать «попросите новую»')
      .toBe('expired');
  });

  it('revoked link never redeems', async () => {
    const inv = await newLink();
    expect(await revokeInviteLink(t.db, inv.id, classId, teacherId), 'отзыв своего приглашения удаётся').toBe(true);
    const r = await redeemInviteLink(t.db, inv.token, userIds[1]!);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.state).toBe('revoked');
  });

  /**
   * Отдельное утверждение о том, что расход берёт ТОЛЬКО ссылки: строка прежнего способа
   * (`kind = 'code'`) не читается как право на вход. Проверено сильно — её `code_hash` ровно тот,
   * который даёт штатный токен ссылки, то есть отличается от живой записи только вид. Если бы
   * фильтр по виду когда-нибудь выпал, удалённый способ вернулся бы запасной дверью на уровне
   * сервиса, и этот тест это поймает.
   */
  it('a legacy kind=code row is not a redemption target', async () => {
    const token = generateInviteToken();
    const legacyId = crypto.randomUUID();
    await t.db.insert(inviteCodes).values({
      id: legacyId, classId, codeHash: hashInviteToken(token, env.JWT_SECRET), createdBy: teacherId,
      expiresAt: new Date(Date.now() + 86_400_000), kind: 'code',
    });

    const r = await redeemInviteLink(t.db, token, userIds[2]!);
    expect(r.ok, 'старая строка не даёт вход').toBe(false);
    expect(!r.ok && r.state, 'для расхода её просто нет').toBe('invalid');
    const [row] = await t.db.select().from(inviteCodes).where(eq(inviteCodes.id, legacyId)).limit(1);
    expect(row.usedAt, 'и остаётся не тронутой').toBeNull();
  });
});
