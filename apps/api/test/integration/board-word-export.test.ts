/**
 * Часть E (2026-10-17): сцена КАК ЕЁ ОТДАЁТ СЕРВЕР превращается в .docx и разбирается.
 *
 * Юнит-тест `board-word-docx` работает на сцене, собранной вручную. Здесь доказано другое: сервер
 * хранит и отдаёт ровно те поля, на которых держится разбор (`type`, `x/y/width/height`, `text`,
 * `fontSize`, `angle`, `strokeColor`, `textAlign`), и путь «PUT страницы → GET /board → план →
 * .docx → распаковка» проходит без браузера целиком. Если сервер перестанет отдавать, скажем,
 * `fontSize`, этот тест красный, а юнит — нет.
 */
import { inflateRawSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { planWordBoard } from '@klass/shared';
import type { FastifyInstance } from 'fastify';
import { preparedDb, TEST_DATABASE_URL, type TestDB } from './util.js';
import { buildApp } from '../../src/app.js';
import { classes, users, whiteboards } from '../../src/db/schema.js';
import { hashPassword } from '../../src/lib/password.js';

const suite = TEST_DATABASE_URL ? describe : describe.skip;
const PW = 'Passw0rd123';
const H = (tok: string) => ({ authorization: `Bearer ${tok}` });

/** 1×1 чёрный PNG: в этом тесте важна упаковка документа, а не содержимое растра. */
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

/** Минимальный читатель zip: центральный каталог → локальный заголовок → inflateRaw. */
function documentXml(bytes: Uint8Array): string {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error('не zip: не найден конец центрального каталога');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    if (name === 'word/document.xml') {
      const start = localOff + 30 + buf.readUInt16LE(localOff + 26) + buf.readUInt16LE(localOff + 28);
      const raw = buf.subarray(start, start + compSize);
      return (method === 0 ? Buffer.from(raw) : inflateRawSync(raw)).toString('utf8');
    }
    off += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error('в архиве нет word/document.xml');
}

suite('Word-экспорт: серверная сцена → документ (часть E)', () => {
  let t: TestDB;
  let app: FastifyInstance;
  let teacherTok = '';
  let classId = '';
  let sessionId = '';

  beforeAll(async () => {
    t = await preparedDb(TEST_DATABASE_URL);
    app = await buildApp(t.db);
    const pw = await hashPassword(PW);
    const [teacher] = await t.db.insert(users).values({
      role: 'teacher', name: 'WD Teacher', email: 'wd@x.io', passwordHash: pw, tz: 'UTC',
    }).returning();
    const [cls] = await t.db.insert(classes).values({ name: '7WD', teacherId: teacher.id }).returning();
    classId = cls.id;
    teacherTok = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'wd@x.io', password: PW } }))
      .json().accessToken as string;
  });

  afterAll(async () => { await app?.close(); await t?.sql.end(); });

  it('сохранённая доска отдаётся с полными полями, и из неё собирается редактируемый .docx', async () => {
    const started = await app.inject({ method: 'POST', url: '/api/lessons/start', headers: H(teacherTok), payload: { classId } });
    expect(started.statusCode).toBe(201);
    sessionId = started.json().id as string;

    // сцена ровно та, которую пишет клиент Excalidraw: фигура, обычный текст, многострочный с
    // узбекской буквой, повёрнутый текст и пустой текст
    const saved = await app.inject({
      method: 'PUT', url: `/api/lessons/${sessionId}/board/page`, headers: H(teacherTok),
      payload: {
        pageNo: 1, title: 'Доска про дроби',
        elements: [
          { id: 'r1', type: 'rectangle', x: 10, y: 10, width: 400, height: 300, angle: 0, isDeleted: false, strokeColor: '#1e1e1e' },
          { id: 't1', type: 'text', x: 30, y: 40, width: 240, height: 40, angle: 0, isDeleted: false, fontSize: 28, text: 'Проверка доски', strokeColor: '#c92a2a', textAlign: 'left' },
          { id: 't2', type: 'text', x: 30, y: 120, width: 240, height: 90, angle: 0, isDeleted: false, fontSize: 20, text: 'Oʻzbekcha gʻaraza\nikkinchi qator', textAlign: 'center' },
          { id: 't3', type: 'text', x: 300, y: 250, width: 90, height: 30, angle: 0.6, isDeleted: false, fontSize: 20, text: 'Na kos' },
          { id: 't4', type: 'text', x: 1, y: 1, width: 4, height: 4, angle: 0, isDeleted: false, fontSize: 20, text: '' },
        ],
      },
    });
    expect(saved.statusCode).toBe(200);

    const got = await app.inject({ method: 'GET', url: `/api/lessons/${sessionId}/board`, headers: H(teacherTok) });
    expect(got.statusCode).toBe(200);
    const page = got.json().pages.find((p: { pageNo: number }) => p.pageNo === 1);
    expect(page, 'страница вернулась').toBeTruthy();

    const plan = planWordBoard(page.elements);
    // сервер донёс поля, на которых держится разбор: иначе эти числа были бы другими
    expect(plan.texts.map((x) => x.id), 'пустой текст не редактируется, повёрнутый остаётся картинкой').toEqual(['t1', 't2']);
    expect(plan.texts.find((x) => x.id === 't2')!.fontPx, 'fontSize дошёл с сервера').toBe(20);
    expect(plan.texts.find((x) => x.id === 't1')!.color, 'strokeColor дошёл с сервера').toBe('c92a2a');
    expect(plan.texts.find((x) => x.id === 't2')!.lines).toEqual(['Oʻzbekcha gʻaraza', 'ikkinchi qator']);
    expect(plan.picture.map((e) => e.id)).toEqual(['r1', 't3']);
    expect(plan.rotatedInPicture).toBe(1);

    const { buildWordDocxBytes } = await import('@klass/shared/boardDocxBuild');
    const doc = documentXml(await buildWordDocxBytes({
      mode: 'editable',
      boards: [{ png: PNG_1PX, elements: page.elements as unknown[] }],
      cancelled: () => false,
    }));
    expect((doc.match(/<w:framePr/g) ?? []).length, 'рамки: подложка + два редактируемых текста').toBe(3);
    expect(doc, 'текст с сервера читается в файле побуквенно').toContain('Проверка доски');
    expect(doc, 'oʻ/gʻ (U+02BB) дошли до файла').toContain('Oʻzbekcha gʻaraza');
    expect(doc, 'повёрнутая строка в файл не попала — она в подложке').not.toContain('Na kos');
    expect((doc.match(/<w:drawing>/g) ?? []).length).toBe(1);
    expect((doc.match(/<w:sectPr/g) ?? []).length, 'одна доска — одна страница').toBe(1);
  });

  it('завершённый урок освобождает класс: следующий стартует с чистой доской', async () => {
    // у класса бывал только один живой урок, поэтому `start` вернёт тот же session, пока его
    // не завершить — это проверка на «чистая доска», а не на «привязка к сессии»
    await app.inject({ method: 'POST', url: `/api/lessons/${sessionId}/join`, headers: H(teacherTok), payload: {} });
    const ended = await app.inject({ method: 'POST', url: `/api/lessons/${sessionId}/end`, headers: H(teacherTok), payload: {} });
    expect(ended.statusCode, 'урок завершён').toBeLessThan(300);

    const other = await app.inject({ method: 'POST', url: '/api/lessons/start', headers: H(teacherTok), payload: { classId } });
    expect(other.statusCode).toBe(201);
    const otherId = other.json().id as string;
    expect(otherId, 'новый урок — новая сессия').not.toBe(sessionId);

    const pages = (await app.inject({ method: 'GET', url: `/api/lessons/${otherId}/board`, headers: H(teacherTok) })).json().pages;
    expect(planWordBoard((pages[0] as { elements?: unknown[] } | undefined)?.elements ?? []).texts, 'доска нового урока пуста').toEqual([]);
    const rows = await t.db.select({ id: whiteboards.sessionId }).from(whiteboards)
      .where(eq(whiteboards.sessionId, otherId));
    expect(rows.length, 'черновик страницы не пишет чужую сцену')
      .toBeLessThanOrEqual(1);
  });
});
