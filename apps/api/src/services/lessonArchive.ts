import { and, desc, eq, isNull, lt, sql } from 'drizzle-orm';
import { lessonAttendance, lessonComments, lessonSessions, users, whiteboards } from '../db/schema.js';
import type { DB } from '../db/index.js';
export { MAX_SCENE_BYTES } from './board.js';

/**
 * Часть 4 (2026-10-14): архив завершённых уроков.
 *
 * Архив строится ПОВЕРХ существующих таблиц: `lesson_sessions` (дата и длительность),
 * `whiteboards` (сцены), `lesson_comments` (расшифровка) и новой `lesson_attendance` (приход и
 * уход). Отдельной «архивной копии» нет намеренно: копия — это второй источник правды, который
 * всегда отстаёт от первого.
 */

export const ARCHIVE_PAGE_MAX = 50;

export interface ArchiveRow {
  id: string; startedAt: Date; endedAt: Date | null; eventId: string | null;
  durationMin: number; boards: number; comments: number; participants: number;
}

/** Пришёл: первая строка на (урок, человек). Переподключения новой строки не заводят. */
export async function recordJoin(db: DB, sessionId: string, userId: string): Promise<void> {
  await db.insert(lessonAttendance).values({ sessionId, userId })
    .onConflictDoNothing({ target: [lessonAttendance.sessionId, lessonAttendance.userId] });
}

/** Ушёл: закрывается последний незакрытый приход, более ранние не переписываются. */
export async function recordLeave(db: DB, sessionId: string, userId: string): Promise<void> {
  await db.update(lessonAttendance).set({ leftAt: new Date() })
    .where(and(
      eq(lessonAttendance.sessionId, sessionId),
      eq(lessonAttendance.userId, userId),
      isNull(lessonAttendance.leftAt),
    ));
}

/** Урок завершили: у тех, кто не нажал «выйти», уход ставится фактом завершения. */
export async function closeAttendance(db: DB, sessionId: string): Promise<void> {
  await db.update(lessonAttendance).set({ leftAt: new Date() })
    .where(and(eq(lessonAttendance.sessionId, sessionId), isNull(lessonAttendance.leftAt)));
}

/**
 * Список завершённых уроков класса, от новых к старым.
 *
 * Курсор — `before` по startedAt (тот же приём, что у чата): страница смещается по времени, а не по
 * «номеру страницы», который разъезжается, пока учитель удаляет записи. В архив попадают ТОЛЬКО
 * завершённые уроки: идущий урок — это не история, он и так доступен целиком.
 *
 * `eventId` — ссылка из прошедшего события календаря: у события есть только свой id, а нужен урок,
 * который по нему проводился. Фильтр серверный, потому что «какое событие → какой урок» знает
 * только база, и потому что право на этот урок всё равно проверяет `resolveClass` до вызова.
 */
export async function listArchive(
  db: DB, params: { classId: string; before: Date | null; limit: number; eventId?: string | null },
): Promise<{ items: ArchiveRow[]; nextCursor: string | null }> {
  const { classId, before, eventId } = params;
  const size = Math.min(Math.max(Math.trunc(params.limit) || 1, 1), ARCHIVE_PAGE_MAX);
  const cond = [eq(lessonSessions.classId, classId), sql`${lessonSessions.endedAt} is not null`];
  if (before) cond.push(lt(lessonSessions.startedAt, before));
  if (eventId) cond.push(eq(lessonSessions.eventId, eventId));
  const rows = await db.select({
    id: lessonSessions.id,
    startedAt: lessonSessions.startedAt,
    endedAt: lessonSessions.endedAt,
    eventId: lessonSessions.eventId,
    /*
     * Корреляция названа таблицей явно. `${lessonSessions.id}` внутри `sql`-поля SELECT дренч
     * разворачивает ГОЛЫМ `"id"`, а такое имя в подзапросе относится к таблице самого подзапроса:
     * `from lesson_comments c where c.lesson_session_id = "id"` считало `c.id`, то есть всегда ноль.
     * Интеграционный тест это и поймал — boards=1 при comments=0 на одной и той же строке.
     */
    boards: sql<number>`(select count(*) from whiteboards w where w.session_id = "lesson_sessions"."id")`,
    comments: sql<number>`(select count(*) from lesson_comments c where c.lesson_session_id = "lesson_sessions"."id" and c.deleted_at is null)`,
    participants: sql<number>`(select count(*) from lesson_attendance a where a.lesson_session_id = "lesson_sessions"."id")`,
  }).from(lessonSessions)
    .where(and(...cond))
    .orderBy(desc(lessonSessions.startedAt))
    .limit(size + 1);
  const hasMore = rows.length > size;
  const page = hasMore ? rows.slice(0, size) : rows;
  const last = page.at(-1);
  return {
    items: page.map((r) => ({
      id: r.id,
      startedAt: r.startedAt,
      endedAt: r.endedAt,
      eventId: r.eventId,
      durationMin: r.endedAt ? Math.max(0, Math.round((+r.endedAt - +r.startedAt) / 60_000)) : 0,
      boards: Number(r.boards), comments: Number(r.comments), participants: Number(r.participants),
    })),
    nextCursor: hasMore && last ? new Date(last.startedAt).toISOString() : null,
  };
}

/**
 * Доски завершённого урока. `bytes` отдаётся рядом со сценой, чтобы клиент решал, что рисовать
 * сразу, а что подгрузить по клику: миниатюра строится из той же сцены на клиенте.
 */
export async function archiveBoards(db: DB, sessionId: string) {
  const rows = await db.select({
    pageNo: whiteboards.pageNo,
    title: whiteboards.title,
    snapshot: whiteboards.snapshot,
    bytes: sql<number>`length(cast(${whiteboards.snapshot} as text))`,
    updatedAt: whiteboards.updatedAt,
  }).from(whiteboards).where(eq(whiteboards.sessionId, sessionId)).orderBy(whiteboards.pageNo);
  return rows.map((r) => ({
    pageNo: r.pageNo,
    title: r.title,
    updatedAt: r.updatedAt,
    bytes: Number(r.bytes),
    elements: ((r.snapshot as { elements?: unknown[] }).elements ?? []) as unknown[],
  }));
}

/** Комментарии завершённого урока — только учителю. Мягко удалённые не возвращаются никогда. */
export async function archiveComments(db: DB, sessionId: string) {
  const rows = await db.select({
    id: lessonComments.id,
    text: lessonComments.text,
    createdAt: lessonComments.createdAt,
    author: users.name,
    authorLastName: users.lastName,
    pinned: lessonComments.pinned,
    answered: lessonComments.answered,
  }).from(lessonComments)
    .innerJoin(users, eq(users.id, lessonComments.authorId))
    .where(and(eq(lessonComments.sessionId, sessionId), isNull(lessonComments.deletedAt)))
    .orderBy(lessonComments.createdAt);
  return rows.map((r) => ({
    id: r.id, text: r.text, createdAt: r.createdAt, pinned: r.pinned, answered: r.answered,
    author: [r.author, r.authorLastName].filter(Boolean).join(' ') || '—',
  }));
}

/** Кто на уроке был — только учителю своего класса. Ровно приход и уход, без «кто сколько молчал». */
export async function archiveAttendance(db: DB, sessionId: string) {
  const rows = await db.select({
    userId: lessonAttendance.userId,
    joinedAt: lessonAttendance.joinedAt,
    leftAt: lessonAttendance.leftAt,
    name: users.name,
    lastName: users.lastName,
    role: users.role,
  }).from(lessonAttendance)
    .innerJoin(users, eq(users.id, lessonAttendance.userId))
    .where(eq(lessonAttendance.sessionId, sessionId))
    .orderBy(lessonAttendance.joinedAt);
  return rows.map((r) => ({
    userId: r.userId,
    name: [r.name, r.lastName].filter(Boolean).join(' ') || '—',
    role: r.role, joinedAt: r.joinedAt, leftAt: r.leftAt,
  }));
}

/**
 * Срок хранения: `BOARD_ARCHIVE_RETENTION_DAYS`, 0 (по умолчанию) — не удалять никогда. Архив —
 * учебная история, и терять её по умолчанию нельзя; включается только решением владельца.
 * Удаление идёт каскадом: вместе с записью урока уходят доски, комментарии, руки и присутствие.
 */
export async function sweepArchive(db: DB, retentionDays: number, now = new Date()): Promise<number> {
  if (!retentionDays) return 0;
  const cutoff = new Date(now.getTime() - retentionDays * 86_400_000);
  const gone = await db.delete(lessonSessions).where(and(
    sql`${lessonSessions.endedAt} is not null`,
    lt(lessonSessions.endedAt, cutoff),
  )).returning({ id: lessonSessions.id });
  return gone.length;
}

/** Удаление записи архива учителем. Незавершённый урок этим маршрутом удалить нельзя. */
export async function deleteArchiveEntry(db: DB, sessionId: string): Promise<boolean> {
  const gone = await db.delete(lessonSessions)
    .where(and(eq(lessonSessions.id, sessionId), sql`${lessonSessions.endedAt} is not null`))
    .returning({ id: lessonSessions.id });
  return gone.length > 0;
}

/** Курсор приходит из строки; мусор (или подбор руками) трактуется как «первая страница». */
export function parseCursor(raw: unknown): Date | null {
  if (typeof raw !== 'string' || !raw) return null;
  const d = new Date(raw);
  return Number.isNaN(+d) ? null : d;
}
