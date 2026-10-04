import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, desc, eq } from 'drizzle-orm';
import { noteHasContent } from '@klass/shared';
import type { DB } from '../db/index.js';
import { studentNotes, lessonSessions } from '../db/schema.js';
import { resolveClass } from '../services/classes.js';

/** §3.8 — private sheets: visible only to their owner (teacher never sees them). */
export async function studentNoteRoutes(app: FastifyInstance, opts: { db: DB }) {
  const { db } = opts;
  const bodySchema = z.object({
    classId: z.string().uuid(),
    sessionId: z.string().uuid().nullable().optional(),
    title: z.string().max(200).default(''),
    body: z.string().max(200000).default(''),
  });
  const patchSchema = z.object({
    title: z.string().max(200).optional(),
    body: z.string().max(200000).optional(),
  });

  app.get('/api/student-notes', { preHandler: app.authenticate }, async (req) => {
    const q = req.query as { classId?: string; sessionId?: string };
    if (req.user!.role === 'teacher') return []; // teachers never see student sheets
    if (q.classId) {
      return db.select().from(studentNotes)
        .where(and(eq(studentNotes.userId, req.user!.id), eq(studentNotes.classId, q.classId)))
        .orderBy(desc(studentNotes.updatedAt));
    }
    if (q.sessionId) {
      return db.select().from(studentNotes)
        .where(and(eq(studentNotes.userId, req.user!.id), eq(studentNotes.sessionId, q.sessionId)))
        .orderBy(desc(studentNotes.updatedAt));
    }
    return db.select().from(studentNotes)
      .where(eq(studentNotes.userId, req.user!.id))
      .orderBy(desc(studentNotes.updatedAt));
  });

  app.post('/api/student-notes', { preHandler: app.authenticate }, async (req, reply) => {
    if (req.user!.role !== 'student') return reply.code(403).send({ error: 'forbidden' });
    const p = bodySchema.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: 'invalidInput' });
    if (!noteHasContent(p.data.title, p.data.body)) return reply.code(400).send({ error: 'noteEmpty', message: 'A note needs a title or some text (at least one non-blank character)' });
    const cls = await resolveClass(db, req.user!.id, 'student', p.data.classId);
    if (!cls) return reply.code(404).send({ error: 'notFound' });
    if (p.data.sessionId) {
      const [s] = await db.select({ classId: lessonSessions.classId }).from(lessonSessions)
        .where(eq(lessonSessions.id, p.data.sessionId)).limit(1);
      if (!s || s.classId !== p.data.classId) return reply.code(400).send({ error: 'invalidInput' });
    }
    const [row] = await db.insert(studentNotes).values({
      userId: req.user!.id, classId: p.data.classId,
      sessionId: p.data.sessionId ?? null, title: p.data.title, body: p.data.body,
    }).returning();
    return reply.code(201).send(row);
  });

  app.patch('/api/student-notes/:id', { preHandler: app.authenticate }, async (req, reply) => {
    const p = patchSchema.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: 'invalidInput' });
    if (p.data.title !== undefined || p.data.body !== undefined) {
      const [ex] = await db.select({ title: studentNotes.title, body: studentNotes.body })
        .from(studentNotes)
        .where(and(eq(studentNotes.id, (req.params as { id: string }).id), eq(studentNotes.userId, req.user!.id)))
        .limit(1);
      if (!ex) return reply.code(404).send({ error: 'notFound' });
      if (!noteHasContent(p.data.title ?? ex.title, p.data.body ?? ex.body)) return reply.code(400).send({ error: 'noteEmpty', message: 'A note needs a title or some text (at least one non-blank character)' });
    }
    const [row] = await db.update(studentNotes)
      .set({ ...p.data, updatedAt: new Date() })
      .where(and(eq(studentNotes.id, (req.params as { id: string }).id), eq(studentNotes.userId, req.user!.id)))
      .returning();
    if (!row) return reply.code(404).send({ error: 'notFound' });
    return row;
  });

  app.delete('/api/student-notes/:id', { preHandler: app.authenticate }, async (req, reply) => {
    const [row] = await db.delete(studentNotes)
      .where(and(eq(studentNotes.id, (req.params as { id: string }).id), eq(studentNotes.userId, req.user!.id)))
      .returning({ id: studentNotes.id });
    if (!row) return reply.code(404).send({ error: 'notFound' });
    return { ok: true };
  });
}
