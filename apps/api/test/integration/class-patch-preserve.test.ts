/**
 * PATCH класса не имеет права додумывать значения (2026-10-27).
 *
 * Юнит `class-update-partial.test.ts` объясняет ПРИЧИНУ (в Zod 4 `.partial()` сохраняет
 * `default()`, поэтому `classCreateSchema.partial()` на запросе `{name}` возвращал ещё
 * `description:''`, `color:'#4f46e5'` и оба переключателя выключенными). Здесь — то, что
 * человек заметил бы в продукте: учитель переименовывает класс, а у него исчезает подпись,
 * цвет и включённый показ архива ученикам. Плюс вторая половина той же поломки: защита
 * «пустое обновление — это 400, а не UPDATE без SET» держится на том, что пустой объект
 * пустым и остаёт.
 *
 * Тест идёт через HTTP, а не через схему, потому что ломался именно маршрут: сервис
 * `updateClass` пишет ровно то, что ему дали, и «что дали» решает транспорт.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { TEST_DATABASE_URL, preparedDb, makeTeacher, type TestDB } from './util.js';
import { buildApp } from '../../src/app.js';
import { env } from '../../src/env.js';
import { classes } from '../../src/db/schema.js';
import type { FastifyInstance } from 'fastify';

const suite = TEST_DATABASE_URL ? describe : describe.skip;

suite('PATCH класса сохраняет непомянутые поля', () => {
  let t: TestDB;
  let app: FastifyInstance;
  let tok: string;

  const bearer = () => ({ authorization: `Bearer ${tok}` });
  const patch = (classId: string, payload: unknown) => app.inject({
    method: 'PATCH', url: `/api/classes/${classId}`, headers: bearer(), payload,
  });

  async function makeClass(payload: Record<string, unknown>) {
    const r = await app.inject({
      method: 'POST', url: '/api/classes', headers: bearer(), payload,
    });
    expect(r.statusCode, r.body).toBe(201);
    return r.json() as { id: string };
  }

  /** состояние класса в базе — источник истины, а не эхо ответа маршрута */
  const row = async (id: string) =>
    (await t.db.select().from(classes).where(eq(classes.id, id)).limit(1))[0]!;

  beforeAll(async () => {
    t = await preparedDb(TEST_DATABASE_URL);
    env.RATE_LOGIN_MAX = 500;
    env.RATE_IP_FAIL_MAX = 500;
    app = await buildApp(t.db);
    const te = await makeTeacher(t.sql, `cp-${Date.now()}@x.io`);
    const login = await app.inject({
      method: 'POST', url: '/api/auth/login', payload: { email: te.email, password: te.password },
    });
    expect(login.statusCode, login.body).toBe(200);
    tok = login.json().accessToken as string;
  });
  afterAll(async () => { await app?.close(); await t?.sql.end(); });

  it('переименование не трогает описание, цвет и оба переключателя', async () => {
    const c = await makeClass({
      name: '7-Б', description: 'Физика, вторая четверть', color: '#ff6b00',
      botPublicSchedule: true, boardArchivePublic: true,
    });
    const before = await row(c.id);
    expect(before.description).toBe('Физика, вторая четверть');
    expect(before.color).toBe('#ff6b00');
    expect(before.botPublicSchedule).toBe(true);
    expect(before.boardArchivePublic).toBe(true);

    const r = await patch(c.id, { name: '7-Б (кабинет 12)' });
    expect(r.statusCode, r.body).toBe(200);

    const after = await row(c.id);
    expect(after.name).toBe('7-Б (кабинет 12)', 'имя изменилось');
    expect(after.description, 'описание не очищено').toBe('Физика, вторая четверть');
    expect(after.color, 'цвет не вернулся к дефолту').toBe('#ff6b00');
    expect(after.botPublicSchedule, 'расписание бота осталось включённым').toBe(true);
    expect(after.boardArchivePublic, 'показ архива остался включённым').toBe(true);
  });

  it('каждое поле обновляется по отдельности и только оно', async () => {
    const c = await makeClass({ name: '8-А', description: 'старое', color: '#00ff00' });

    const d = await patch(c.id, { description: 'новое' });
    expect(d.statusCode, d.body).toBe(200);
    let after = await row(c.id);
    expect(after.description).toBe('новое');
    expect(after.color, 'цвет не тронут правкой описания').toBe('#00ff00');
    expect(after.name).toBe('8-А');

    const p = await patch(c.id, { boardArchivePublic: true });
    expect(p.statusCode, p.body).toBe(200);
    after = await row(c.id);
    expect(after.boardArchivePublic).toBe(true);
    expect(after.description, 'описание не тронуто переключателем').toBe('новое');
    expect(after.color).toBe('#00ff00');

    // явная очистка остаётся возможной: пустая строка — это воля клиента, а не подставленный default
    const clear = await patch(c.id, { description: '' });
    expect(clear.statusCode, clear.body).toBe(200);
    expect((await row(c.id)).description).toBe('');
  });

  it('пустой PATCH — 400 invalidInput, а не «UPDATE с одними дефолтами»', async () => {
    const c = await makeClass({ name: '9-В', description: 'не трогать', color: '#123456' });
    const r = await patch(c.id, {});
    expect(r.statusCode, r.body).toBe(400);
    expect(r.json().error).toBe('invalidInput');
    const after = await row(c.id);
    expect(after.description).toBe('не трогать');
    expect(after.color).toBe('#123456');
  });

  it('кривые значения по-прежнему отвергаются (политика length/цвета не разехалась с созданием)', async () => {
    const c = await makeClass({ name: '9-Г' });
    for (const body of [{ color: 'red' }, { name: '7' }, { description: 'x'.repeat(2001) }]) {
      const r = await patch(c.id, body);
      expect(r.statusCode, JSON.stringify(body)).toBe(400);
    }
    const after = await row(c.id);
    expect(after.name).toBe('9-Г');
  });
});
