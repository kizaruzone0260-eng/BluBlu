import { and, desc, eq, inArray, lte, sql } from 'drizzle-orm';
import {
  posts, files, users, teacherNotes, topics, postAttachments, postAudience, classMembers,
} from '../db/schema.js';
import type { DB } from '../db/index.js';
import { env } from '../env.js';
import { getStorage } from '../storage/provider.js';
import { detectFileType } from '../lib/magic.js';
import { randomUUID } from 'node:crypto';
import { enqueueNotification } from './notify.js';
import { classTitle } from './notifyQueue.js';

/**
 * Material form (task A): posts with unified attachments (file/link/youtube/
 * drive), selected-student audiences, real topics and draft/scheduled/published
 * statuses. Students only ever see published material addressed to them — the
 * feed, file delivery and the bot all run the same visibility rules server-side.
 */

export type AttachmentKind = 'file' | 'link' | 'youtube' | 'drive';
export type PostStatus = 'draft' | 'scheduled' | 'published';

/**
 * Only http(s) absolute URLs with a dotted host survive. This is pure parsing —
 * the server NEVER fetches these URLs (no SSRF). javascript:, data:, file:,
 * protocol-relative and bare hostnames are rejected.
 */
export function safeExternalUrl(raw: string): string | null {
  try {
    const u = new URL(String(raw).trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    const h = u.hostname.toLowerCase();
    if (!/^[a-z0-9.-]+$/.test(h) || !h.includes('.')) return null;
    return u.toString().slice(0, 2000);
  } catch { return null; }
}

export function classifyAttachmentUrl(url: string): AttachmentKind {
  let h = 'https://';
  try { h = new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { /* link */ }
  if (h === 'youtu.be' || h === 'youtube.com' || h.endsWith('.youtube.com')) return 'youtube';
  if (h === 'drive.google.com' || h === 'docs.google.com') return 'drive';
  return 'link';
}

export interface AttachmentRow {
  id: string; kind: AttachmentKind; url: string | null; title: string; position: number;
  file: { id: string; name: string; mime: string; size: number } | null;
}

export interface FeedItem {
  id: string;
  kind: 'material' | 'announcement';
  title: string;
  body: string;
  pinned: boolean;
  topic: string | null; // legacy free-text (pre-form posts without a migrated topic)
  topicId: string | null;
  topicName: string | null;
  status: PostStatus;
  scheduledAt: string | null;
  /** selected-student ids — ONLY in the teacher view; empty ⇒ whole class */
  audience: string[];
  attachments: AttachmentRow[];
  createdAt: string;
  authorName: string;
}

/** student visibility: published AND (no audience rows OR the student is listed) */
const studentVisibility = (viewerId: string) => sql`
  ${posts.status} = 'published'
  AND (NOT EXISTS (SELECT 1 FROM post_audience pa WHERE pa.post_id = ${posts.id})
       OR EXISTS (SELECT 1 FROM post_audience pb WHERE pb.post_id = ${posts.id} AND pb.user_id = ${viewerId}))`;

export async function getFeed(
  db: DB, classId: string, viewer: { userId: string; isTeacher: boolean },
): Promise<FeedItem[]> {
  const rows = await db
    .select({
      id: posts.id, kind: posts.kind, title: posts.title, body: posts.body,
      pinned: posts.pinned, topic: posts.topic, topicId: posts.topicId,
      topicName: topics.name,
      status: posts.status, scheduledAt: posts.scheduledAt, createdAt: posts.createdAt,
      authorName: sql<string>`concat_ws(' ', ${users.name}, nullif(${users.lastName}, ''))`,
    })
    .from(posts)
    .innerJoin(users, eq(users.id, posts.authorId))
    .leftJoin(topics, eq(topics.id, posts.topicId))
    .where(and(
      eq(posts.classId, classId),
      viewer.isTeacher ? undefined : studentVisibility(viewer.userId),
    ))
    .orderBy(desc(posts.pinned), desc(posts.createdAt));
  const ids = rows.map((r) => r.id);
  const atts = ids.length ? await db
    .select({
      id: postAttachments.id, postId: postAttachments.postId, kind: postAttachments.kind,
      url: postAttachments.url, title: postAttachments.title, position: postAttachments.position,
      fileId: files.id, fname: files.originalName, fmime: files.mime, fsize: files.size,
    })
    .from(postAttachments)
    .leftJoin(files, eq(files.id, postAttachments.fileId))
    .where(inArray(postAttachments.postId, ids))
    .orderBy(postAttachments.position) : [];
  const aud = viewer.isTeacher && ids.length ? await db
    .select({ postId: postAudience.postId, userId: postAudience.userId })
    .from(postAudience).where(inArray(postAudience.postId, ids)) : [];
  return rows.map((r) => ({
    id: r.id, kind: r.kind, title: r.title, body: r.body, pinned: r.pinned,
    topic: r.topic, topicId: r.topicId, topicName: r.topicName,
    status: r.status as PostStatus,
    scheduledAt: r.scheduledAt ? r.scheduledAt.toISOString() : null,
    createdAt: r.createdAt.toISOString(), authorName: r.authorName,
    audience: aud.filter((a) => a.postId === r.id).map((a) => a.userId),
    attachments: atts.filter((a) => a.postId === r.id).map((a) => ({
      id: a.id, kind: a.kind as AttachmentKind, url: a.url, title: a.title, position: a.position,
      file: a.fileId ? { id: a.fileId, name: a.fname!, mime: a.fmime!, size: a.fsize! } : null,
    })),
  }));
}

/** Teacher/student visibility check for a single post (file delivery, deep links). */
export async function canSeePost(
  db: DB, classId: string, postId: string, viewer: { userId: string; isTeacher: boolean },
): Promise<boolean> {
  const [p] = await db.select({ status: posts.status }).from(posts)
    .where(and(eq(posts.id, postId), eq(posts.classId, classId))).limit(1);
  if (!p) return false;
  if (viewer.isTeacher) return true;
  if (p.status !== 'published') return false;
  const aud = await db.select({ userId: postAudience.userId }).from(postAudience)
    .where(eq(postAudience.postId, postId));
  return aud.length === 0 || aud.some((a) => a.userId === viewer.userId);
}

export interface UploadFileInput { buffer: Buffer; filename: string }

export class UploadRejected extends Error {
  constructor(public reason: 'fileTypeRejected' | 'tooLarge' | 'quotaExceeded') { super(reason); }
}
export class MaterialRejected extends Error {
  constructor(public reason: 'invalidAudience' | 'invalidTopic' | 'invalidSchedule' | 'invalidLink') { super(reason); }
}

/** validate + store buffers, respecting the magic-bytes/quota rules (shared by create & append) */
async function storeUploads(db: DB, teacherId: string, postId: string, uploaded: UploadFileInput[]) {
  const maxBytes = env.MAX_FILE_MB * 1024 * 1024;
  const quotaBytes = env.TEACHER_QUOTA_GB * 1024 * 1024 * 1024;
  const storage = getStorage();
  const prepared: { key: string; buffer: Buffer; mime: string; name: string }[] = [];
  let incoming = 0;
  for (const f of uploaded) {
    if (f.buffer.length > maxBytes) throw new UploadRejected('tooLarge');
    const detected = detectFileType(f.buffer.subarray(0, Math.min(f.buffer.length, 8192)), f.filename);
    if (detected.group === 'unknown') throw new UploadRejected('fileTypeRejected');
    prepared.push({
      key: `${randomUUID()}.${'ext' in detected ? detected.ext : 'bin'}`,
      buffer: f.buffer, mime: 'mime' in detected ? detected.mime : 'application/octet-stream', name: f.filename,
    });
    incoming += f.buffer.length;
  }
  if (prepared.length > 0) {
    const [used] = await db
      .select({ total: sql<number>`coalesce(sum(size), 0)::bigint` })
      .from(files)
      .where(eq(files.uploadedBy, teacherId));
    if (Number(used!.total) + incoming > quotaBytes) throw new UploadRejected('quotaExceeded');
  }
  let position = prepared.length
    ? Number(await db.select({ n: sql<number>`coalesce(max(${postAttachments.position}), -1)::int` })
        .from(postAttachments).where(eq(postAttachments.postId, postId)).then((r) => r[0]?.n ?? -1))
    : -1;
  const out: AttachmentRow[] = [];
  for (const p of prepared) {
    await storage.put(p.key, p.buffer);
    const [fr] = await db.insert(files).values({
      postId, storageKey: p.key, originalName: p.name, mime: p.mime, size: p.buffer.length, uploadedBy: teacherId,
    }).returning();
    const [ar] = await db.insert(postAttachments).values({
      postId, kind: 'file', title: p.name, fileId: fr!.id, position: ++position,
    }).returning();
    out.push({ id: ar!.id, kind: 'file', url: null, title: p.name, position: ar!.position, file: { id: fr!.id, name: p.name, mime: p.mime, size: p.buffer.length } });
  }
  return out;
}

export interface MaterialInput {
  title: string;
  description: string;
  topicId: string | null;
  /** create-on-demand topic name when topicId is absent */
  newTopic: string | null;
  status: PostStatus;
  scheduledAt: Date | null;
  /** selected students; [] ⇒ the whole class */
  audience: string[];
  /** link/youtube/drive attachments (validated, never fetched) */
  links: { url: string; title: string }[];
}

export async function createMaterial(
  db: DB, teacherId: string, classId: string,
  input: MaterialInput,
  uploaded: UploadFileInput[],
) {
  let topicId = input.topicId;
  if (topicId) {
    const [t] = await db.select({ id: topics.id }).from(topics)
      .where(and(eq(topics.id, topicId), eq(topics.classId, classId))).limit(1);
    if (!t) throw new MaterialRejected('invalidTopic');
  } else if (input.newTopic) {
    topicId = await getOrCreateTopic(db, classId, input.newTopic);
  }
  if (input.audience.length) {
    const members = await db.select({ userId: classMembers.userId }).from(classMembers)
      .where(eq(classMembers.classId, classId));
    const known = new Set(members.map((m) => m.userId));
    if (!input.audience.every((u) => known.has(u))) throw new MaterialRejected('invalidAudience');
  }
  if (input.status === 'scheduled' && (!input.scheduledAt || input.scheduledAt.getTime() <= Date.now())) {
    throw new MaterialRejected('invalidSchedule');
  }
  const [post] = await db.insert(posts).values({
    classId, authorId: teacherId, kind: 'material',
    title: input.title, body: input.description,
    topicId, status: input.status, scheduledAt: input.status === 'scheduled' ? input.scheduledAt : null,
  }).returning();
  if (input.audience.length) {
    await db.insert(postAudience).values(input.audience.map((userId) => ({ postId: post!.id, userId })));
  }
  let position = -1;
  for (const l of input.links) {
    const url = safeExternalUrl(l.url);
    if (!url) throw new MaterialRejected('invalidLink');
    const kind = classifyAttachmentUrl(url);
    await db.insert(postAttachments).values({ postId: post!.id, kind, url, title: l.title.slice(0, 200), position: ++position });
  }
  await storeUploads(db, teacherId, post!.id, uploaded);
  return post!;
}

/** topic get-or-create by (class, name); ordering appends after the last one */
export async function getOrCreateTopic(db: DB, classId: string, name: string): Promise<string> {
  const clean = name.trim().slice(0, 120);
  const [existing] = await db.select({ id: topics.id }).from(topics)
    .where(and(eq(topics.classId, classId), eq(topics.name, clean))).limit(1);
  if (existing) return existing.id;
  const [max] = await db.select({ n: sql<number>`coalesce(max(${topics.position}), -1)::int` })
    .from(topics).where(eq(topics.classId, classId));
  const [t] = await db.insert(topics).values({ classId, name: clean, position: (max?.n ?? -1) + 1 }).returning();
  return t!.id;
}

export async function listTopics(db: DB, classId: string) {
  return db.select({ id: topics.id, name: topics.name, position: topics.position })
    .from(topics).where(eq(topics.classId, classId)).orderBy(topics.position);
}

export async function addFilesToPost(db: DB, teacherId: string, postId: string, uploaded: UploadFileInput[]) {
  return storeUploads(db, teacherId, postId, uploaded);
}

export async function addLinkAttachment(db: DB, postId: string, rawUrl: string, title: string) {
  const url = safeExternalUrl(rawUrl);
  if (!url) return null;
  const kind = classifyAttachmentUrl(url);
  const [max] = await db.select({ n: sql<number>`coalesce(max(${postAttachments.position}), -1)::int` })
    .from(postAttachments).where(eq(postAttachments.postId, postId));
  const [a] = await db.insert(postAttachments).values({
    postId, kind, url, title: title.slice(0, 200) || url, position: (max?.n ?? -1) + 1,
  }).returning();
  return a;
}

/** remove an attachment; file attachments also drop their stored object */
export async function removeAttachment(db: DB, postId: string, attachmentId: string): Promise<boolean> {
  const [a] = await db.select().from(postAttachments)
    .where(and(eq(postAttachments.id, attachmentId), eq(postAttachments.postId, postId))).limit(1);
  if (!a) return false;
  if (a.fileId) {
    const [f] = await db.select({ key: files.storageKey }).from(files).where(eq(files.id, a.fileId)).limit(1);
    await db.delete(postAttachments).where(eq(postAttachments.id, a.id));
    if (f) await getStorage().delete(f.key).catch(() => undefined);
    await db.delete(files).where(eq(files.id, a.fileId)); // the attachment row is already gone
  } else {
    await db.delete(postAttachments).where(eq(postAttachments.id, a.id));
  }
  return true;
}

/** flip a draft/scheduled post to published; returns the post for notifications */
export async function publishPost(db: DB, postId: string) {
  const [p] = await db.update(posts)
    .set({ status: 'published', updatedAt: new Date() })
    .where(and(eq(posts.id, postId), sql`${posts.status} <> 'published'`))
    .returning();
  return p ?? null;
}

/** notify the audience (selected students or the whole class) about a published material */
export async function notifyMaterialPublished(
  db: DB, post: { id: string; classId: string; title: string; authorId: string },
): Promise<void> {
  const aud = await db.select({ userId: postAudience.userId }).from(postAudience)
    .where(eq(postAudience.postId, post.id));
  const name = await classTitle(db, post.classId);
  await enqueueNotification(db, {
    kind: 'materialNew', classId: post.classId, when: new Date(),
    params: { title: post.title, class: name }, dedupeBase: `post:${post.id}`,
    excludeUserId: post.authorId,
    onlyUserIds: aud.length ? aud.map((a) => a.userId) : undefined,
  });
}

/**
 * pg-boss + heartbeat entry point: publish everything whose time has come and
 * notify ONLY the audience (dedupe_key keeps double ticks idempotent, same as
 * the current material flow).
 */
export async function publishDuePosts(db: DB, now = new Date()): Promise<number> {
  const due = await db.select().from(posts)
    .where(and(eq(posts.status, 'scheduled'), lte(posts.scheduledAt, now)));
  for (const p of due) {
    const flipped = await publishPost(db, p.id);
    if (!flipped) continue;
    await notifyMaterialPublished(db, flipped).catch(() => undefined);
  }
  return due.length;
}

export async function createAnnouncement(db: DB, teacherId: string, classId: string, title: string, body: string) {
  const [post] = await db.insert(posts).values({
    classId, authorId: teacherId, kind: 'announcement', title, body,
  }).returning();
  return post!;
}

export async function updatePost(db: DB, id: string, patch: Partial<{
  title: string; body: string; pinned: boolean; topicId: string | null;
}>) {
  const [p] = await db.update(posts).set({ ...patch, updatedAt: new Date() }).where(eq(posts.id, id)).returning();
  return p ?? null;
}

/** replace the audience of a post (teacher edit); [] ⇒ whole class */
export async function setPostAudience(db: DB, postId: string, userIds: string[]) {
  await db.delete(postAudience).where(eq(postAudience.postId, postId));
  if (userIds.length) {
    await db.insert(postAudience).values(userIds.map((userId) => ({ postId, userId })));
  }
}

export async function deletePost(db: DB, id: string) {
  const fs = await db.select({ key: files.storageKey }).from(files).where(eq(files.postId, id));
  const storage = getStorage();
  await db.delete(posts).where(eq(posts.id, id));
  for (const f of fs) await storage.delete(f.key).catch(() => undefined);
}

/** Post with class scope check (returns null → 404). */
export async function getPostForClass(db: DB, postId: string, classId: string) {
  const [p] = await db.select().from(posts).where(and(eq(posts.id, postId), eq(posts.classId, classId))).limit(1);
  return p ?? null;
}

export async function getFileWithClass(db: DB, fileId: string) {
  const [row] = await db
    .select({
      file: files, classId: posts.classId, postId: posts.id,
    })
    .from(files)
    .innerJoin(posts, eq(posts.id, files.postId))
    .where(eq(files.id, fileId))
    .limit(1);
  return row ?? null;
}

// ─── teacher notes ────────────────────────────────────────────────────────────

export async function listNotes(db: DB, teacherId: string, classId?: string) {
  return db.select().from(teacherNotes)
    .where(classId
      ? and(eq(teacherNotes.teacherId, teacherId), eq(teacherNotes.classId, classId))
      : eq(teacherNotes.teacherId, teacherId))
    .orderBy(desc(teacherNotes.pinned), desc(teacherNotes.updatedAt));
}

export async function createNote(db: DB, teacherId: string, classId: string | null, title: string, body: string, eventId?: string | null) {
  const [n] = await db.insert(teacherNotes).values({ teacherId, classId, title, body, eventId: eventId ?? null }).returning();
  return n!;
}

export async function updateNote(db: DB, teacherId: string, id: string, patch: Partial<{
  title: string; body: string; pinned: boolean; classId: string | null; eventId: string | null;
}>) {
  const [n] = await db.update(teacherNotes)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(teacherNotes.id, id), eq(teacherNotes.teacherId, teacherId)))
    .returning();
  return n ?? null;
}

export async function deleteNote(db: DB, teacherId: string, id: string) {
  const n = await getNote(db, teacherId, id);
  if (!n) return false;
  await db.delete(teacherNotes).where(eq(teacherNotes.id, id));
  if (n.sharedPostId) await deletePost(db, n.sharedPostId);
  return true;
}

export async function getNote(db: DB, teacherId: string, id: string) {
  const [n] = await db.select().from(teacherNotes)
    .where(and(eq(teacherNotes.id, id), eq(teacherNotes.teacherId, teacherId))).limit(1);
  return n ?? null;
}

/** «опубликовать классу»: note becomes a feed material (§3.4). Republish updates the same post. */
export async function publishNote(db: DB, teacherId: string, id: string) {
  const note = await getNote(db, teacherId, id);
  if (!note) return null;
  if (!note.classId) return 'no-class' as const;
  if (note.sharedPostId) {
    await updatePost(db, note.sharedPostId, { title: note.title, body: note.body });
    return note.sharedPostId;
  }
  const post = await createMaterial(db, teacherId, note.classId, {
    title: note.title, description: note.body, topicId: null, newTopic: null,
    status: 'published', scheduledAt: null, audience: [], links: [],
  }, []);
  await db.update(teacherNotes).set({ sharedPostId: post.id }).where(eq(teacherNotes.id, id));
  return post.id;
}
