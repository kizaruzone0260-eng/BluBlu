import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DB } from '../db/index.js';
import { resolveClass } from '../services/classes.js';
import {
  listNotes, createNote, updateNote, deleteNote, getNote, publishNote,
} from '../services/posts.js';

/** §3.4 — notes are visible only to their author. */
export async function noteRoutes(app: FastifyInstance, opts: { db: DB }) {
  const { db } = opts;
  const bodySchema = z.object({
    classId: z.string().uuid(),
    title: z.string().trim().max(200).default(''),
    body: z.string().max(200000).default(''),
  });
  const patchSchema = bodySchema.omit({ classId: true }).partial();

  app.get('/api/notes', { preHandler: app.authenticateTeacher }, async (req) => {
    const classId = (req.query as { classId?: string }).classId;
    return listNotes(db, req.user!.id, classId);
  });

  app.post('/api/notes', { preHandler: app.authenticateTeacher }, async (req, reply) => {
    const p = bodySchema.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: 'invalidInput' });
    const cls = await resolveClass(db, req.user!.id, 'teacher', p.data.classId);
    if (!cls) return reply.code(404).send({ error: 'notFound' });
    const n = await createNote(db, req.user!.id, cls.id, p.data.title, p.data.body);
    return reply.code(201).send(n);
  });

  app.patch('/api/notes/:id', { preHandler: app.authenticateTeacher }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const p = patchSchema.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: 'invalidInput' });
    const existing = await getNote(db, req.user!.id, id);
    if (!existing) return reply.code(404).send({ error: 'notFound' });
    const n = await updateNote(db, req.user!.id, id, p.data);
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
    const postId = await publishNote(db, req.user!.id, id);
    if (!postId) return reply.code(404).send({ error: 'notFound' });
    return { postId };
  });
}
