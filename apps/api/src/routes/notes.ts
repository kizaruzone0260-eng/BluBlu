import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { noteHasContent } from '@klass/shared';
import type { DB } from '../db/index.js';
import { events } from '../db/schema.js';
import { resolveClass } from '../services/classes.js';
import {
  listNotes, createNote, updateNote, deleteNote, getNote, publishNote,
} from '../services/posts.js';

/** §3.4 — notes are visible only to their author. */
export async function noteRoutes(app: FastifyInstance, opts: { db: DB }) {
  const { db } = opts;
  const bodySchema = z.object({
    classId: z.string().uuid().nullable().optional(),
    eventId: z.string().uuid().nullable().optional(),
    pinned: z.boolean().optional(),
    title: z.string().trim().max(200).default(''),
    // item 3: the body may carry an embedded vector drawing (≤ ~500 KB encoded)
    body: z.string().max(800000).default(''),
  });
  /**
   * PATCH-схема собрана отдельно, а не `bodySchema.partial()` — тот же лов Zod 4, из-за которого
   * `classUpdateSchema` тоже перестала быть `.partial()`: в четвёрке `.partial()` СОХРАНЯЕТ
   * `default()`, поэтому запрос «закрепить заметку» (`{pinned: true}`) разбирался в
   * `{pinned: true, title: '', body: ''}`, и маршрут добросовестно затирал и заголовок, и текст
   * — а вместо 200 человек получал 400 `noteEmpty`. Замер сделан на 4.6.7 до правки и повторён
   * тестом после неё. Отсутствие ключа здесь снова значит «не трогать»; length-политика та же,
   * что у создания, значений по умолчанию нет ни у одного поля.
   */
  const patchSchema = z.object({
    classId: z.string().uuid().nullable().optional(),
    eventId: z.string().uuid().nullable().optional(),
    pinned: z.boolean().optional(),
    title: z.string().trim().max(200).optional(),
    // item 3: the body may carry an embedded vector drawing (≤ ~500 KB encoded)
    body: z.string().max(800000).optional(),
  });

  app.get('/api/notes', { preHandler: app.authenticateTeacher }, async (req) => {
    const classId = (req.query as { classId?: string }).classId;
    return listNotes(db, req.user!.id, classId);
  });

  app.post('/api/notes', { preHandler: app.authenticateTeacher }, async (req, reply) => {
    const p = bodySchema.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: 'invalidInput' });
    let classId: string | null = p.data.classId ?? null;
    if (classId) {
      const cls = await resolveClass(db, req.user!.id, 'teacher', classId);
      if (!cls) return reply.code(404).send({ error: 'notFound' });
      classId = cls.id;
    }
    // at least one non-blank char in title OR body text (client enforces too; §notes).
    // AFTER the §7 rights check — a foreign class must still answer 404, not 400.
    if (!noteHasContent(p.data.title, p.data.body)) return reply.code(400).send({ error: 'noteEmpty', message: 'A note needs a title or some text (at least one non-blank character)' });
    // the lesson an optional link points at must belong to the same class (§7 ownership)
    let eventId: string | null = p.data.eventId ?? null;
    if (eventId) {
      const [ev] = await db.select({ classId: events.classId }).from(events).where(eq(events.id, eventId)).limit(1);
      if (!ev || (classId !== null && ev.classId !== classId)) return reply.code(400).send({ error: 'invalidInput' });
      const cls = await resolveClass(db, req.user!.id, 'teacher', ev.classId);
      if (!cls) return reply.code(404).send({ error: 'notFound' });
      classId ??= ev.classId;
    }
    const n = await createNote(db, req.user!.id, classId, p.data.title, p.data.body, eventId);
    return reply.code(201).send(n);
  });

  app.patch('/api/notes/:id', { preHandler: app.authenticateTeacher }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const p = patchSchema.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: 'invalidInput' });
    const existing = await getNote(db, req.user!.id, id);
    if (!existing) return reply.code(404).send({ error: 'notFound' });
    if (p.data.title !== undefined || p.data.body !== undefined) {
      const mergedTitle = p.data.title ?? existing.title;
      const mergedBody = p.data.body ?? existing.body;
      if (!noteHasContent(mergedTitle, mergedBody)) return reply.code(400).send({ error: 'noteEmpty', message: 'A note needs a title or some text (at least one non-blank character)' });
    }
    const patch: Record<string, unknown> = { ...p.data };
    if (p.data.classId !== undefined && p.data.classId !== null) {
      const cls = await resolveClass(db, req.user!.id, 'teacher', p.data.classId);
      if (!cls) return reply.code(404).send({ error: 'notFound' });
      patch.classId = cls.id;
    }
    if (p.data.eventId) {
      const [ev] = await db.select({ classId: events.classId }).from(events).where(eq(events.id, p.data.eventId)).limit(1);
      const cid = (patch.classId as string | null | undefined) ?? existing.classId;
      if (!ev || (cid !== null && cid !== undefined && ev.classId !== cid)) return reply.code(400).send({ error: 'invalidInput' });
      const cls = await resolveClass(db, req.user!.id, 'teacher', ev.classId);
      if (!cls) return reply.code(404).send({ error: 'notFound' });
    }
    const n = await updateNote(db, req.user!.id, id, patch);
    return n;
  });

  app.delete('/api/notes/:id', { preHandler: app.authenticateTeacher }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const ok = await deleteNote(db, req.user!.id, id);
    if (!ok) return reply.code(404).send({ error: 'notFound' });
    return { ok: true };
  });

  app.post('/api/notes/:id/publish', { preHandler: app.authenticateTeacher }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const res = await publishNote(db, req.user!.id, id);
    if (res === 'no-class') return reply.code(400).send({ error: 'notes.pickClass' });
    if (!res) return reply.code(404).send({ error: 'notFound' });
    return { postId: res };
  });
}
