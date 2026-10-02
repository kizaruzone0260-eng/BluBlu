import { and, desc, eq, sql } from 'drizzle-orm';
import { posts, files, users, teacherNotes } from '../db/schema.js';
import type { DB } from '../db/index.js';
import { env } from '../env.js';
import { getStorage } from '../storage/provider.js';
import { detectFileType } from '../lib/magic.js';
import { randomUUID } from 'node:crypto';

export interface FeedItem {
  id: string;
  kind: 'material' | 'announcement';
  title: string;
  body: string;
  pinned: boolean;
  topic: string | null;
  createdAt: string;
  authorName: string;
  files: { id: string; name: string; mime: string; size: number }[];
}

export async function getFeed(db: DB, classId: string): Promise<FeedItem[]> {
  const rows = await db
    .select({
      id: posts.id, kind: posts.kind, title: posts.title, body: posts.body,
      pinned: posts.pinned, topic: posts.topic, createdAt: posts.createdAt,
      authorName: users.name,
    })
    .from(posts)
    .innerJoin(users, eq(users.id, posts.authorId))
    .where(eq(posts.classId, classId))
    .orderBy(desc(posts.pinned), desc(posts.createdAt));
  const fileList = await db
    .select({ postId: files.postId, id: files.id, name: files.originalName, mime: files.mime, size: files.size })
    .from(files)
    .where(sql`${files.postId} in (select id from posts where class_id = ${classId})`);
  return rows.map((r) => ({
    id: r.id, kind: r.kind, title: r.title, body: r.body, pinned: r.pinned,
    topic: r.topic, createdAt: r.createdAt.toISOString(), authorName: r.authorName,
    files: fileList.filter((f) => f.postId === r.id),
  }));
}

export interface UploadFileInput { buffer: Buffer; filename: string }

export class UploadRejected extends Error {
  constructor(public reason: 'fileTypeRejected' | 'tooLarge' | 'quotaExceeded') { super(reason); }
}

export async function createMaterial(
  db: DB, teacherId: string, classId: string,
  input: { title: string; description: string; topic?: string },
  uploaded: UploadFileInput[],
) {
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
  const [post] = await db.insert(posts).values({
    classId, authorId: teacherId, kind: 'material',
    title: input.title, body: input.description, topic: input.topic ?? null,
  }).returning();
  for (const p of prepared) {
    await storage.put(p.key, p.buffer);
    await db.insert(files).values({
      postId: post!.id, storageKey: p.key, originalName: p.name, mime: p.mime, size: p.buffer.length, uploadedBy: teacherId,
    });
  }
  return post!;
}

export async function createAnnouncement(db: DB, teacherId: string, classId: string, title: string, body: string) {
  const [post] = await db.insert(posts).values({
    classId, authorId: teacherId, kind: 'announcement', title, body,
  }).returning();
  return post!;
}

export async function updatePost(db: DB, id: string, patch: Partial<{ title: string; body: string; pinned: boolean; topic: string | null }>) {
  const [p] = await db.update(posts).set({ ...patch, updatedAt: new Date() }).where(eq(posts.id, id)).returning();
  return p ?? null;
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
      file: files, classId: posts.classId,
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
    .orderBy(desc(teacherNotes.updatedAt));
}

export async function createNote(db: DB, teacherId: string, classId: string, title: string, body: string) {
  const [n] = await db.insert(teacherNotes).values({ teacherId, classId, title, body }).returning();
  return n!;
}

export async function updateNote(db: DB, teacherId: string, id: string, patch: Partial<{ title: string; body: string }>) {
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
  if (note.sharedPostId) {
    await updatePost(db, note.sharedPostId, { title: note.title, body: note.body });
    return note.sharedPostId;
  }
  const post = await createMaterial(db, teacherId, note.classId,
    { title: note.title, description: note.body }, []);
  await db.update(teacherNotes).set({ sharedPostId: post.id }).where(eq(teacherNotes.id, id));
  return post.id;
}
