/**
 * SEC-14 / SEC-08 (2026-10-28): значимые операции оставляют след в `audit_log`.
 *
 * Отчёт аудита: публикация материалов и объявлений, приложенные файлы, правка и удаление поста,
 * публикация доски и выдача права рисовать, привязка и отвязка личного Telegram — всё это меняло
 * данные класса, но не оставляло ни автора, ни времени, ни цели. Восстановить «кто выложил этот
 * файл» можно было только по машинным таблицам, если они вообще сохранились.
 *
 * Здесь проверяется ровно две вещи для каждой выбранной операции:
 *  1. запись ЕСТЬ, у неё тот актор и та цель (идентификаторы, а не названия);
 *  2. в цели НЕТ содержимого — ни текста задания, ни заголовка, ни имени файла, ни токена привязки.
 *     Журнал не должен становиться второй копией персональных данных (и местом их утечки).
 *
 * `audit()` намеренно fire-and-forget: запись не тормозит ответ. Поэтому тест не спит «достаточно
 * долго», а опрашивает таблицу до появления строки с таймаутом — иначе он проверял бы скорость
 * машины, а не наличие следа.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { TEST_DATABASE_URL, preparedDb, makeTeacher, makeStudent, loginToken, type TestDB } from './util.js';
import { buildApp } from '../../src/app.js';
import { env } from '../../src/env.js';
import { auditLog, classes, telegramLinks } from '../../src/db/schema.js';
import type { FastifyInstance } from 'fastify';

const suite = TEST_DATABASE_URL ? describe : describe.skip;

function multipart(fields: Record<string, string>, file?: { name: string; filename: string; data: Buffer }, boundary = 'AUBOUND') {
  let head = '';
  for (const [k, v] of Object.entries(fields)) {
    head += `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`;
  }
  if (file) {
    head += `--${boundary}\r\nContent-Disposition: form-data; name="${file.name}"; filename="${file.filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`;
    return Buffer.concat([Buffer.from(head, 'utf8'), file.data, Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8')]);
  }
  return Buffer.from(head + `--${boundary}--\r\n`, 'utf8');
}

/** PNG с настоящими magic bytes: публикация доски проходит ту же проверку типа, что и загрузка */
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('audit-idat')]);
const PDF = Buffer.from('%PDF-1.4 audit body');

/** Уникальные маркеры: их отсутствие в журнале и есть доказательство «содержимое не пишется». */
const M = {
  materialTitle: 'маркер-заголовок-материала-8c1f',
  materialBody: 'маркер-описание-материала-8c1f',
  announcementTitle: 'маркер-объявления-8c1f',
  announcementBody: 'маркер-текста-объявления-8c1f',
  fileName: 'маркер-имени-файла-8c1f.pdf',
  linkTitle: 'маркер-названия-ссылки-8c1f',
  editedTitle: 'маркер-новой-темы-8c1f',
  draftTitle: 'маркер-черновика-8c1f',
  boardTitle: 'маркер-доски-8c1f',
};

suite('SEC-14: журнал значимых операций без содержимого', () => {
  let t: TestDB; let app: FastifyInstance;
  let teacherId = '', teacherTok = '', classId = '', studentId = '', studentEmail = '';

  const postJson = (url: string, payload: Record<string, unknown> = {}) =>
    app.inject({ method: 'POST', url, headers: { authorization: `Bearer ${teacherTok}` }, payload });
  const upload = (url: string, fields: Record<string, string>, file?: { name: string; filename: string; data: Buffer }) =>
    app.inject({
      method: 'POST', url,
      headers: { authorization: `Bearer ${teacherTok}`, 'content-type': 'multipart/form-data; boundary=AUBOUND' },
      payload: multipart(fields, file),
    });

  async function rowsOf(action: string) {
    return t.db.select().from(auditLog).where(eq(auditLog.action, action));
  }
  /** fire-and-forget: ждём строку с нужной целью, а не «немного времени» */
  async function waitAudit(action: string, pred: (target: Record<string, unknown>) => boolean = () => true) {
    const deadline = Date.now() + 3000;
    for (;;) {
      const rows = await rowsOf(action);
      const hit = rows.find((r) => pred((r.target ?? {}) as Record<string, unknown>));
      if (hit) return hit;
      if (Date.now() > deadline) throw new Error(`в audit_log нет записи «${action}» с этой целью`);
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  beforeAll(async () => {
    t = await preparedDb(TEST_DATABASE_URL);
    env.RATE_LOGIN_MAX = 500;
    app = await buildApp(t.db);
    const te = await makeTeacher(t.sql, `audit-t-${Date.now()}@x.io`);
    teacherId = te.id;
    teacherTok = await loginToken(app, te.email);
    const [c] = await t.db.insert(classes).values({ teacherId, name: 'Журнал' }).returning();
    classId = c!.id;
    const st = await makeStudent(t.sql, { classId, email: `audit-s-${Date.now()}@x.io` });
    studentId = st.id; studentEmail = st.email;
  });
  afterAll(async () => { await app?.close(); await t?.sql.end(); });

  let postId = '';

  it('material_create: класс, пост, счётчики — без заголовка, текста и имени файла', async () => {
    const r = await upload(`/api/classes/${classId}/materials`, {
      title: M.materialTitle,
      description: M.materialBody,
      attachments: JSON.stringify([{ url: 'https://example.com/a', title: 'А' }, { url: 'https://youtu.be/x', title: 'Б' }]),
    }, { name: 'file', filename: M.fileName, data: PDF });
    expect(r.statusCode, r.body).toBe(201);
    postId = r.json().id as string;

    const row = await waitAudit('material_create', (tg) => tg.postId === postId);
    expect(row.actorId).toBe(teacherId);
    expect(row.target).toMatchObject({ classId, postId, status: 'published', files: 1, links: 2 });
    const wire = JSON.stringify(row.target);
    expect(wire, 'заголовок не копируется в журнал').not.toContain(M.materialTitle);
    expect(wire, 'текст не копируется в журнал').not.toContain(M.materialBody);
    expect(wire, 'имя файла не копируется в журнал').not.toContain(M.fileName);
  });

  it('file_attach: факт и счётчик, но не имя файла', async () => {
    const r = await upload(`/api/posts/${postId}/files`, {}, { name: 'file', filename: M.fileName, data: PDF });
    expect(r.statusCode, r.body).toBe(201);
    const row = await waitAudit('file_attach', (tg) => tg.postId === postId);
    expect(row.actorId).toBe(teacherId);
    expect(row.target).toMatchObject({ classId, postId, files: 1 });
    expect(JSON.stringify(row.target)).not.toContain(M.fileName);
  });

  it('announcement_create: идентификаторы поста, без заголовка и текста', async () => {
    const r = await postJson(`/api/classes/${classId}/announcements`, { title: M.announcementTitle, body: M.announcementBody });
    expect(r.statusCode, r.body).toBe(201);
    const row = await waitAudit('announcement_create', (tg) => tg.postId === r.json().id);
    expect(row.target).toMatchObject({ classId, postId: r.json().id });
    const wire = JSON.stringify(row.target);
    expect(wire).not.toContain(M.announcementTitle);
    expect(wire).not.toContain(M.announcementBody);
  });

  it('post_update: имена изменённых полей и число адресатов, но не новый текст и не почта', async () => {
    const r = await app.inject({
      method: 'PATCH', url: `/api/posts/${postId}`,
      headers: { authorization: `Bearer ${teacherTok}` },
      payload: { title: M.editedTitle, audience: [studentId] },
    });
    expect(r.statusCode, r.body).toBe(200);
    const row = await waitAudit('post_update', (tg) => tg.postId === postId && tg.audienceCount === 1);
    expect(row.target).toMatchObject({ classId, postId, audienceCount: 1 });
    expect((row.target as { fields: string[] }).fields).toContain('title');
    const wire = JSON.stringify(row.target);
    expect(wire).not.toContain(M.editedTitle);
    expect(wire).not.toContain(studentEmail);
  });

  it('attachment_link_add / attachment_remove: идентификатор вложения, без названия ссылки', async () => {
    const added = await postJson(`/api/posts/${postId}/attachments`, { url: 'https://example.com/lesson', title: M.linkTitle });
    expect(added.statusCode, added.body).toBe(201);
    const attId = added.json().id as string;

    const addRow = await waitAudit('attachment_link_add', (tg) => tg.attachmentId === attId);
    expect(addRow.target).toMatchObject({ classId, postId, attachmentId: attId });
    expect(JSON.stringify(addRow.target)).not.toContain(M.linkTitle);

    const gone = await app.inject({
      method: 'DELETE', url: `/api/posts/${postId}/attachments/${attId}`,
      headers: { authorization: `Bearer ${teacherTok}` },
    });
    expect(gone.statusCode).toBe(200);
    const rmRow = await waitAudit('attachment_remove', (tg) => tg.attachmentId === attId);
    expect(rmRow.target).toMatchObject({ classId, postId, attachmentId: attId });
    expect(JSON.stringify(rmRow.target)).not.toContain(M.linkTitle);
  });

  it('post_publish: черновик стал публикацией — след есть', async () => {
    const draft = await upload(`/api/classes/${classId}/materials`, { title: M.draftTitle, publish: 'draft' });
    expect(draft.statusCode, draft.body).toBe(201);
    const draftId = draft.json().id as string;
    const pub = await postJson(`/api/posts/${draftId}/publish`, {});
    expect(pub.statusCode, pub.body).toBe(200);
    const row = await waitAudit('post_publish', (tg) => tg.postId === draftId);
    expect(row.target).toMatchObject({ classId, postId: draftId });
    expect(JSON.stringify(row.target)).not.toContain(M.draftTitle);
  });

  it('post_delete: вид и идентификаторы удалённого поста', async () => {
    const draft = await upload(`/api/classes/${classId}/materials`, { title: M.draftTitle, publish: 'draft' });
    const id = draft.json().id as string;
    const del = await app.inject({
      method: 'DELETE', url: `/api/posts/${id}`,
      headers: { authorization: `Bearer ${teacherTok}` },
    });
    expect(del.statusCode).toBe(200);
    const row = await waitAudit('post_delete', (tg) => tg.postId === id);
    expect(row.target).toMatchObject({ classId, postId: id, kind: 'material' });
  });

  it('board_publish: урок и пост, без заголовка страницы', async () => {
    const start = await postJson('/api/lessons/start', { classId });
    // 201 — урок создан, 200 — вернулась уже активная сессия класса (startLesson идемпотентен)
    expect([200, 201], start.body).toContain(start.statusCode);
    const lessonId = start.json().id as string;
    const pub = await postJson(`/api/lessons/${lessonId}/board/publish`, {
      dataUrl: `data:image/png;base64,${PNG.toString('base64')}`, kind: 'png', title: M.boardTitle,
    });
    expect(pub.statusCode, pub.body).toBe(201);
    const row = await waitAudit('board_publish', (tg) => tg.lessonId === lessonId);
    expect(row.target).toMatchObject({ classId, lessonId, postId: pub.json().postId, kind: 'png' });
    expect(JSON.stringify(row.target)).not.toContain(M.boardTitle);
  });

  it('board_draw_permission: кому и что разрешили — след по идентификатору ученика', async () => {
    const start = await postJson('/api/lessons/start', { classId });
    const lessonId = start.json().id as string;
    const r = await postJson(`/api/lessons/${lessonId}/board/draw`, { userId: studentId, allow: true });
    expect(r.statusCode, r.body).toBe(200);
    const row = await waitAudit('board_draw_permission', (tg) => tg.lessonId === lessonId && tg.userId === studentId);
    expect(row.target).toMatchObject({ classId, lessonId, userId: studentId, allow: true });
    expect(JSON.stringify(row.target)).not.toContain(studentEmail);
  });

  it('telegram_unlink: был ли канал привязан и к какому чату — без токена', async () => {
    await t.db.insert(telegramLinks).values({ userId: teacherId, chatId: '777001' });
    const r = await app.inject({
      method: 'DELETE', url: '/api/me/telegram-link',
      headers: { authorization: `Bearer ${teacherTok}` },
    });
    expect(r.statusCode).toBe(200);
    const row = await waitAudit('telegram_unlink', (tg) => tg.hadLink === true);
    expect(row.actorId).toBe(teacherId);
    expect(row.target).toMatchObject({ channel: 'personal', hadLink: true, chatId: '777001' });
  });

  it('telegram_link_request: одноразовый токен не попадает в журнал', async () => {
    const prevTok = env.TELEGRAM_BOT_TOKEN, prevName = env.TELEGRAM_BOT_NAME;
    env.TELEGRAM_BOT_TOKEN = '1:audit-test'; env.TELEGRAM_BOT_NAME = 'audit_bot';
    try {
      const r = await postJson('/api/me/telegram-link', {});
      expect(r.statusCode, r.body).toBe(200);
      const { token, url } = r.json() as { token: string; url: string };
      expect(token.length, 'токен действительно выдан').toBeGreaterThan(10);
      const row = await waitAudit('telegram_link_request');
      expect(row.target).toMatchObject({ channel: 'personal' });
      const wire = JSON.stringify(row.target);
      expect(wire, 'токен привязки в журнале — это утечка').not.toContain(token);
      expect(wire).not.toContain(url);
      expect(wire).not.toContain('t.me');
    } finally {
      env.TELEGRAM_BOT_TOKEN = prevTok; env.TELEGRAM_BOT_NAME = prevName;
    }
  });

  it('сводно: ни в одной записи журнала нет пароля, текста или запрещённых ключей', async () => {
    const all = await t.db.select().from(auditLog);
    expect(all.length, 'записи вообще появились').toBeGreaterThan(7);
    const wire = JSON.stringify(all);
    const forbiddenValues = [
      'Passw0rd123', M.materialTitle, M.materialBody, M.announcementTitle, M.announcementBody,
      M.fileName, M.linkTitle, M.editedTitle, M.draftTitle, M.boardTitle,
    ];
    for (const v of forbiddenValues) expect(wire, `«${v}» не должно быть в журнале`).not.toContain(v);
    const forbiddenKeys = ['password', 'passwordHash', 'token', 'body', 'text', 'title', 'filename', 'name', 'email'];
    for (const row of all) {
      for (const k of Object.keys((row.target ?? {}) as Record<string, unknown>)) {
        expect(forbiddenKeys, `ключ «${k}» в журнале слишком содержателен`).not.toContain(k);
      }
    }
  });
});
