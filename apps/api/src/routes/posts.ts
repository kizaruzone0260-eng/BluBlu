import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { posts as postsTable } from '../db/schema.js';
import type { DB } from '../db/index.js';
import { resolveClass } from '../services/classes.js';
import {
  getFeed, createMaterial, createAnnouncement, updatePost, deletePost,
  getFileWithClass, UploadRejected,
} from '../services/posts.js';
import { getStorage } from '../storage/provider.js';
import { isInlineSafe } from '../lib/magic.js';

const postPatchSchema = z.object({
  title: z.string().trim().max(200).optional(),
  body: z.string().max(20000).optional(),
  pinned: z.boolean().optional(),
  topic: z.string().trim().max(120).nullable().optional(),
});

async function memberOrTeacher(db: DB, req: FastifyRequest, reply: FastifyReply, classId: string) {
  if (!req.user) { await reply.code(401).send({ error: 'unauthorized' }); return null; }
  return resolveClass(db, req.user.id, req.user.role, classId);
}

export async function postRoutes(app: FastifyInstance, opts: { db: DB }) {
  const { db } = opts;

  // Feed: newest first, pinned on top; class members + teacher (§7 → 404 otherwise)
  app.get('/api/classes/:id/feed', { preHandler: app.authenticate }, async (req, reply) => {
    const classId = (req.params as { id: string }).id;
    if (!z.string().uuid().safeParse(classId).success) return reply.code(404).send({ error: 'notFound' });
    const cls = await memberOrTeacher(db, req, reply, classId);
    if (!cls) return reply.code(404).send({ error: 'notFound' });
    return getFeed(db, cls.id);
  });

  // Teacher creates material with 0..n files (multipart)
  app.post('/api/classes/:id/materials', {
    preHandler: app.authenticateTeacher,
  }, async (req, reply) => {
    const classId = (req.params as { id: string }).id;
    const cls = await memberOrTeacher(db, req, reply, classId);
    if (!cls) return reply.code(404).send({ error: 'notFound' });
    if (!req.isMultipart()) return reply.code(400).send({ error: 'invalidInput' });

    const fields: Record<string, string> = {};
    const uploaded: { buffer: Buffer; filename: string }[] = [];
    try {
      for await (const part of req.parts()) {
        if (part.type === 'file') {
          const buf = await part.toBuffer();
          uploaded.push({ buffer: buf, filename: part.filename });
        } else {
          fields[part.fieldname] = String(part.value);
        }
      }
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      if (/too.?large|FILE_TOO_LARGE/i.test(msg)) return reply.code(413).send({ error: 'tooLarge' });
      throw e;
    }
    const title = (fields.title ?? '').trim().slice(0, 200);
    const description = (fields.description ?? '').trim().slice(0, 4000);
    const topic = (fields.topic ?? '').trim().slice(0, 120) || undefined;
    if (!title || uploaded.length === 0) return reply.code(400).send({ error: 'invalidInput' });
    try {
      const post = await createMaterial(db, req.user!.id, cls.id, { title, description, topic }, uploaded);
      return reply.code(201).send(post);
    } catch (e) {
      if (e instanceof UploadRejected) {
        const code = e.reason === 'tooLarge' ? 413 : e.reason === 'quotaExceeded' ? 507 : 415;
        return reply.code(code).send({ error: e.reason });
      }
      throw e;
    }
  });

  app.post('/api/classes/:id/announcements', { preHandler: app.authenticateTeacher }, async (req, reply) => {
    const classId = (req.params as { id: string }).id;
    const cls = await memberOrTeacher(db, req, reply, classId);
    if (!cls) return reply.code(404).send({ error: 'notFound' });
    const p = z.object({ title: z.string().trim().max(200), body: z.string().max(4000) }).safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: 'invalidInput' });
    const post = await createAnnouncement(db, req.user!.id, cls.id, p.data.title, p.data.body);
    return reply.code(201).send(post);
  });

  app.patch('/api/posts/:postId', { preHandler: app.authenticateTeacher }, async (req, reply) => {
    const postId = (req.params as { postId: string }).postId;
    const p = postPatchSchema.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: 'invalidInput' });
    const existing = await db.select().from(postsTable).where(eq(postsTable.id, postId)).limit(1).then((r) => r[0]);
    if (!existing) return reply.code(404).send({ error: 'notFound' });
    const cls = await memberOrTeacher(db, req, reply, existing.classId);
    if (!cls) return reply.code(404).send({ error: 'notFound' });
    const updated = await updatePost(db, postId, p.data);
    return updated;
  });

  app.delete('/api/posts/:postId', { preHandler: app.authenticateTeacher }, async (req, reply) => {
    const postId = (req.params as { postId: string }).postId;
    const existing = await db.select().from(postsTable).where(eq(postsTable.id, postId)).limit(1).then((r) => r[0]);
    if (!existing) return reply.code(404).send({ error: 'notFound' });
    const cls = await memberOrTeacher(db, req, reply, existing.classId);
    if (!cls) return reply.code(404).send({ error: 'notFound' });
    await deletePost(db, postId);
    return { ok: true };
  });

  // ─── files: authorized delivery only (§3.3). Never inline-executable, always nosniff. ───
  async function serveFile(req: FastifyRequest, reply: FastifyReply, inline: boolean) {
    const fileId = (req.params as { id: string }).id;
    if (!z.string().uuid().safeParse(fileId).success) return reply.code(404).send({ error: 'notFound' });
    const row = await getFileWithClass(db, fileId);
    if (!row) return reply.code(404).send({ error: 'notFound' });
    const cls = await memberOrTeacher(db, req, reply, row.classId);
    if (!cls) return reply.code(404).send({ error: 'notFound' });
    if (inline && !isInlineSafe(row.file.mime)) return reply.code(400).send({ error: 'notPreviewable' });

    const storage = getStorage();
    let range: { start: number; end?: number } | undefined;
    const rangeHeader = req.headers.range;
    if (rangeHeader) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
      if (m) {
        const size = await storage.stat(row.file.storageKey);
        if (size === null) return reply.code(404).send({ error: 'notFound' });
        const start = m[1] ? Number(m[1]) : 0;
        const end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
        if (start >= size || start > end) return reply.code(416).header('content-range', `bytes */${size}`).send();
        range = { start, end };
      }
    }
    const opened = await storage.open(row.file.storageKey, range);
    if (!opened) return reply.code(404).send({ error: 'notFound' });

    reply.header('content-type', row.file.mime);
    reply.header('x-content-type-options', 'nosniff');
    reply.header('content-disposition',
      `${inline && isInlineSafe(row.file.mime) ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(row.file.originalName)}`);
    reply.header('accept-ranges', 'bytes');
    if (range) {
      reply.code(206);
      reply.header('content-range', `bytes ${opened.start}-${opened.end}/${opened.size}`);
      reply.header('content-length', String(opened.end - opened.start + 1));
    } else {
      reply.header('content-length', String(opened.size));
    }
    return reply.send(opened.stream);
  }

  app.get('/api/files/:id', { preHandler: app.authenticate }, (req, reply) => serveFile(req, reply, false));
  app.get('/api/files/:id/inline', { preHandler: app.authenticate }, (req, reply) => serveFile(req, reply, true));
}
