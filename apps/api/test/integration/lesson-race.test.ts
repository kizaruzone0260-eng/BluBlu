/**
 * SEC-11 (2026-10-28): один активный урок на класс — инвариант базы, а не надежда сервиса.
 *
 * До этой правки `startLesson` делал SELECT активной сессии, а затем INSERT — между запросами
 * было окно. Два одновременных «Начать урок» создавали две сессии одного класса: две комнаты
 * LiveKit, две доски, ученики в разных уроках. Отчёт аудита зафиксировал гонку.
 *
 * Что доказывается здесь:
 *  • частичный уникальный индекс реально стоит в базе и отвергает ВТОРУЮ активную строку даже
 *    при прямой вставке, мимо сервиса;
 *  • завершённая сессия индексу не мешает — история класса не ограничена;
 *  • настоящая конкурентность (Promise.all, не последовательный цикл) даёт ровно одну сессию,
 *    и все ответы — один и тот же id, то есть для учителя это обычный идемпотентный «уже начат»;
 *  • после завершения урок можно начать снова, и это НОВАЯ сессия, а старая остаётся завершённой.
 *
 * Тест намеренно ходит и через HTTP-маршрут, и через сервис: первый проверяет то, что видит
 * клиент, второй — что правило не держится на одной вызывающей стороне.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import fs from 'node:fs';
import path from 'node:path';
import { TEST_DATABASE_URL, preparedDb, makeTeacher, loginToken, type TestDB } from './util.js';
import { buildApp } from '../../src/app.js';
import { classes, lessonSessions } from '../../src/db/schema.js';
import { startLesson } from '../../src/services/lessons.js';
import { isUniqueViolation } from '../../src/lib/pgErrors.js';
import { env } from '../../src/env.js';
import type { FastifyInstance } from 'fastify';

const suite = TEST_DATABASE_URL ? describe : describe.skip;

suite('SEC-11: одна активная сессия класса', () => {
  let t: TestDB; let app: FastifyInstance;
  let teacherId = '', teacherTok = '', classId = '';

  const activeOf = (cls: string) => t.db.select().from(lessonSessions)
    .where(and(eq(lessonSessions.classId, cls), isNull(lessonSessions.endedAt)));
  const startErr = (cls: string) => app.inject({
    method: 'POST', url: '/api/lessons/start',
    headers: { authorization: `Bearer ${teacherTok}` }, payload: { classId: cls },
  });

  beforeAll(async () => {
    t = await preparedDb(TEST_DATABASE_URL);
    env.RATE_LOGIN_MAX = 500;
    app = await buildApp(t.db);
    const te = await makeTeacher(t.sql, `race-${Date.now()}@x.io`);
    teacherId = te.id;
    teacherTok = await loginToken(app, te.email);
    const [c] = await t.db.insert(classes).values({ teacherId, name: 'Гонка уроков' }).returning();
    classId = c!.id;
  });
  afterAll(async () => { await app?.close(); await t?.sql.end(); });

  it('шесть одновременных «Начать урок» дают одну сессию и один id во всех ответах', async () => {
    const responses = await Promise.all(Array.from({ length: 6 }, () => startErr(classId)));
    for (const r of responses) {
      expect([200, 201], r.body).toContain(r.statusCode);
    }
    const ids = new Set(responses.map((r) => (r.json() as { id: string }).id));
    expect(ids.size, 'все ответы про один и тот же урок').toBe(1);
    const rows = await activeOf(classId);
    expect(rows, 'в базе ровно одна активная сессия').toHaveLength(1);
  });

  it('сервис под той же нагрузкой идемпотентен: восемь вызовов — один урок', async () => {
    const [s] = await activeOf(classId);
    // сначала завершаем текущий урок, чтобы сценарий начинался с пустой комнаты
    await app.inject({
      method: 'POST', url: `/api/lessons/${s!.id}/end`,
      headers: { authorization: `Bearer ${teacherTok}` },
    });
    expect(await activeOf(classId)).toHaveLength(0);

    const sessions = await Promise.all(Array.from({ length: 8 }, () => startLesson(t.db, teacherId, classId)));
    expect(new Set(sessions.map((x) => x.id)).size, 'все получили одну сессию').toBe(1);
    expect(await activeOf(classId)).toHaveLength(1);
  });

  it('индекс стоит в базе: вторая активная строка отвергается даже прямой вставкой', async () => {
    const [active] = await activeOf(classId);
    expect(active).toBeTruthy();
    let code = '';
    try {
      await t.db.insert(lessonSessions).values({
        classId, roomName: `lesson-race-${Date.now()}`, createdBy: teacherId,
      });
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
      code = '23505';
    }
    expect(code, 'база сама не даёт двух активных уроков').toBe('23505');
    expect(await activeOf(classId)).toHaveLength(1);
  });

  it('завершённые уроки не мешают: после end можно начать новый, история остаётся', async () => {
    const [first] = await activeOf(classId);
    const ended = await app.inject({
      method: 'POST', url: `/api/lessons/${first!.id}/end`,
      headers: { authorization: `Bearer ${teacherTok}` },
    });
    expect(ended.statusCode, ended.body).toBe(200);

    const next = await startErr(classId);
    expect([200, 201], next.body).toContain(next.statusCode);
    const nextId = next.json().id as string;
    expect(nextId, 'это новая сессия, а не завершённая').not.toBe(first!.id);

    const active = await activeOf(classId);
    expect(active).toHaveLength(1);
    expect(active[0]!.id).toBe(nextId);
    const all = await t.db.select().from(lessonSessions).where(eq(lessonSessions.classId, classId));
    expect(all.length, 'завершённые уроки никуда не исчезли').toBeGreaterThanOrEqual(3);
    expect(all.find((r) => r.id === first!.id)!.endedAt, 'старый урок остался завершённым').not.toBeNull();
  });

  /*
   * Миграция обязана быть применимой и к базе, где гонка УЖЕ случилась: иначе уникальный индекс
   * просто не создастся, и deploy упадёт ровно у тех, кому исправление нужнее всего. Здесь это
   * воспроизводится честно: индекс временно снимается, вставляются две активные сессии, затем
   * выполняется SQL миграции 0037 из файла (а не его пересказ). Остаться должна одна активная —
   * самая новая, — а вторая обязана стать завершённой, а не исчезнуть.
   */
  it('SQL миграции 0037 убирает уже существующие две активные сессии и создаёт индекс', async () => {
    await t.sql`drop index if exists lesson_sessions_one_active_per_class`;
    const [c] = await t.db.insert(classes).values({ teacherId, name: 'Уже была гонка' }).returning();
    const [older] = await t.db.insert(lessonSessions).values({
      classId: c!.id, roomName: `dup-old-${Date.now()}`, createdBy: teacherId,
    }).returning();
    await new Promise((r) => setTimeout(r, 15));
    const [newer] = await t.db.insert(lessonSessions).values({
      classId: c!.id, roomName: `dup-new-${Date.now()}`, createdBy: teacherId,
    }).returning();
    expect(await activeOf(c!.id), 'гонка воспроизведена').toHaveLength(2);

    const file = path.resolve('src/db/migrations/0037_lesson_one_active_per_class.sql');
    const statements = fs.readFileSync(file, 'utf8').split('--> statement-breakpoint');
    try {
      for (const s of statements) await t.sql.unsafe(s);
    } finally {
      // страховка на случай падения: индекс обязан остаться в базе для следующих файлов
      await t.sql.unsafe(
        'create unique index if not exists lesson_sessions_one_active_per_class on lesson_sessions (class_id) where ended_at is null',
      ).catch(() => undefined);
    }

    const active = await activeOf(c!.id);
    expect(active, 'осталась одна активная сессия').toHaveLength(1);
    expect(active[0]!.id, 'самая новая осталась активной').toBe(newer!.id);
    const [oldRow] = await t.db.select().from(lessonSessions).where(eq(lessonSessions.id, older!.id));
    expect(oldRow!.endedAt, 'старая не удалена, а завершена').not.toBeNull();
    const [idx] = await t.sql`select indexname from pg_indexes where indexname = 'lesson_sessions_one_active_per_class'`;
    expect(idx, 'индекс создан миграцией').toBeTruthy();
  });
});
