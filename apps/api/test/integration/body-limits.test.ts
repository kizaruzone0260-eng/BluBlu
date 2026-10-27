/**
 * Транспортные пределы размера тела (задача 2026-10-27, часть A).
 *
 * До этой правки предел тела в коде не назывался вовсе: действовал молчаливый дефолт Fastify
 * (1 МБ). Из этого следовали две разные беды, и тесты ниже — по одной на каждую:
 *
 *  1. Схема публикации доски обещала принять до 12 000 000 символов base64, а транспорт резал
 *     тело на 1 МБ. Плотная доска НЕ ПУБЛИКОВАЛАСЬ, и учитель получал 413 без объяснения.
 *     Предел этого маршрута поднят до его же контракта — и это единственное исключение.
 *  2. Предел есть, но он нигде не зафиксирован, поэтому «схема с `.max()`» создавала иллюзию
 *     защиты: тело произвольного размера всё равно доезжало до разбора.
 *
 * Проверяется и то, что лимиты не ломают легитимное: реальная плотная страница доски и полный
 * набор настроек уведомлений обязаны проходить. Отказ везде — 4xx с кодом и `reqId`, никогда
 * не 500 и не оборванное соединение.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { TEST_DATABASE_URL, preparedDb, makeTeacher, type TestDB } from './util.js';
import { buildApp } from '../../src/app.js';
import { env } from '../../src/env.js';
import { classes, whiteboards } from '../../src/db/schema.js';
import { JSON_BODY_LIMIT, BOARD_PUBLISH_BODY_LIMIT } from '../../src/lib/bodyLimits.js';
import { MAX_BOARD_ELEMENTS, MAX_STUDENT_ELEMENTS } from '../../src/services/board.js';
import { MAX_NOTIFY_KIND_KEYS } from '../../src/routes/telegram.js';
import { REQUEST_ID_PATTERN } from '../../src/lib/requestId.js';
import type { FastifyInstance } from 'fastify';

const suite = TEST_DATABASE_URL ? describe : describe.skip;

suite('Пределы размера тела запроса', () => {
  let t: TestDB;
  let app: FastifyInstance;
  let tok: string;
  let classId: string;
  let sessionId: string;

  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

  beforeAll(async () => {
    t = await preparedDb(TEST_DATABASE_URL);
    env.RATE_LOGIN_MAX = 500;
    env.RATE_IP_FAIL_MAX = 500;
    app = await buildApp(t.db);

    const te = await makeTeacher(t.sql, `bl-${Date.now()}@x.io`);
    const login = await app.inject({
      method: 'POST', url: '/api/auth/login', payload: { email: te.email, password: te.password },
    });
    expect(login.statusCode, login.body).toBe(200);
    tok = login.json().accessToken as string;

    const [cls] = await t.db.insert(classes).values({ teacherId: te.id, name: 'Body limits' }).returning();
    classId = cls!.id;

    const started = await app.inject({
      method: 'POST', url: '/api/lessons/start', headers: bearer(tok), payload: { classId },
    });
    expect([200, 201], started.body).toContain(started.statusCode);
    sessionId = started.json().id as string;
    expect(sessionId).toBeTruthy();
  });
  afterAll(async () => { await app?.close(); await t?.sql.end(); });

  it('тело больше общего предела — 413 с кодом и reqId, а не 500 и не молчаливый обрыв', async () => {
    const r = await app.inject({
      method: 'PATCH', url: `/api/classes/${classId}`, headers: bearer(tok),
      payload: { description: 'x'.repeat(JSON_BODY_LIMIT * 2) },
    });
    expect(r.statusCode).toBe(413);
    const body = r.json() as { error?: string; reqId?: string };
    expect(body.error, 'клиенту приходит переводимый код, а не текст фреймворка').toBe('invalidInput');
    expect(body.reqId, 'у отказа есть идентификатор для разбора').toMatch(REQUEST_ID_PATTERN);

    const [row] = await t.db.select({ description: classes.description }).from(classes)
      .where(eq(classes.id, classId));
    expect(row?.description ?? '', 'отклонённое тело ничего не записало').not.toContain('xxx');
  });

  it('РЕГРЕССИЯ: публикация доски крупнее 1 МБ проходит — прежний молчаливый предел её резал', async () => {
    // ~2 МБ base64 → ~1,5 МБ файла. Это больше прежнего предела тела (1 МБ), но меньше и
    // контракта маршрута (12 000 000 символов), и `MAX_FILE_MB` (в тестах 2 МБ) — то есть
    // полностью легитимная публикация, которая до правки отвечала 413.
    // Сигнатура PNG настоящая: сохранение материала проверяет тип по первым байтам, и отказ по
    // типу («fileTypeRejected») скрыл бы ровно то, что здесь проверяется, — размер тела.
    const pngHead = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const bytes = Buffer.concat([pngHead, Buffer.alloc(1_500_000 - pngHead.length, 7)]);
    const dataUrl = `data:image/png;base64,${bytes.toString('base64')}`;
    expect(dataUrl.length, 'тело заведомо больше общего предела').toBeGreaterThan(JSON_BODY_LIMIT);
    expect(dataUrl.length).toBeLessThan(BOARD_PUBLISH_BODY_LIMIT);

    const r = await app.inject({
      method: 'POST', url: `/api/lessons/${sessionId}/board/publish`, headers: bearer(tok),
      payload: { dataUrl, kind: 'png', title: 'Big board' },
    });
    expect(r.statusCode, r.body.slice(0, 400)).toBe(201);
    expect(r.json().postId).toBeTruthy();
  });

  it('исключение не бездонно: тело больше BOARD_PUBLISH_BODY_LIMIT — тот же 413', async () => {
    const r = await app.inject({
      method: 'POST', url: `/api/lessons/${sessionId}/board/publish`, headers: bearer(tok),
      payload: { dataUrl: `data:image/png;base64,${'x'.repeat(BOARD_PUBLISH_BODY_LIMIT)}`, kind: 'png', title: 'Too big' },
    });
    expect(r.statusCode).toBe(413);
    expect(r.json().error).toBe('invalidInput');
  });

  it('потолок числа элементов доски срабатывает и через HTTP: 400, и на доске ничего не появляется', async () => {
    // 20 001 минимальный элемент — это ~260 КБ тела: транспорт пропускает, значит отказывает
    // именно схема, а не предел размера.
    const over = Array.from({ length: MAX_BOARD_ELEMENTS + 1 }, (_, i) => ({ id: `e${i}` }));
    const r = await app.inject({
      method: 'PUT', url: `/api/lessons/${sessionId}/board/page`, headers: bearer(tok),
      payload: { pageNo: 1, elements: over },
    });
    expect(r.statusCode, r.body.slice(0, 300)).toBe(400);
    expect(r.json().error).toBe('invalidInput');

    const rows = await t.db.select().from(whiteboards)
      .where(and(eq(whiteboards.sessionId, sessionId), eq(whiteboards.pageNo, 1)));
    expect(rows, 'отклонённая страница не записана').toHaveLength(0);
  });

  it('реальная плотная страница доски проходит под тем же пределом', async () => {
    // 300 элементов (= потолок ученической сцены) по 150 точек: сотни килобайт честного рисунка.
    const points = Array.from({ length: 150 }, (_, i) => [i, i * 2]);
    const elements = Array.from({ length: MAX_STUDENT_ELEMENTS }, (_, i) => ({
      id: `p${i}`, type: 'draw', x: i, y: i, strokeColor: '#123456', points,
    }));
    const payload = JSON.stringify({ pageNo: 2, title: 'Плотная страница', elements });
    expect(payload.length, 'тело заметно больше ста килобайт').toBeGreaterThan(200_000);
    expect(payload.length, 'но в общий предел укладывается').toBeLessThan(JSON_BODY_LIMIT);

    const r = await app.inject({
      method: 'PUT', url: `/api/lessons/${sessionId}/board/page`,
      // тело передаётся уже собранной строкой, чтобы тест утверждал его РЕАЛЬНЫЙ размер;
      // заголовок тогда обязан быть своим — иначе 415 вместо разбора JSON
      headers: { ...bearer(tok), 'content-type': 'application/json' },
      payload,
    });
    expect(r.statusCode, r.body.slice(0, 300)).toBe(200);

    const [row] = await t.db.select().from(whiteboards)
      .where(and(eq(whiteboards.sessionId, sessionId), eq(whiteboards.pageNo, 2)));
    expect(row, 'страница сохранена').toBeTruthy();
    expect(row!.title).toBe('Плотная страница');
    expect(JSON.stringify(row!.snapshot)).toContain('"p0"');
  });

  it('словарь настроек уведомлений: полный набор проходит, лишний ключ — 400, прежнее не затирается', async () => {
    const kinds = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`kind${i}`, true]));

    const ok = await app.inject({
      method: 'PUT', url: '/api/me/notify-prefs', headers: bearer(tok),
      payload: { kinds: kinds(MAX_NOTIFY_KIND_KEYS) },
    });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(Object.keys(ok.json().kinds as object)).toHaveLength(MAX_NOTIFY_KIND_KEYS);

    const tooMany = await app.inject({
      method: 'PUT', url: '/api/me/notify-prefs', headers: bearer(tok),
      payload: { kinds: kinds(MAX_NOTIFY_KIND_KEYS + 1) },
    });
    expect(tooMany.statusCode, tooMany.body).toBe(400);
    expect(tooMany.json().error).toBe('invalidInput');

    const after = await app.inject({ method: 'GET', url: '/api/me/notify-prefs', headers: bearer(tok) });
    expect(after.statusCode).toBe(200);
    expect(Object.keys(after.json().kinds as object), 'отказ не затёр сохранённые настройки')
      .toHaveLength(MAX_NOTIFY_KIND_KEYS);
  });
});
