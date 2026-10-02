import {
  pgTable, pgEnum, text, timestamp, uuid, primaryKey, index, bigserial, jsonb, boolean, bigint,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const userRoleEnum = pgEnum('user_role', ['teacher', 'student']);
export const localeEnum = pgEnum('app_locale', ['ru', 'uz']);
export const postKindEnum = pgEnum('post_kind', ['material', 'announcement']);
export const eventKindEnum = pgEnum('event_kind', ['lesson', 'deadline', 'other']);

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  role: userRoleEnum('role').notNull(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  locale: localeEnum('locale').notNull().default('ru'),
  tz: text('tz').notNull().default('Asia/Tashkent'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, (t) => [index('users_email_idx').on(t.email)]);

export const classes = pgTable('classes', {
  id: uuid('id').primaryKey().defaultRandom(),
  teacherId: uuid('teacher_id').notNull().references(() => users.id),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  color: text('color').notNull().default('#4f46e5'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  archivedAt: timestamp('archived_at', { withTimezone: true }),
}, (t) => [index('classes_teacher_idx').on(t.teacherId)]);

export const classMembers = pgTable('class_members', {
  classId: uuid('class_id').notNull().references(() => classes.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.classId, t.userId] }), index('members_user_idx').on(t.userId)]);

/** Only the SHA-256 hash of the code is stored; the plain code is shown once. */
export const inviteCodes = pgTable('invite_codes', {
  id: uuid('id').primaryKey().defaultRandom(),
  classId: uuid('class_id').notNull().references(() => classes.id, { onDelete: 'cascade' }),
  codeHash: text('code_hash').notNull().unique(),
  createdBy: uuid('created_by').notNull().references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedBy: uuid('used_by').references(() => users.id),
  usedAt: timestamp('used_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
}, (t) => [index('invites_class_idx').on(t.classId)]);

/** Rotating refresh tokens; only salted SHA-256 hash stored. */
export const refreshTokens = pgTable('refresh_tokens', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull().unique(),
  familyId: uuid('family_id').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  replacedAt: timestamp('replaced_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('refresh_user_idx').on(t.userId), index('refresh_family_idx').on(t.familyId)]);

export const auditLog = pgTable('audit_log', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  actorId: uuid('actor_id').references(() => users.id),
  action: text('action').notNull(),
  target: jsonb('target').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const posts = pgTable('posts', {
  id: uuid('id').primaryKey().defaultRandom(),
  classId: uuid('class_id').notNull().references(() => classes.id, { onDelete: 'cascade' }),
  authorId: uuid('author_id').notNull().references(() => users.id),
  kind: postKindEnum('kind').notNull(),
  title: text('title').notNull().default(''),
  body: text('body').notNull().default(''),
  pinned: boolean('pinned').notNull().default(false),
  topic: text('topic'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('posts_class_idx').on(t.classId, t.createdAt)]);

/** Files: storage_key is an opaque UUID; original name never touches the disk path. */
export const files = pgTable('files', {
  id: uuid('id').primaryKey().defaultRandom(),
  postId: uuid('post_id').notNull().references(() => posts.id, { onDelete: 'cascade' }),
  storageKey: text('storage_key').notNull().unique(),
  originalName: text('original_name').notNull(),
  mime: text('mime').notNull(),
  size: bigint('size', { mode: 'number' }).notNull(),
  uploadedBy: uuid('uploaded_by').notNull().references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('files_post_idx').on(t.postId)]);

export const teacherNotes = pgTable('teacher_notes', {
  id: uuid('id').primaryKey().defaultRandom(),
  teacherId: uuid('teacher_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  classId: uuid('class_id').notNull().references(() => classes.id, { onDelete: 'cascade' }),
  title: text('title').notNull().default(''),
  body: text('body').notNull().default(''),
  sharedPostId: uuid('shared_post_id').references(() => posts.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('notes_teacher_idx').on(t.teacherId, t.classId)]);

/**
 * §3.5 — times stored in UTC plus the event's IANA zone. `rrule` is an RRULE
 * string iterated in wall-clock time of `tz`; `exdates` are UTC instants of
 * individual occurrences removed via “only this”.
 */
export const events = pgTable('events', {
  id: uuid('id').primaryKey().defaultRandom(),
  classId: uuid('class_id').notNull().references(() => classes.id, { onDelete: 'cascade' }),
  kind: eventKindEnum('kind').notNull(),
  title: text('title').notNull(),
  description: text('description').notNull().default(''),
  startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
  endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
  tz: text('tz').notNull().default('Asia/Tashkent'),
  rrule: text('rrule'),
  exdates: jsonb('exdates').$type<string[]>().notNull().default([]),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('events_class_start_idx').on(t.classId, t.startsAt)]);

/** §3.5 ICS subscription: personal read-only secret token, hash-only storage. */
export const icsTokens = pgTable('ics_tokens', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }).unique(),
  tokenHash: text('token_hash').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** §3.6 lesson session: created when the teacher presses “Start lesson”. */
export const lessonSessions = pgTable('lesson_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  classId: uuid('class_id').notNull().references(() => classes.id, { onDelete: 'cascade' }),
  eventId: uuid('event_id').references(() => events.id, { onDelete: 'set null' }),
  roomName: text('room_name').notNull().unique(),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  endedAt: timestamp('ended_at', { withTimezone: true }),
  /** «режим лекции»: students cannot unmute/publish until granted */
  lectureMode: boolean('lecture_mode').notNull().default(false),
  /** layout for everyone: {layout: 'gallery'|'stage'|'teacher'} */
  layoutState: jsonb('layout_state').$type<{ layout: 'gallery' | 'stage' | 'teacher' }>().notNull().default({ layout: 'gallery' }),
  createdBy: uuid('created_by').notNull().references(() => users.id),
}, (t) => [index('lessons_class_idx').on(t.classId, t.startedAt)]);

export type User = typeof users.$inferSelect;
export type Class = typeof classes.$inferSelect;
export type InviteCode = typeof inviteCodes.$inferSelect;
