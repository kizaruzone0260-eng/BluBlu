import {
  pgTable, pgEnum, text, timestamp, uuid, primaryKey, index, bigserial, jsonb, boolean, bigint, integer,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const userRoleEnum = pgEnum('user_role', ['teacher', 'student']);
export const localeEnum = pgEnum('app_locale', ['ru', 'uz', 'en']);
export const postKindEnum = pgEnum('post_kind', ['material', 'announcement']);
export const eventKindEnum = pgEnum('event_kind', ['lesson', 'deadline', 'other']);
/** item 8 — per-class chat state: open / closed / announcements only. */
export const chatModeEnum = pgEnum('chat_mode', ['on', 'off', 'announce']);

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
  chatMode: chatModeEnum('chat_mode').notNull().default('on'), // item 8
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
  // D.1: notes are not bound to a class necessarily
  classId: uuid('class_id').references(() => classes.id, { onDelete: 'cascade' }),
  // optional link to the lesson (calendar event) the note was made for
  eventId: uuid('event_id').references(() => events.id, { onDelete: 'set null' }),
  pinned: boolean('pinned').notNull().default(false),
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

/** §3.7 whiteboard: merged Excalidraw snapshot per (session, page). */
export const whiteboards = pgTable('whiteboards', {
  sessionId: uuid('session_id').notNull().references(() => lessonSessions.id, { onDelete: 'cascade' }),
  pageNo: integer('page_no').notNull(),
  snapshot: jsonb('snapshot').$type<{ elements: unknown[]; appState: Record<string, unknown> }>().notNull().default({ elements: [], appState: {} }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.sessionId, t.pageNo] })]);

/** §3.8 personal student sheets — visible only to their owner. */
export const studentNotes = pgTable('student_notes', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  classId: uuid('class_id').notNull().references(() => classes.id, { onDelete: 'cascade' }),
  sessionId: uuid('session_id').references(() => lessonSessions.id, { onDelete: 'set null' }),
  title: text('title').notNull().default(''),
  body: text('body').notNull().default(''),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('studentnotes_user_idx').on(t.userId, t.classId)]);

// ─── §3.9 Telegram ────────────────────────────────────────────────────────────

export const notifyChannelEnum = pgEnum('notify_channel', ['private', 'group', 'both']);

/** user ↔ chat_id binding; bot never writes first (§3.9 acceptance). */
export const telegramLinks = pgTable('telegram_links', {
  userId: uuid('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  chatId: text('chat_id').notNull().unique(),
  linkedAt: timestamp('linked_at', { withTimezone: true }).notNull().defaultNow(),
  blockedAt: timestamp('blocked_at', { withTimezone: true }),
});

/** one-time /start tokens, TTL 15 min, hash-only. */
export const telegramTokens = pgTable('telegram_tokens', {
  tokenHash: text('token_hash').primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
});

/** class group chat bound via /link + bind code. */
export const classTelegramChats = pgTable('class_telegram_chats', {
  classId: uuid('class_id').notNull().references(() => classes.id, { onDelete: 'cascade' }),
  chatId: text('chat_id').notNull(),
  linkedBy: uuid('linked_by').notNull().references(() => users.id),
  linkedAt: timestamp('linked_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.classId, t.chatId] })]);

/** short-lived bind codes created in the class UI for /link. */
export const classLinkTokens = pgTable('class_link_tokens', {
  tokenHash: text('token_hash').primaryKey(),
  classId: uuid('class_id').notNull().references(() => classes.id, { onDelete: 'cascade' }),
  createdBy: uuid('created_by').notNull().references(() => users.id),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
});

export const notificationPrefs = pgTable('notification_prefs', {
  userId: uuid('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  kinds: jsonb('kinds').$type<Record<string, boolean>>().notNull().default({}),
  quietFrom: integer('quiet_from').notNull().default(22), // local hour
  quietTo: integer('quiet_to').notNull().default(8),
  channel: notifyChannelEnum('channel').notNull().default('private'),
});

/** per-class channel override (group / private / both) */
export const classNotifyPrefs = pgTable('class_notify_prefs', {
  classId: uuid('class_id').primaryKey().references(() => classes.id, { onDelete: 'cascade' }),
  channel: notifyChannelEnum('channel').notNull().default('private'),
});

export const notificationStatusEnum = pgEnum('notification_status',
  ['pending', 'sent', 'failed', 'blocked', 'skipped']);

/**
 * One-time WebSocket tickets (30 s TTL, bound to user + lesson session).
 * Replaces access tokens in WS query strings so no long-lived secret ever
 * appears in a URL (Caddy access log, proxies, browser history).
 */
export const wsTickets = pgTable('ws_tickets', {
  tokenHash: text('token_hash').primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  sessionId: uuid('session_id').notNull().references(() => lessonSessions.id, { onDelete: 'cascade' }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('ws_tickets_session_idx').on(t.sessionId)]);

export const notifications = pgTable('notifications', {
  id: uuid('id').primaryKey().defaultRandom(),
  kind: text('kind').notNull(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
  chatId: text('chat_id'),
  classId: uuid('class_id').references(() => classes.id, { onDelete: 'cascade' }),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
  dedupeKey: text('dedupe_key').notNull().unique(),
  sendAt: timestamp('send_at', { withTimezone: true }).notNull().defaultNow(),
  status: notificationStatusEnum('status').notNull().default('pending'),
  attempts: integer('attempts').notNull().default(0),
  lastError: text('last_error'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('notifications_status_idx').on(t.status, t.sendAt)]);

/**
 * Item 8 — class chat: one shared thread per class, members only.
 * Every FK is ON DELETE CASCADE: removing the class or an account removes
 * its messages/mutes/reads with it.
 */
export const chatMessages = pgTable('chat_messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  classId: uuid('class_id').notNull().references(() => classes.id, { onDelete: 'cascade' }),
  authorId: uuid('author_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  text: text('text').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('chat_messages_class_time_idx').on(t.classId, t.createdAt)]);

export const chatMutes = pgTable('chat_mutes', {
  id: uuid('id').primaryKey().defaultRandom(),
  classId: uuid('class_id').notNull().references(() => classes.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  mutedBy: uuid('muted_by').notNull().references(() => users.id),
  /** NULL = forever; otherwise mutes stop at this instant. */
  until: timestamp('until', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('chat_mutes_class_user_idx').on(t.classId, t.userId)]);

export const chatReads = pgTable('chat_reads', {
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  classId: uuid('class_id').notNull().references(() => classes.id, { onDelete: 'cascade' }),
  lastReadAt: timestamp('last_read_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.userId, t.classId] })]);

/** Chat WS tickets — same one-time 30 s semantics as lesson tickets, bound to a class. */
export const chatWsTickets = pgTable('chat_ws_tickets', {
  tokenHash: text('token_hash').primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  classId: uuid('class_id').notNull().references(() => classes.id, { onDelete: 'cascade' }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('chat_ws_tickets_class_idx').on(t.classId)]);
