import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DB } from '../db/index.js';
import { resolveClass } from '../services/classes.js';
import { getSession } from '../services/lessons.js';
import {
  ARCHIVE_PAGE_MAX, archiveBoards, archiveComments, archiveAttendance, deleteArchiveEntry,
  listArchive, parseCursor,
} from '../services/lessonArchive.js';

/**
 * Часть 4 (2026-10-14): архив уроков.
 *
 * Три правила доступа, и все три проверяются здесь, на сервере:
 *  - учителю класса — список, доски, комментарии и участники;
 *  - ученику — ТОЛЬКО доски, и только когда учитель включил переключатель класса
 *    «показывать архив досок ученикам» (по умолчанию выключен). Без переключателя ответ
 *    неотличим от «такого класса нет»: 404, а не 403 — иначе список классов утекает по коду;
 *  - чужой класс и несуществующий урок отвечают одинаковым 404 с одинаковым телом.
 *
 * Просмотр идёт обычными GET-запросами: ни сокета, ни одноразового билета архиву не нужно — он
 * ничего не меняет.
 */
export async function lessonArchiveRoutes(app: FastifyInstance, opts: { db: DB }) {
  const { db } = opts;

  /** Кто смотрит и что ему можно. `null` — отвечено 404, маршрут заканчивает здесь. */
  async function access(req: { user: { id: string; role: 'teacher' | 'student' } | null },
    reply: import('fastify').FastifyReply, classId: string) {
    const cls = await resolveClass(db, req.user!.id, req.user!.role, classId);
    if (!cls) { await reply.code(404).send({ error: 'notFound' }); return null; }
    const isTeacher = req.user!.role === 'teacher';
    if (!isTeacher && !cls.boardArchivePublic) { await reply.code(404).send({ error: 'notFound' }); return null; }
    return { cls, isTeacher };
  }

  app.get('/api/classes/:id/lessons/archive', { preHandler: app.authenticate }, async (req, reply) => {
    const classId = (req.params as { id: string }).id;
    const q = z.object({
      limit: z.coerce.number().int().min(1).max(ARCHIVE_PAGE_MAX).default(20),
      before: z.string().optional(),
      // ссылка из прошедшего события календаря: архив по event_id. uuid() обязателен — иначе
      // Postgres падает на разборе значения, а не отвечает «пусто».
      event: z.string().uuid().optional(),
    }).safeParse(req.query ?? {});
    if (!q.success) return reply.code(400).send({ error: 'invalidInput' });
    const seen = await access(req, reply, classId);
    if (!seen) return;
    const page = await listArchive(db, {
      classId: seen.cls.id, before: parseCursor(q.data.before), limit: q.data.limit, eventId: q.data.event ?? null,
    });
    return {
      // ученику не отдаются ни число комментариев, ни число участников: ему положены доски
      items: page.items.map((r) => (seen.isTeacher ? r
        : { id: r.id, startedAt: r.startedAt, endedAt: r.endedAt, eventId: r.eventId, durationMin: r.durationMin, boards: r.boards })),
      nextCursor: page.nextCursor,
      canManage: seen.isTeacher,
    };
  });

  app.get('/api/lessons/:id/archive', { preHandler: app.authenticate }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const s = await getSession(db, id);
    // незавершённый урок в архив не пускает: у него есть живая страница урока
    if (!s || !s.endedAt) return reply.code(404).send({ error: 'notFound' });
    const seen = await access(req, reply, s.classId);
    if (!seen) return;
    const boards = await archiveBoards(db, id);
    if (!seen.isTeacher) {
      return {
        session: {
          id: s.id, classId: s.classId, eventId: s.eventId, startedAt: s.startedAt, endedAt: s.endedAt,
        },
        boards, canManage: false,
      };
    }
    return {
      session: {
        id: s.id, classId: s.classId, eventId: s.eventId, startedAt: s.startedAt, endedAt: s.endedAt,
        lectureMode: s.lectureMode, commentsMode: s.commentsMode,
      },
      boards,
      comments: await archiveComments(db, id),
      attendance: await archiveAttendance(db, id),
      canManage: true,
    };
  });

  // Учитель удаляет запись архива; каскад уносит доски, комментарии, руки и присутствие.
  app.delete('/api/lessons/:id/archive', { preHandler: app.authenticateTeacher }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const s = await getSession(db, id);
    if (!s || !s.endedAt) return reply.code(404).send({ error: 'notFound' });
    const cls = await resolveClass(db, req.user!.id, 'teacher', s.classId);
    if (!cls) return reply.code(404).send({ error: 'notFound' });
    const ok = await deleteArchiveEntry(db, id);
    if (!ok) return reply.code(404).send({ error: 'notFound' });
    return { ok: true };
  });
}
