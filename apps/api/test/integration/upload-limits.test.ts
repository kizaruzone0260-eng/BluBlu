/**
 * SEC-10 (2026-10-28): потолок одновременных тяжёлых загрузок.
 *
 * Отчёт аудита: оба маршрута вложений читают multipart целиком в память, а ограничение размера
 * считается на ОДИН запрос — параллельные загрузки складываются в память контейнера без всякого
 * счётчика. Здесь проверяется поведение маршрута, а не только сам модуль (`test/unit/upload-gate.test.ts`):
 *
 *  • при занятых слотах маршрут отвечает 429 `uploadBusy` с `Retry-After` и НЕ создаёт материал;
 *  • после освобождения слота та же загрузка проходит — то есть отказ временный, а не поломка;
 *  • слот возвращается и после 404/400: иначе одна неудачная попытка навсегда съедала бы место;
 *  • сбой вставки записи после записи байтов не оставляет ни файла на диске, ни строки `files`;
 *  • удаление самого материала убирает все его файлы и строки `files`, а не только пост.
 *
 * Предпоследний пункт — старый дефект из Stage 4 аудита («файлы, оставшиеся после неудачной вставки»).
 * Воспроизводится он честно, без моков БД: предсуществующее вложение с `position = 2147483647`
 * делает следующий `position + 1` переполнением integer, то есть падает ровно ВТОРАЯ вставка —
 * после того как байты уже записаны и строка `files` уже создана.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { TEST_DATABASE_URL, preparedDb, makeTeacher, loginToken, type TestDB } from './util.js';
import { buildApp } from '../../src/app.js';
import { classes, files as filesTable, postAttachments, posts } from '../../src/db/schema.js';
import { storeUploads } from '../../src/services/posts.js';
import { setStorage, type StorageProvider } from '../../src/storage/provider.js';
import {
  tryAcquireUploadSlot, releaseUploadSlot, activeUploads, setUploadSlotLimit,
} from '../../src/lib/uploadGate.js';
import type { FastifyInstance } from 'fastify';

const suite = TEST_DATABASE_URL ? describe : describe.skip;

function multipart(fields: Record<string, string>, file: { name: string; filename: string; data: Buffer }, boundary = 'UGBOUND') {
  let head = '';
  for (const [k, v] of Object.entries(fields)) {
    head += `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`;
  }
  head += `--${boundary}\r\nContent-Disposition: form-data; name="${file.name}"; filename="${file.filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`;
  return Buffer.concat([Buffer.from(head, 'utf8'), file.data, Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8')]);
}

/** минимальное хранилище без диска: важно только, что put и delete парные */
class FakeStorage implements StorageProvider {
  objects = new Map<string, Buffer>();
  putCalls: string[] = [];
  deleteCalls: string[] = [];
  async put(key: string, data: Buffer) { this.objects.set(key, data); this.putCalls.push(key); }
  async open() { return null; }
  async stat() { return null; }
  async delete(key: string) { this.objects.delete(key); this.deleteCalls.push(key); }
}

suite('SEC-10: гейт одновременных загрузок и уборка сирот', () => {
  let t: TestDB; let app: FastifyInstance;
  let teacherId = '', teacherTok = '', classId = '';
  const pdf = Buffer.from('%PDF-1.4 upload gate body');

  const up = (cls: string, fields: Record<string, string>, file = { name: 'file', filename: 'doc.pdf', data: pdf }) =>
    app.inject({
      method: 'POST', url: `/api/classes/${cls}/materials`,
      headers: { authorization: `Bearer ${teacherTok}`, 'content-type': 'multipart/form-data; boundary=UGBOUND' },
      payload: multipart(fields, file),
    });
  const postCount = async (cls: string) =>
    (await t.db.select({ id: posts.id }).from(posts).where(eq(posts.classId, cls))).length;

  beforeAll(async () => {
    t = await preparedDb(TEST_DATABASE_URL);
    app = await buildApp(t.db);
    const te = await makeTeacher(t.sql, `upgate-${Date.now()}@x.io`);
    teacherId = te.id;
    teacherTok = await loginToken(app, te.email);
    const [c] = await t.db.insert(classes).values({ teacherId, name: 'Гейт загрузок' }).returning();
    classId = c!.id;
  });
  afterAll(async () => {
    setStorage(null);
    while (activeUploads() > 0) releaseUploadSlot();
    await app?.close(); await t?.sql.end();
  });

  it('при занятых слотах — 429 uploadBusy с Retry-After и ни одного материала; после release — 201', async () => {
    const prev = setUploadSlotLimit(1);
    try {
      expect(tryAcquireUploadSlot(), 'единственный слот занят другим запросом').toBe(true);
      const busy = await up(classId, { title: 'Не должно появиться' });
      expect(busy.statusCode, busy.body).toBe(429);
      expect(busy.json().error).toBe('uploadBusy');
      expect(String(busy.headers['retry-after']), 'клиенту есть что показать словами').toBe('5');
      expect(await postCount(classId), 'при отказе материал не создаётся').toBe(0);
    } finally {
      releaseUploadSlot();
      setUploadSlotLimit(prev);
    }
    const ok = await up(classId, { title: 'После гейта' });
    expect(ok.statusCode, ok.body).toBe(201);
    await new Promise((r) => setTimeout(r, 20)); // onResponse освобождает слот после отправки
    expect(activeUploads(), 'слот вернулся после успешного ответа').toBe(0);
  });

  it('слот освобождается и после 404, и после 400 — иначе неудачная попытка съедала бы место', async () => {
    const foreign = await up(crypto.randomUUID(), { title: 'Чужой класс' });
    expect(foreign.statusCode).toBe(404);
    await new Promise((r) => setTimeout(r, 20));
    expect(activeUploads(), '404 не должен оставить слот занятым').toBe(0);

    const bad = await up(classId, { title: '   ' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe('titleRequired');
    await new Promise((r) => setTimeout(r, 20));
    expect(activeUploads(), '400 не должен оставить слот занятым').toBe(0);

    const ok = await up(classId, { title: 'После ошибок' });
    expect(ok.statusCode, 'загрузки после ошибок по-прежнему работают').toBe(201);
  });

  it('сбой вставки вложения убирает и байты, и строку files, а не оставляет сироту', async () => {
    const fake = new FakeStorage();
    setStorage(fake);
    try {
      const [p] = await t.db.insert(posts).values({ classId, authorId: teacherId, kind: 'material', title: 'Сирота' }).returning();
      // position = максимум integer: следующий ++position переполнит колонку и уронит вторую вставку
      await t.db.insert(postAttachments).values({
        postId: p!.id, kind: 'link', url: 'https://example.com/pre', title: 'pre', position: 2147483647,
      });

      await expect(storeUploads(t.db, teacherId, p!.id, [{ buffer: pdf, filename: 'boom.pdf' }]))
        .rejects.toThrow();

      expect(fake.putCalls.length, 'байты успели записаться — иначе тест проверял бы не тот сценарий').toBe(1);
      expect(fake.deleteCalls, 'убраны ровно по тому же ключу').toEqual(fake.putCalls);
      expect(fake.objects.size).toBe(0);
      expect(await t.db.select().from(filesTable).where(eq(filesTable.postId, p!.id)),
        'строки files не осталось — она не учитывалась бы в квоте и не удалялась бы никогда').toHaveLength(0);
      expect(await t.db.select().from(postAttachments).where(eq(postAttachments.postId, p!.id)),
        'предсуществующее вложение не тронуто').toHaveLength(1);
    } finally {
      setStorage(null);
    }
  });

  it('удаление материала убирает его файлы из хранилища и строки files (SEC-19)', async () => {
    const fake = new FakeStorage();
    setStorage(fake);
    try {
      const created = await up(classId, { title: 'Удаляемый материал' });
      expect(created.statusCode, created.body).toBe(201);
      const postId = created.json().id as string;
      expect(fake.putCalls, 'байты записались — иначе тест проверял бы не тот сценарий').toHaveLength(1);

      const del = await app.inject({
        method: 'DELETE', url: `/api/posts/${postId}`,
        headers: { authorization: `Bearer ${teacherTok}` },
      });
      expect(del.statusCode).toBe(200);
      expect(fake.deleteCalls, 'удалён ровно тот ключ, который записали').toEqual(fake.putCalls);
      expect(fake.objects.size).toBe(0);
      expect(await t.db.select().from(filesTable).where(eq(filesTable.postId, postId)),
        'строк files не осталось — квота их больше не считает').toHaveLength(0);
      expect(await t.db.select().from(posts).where(eq(posts.id, postId))).toHaveLength(0);
    } finally {
      setStorage(null);
    }
  });
});
