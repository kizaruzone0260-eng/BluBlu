import {
  pgTable, pgEnum, text, timestamp, uuid, primaryKey, index, unique, bigserial, jsonb, boolean, bigint, integer,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { DEFAULT_LOCALE } from '@klass/shared';

export const userRoleEnum = pgEnum('user_role', ['teacher', 'student']);
export const localeEnum = pgEnum('app_locale', ['ru', 'uz', 'en']);
export const postKindEnum = pgEnum('post_kind', ['material', 'announcement']);
/** Material task A: a post is a draft, scheduled for later, or visible. */
export const postStatusEnum = pgEnum('post_status', ['draft', 'scheduled', 'published']);
/** Material task A: unified attachment kinds (files keep their rows in `files`). */
export const attachmentKindEnum = pgEnum('attachment_kind', ['file', 'link', 'youtube', 'drive']);
export const eventKindEnum = pgEnum('event_kind', ['lesson', 'deadline', 'other']);
/** item 8 — per-class chat state: open / closed / announcements only. */
export const chatModeEnum = pgEnum('chat_mode', ['on', 'off', 'announce']);
/**
 * Task 2 (2026-10-09) — «комментарии во время урока»: on = everyone writes, off = nobody,
 * slow = a student writes at most once per 10 s (the teacher is never rate-limited by mode).
 */
export const commentsModeEnum = pgEnum('comments_mode', ['on', 'off', 'slow']);

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  role: userRoleEnum('role').notNull(),
  name: text('name').notNull(),
  /** item 9 — family name, stored apart from the given name; '' for old accounts. */
  lastName: text('last_name').notNull().default(''),
  /**
   * Name screen (task 2): set when BOTH given and family names are known —
   * at registration (step 2) or when the profile was completed later. NULL on
   * accounts whose name or family name is empty → the «Имя и фамилия» gate is
   * shown right after login until it is saved.
   */
  profileCompletedAt: timestamp('profile_completed_at', { withTimezone: true }),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  /**
   * Part 3: set when a temporary password was issued (teacher reset / owner
   * script). The SPA must force a password change before the app unlocks; a
   * successful change or self-set password clears it.
   */
  mustChangePassword: boolean('must_change_password').notNull().default(false),
  /**
   * Language (task 1, 2026-10-09). The DEFAULT is what an account gets when nobody chose
   * anything — English, like every other default in the product. `localeExplicit` is the part
   * that makes the bug fixable: 'en' in this column means "default", "en" next to
   * locale_explicit=true means "this person asked for English", and only the second one may
   * override what the browser already shows.
   */
  locale: localeEnum('locale').notNull().default(DEFAULT_LOCALE),
  localeExplicit: boolean('locale_explicit').notNull().default(false),
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
  /** bot task §3: unauthenticated /schedule by class name works ONLY when this is on */
  botPublicSchedule: boolean('bot_public_schedule').notNull().default(false),
  /**
   * Часть 4 (2026-10-14): «показывать архив досок ученикам». По умолчанию ВЫКЛЮЧЕНО: архив —
   * это записи про завершённый урок, и решение о том, видит ли класс свои доски прошлых занятий,
   * принимает учитель. Ученику при включённом переключателе отдаются ТОЛЬКО доски: ни комментариев,
   * ни списка участников (см. routes/lessonArchive.ts).
   */
  boardArchivePublic: boolean('board_archive_public').notNull().default(false),
}, (t) => [index('classes_teacher_idx').on(t.teacherId)]);

export const classMembers = pgTable('class_members', {
  classId: uuid('class_id').notNull().references(() => classes.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.classId, t.userId] }), index('members_user_idx').on(t.userId)]);

/**
 * Только хеш подписанного SHA-256 значения лежит в базе; сам код/токен показывается один раз.
 *
 * Одна таблица на два вида приглашения (задача 2026-10-23, часть A):
 *  • `kind = 'code'` — прежний восьмизначный код класса (ветка хеша `code.`), который ученик
 *    ВВОДИЛ руками. Способ выведен из продукта 2026-10-27: функция, которая его кодировала,
 *    удалена вместе с `lib/invite.ts`, ни один маршрут его не читает и право на вход по такой
 *    строке больше не даётся. Строки при этом НЕ удалены и НЕ переписаны — это история класса,
 *    и экран приглашений показывает её под статусом «устарел»;
 *  • `kind = 'link'` — одноразовая ссылка `<PUBLIC_URL>/join#<token>` (кодируется
 *    `hashInviteToken`, ветка `link.`): 24 случайных байта, расходится ровно один раз,
 *    отзывается учителем, помечает кто и кем использован.
 *
 * Разные доменные префиксы в хеш-функции означают, что ни один код не может совпасть с хешем
 * ссылки и наоборот, поэтому общий уникальный индекс здесь — не лотерея, а намерение: смысл у
 * строк один («учитель пригласил в этот класс»), и набор полей (срок, отзыв, кем и когда
 * израсходовано) для обоих видов один и тот же.
 */
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
  /** кто отозвал (учитель) — нужно для журнала: «приглашение отозвано» это привилегированное действие */
  revokedBy: uuid('revoked_by').references(() => users.id),
  /** 'code' — прежний способ; 'link' — одноразовая ссылка */
  kind: text('kind').notNull().default('code'),
  /** подпись учителя (например имя ученика); наружу не отдаётся, кроме как самому учителю */
  label: text('label').notNull().default(''),
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

/**
 * Login brute-force lockout (Hardening follow-up, part 2): one row per
 * NORMALIZED email tracking consecutive failed attempts and the moment the
 * account stops rejecting further tries. Postgres-backed so the counter
 * survives an API restart and applies across every client IP — closing the
 * "rotate IPs to brute one account" gap the per-IP HTTP limiter leaves. The
 * delay is bounded (≤ 15 min) so no account — including the owner or a teacher
 * — is ever locked out permanently. Successful login deletes the row.
 */
export const loginAttempts = pgTable('login_attempts', {
  email: text('email').primaryKey(),
  failCount: integer('fail_count').notNull().default(0),
  lockedUntil: timestamp('locked_until', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Часть F (2026-10-16): код подтверждения почты при регистрации.
 *
 * Одна активная строка на адрес: повторный запрос ЗАМЕЩАЕТ код (attempt-счётчик и срок
 * обнуляются), а не плодит их — иначе «пять попыток» превращаются в «пять попыток на каждый
 * из шести отправленных писем». Ключ — нормализованный email, ровно как в `login_attempts`.
 *
 * Хранится ТОЛЬКО соль+SHA-256 кода, не сам код: шестизначный код живёт 15 минут и у него есть
 * потолок угадываний, но дамп базы (а дамп всей школы делают каждую ночь, см. docs/BACKUP.md) не
 * должен отдавать кому-то рабочий набор кодов для чужой регистрации.
 *
 * `usedAt` вместо удаления: списанный код обязан остаться различимым, чтобы второй прогон
 * того же кода дал «уже использован», а не «не найдено» — то же решение, что у invite-кодов.
 */
export const emailVerifications = pgTable('email_verifications', {
  email: text('email').primaryKey(),
  codeHash: text('code_hash').notNull(),
  attempts: integer('attempts').notNull().default(0),
  sentAt: timestamp('sent_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
});

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
  // legacy free-text topic (pre-material-form posts); new posts use topicId
  topic: text('topic'),
  // ── material form (task A) ──
  status: postStatusEnum('status').notNull().default('published'),
  scheduledAt: timestamp('scheduled_at', { withTimezone: true }),
  topicId: uuid('topic_id').references(() => topics.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('posts_class_idx').on(t.classId, t.createdAt)]);

/** Material task A: Google-Classroom-style topics, ordered per class. */
export const topics = pgTable('topics', {
  id: uuid('id').primaryKey().defaultRandom(),
  classId: uuid('class_id').notNull().references(() => classes.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  position: integer('position').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('topics_class_idx').on(t.classId, t.position)]);

/** Material task A: unified attachments. kind=file ⇒ fileId set, url null. */
export const postAttachments = pgTable('post_attachments', {
  id: uuid('id').primaryKey().defaultRandom(),
  postId: uuid('post_id').notNull().references(() => posts.id, { onDelete: 'cascade' }),
  kind: attachmentKindEnum('kind').notNull(),
  url: text('url'),
  title: text('title').notNull().default(''),
  fileId: uuid('file_id').references(() => files.id, { onDelete: 'cascade' }),
  position: integer('position').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('post_attachments_post_idx').on(t.postId, t.position)]);

/** Material task A: selected-student audience. No rows ⇒ the whole class. */
export const postAudience = pgTable('post_audience', {
  postId: uuid('post_id').notNull().references(() => posts.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
}, (t) => [primaryKey({ columns: [t.postId, t.userId] }), index('post_audience_user_idx').on(t.userId)]);

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
  /** moderation feedback (task 3): «mute everyone» state, restored on reconnect */
  muteAll: boolean('mute_all').notNull().default(false),
  /**
   * Часть 1 (2026-10-13): ответ на переключатель «Вернуть микрофоны и камеры учеников после
   * лекции». Живёт на сессии, а не в теле запроса: ученик переподключается посреди лекции, и
   * решение учителя должно остаться в силе после его перезагрузки страницы.
   */
  lectureRestore: boolean('lecture_restore').notNull().default(true),
  /**
   * Часть 1 (2026-10-13): снимок «что горело» — с НИХНЕЙ стороны, а не с клиентской.
   *
   * Маршрут включения лекции читает список участников ДО того, как отзывать публикацию, и пишет
   * здесь для каждого ученика, включены ли у него микрофон и камера. Причина ровно одна: отзыв
   * публикации доходит до браузера раньше нашего кадра (замер CI 2026-10-13), поэтому снимок,
   * сделанный на клиенте по кадру, показывает пустоту. Сервер снимок делает в момент, который он
   * сам же и меняет, — порядок событий ему не мешает, и снимок переживает перезагрузку страницы
   * ученика посреди лекции. Ключ — identity участника; наружу из него отдаётся только запись
   * спрашивающего (статус урока), чужой список не видит никто.
   */
  lecturePreDevices: jsonb('lecture_pre_devices')
    .$type<Record<string, { mic: boolean; cam: boolean }>>().notNull().default({}),
  /**
   * Часть 3 (2026-10-14): право рисовать на доске.
   *
   * Живёт на СЕССИИ, а не в сокете: ученик переподключается, обновляет страницу, приходит позже —
   * разрешение должно остаться тем, его сделал учитель, а не тем, что запомнил чей-то клиент.
   * `boardDrawStudents` — множество `userId → true`; `boardDrawAll` — «разрешить всем», включая
   * тех, кто придёт после. Проверяется сервером на КАЖДОМ сообщении доски (см. routes/board.ts),
   * а не только при подключении: отзыв действует сразу.
   */
  boardDrawAll: boolean('board_draw_all').notNull().default(false),
  boardDrawStudents: jsonb('board_draw_students').$type<Record<string, true>>().notNull().default({}),
  /**
   * Layout for everyone (task B): gallery/stage/teacher are the classic modes,
   * 'auto' lets the client pick; boardOpen promotes the whiteboard to the main
   * stage window for ALL participants (jsonb — no migration needed).
   */
  layoutState: jsonb('layout_state').$type<{ layout: 'auto' | 'gallery' | 'stage' | 'teacher'; boardOpen?: boolean }>().notNull().default({ layout: 'gallery' }),
  /** task 2 (2026-10-09): who may write comments during THIS lesson */
  commentsMode: commentsModeEnum('comments_mode').notNull().default('on'),
  createdBy: uuid('created_by').notNull().references(() => users.id),
}, (t) => [index('lessons_class_idx').on(t.classId, t.startedAt)]);

/**
 * Task 2 (2026-10-09) — comments written while a lesson runs. They belong to the SESSION, not to
 * the class: a finished lesson keeps its own transcript, and access is decided through the
 * session's class (see `commentAccess`), so a foreign session and a nonexistent one answer
 * identically. Text is plain (never HTML-rendered on the client) and deletion is SOFT —
 * `deleted_at` keeps the fact that something was removed while the content goes away; the
 * author is kept for the teacher's moderation view, and `eraseAccount` deletes rows physically.
 */
export const lessonComments = pgTable('lesson_comments', {
  id: uuid('id').primaryKey().defaultRandom(),
  sessionId: uuid('lesson_session_id').notNull().references(() => lessonSessions.id, { onDelete: 'cascade' }),
  authorId: uuid('author_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  text: text('text').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  /** the teacher's «закрепить»: max 3 per session, shown above the rest */
  pinned: boolean('pinned').notNull().default(false),
  /** the teacher's «отвечено» marker — a workflow flag, not a read receipt */
  answered: boolean('answered').notNull().default(false),
}, (t) => [index('lesson_comments_session_idx').on(t.sessionId, t.createdAt)]);

/**
 * «Заглушить ученика на урок» (task 2). Keyed by the session, so the mute cannot leak into the
 * next lesson and needs no expiry column; the class chat keeps its own, longer-lived mutes.
 */
export const lessonCommentMutes = pgTable('lesson_comment_mutes', {
  id: uuid('id').primaryKey().defaultRandom(),
  sessionId: uuid('lesson_session_id').notNull().references(() => lessonSessions.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  mutedBy: uuid('muted_by').notNull().references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('lesson_comment_mutes_session_user_idx').on(t.sessionId, t.userId)]);

/** Per-user «last read» so the unread counter survives a reload and follows to another device. */
export const lessonCommentReads = pgTable('lesson_comment_reads', {
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  sessionId: uuid('lesson_session_id').notNull().references(() => lessonSessions.id, { onDelete: 'cascade' }),
  lastReadAt: timestamp('last_read_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.userId, t.sessionId] })]);

/**
 * «Поднять руку» (task 2Б, 2026-10-10) — one row per person per lesson.
 *
 * Lowering the hand DELETEs the row rather than marking it: the queue is the live state of a
 * running lesson, and a finished lesson must not keep a list of who wanted to speak. The same
 * reason makes the key the session and not the class — a hand cannot leak into the next lesson
 * (same argument as `lesson_comment_mutes`).
 *
 * `granted_at` is the teacher's «дать слово». It is deliberately only a fact about the lesson:
 * the LiveKit publish permission is DERIVED from it (`floorPermission` in services/lessons.ts,
 * called from routes/lessonHands.ts), so ending the
 * lesson, lowering the hand or revoking the floor cannot leave a student able to publish — the
 * permission is rewritten every time the flag changes, and the tokens themselves are never
 * widened for anybody else.
 */
export const lessonHands = pgTable('lesson_hands', {
  id: uuid('id').primaryKey().defaultRandom(),
  sessionId: uuid('lesson_session_id').notNull().references(() => lessonSessions.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  raisedAt: timestamp('raised_at', { withTimezone: true }).notNull().defaultNow(),
  grantedAt: timestamp('granted_at', { withTimezone: true }),
}, (t) => [
  unique('lesson_hands_session_user_key').on(t.sessionId, t.userId),
  index('lesson_hands_session_idx').on(t.sessionId, t.raisedAt),
]);

export type User = typeof users.$inferSelect;
export type Class = typeof classes.$inferSelect;
export type InviteCode = typeof inviteCodes.$inferSelect;

/**
 * Часть 4 (2026-10-14): кто на уроке был. Минимальная запись «приход и уход» — одна строка на
 * (сессия, человек): `joined_at` ставится при первом входе, `left_at` — при выходе из сокета урока
 * и при завершении урока. Хранится ровно факт присутствия, без времени у микрофона и без каких-либо
 * данных о том, ЧТО говорил участник.
 *
 * Зачем это архиву: «сколько человек было на уроке» — единственный вопрос об участниках, на который
 * можно ответить честно после того, как комната закрылась (список LiveKit живёт только во время
 * урока). Таблица новая ⇒ RLS включён, политик нет, привилегий не выдано (posture 0019/0021/0025).
 */
export const lessonAttendance = pgTable('lesson_attendance', {
  id: uuid('id').primaryKey().defaultRandom(),
  sessionId: uuid('lesson_session_id').notNull().references(() => lessonSessions.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
  leftAt: timestamp('left_at', { withTimezone: true }),
}, (t) => [
  unique('lesson_attendance_session_user_key').on(t.sessionId, t.userId),
  index('lesson_attendance_session_idx').on(t.sessionId),
]);

/** §3.7 whiteboard: merged Excalidraw snapshot per (session, page).
 *  `title` is the teacher's label for the page (plain text, ≤40 chars, board-pages task 1б);
 *  empty means "no label" and the client falls back to the localized «Доска N».
 *  `authors` (часть 3) — карта `id элемента → userId` автора. Она хранится СЕРВЕРОМ и берётся
 *  из идентичности сокета, а не из тела сообщения: клиент, приславший чужой `authorId`, ничего
 *  этим не добьётся. Нужна она для двух вещей: «ученик правит только своё» и «учитель удаляет
 *  рисунки ученика». */
export const whiteboards = pgTable('whiteboards', {
  sessionId: uuid('session_id').notNull().references(() => lessonSessions.id, { onDelete: 'cascade' }),
  pageNo: integer('page_no').notNull(),
  title: text('title').notNull().default(''),
  snapshot: jsonb('snapshot').$type<{ elements: unknown[]; appState: Record<string, unknown> }>().notNull().default({ elements: [], appState: {} }),
  authors: jsonb('authors').$type<Record<string, string>>().notNull().default({}),
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

/**
 * Часть A (2026-10-16). `sending` — ряд захвачен одним проходом и больше никому не виден;
 * `expired` — просрочен и не отправляется (свежесть, см. `sendDue`).
 */
export const notificationStatusEnum = pgEnum('notification_status',
  ['pending', 'sending', 'sent', 'failed', 'blocked', 'skipped', 'expired']);

// ─── Telegram bot dialogs (bot task §6) ──────────────────────────────────────

/**
 * Dialog state lives in Postgres, NOT in memory: the Render service sleeps and
 * restarts between updates, but an /announce confirmation or a /contact step
 * must survive that. One row per private chat.
 */
export const botSessions = pgTable('bot_sessions', {
  chatId: text('chat_id').primaryKey(),
  /** e.g. announce:class | announce:text | announce:confirm | contact:name | contact:class | contact:text | reply:<role> */
  state: text('state').notNull().default(''),
  data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Idempotency ledger: a redelivered update_id must never repeat an action.
 *
 * Часть A4 (2026-10-16): маршрут `/webhook/telegram` отвечает Telegram сразу после записи
 * сюда, а обработку делает фоном. Поэтому строка знает не только «я такое видела», но и
 * что именно: `payload` — сам update, `processed_at` — NULL, пока действие не выполнено.
 * При старте процесса незавершённые строки моложе 10 минут переобрабатываются (иначе
 * падение в фоне или рестарт сервиса на холодном Render теряли обновление навсегда).
 * `payload` — текст, который кто-то написал боту: `sweepBotState` держит журнал 24 ч,
 * этого с запасом хватает и на повторные доставки Telegram, и на 10-минутное окно
 * переобработки.
 */
export const botUpdates = pgTable('bot_updates', {
  updateId: bigint('update_id', { mode: 'number' }).primaryKey(),
  seenAt: timestamp('seen_at', { withTimezone: true }).notNull().defaultNow(),
  payload: jsonb('payload').$type<Record<string, unknown>>(),
  processedAt: timestamp('processed_at', { withTimezone: true }),
});

/** /contact reports: what the sender typed + delivery/reply bookkeeping. */
export const contactReports = pgTable('contact_reports', {
  id: uuid('id').primaryKey().defaultRandom(),
  senderChatId: text('sender_chat_id').notNull(),
  senderUserId: uuid('sender_user_id').references(() => users.id, { onDelete: 'set null' }),
  name: text('name').notNull(),
  classHint: text('class_hint').notNull(),
  classId: uuid('class_id').references(() => classes.id, { onDelete: 'set null' }),
  message: text('message').notNull(),
  teacherUserId: uuid('teacher_user_id').references(() => users.id, { onDelete: 'set null' }),
  teacherChatId: text('teacher_chat_id'),
  delivered: boolean('delivered').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  /** the report↔chat link (reply routing) is kept for 30 days only */
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
});

/** senders a teacher blocked from /contact; the teacher can unblock in /settings */
export const contactBlocklist = pgTable('contact_blocklist', {
  senderChatId: text('sender_chat_id').primaryKey(),
  blockedBy: uuid('blocked_by').references(() => users.id, { onDelete: 'set null' }),
  blockedAt: timestamp('blocked_at', { withTimezone: true }).notNull().defaultNow(),
});

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
  /**
   * Часть A1 (2026-10-16): момент атомарного захвата ряда проходом `sendDue`. Пока
   * `status = 'sending'`, строку никто другой не берёт; зависший захват (процесс умер
   * между отправкой и записью итога) старше 5 минут возвращается в `pending`.
   */
  lockedAt: timestamp('locked_at', { withTimezone: true }),
  /**
   * Часть A2: начало того события, ради которого это напоминание (`EnqueueArgs.when` для
   * очередей из `enqueueNotification`, время вхождения для `scanReminders`). NULL у рядов,
   * поставленных до миграции 0031, — для них проверка свежести сводится к возрасту `send_at`.
   */
  startsAt: timestamp('starts_at', { withTimezone: true }),
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
  editedAt: timestamp('edited_at', { withTimezone: true }),
  /**
   * Reply task 2 (2026-10-08). The live link to the quoted message: ON DELETE SET NULL, so
   * deleting an original never fails and never takes the answer with it.
   */
  replyToId: uuid('reply_to_id').references((): AnyPgColumn => chatMessages.id, { onDelete: 'set null' }),
  /**
   * The same id WITHOUT a constraint. Message deletion is PHYSICAL (it is part of `eraseAccount`),
   * and after the SET NULL above nothing in the row would say that a quote was ever there — this
   * column is what lets the API answer `replyTo.deleted = true` and the client show
   * «Сообщение удалено». It stores an id only: no author name, no text of the deleted message.
   */
  replyRefId: uuid('reply_ref_id'),
}, (t) => [
  index('chat_messages_class_time_idx').on(t.classId, t.createdAt),
  index('chat_messages_reply_to_idx').on(t.replyToId),
  index('chat_messages_reply_ref_idx').on(t.replyRefId),
]);

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

/**
 * Legal/consent (Hardening Phase 2): the privacy+terms bundle a user accepted,
 * with its version and the acceptance instant. One row per user; the SPA shows
 * the accept gate whenever the stored version differs from the CURRENT one, so
 * a new policy version is re-accepted once on next login. FK cascades so account
 * deletion removes it.
 */
export const policyAcceptances = pgTable('policy_acceptances', {
  userId: uuid('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  version: text('version').notNull(),
  acceptedAt: timestamp('accepted_at', { withTimezone: true }).notNull().defaultNow(),
});

// ─── Telegram homework assistant (2026-10-22) ────────────────────────────────
//
// A deliberately separate domain: nothing here alters `classes`, `posts` or the
// public-site flows. Offline groups exist only in these tables, and a publication
// belongs to a Telegram chat, not to a BluBlu class. The optional bridge to class
// materials is NOT implemented; it can be added later without changing this shape.

/** Telegram groups an operator may publish to. Soft-removed, never deleted: history survives. */
export const tgGroupKindEnum = pgEnum('tg_group_kind', ['online', 'offline']);
export const tgGroupStatusEnum = pgEnum('tg_group_status', ['active', 'removed']);
/**
 * Draft lifecycle. `publish_unknown` is terminal: at least one send may have happened.
 * `choosing_materials` and `awaiting_instruction` (migration 0034) are the two library
 * steps that sit between "groups picked" and "collecting": the teacher either chooses a
 * saved book or continues without one, and then says what to do with it.
 */
export const tgDraftStatusEnum = pgEnum('tg_draft_status', [
  'selecting', 'choosing_materials', 'awaiting_instruction', 'collecting', 'formatting',
  'needs_clarification', 'preview', 'publishing', 'published', 'failed',
  'publish_unknown', 'cancelled',
]);
export const tgItemKindEnum = pgEnum('tg_item_kind', ['text', 'link', 'photo', 'document']);
export const tgPublicationStatusEnum = pgEnum('tg_publication_status',
  ['sending', 'sent', 'failed', 'uncertain']);
/** A reusable attachment: a textbook, a workbook, anything else the teacher uploads once. */
export const tgMaterialKindEnum = pgEnum('tg_material_kind', ['book', 'workbook', 'other']);
/** `archived` = «убрано из рекомендаций»: файл остаётся, новые задания его не предлагают. */
export const tgMaterialStatusEnum = pgEnum('tg_material_status', ['active', 'archived']);
/**
 * Which Telegram message carried the file. This is NOT the MIME type: a PNG sent «as a
 * file» arrives in `message.document`, and its `file_id` can only be sent as a document.
 * Guessing from `image/png` is exactly what broke the live test of 2026-10-23
 * (`400 can't use file of type Document as Photo`), so the type is recorded, not inferred.
 * Rows written before this column exists are NULL: publication then copies the original
 * message when it knows the source, and otherwise sends a document.
 */
export const tgMediaTypeEnum = pgEnum('tg_media_type', ['photo', 'document']);

/** One row per linked BluBlu teacher who has ever used /homework. */
export const tgOperators = pgTable('tg_operators', {
  userId: uuid('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  telegramUserId: bigint('telegram_user_id', { mode: 'number' }).notNull(),
  telegramChatId: text('telegram_chat_id').notNull(),
  username: text('username').notNull().default(''),
  displayName: text('display_name').notNull().default(''),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [unique('tg_operators_chat_key').on(t.telegramChatId)]);

/**
 * A group is identified by (owner, Telegram chat). The same Telegram group can be
 * connected by two teachers only if both are administrators — binding requires it.
 */
export const tgGroups = pgTable('tg_groups', {
  id: uuid('id').primaryKey().defaultRandom(),
  ownerId: uuid('owner_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  telegramChatId: text('telegram_chat_id').notNull(),
  title: text('title').notNull(),
  kind: tgGroupKindEnum('kind').notNull().default('offline'),
  status: tgGroupStatusEnum('status').notNull().default('active'),
  boundAt: timestamp('bound_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique('tg_groups_owner_chat_key').on(t.ownerId, t.telegramChatId),
  index('tg_groups_owner_status_idx').on(t.ownerId, t.status),
]);

/** One-time code typed as `/bind CODE` in a group. Only the hash is stored. */
export const tgBindTokens = pgTable('tg_bind_tokens', {
  tokenHash: text('token_hash').primaryKey(),
  ownerId: uuid('owner_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
}, (t) => [index('tg_bind_tokens_expiry_idx').on(t.expiresAt)]);

/**
 * A homework draft. Materials live in `tg_draft_items`; selected groups in
 * `tg_draft_targets`. The AI result is stored as plain text — it is what the
 * teacher previews and what publication sends, so a restart changes nothing.
 */
export const tgDrafts = pgTable('tg_drafts', {
  id: uuid('id').primaryKey().defaultRandom(),
  ownerId: uuid('owner_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  status: tgDraftStatusEnum('status').notNull().default('selecting'),
  title: text('title').notNull().default(''),
  formattedText: text('formatted_text').notNull().default(''),
  /**
   * The teacher's own words about the task (`Unit 2, Exercises 1–5`). It is the only text
   * a library-based homework has besides the collected materials, so it is stored apart
   * from `formattedText`: the teacher may edit the final message without losing what she
   * actually asked for.
   */
  instruction: text('instruction').notNull().default(''),
  aiQuestions: jsonb('ai_questions').$type<string[]>().notNull().default([]),
  aiWarnings: jsonb('ai_warnings').$type<string[]>().notNull().default([]),
  aiProvider: text('ai_provider').notNull().default(''),
  lastError: text('last_error').notNull().default(''),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  publishedAt: timestamp('published_at', { withTimezone: true }),
}, (t) => [index('tg_drafts_owner_status_idx').on(t.ownerId, t.status, t.updatedAt)]);

export const tgDraftTargets = pgTable('tg_draft_targets', {
  draftId: uuid('draft_id').notNull().references(() => tgDrafts.id, { onDelete: 'cascade' }),
  groupId: uuid('group_id').notNull().references(() => tgGroups.id, { onDelete: 'cascade' }),
  position: integer('position').notNull().default(0),
}, (t) => [primaryKey({ columns: [t.draftId, t.groupId] })]);

/**
 * One collected material per source Telegram message. `file_id` is Telegram's own
 * reference: bytes are never copied into Render's ephemeral disk or into Postgres.
 * The unique (draft, source message) key makes webhook redelivery harmless.
 *
 * `source_chat_id` + `source_message_id` are what publication actually uses: Telegram
 * `copyMessage` re-posts the ORIGINAL message, so a photo stays a photo, a document stays
 * a document, and the caption, file name and grouping of an album survive. `file_id` is a
 * fallback only — and the live test of 2026-10-23 proved why: a PNG sent as a document has
 * a document `file_id`, and `sendPhoto` rejected it with
 * «400 can't use file of type Document as Photo».
 * `source_media_group_id` is Telegram's album id: items sharing it are copied with one
 * `copyMessages` call, which keeps the album together in the group.
 */
export const tgDraftItems = pgTable('tg_draft_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  draftId: uuid('draft_id').notNull().references(() => tgDrafts.id, { onDelete: 'cascade' }),
  position: integer('position').notNull().default(0),
  kind: tgItemKindEnum('kind').notNull(),
  text: text('text').notNull().default(''),
  url: text('url'),
  fileId: text('file_id'),
  fileUniqueId: text('file_unique_id'),
  fileName: text('file_name'),
  mimeType: text('mime_type'),
  fileSize: bigint('file_size', { mode: 'number' }),
  caption: text('caption').notNull().default(''),
  sourceMessageId: bigint('source_message_id', { mode: 'number' }).notNull(),
  sourceChatId: text('source_chat_id'),
  sourceMediaGroupId: text('source_media_group_id'),
  forwarded: boolean('forwarded').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique('tg_draft_items_source_key').on(t.draftId, t.sourceMessageId),
  index('tg_draft_items_draft_idx').on(t.draftId, t.position),
]);

/**
 * How one part of a publication ended up. `sent` means Telegram confirmed that part with a
 * message id, `failed` means Telegram refused exactly that part, `unknown` means the answer
 * never arrived and the part may have been delivered. The teacher's result screen is built
 * from these rows, so «the text went out, the file did not» is never reported as «nothing
 * was sent».
 */
export interface PublicationPart {
  kind: 'text' | 'material' | 'photo' | 'document';
  label: string;
  method: 'copy' | 'file_id' | 'text';
  status: 'sent' | 'failed' | 'unknown';
  messageId: number | null;
  error: string;
}

/** Per-group real outcome of one publish attempt; group title/chat are snapshotted for history. */
export const tgPublications = pgTable('tg_publications', {
  id: uuid('id').primaryKey().defaultRandom(),
  draftId: uuid('draft_id').notNull().references(() => tgDrafts.id, { onDelete: 'cascade' }),
  groupId: uuid('group_id').notNull().references(() => tgGroups.id),
  groupTitle: text('group_title').notNull(),
  telegramChatId: text('telegram_chat_id').notNull(),
  status: tgPublicationStatusEnum('status').notNull().default('sending'),
  telegramMessageId: bigint('telegram_message_id', { mode: 'number' }),
  error: text('error').notNull().default(''),
  /** Per-part outcome of this attempt (text plus every attachment), newest run only. */
  parts: jsonb('parts').$type<PublicationPart[]>().notNull().default([]),
  attempts: integer('attempts').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique('tg_publications_draft_group_key').on(t.draftId, t.groupId),
  index('tg_publications_draft_idx').on(t.draftId),
]);

/**
 * Short callback references. Telegram allows 64 bytes of callback_data; the
 * existing signed payloads are longer, so this module uses `h1.<16 chars>` and
 * keeps the meaning server-side. One-time rows are atomically claimed.
 */
export const tgCallbackTokens = pgTable('tg_callback_tokens', {
  token: text('token').primaryKey(),
  ownerId: uuid('owner_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  payload: jsonb('payload').$type<Record<string, string>>().notNull().default({}),
  once: boolean('once').notNull().default(true),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('tg_callback_tokens_expiry_idx').on(t.expiresAt)]);

/**
 * The teacher's material library (2026-10-22, part B).
 *
 * A material is a FILE the teacher uploads once and re-uses as an attachment — a textbook,
 * a workbook. Its bytes are never stored: Telegram's own `file_id` plus the coordinates of
 * the original message (`source_chat_id`, `source_message_id`) are enough, and publication
 * prefers `copyMessage` on those coordinates — no download, no re-upload, and the media
 * keeps the type it really has. `file_unique_id` is the stable identity, so uploading the same
 * book twice updates one row instead of filling the library with duplicates.
 *
 * The contents are deliberately NOT read here (no OCR, no PDF/DOCX parser, no vision): the
 * formatter sees the title the teacher typed, never the file. That is also why a broken
 * `file_id` is a re-upload problem and not a data-loss problem.
 */
export const tgMaterials = pgTable('tg_materials', {
  id: uuid('id').primaryKey().defaultRandom(),
  ownerId: uuid('owner_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  kind: tgMaterialKindEnum('kind').notNull().default('other'),
  telegramFileId: text('telegram_file_id').notNull(),
  fileUniqueId: text('file_unique_id').notNull(),
  mediaType: tgMediaTypeEnum('media_type'),
  fileName: text('file_name').notNull().default(''),
  mimeType: text('mime_type').notNull().default(''),
  fileSize: bigint('file_size', { mode: 'number' }),
  /** Where the original message still lives: `copyMessage` reads the file from here. */
  sourceChatId: text('source_chat_id'),
  sourceMessageId: bigint('source_message_id', { mode: 'number' }),
  status: tgMaterialStatusEnum('status').notNull().default('active'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
}, (t) => [
  unique('tg_materials_owner_file_key').on(t.ownerId, t.fileUniqueId),
  index('tg_materials_owner_status_idx').on(t.ownerId, t.status, t.updatedAt),
  index('tg_materials_owner_used_idx').on(t.ownerId, t.status, t.lastUsedAt),
]);

/** «В каких группах этот материал уместен». Recommendations are per group, never global. */
export const tgMaterialGroups = pgTable('tg_material_groups', {
  materialId: uuid('material_id').notNull().references(() => tgMaterials.id, { onDelete: 'cascade' }),
  groupId: uuid('group_id').notNull().references(() => tgGroups.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.materialId, t.groupId] }),
  index('tg_material_groups_group_idx').on(t.groupId),
]);

/**
 * A material chosen for one draft, stored as a SNAPSHOT (title, kind, file id).
 *
 * `material_id` is ON DELETE SET NULL on purpose: removing a book from the library must
 * never touch a draft that is being written, and must never rewrite the history of what
 * was already published. Renaming a material has the same property — the draft keeps the
 * title that was chosen at the time.
 */
export const tgDraftMaterials = pgTable('tg_draft_materials', {
  id: uuid('id').primaryKey().defaultRandom(),
  draftId: uuid('draft_id').notNull().references(() => tgDrafts.id, { onDelete: 'cascade' }),
  materialId: uuid('material_id').references(() => tgMaterials.id, { onDelete: 'set null' }),
  position: integer('position').notNull().default(0),
  title: text('title').notNull(),
  kind: tgMaterialKindEnum('kind').notNull().default('other'),
  telegramFileId: text('telegram_file_id').notNull(),
  fileUniqueId: text('file_unique_id'),
  mediaType: tgMediaTypeEnum('media_type'),
  fileName: text('file_name').notNull().default(''),
  mimeType: text('mime_type').notNull().default(''),
  fileSize: bigint('file_size', { mode: 'number' }),
  /** Snapshotted with the choice: the book may be re-uploaded later, this draft keeps its own. */
  sourceChatId: text('source_chat_id'),
  sourceMessageId: bigint('source_message_id', { mode: 'number' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique('tg_draft_materials_draft_file_key').on(t.draftId, t.telegramFileId),
  index('tg_draft_materials_draft_idx').on(t.draftId, t.position),
]);
