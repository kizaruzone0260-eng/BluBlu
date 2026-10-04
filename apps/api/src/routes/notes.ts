import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
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
    body: z.string().max(200000).default(''),
  });
  const patchSchema = bodySchema.partial();

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
