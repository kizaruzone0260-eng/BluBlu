import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { posts as postsTable, topics as topicsTable } from '../db/schema.js';
import type { DB } from '../db/index.js';
import { resolveClass } from '../services/classes.js';
import {
  getFeed, createMaterial, createAnnouncement, updatePost, deletePost,
  getFileWithClass, canSeePost, UploadRejected, MaterialRejected,
  safeExternalUrl, listTopics, getOrCreateTopic, addFilesToPost, addLinkAttachment,
  removeAttachment, publishPost, notifyMaterialPublished, setPostAudience,
} from '../services/posts.js';
import { getStorage } from '../storage/provider.js';
import { isInlineSafe, fileCsp } from '../lib/magic.js';
import { tryAcquireUploadSlot, releaseUploadSlot } from '../lib/uploadGate.js';
import { audit } from '../services/audit.js';
import { enqueueNotification } from '../services/notify.js';
import { classTitle, schedulePostPublish } from '../services/notifyQueue.js';

/**
 * Material form (task A). One endpoint family for materials, topics and
 * attachments; every read enforces the same visibility rule (published +
 * audience) server-side, so a student can never reach a draft, a scheduled
 * post or material they are not addressed in.
 */

const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const postPatchSchema = z.object({
  title: z.string().trim().max(200).optional(),
  body: z.string().max(20000).optional(),
  pinned: z.boolean().optional(),
  topicId: z.string().uuid().nullable().optional(),
  audience: z.array(z.string().uuid()).max(500).optional(),
});
const linkSchema = z.object({ url: z.string().min(1).max(2000), title: z.string().max(200).default('') });
const topicSchema = z.object({ name: z.string().trim().min(1).max(120) });

function parseJsonArray(raw: string | undefined): unknown[] | null | 'bad' {
  if (!raw || !raw.trim()) return null;
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : 'bad';
  } catch { return 'bad'; }
}

async function memberOrTeacher(db: DB, req: FastifyRequest, reply: FastifyReply, classId: string) {
  if (!req.user) { await reply.code(401).send({ error: 'unauthorized' }); return null; }
  return resolveClass(db, req.user.id, req.user.role, classId);
}

/** multipart reader shared by the two file endpoints */
async function readMultipart(req: FastifyRequest, reply: FastifyReply) {
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
    if (/too.?large|FILE_TOO_LARGE/i.test(msg)) { await reply.code(413).send({ error: 'tooLarge' }); return null; }
    throw e;
  }
  return { fields, uploaded };
}

function rejectToReply(e: unknown, reply: FastifyReply) {
  if (e instanceof UploadRejected) {
    const code = e.reason === 'tooLarge' ? 413 : e.reason === 'quotaExceeded' ? 507 : 415;
    return reply.code(code).send({ error: e.reason });
  }
  if (e instanceof MaterialRejected) return reply.code(400).send({ error: e.reason });
  throw e;
}

/*
 * Гейт одновременных загрузок (2026-10-28, аудит SEC-10). Два маршрута ниже читают multipart
 * ЦЕЛИКОМ в память и держат буферы до конца записи, а лимит размера считается на один запрос
 * (`MAX_FILE_MB × 4 файла`): он ничего не говорит о том, сколько таких запросов сервер обслуживает
 * одновременно. Это два хука уровня маршрута, а не обёртка внутри тела, по одной причине: slot
 * обязан освобождаться ВСЕГДА, включая 4xx, 5xx и оборванное соединение, — а ручная `try/finally`
 * вокруг шестидесятистрочного обработчика как раз и есть то место, где такой finally однажды
 * забывают. Отказ — 429 с `Retry-After`, а не очередь: очередь тоже держала бы раскрытый
 * multipart и соединение, только невидимо для наблюдателя.
 */
const UPLOAD_RETRY_AFTER_SEC = '5';
/** Запросы, которые действительно получили слот; без этого onResponse отдал бы чужой слот. */
const heldSlots = new WeakSet<FastifyRequest>();

const uploadGateHooks = {
  onRequest: async (req: FastifyRequest, reply: FastifyReply) => {
    if (tryAcquireUploadSlot()) { heldSlots.add(req); return undefined; }
    reply.header('retry-after', UPLOAD_RETRY_AFTER_SEC);
    return reply.code(429).send({ error: 'uploadBusy' });
  },
  // onResponse стреляет и после успешного ответа, и после отказа; `onRequestAbort` — когда клиент
  // ушёл посреди передачи. WeakSet делает освобождение идемпотентным.
  onResponse: async (req: FastifyRequest) => { if (heldSlots.delete(req)) releaseUploadSlot(); },
  onRequestAbort: async (req: FastifyRequest) => { if (heldSlots.delete(req)) releaseUploadSlot(); },
};

export async function postRoutes(app: FastifyInstance, opts: { db: DB }) {
  const { db } = opts;

  // Feed: newest first, pinned on top; class members + teacher (§7 → 404 otherwise).
  // Students receive ONLY published posts addressed to them (task A).
  app.get('/api/classes/:id/feed', { preHandler: app.authenticate }, async (req, reply) => {
    const classId = (req.params as { id: string }).id;
    if (!z.string().uuid().safeParse(classId).success) return reply.code(404).send({ error: 'notFound' });
    const cls = await memberOrTeacher(db, req, reply, classId);
    if (!cls) return reply.code(404).send({ error: 'notFound' });
    return getFeed(db, cls.id, { userId: req.user!.id, isTeacher: req.user!.role === 'teacher' });
  });

  // ─── topics (task A §2) ─────────────────────────────────────────────────────
  app.get('/api/classes/:id/topics', { preHandler: app.authenticate }, async (req, reply) => {
    const classId = (req.params as { id: string }).id;
    const cls = await memberOrTeacher(db, req, reply, classId);
    if (!cls) return reply.code(404).send({ error: 'notFound' });
    return listTopics(db, cls.id);
  });

  app.post('/api/classes/:id/topics', { preHandler: app.authenticateTeacher }, async (req, reply) => {
    const classId = (req.params as { id: string }).id;
    const cls = await memberOrTeacher(db, req, reply, classId);
    if (!cls) return reply.code(404).send({ error: 'notFound' });
    const p = topicSchema.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: 'invalidInput' });
    const id = await getOrCreateTopic(db, cls.id, p.data.name);
    const [row] = await db.select({ id: topicsTable.id, name: topicsTable.name, position: topicsTable.position })
      .from(topicsTable).where(eq(topicsTable.id, id)).limit(1);
    return reply.code(201).send(row);
  });

  /** teacher-only topic edit; class ownership re-derived from the row itself */
  async function ownTopic(req: FastifyRequest, reply: FastifyReply) {
    const topicId = (req.params as { id: string }).id;
    if (!uuidRe.test(topicId)) { await reply.code(404).send({ error: 'notFound' }); return null; }
    const [t] = await db.select().from(topicsTable).where(eq(topicsTable.id, topicId)).limit(1);
    if (!t) { await reply.code(404).send({ error: 'notFound' }); return null; }
    const cls = await resolveClass(db, req.user!.id, 'teacher', t.classId);
    if (!cls) { await reply.code(404).send({ error: 'notFound' }); return null; }
    return t;
  }

  app.patch('/api/topics/:id', { preHandler: app.authenticateTeacher }, async (req, reply) => {
    const t = await ownTopic(req, reply);
    if (!t) return reply;
    const p = topicSchema.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: 'invalidInput' });
    const [row] = await db.update(topicsTable).set({ name: p.data.name }).where(eq(topicsTable.id, t.id)).returning({ id: topicsTable.id, name: topicsTable.name, position: topicsTable.position });
    return row;
  });

  app.delete('/api/topics/:id', { preHandler: app.authenticateTeacher }, async (req, reply) => {
    const t = await ownTopic(req, reply);
    if (!t) return reply;
    await db.delete(topicsTable).where(eq(topicsTable.id, t.id)); // posts keep, topic_id → null
    return { ok: true };
  });

  // ─── materials ──────────────────────────────────────────────────────────────

  // Teacher creates a material: multipart — text fields + JSON arrays + files.
  app.post('/api/classes/:id/materials', {
    preHandler: app.authenticateTeacher,
    ...uploadGateHooks,
  }, async (req, reply) => {
    const classId = (req.params as { id: string }).id;
    const cls = await memberOrTeacher(db, req, reply, classId);
    if (!cls) return reply.code(404).send({ error: 'notFound' });
    if (!req.isMultipart()) return reply.code(400).send({ error: 'invalidInput' });
    const mp = await readMultipart(req, reply);
    if (!mp) return reply;
    const { fields, uploaded } = mp;

    const title = (fields.title ?? '').trim().slice(0, 200);
    const description = (fields.description ?? '').trim().slice(0, 20000);
    if (!title) return reply.code(400).send({ error: 'titleRequired' });

    const publish = ['now', 'draft', 'schedule'].includes(fields.publish ?? '') ? fields.publish : 'now';
    let scheduledAt: Date | null = null;
    if (publish === 'schedule') {
      scheduledAt = fields.scheduledAt ? new Date(fields.scheduledAt) : null;
      if (!scheduledAt || Number.isNaN(scheduledAt.getTime()) || scheduledAt.getTime() <= Date.now()) {
        return reply.code(400).send({ error: 'invalidSchedule' });
      }
    }
    const audience = parseJsonArray(fields.audience);
    if (audience === 'bad' || (audience && audience.some((u) => typeof u !== 'string' || !uuidRe.test(u)))) {
      return reply.code(400).send({ error: 'invalidInput' });
    }
    const linksRaw = parseJsonArray(fields.attachments);
    if (linksRaw === 'bad') return reply.code(400).send({ error: 'invalidInput' });
    const links: { url: string; title: string }[] = [];
    for (const l of linksRaw ?? []) {
      const lp = linkSchema.safeParse(l);
      if (!lp.success) return reply.code(400).send({ error: 'invalidInput' });
      if (!safeExternalUrl(lp.data.url)) return reply.code(400).send({ error: 'invalidLink' });
      links.push({ url: lp.data.url, title: lp.data.title });
    }
    const topicId = fields.topicId && uuidRe.test(fields.topicId) ? fields.topicId : null;
    const newTopic = (fields.newTopic ?? '').trim().slice(0, 120) || null;

    try {
      const post = await createMaterial(db, req.user!.id, cls.id, {
        title, description, topicId, newTopic,
        status: publish === 'now' ? 'published' : publish === 'draft' ? 'draft' : 'scheduled',
        scheduledAt, audience: (audience as string[] | null) ?? [], links,
      }, uploaded);
      if (post.status === 'published') {
        void notifyMaterialPublished(db, post).catch(() => undefined);
      }
      if (post.status === 'scheduled' && post.scheduledAt) schedulePostPublish(post.scheduledAt);
      /*
       * Журнал (2026-10-28, аудит SEC-08). До этой правки в файле не было НИ ОДНОГО вызова
       * `audit()`: публикация материала и приложенные к нему файлы не оставляли следа, и на
       * вопрос «кто выложил этот файл в этот класс» не отвечал ни API, ни `audit_log`. В цели —
       * только идентификаторы и счётчики: ни заголовка, ни текста, ни имён ссылок.
       */
      audit(db, req.user!.id, 'material_create', {
        classId: cls.id, postId: post.id, status: post.status, files: uploaded.length, links: links.length,
      });
      return reply.code(201).send(post);
    } catch (e) {
      return rejectToReply(e, reply);
    }
  });

  app.post('/api/classes/:id/announcements', { preHandler: app.authenticateTeacher }, async (req, reply) => {
    const classId = (req.params as { id: string }).id;
    const cls = await memberOrTeacher(db, req, reply, classId);
    if (!cls) return reply.code(404).send({ error: 'notFound' });
    const p = z.object({ title: z.string().trim().max(200), body: z.string().max(4000) }).safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: 'invalidInput' });
    const post = await createAnnouncement(db, req.user!.id, cls.id, p.data.title, p.data.body);
    void (async () => {
      const name = await classTitle(db, cls.id);
      await enqueueNotification(db, {
        kind: 'announcementNew', classId: cls.id, when: new Date(),
        params: { title: p.data.title, class: name }, dedupeBase: `post:${post.id}`, excludeUserId: req.user!.id,
      });
    })().catch(() => undefined);
    audit(db, req.user!.id, 'announcement_create', { classId: cls.id, postId: post.id });
    return reply.code(201).send(post);
  });

  /** teacher-owned post loader shared by every /api/posts/:postId route (404 otherwise) */
  async function ownPost(req: FastifyRequest, reply: FastifyReply) {
    const postId = (req.params as { postId: string }).postId;
    if (!uuidRe.test(postId)) { await reply.code(404).send({ error: 'notFound' }); return null; }
    const existing = await db.select().from(postsTable).where(eq(postsTable.id, postId)).limit(1).then((r) => r[0]);
    if (!existing) { await reply.code(404).send({ error: 'notFound' }); return null; }
    const cls = await resolveClass(db, req.user!.id, 'teacher', existing.classId);
    if (!cls) { await reply.code(404).send({ error: 'notFound' }); return null; }
    return existing;
  }

  app.patch('/api/posts/:postId', { preHandler: app.authenticateTeacher }, async (req, reply) => {
    const existing = await ownPost(req, reply);
    if (!existing) return reply;
    const p = postPatchSchema.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: 'invalidInput' });
    const { audience, ...text } = p.data;
    if (text.topicId) {
      const [t] = await db.select({ id: topicsTable.id, classId: topicsTable.classId })
        .from(topicsTable).where(eq(topicsTable.id, text.topicId)).limit(1);
      if (!t || t.classId !== existing.classId) return reply.code(400).send({ error: 'invalidInput' });
    }
    /*
     * Текст и аудитория применяются ОДНИМ ходом. Пока аудитория проверялась после `updatePost`,
     * отказ `invalidAudience` возвращал 400 уже с применённым заголовком — клиент считал правку
     * несохранённой, а в ленте она была. Отказ обязан откатывать и текст.
     */
    try {
      await db.transaction(async (tx) => {
        if (Object.keys(text).length) await updatePost(tx, existing.id, text);
        // класс и проверка участников — здесь: `post_audience` без них была бы строкой в никуда
        if (audience) await setPostAudience(tx, existing.classId, existing.id, audience);
      });
    } catch (e) {
      return rejectToReply(e, reply);
    }
    const [row] = await db.select().from(postsTable).where(eq(postsTable.id, existing.id)).limit(1);
    // имена полей и количество адресатов, но ни заголовка, ни текста, ни списка имён учеников
    audit(db, req.user!.id, 'post_update', {
      classId: existing.classId, postId: existing.id, fields: Object.keys(text),
      ...(audience ? { audienceCount: audience.length } : {}),
    });
    return row ?? existing;
  });

  // publish a draft/scheduled post NOW (also used by the schedule test path)
  app.post('/api/posts/:postId/publish', { preHandler: app.authenticateTeacher }, async (req, reply) => {
    const existing = await ownPost(req, reply);
    if (!existing) return reply;
    const flipped = await publishPost(db, existing.id);
    if (!flipped) return reply.code(400).send({ error: 'alreadyPublished' });
    void notifyMaterialPublished(db, flipped).catch(() => undefined);
    audit(db, req.user!.id, 'post_publish', { classId: existing.classId, postId: existing.id });
    return flipped;
  });

  // add a link/youtube/drive attachment to an existing post
  app.post('/api/posts/:postId/attachments', { preHandler: app.authenticateTeacher }, async (req, reply) => {
    const existing = await ownPost(req, reply);
    if (!existing) return reply;
    const p = linkSchema.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: 'invalidInput' });
    if (!safeExternalUrl(p.data.url)) return reply.code(400).send({ error: 'invalidLink' });
    const row = await addLinkAttachment(db, existing.id, p.data.url, p.data.title);
    audit(db, req.user!.id, 'attachment_link_add', { classId: existing.classId, postId: existing.id, attachmentId: row?.id ?? null });
    return reply.code(201).send(row);
  });

  app.delete('/api/posts/:postId/attachments/:attachmentId', { preHandler: app.authenticateTeacher }, async (req, reply) => {
    const existing = await ownPost(req, reply);
    if (!existing) return reply;
    const aid = (req.params as { attachmentId: string }).attachmentId;
    if (!uuidRe.test(aid)) return reply.code(404).send({ error: 'notFound' });
    const gone = await removeAttachment(db, existing.id, aid);
    if (!gone) return reply.code(404).send({ error: 'notFound' });
    // удаление вложения — то, что ученик может обнаружить только постфактум, поэтому след обязан
    // быть: идентификаторы, без имени файла и без пути в хранилище
    audit(db, req.user!.id, 'attachment_remove', { classId: existing.classId, postId: existing.id, attachmentId: aid });
    return { ok: true };
  });

  // append files to an existing post (multipart, same limits/magic bytes/quota)
  app.post('/api/posts/:postId/files', { preHandler: app.authenticateTeacher, ...uploadGateHooks }, async (req, reply) => {
    const existing = await ownPost(req, reply);
    if (!existing) return reply;
    if (!req.isMultipart()) return reply.code(400).send({ error: 'invalidInput' });
    const mp = await readMultipart(req, reply);
    if (!mp) return reply;
    if (!mp.uploaded.length) return reply.code(400).send({ error: 'invalidInput' });
    try {
      const added = await addFilesToPost(db, req.user!.id, existing.id, mp.uploaded);
      audit(db, req.user!.id, 'file_attach', {
        classId: existing.classId, postId: existing.id,
        files: added.filter((a) => a.kind === 'file').length,
      });
      return reply.code(201).send(added);
    } catch (e) {
      return rejectToReply(e, reply);
    }
  });

  app.delete('/api/posts/:postId', { preHandler: app.authenticateTeacher }, async (req, reply) => {
    const existing = await ownPost(req, reply);
    if (!existing) return reply;
    await deletePost(db, existing.id);
    audit(db, req.user!.id, 'post_delete', { classId: existing.classId, postId: existing.id, kind: existing.kind });
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
    // task A: the file follows its post — drafts, scheduled posts and posts
    // addressed to OTHER students are invisible (404), even to class members.
    if (!(await canSeePost(db, row.classId, row.postId, { userId: req.user!.id, isTeacher: req.user!.role === 'teacher' }))) {
      return reply.code(404).send({ error: 'notFound' });
    }
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
    // Render free tier has NO persistent disk: the file can vanish between the
    // stat above and the first read. Fail as a clean 404/abort, never a crash.
    opened.stream.on('error', () => {
      if (!reply.sent) void reply.code(404).send({ error: 'notFound' });
      else reply.raw.destroy();
    });

    reply.header('content-type', row.file.mime);
    reply.header('x-content-type-options', 'nosniff');
    // C1 (2026-10-16): пользовательский байт отдаётся в sandbox, кроме inline PDF — см. fileCsp.
    const shownInline = inline && isInlineSafe(row.file.mime);
    reply.header('content-security-policy', fileCsp(row.file.mime, shownInline));
    reply.header('content-disposition',
      `${shownInline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(row.file.originalName)}`);
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
