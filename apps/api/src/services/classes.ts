import { and, eq, desc, isNull, sql } from 'drizzle-orm';
import { classes, classMembers, users } from '../db/schema.js';
import type { DB } from '../db/index.js';

export interface ClassView {
  id: string;
  name: string;
  description: string;
  color: string;
  teacherId: string;
  teacherName: string;
  archived: boolean;
  chatMode: 'on' | 'off' | 'announce'; // item 8
  botPublicSchedule: boolean; // bot task §3
  /** часть 4: показывать ли ученикам архив досок этого класса */
  boardArchivePublic: boolean;
  memberCount: number;
  role: 'teacher' | 'student';
}

/** Access check per §7: member or owning teacher, otherwise null → route answers 404. */
export async function resolveClass(db: DB, userId: string, role: 'teacher' | 'student', classId: string) {
  if (role === 'teacher') {
    const [c] = await db
      .select()
      .from(classes)
      .where(and(eq(classes.id, classId), eq(classes.teacherId, userId), isNull(classes.archivedAt)))
      .limit(1);
    return c ?? null;
  }
  const [c] = await db
    .select({ cls: classes })
    .from(classMembers)
    .innerJoin(classes, and(eq(classes.id, classMembers.classId), isNull(classes.archivedAt)))
    .where(and(eq(classMembers.userId, userId), eq(classMembers.classId, classId)))
    .limit(1)
    .then((r) => r.map((x) => x.cls));
  return c ?? null;
}

export async function listMyClasses(db: DB, userId: string, role: 'teacher' | 'student', includeArchived = false): Promise<ClassView[]> {
  if (role === 'teacher') {
    const where = includeArchived
      ? eq(classes.teacherId, userId)
      : and(eq(classes.teacherId, userId), isNull(classes.archivedAt));
    return db
      .select({
        id: classes.id,
        name: classes.name,
        description: classes.description,
        color: classes.color,
        teacherId: classes.teacherId,
        teacherName: sql<string>`concat_ws(' ', ${users.name}, nullif(${users.lastName}, ''))`,
        archived: sql<boolean>`(classes.archived_at IS NOT NULL)`,
        chatMode: classes.chatMode,
        botPublicSchedule: classes.botPublicSchedule,
        boardArchivePublic: classes.boardArchivePublic,
        memberCount: sql<number>`(select count(*)::int from class_members where class_members.class_id = classes.id)`,
        role: sql<'teacher'>`'teacher'`,
      })
      .from(classes)
      .innerJoin(users, eq(users.id, classes.teacherId))
      .where(where)
      .orderBy(desc(classes.createdAt));
  }
  const where = includeArchived
    ? eq(classMembers.userId, userId)
    : and(eq(classMembers.userId, userId), isNull(classes.archivedAt));
  return db
    .select({
      id: classes.id,
      name: classes.name,
      description: classes.description,
      color: classes.color,
      teacherId: classes.teacherId,
      teacherName: sql<string>`concat_ws(' ', ${users.name}, nullif(${users.lastName}, ''))`,
      archived: sql<boolean>`(classes.archived_at IS NOT NULL)`,
      chatMode: classes.chatMode,
        botPublicSchedule: classes.botPublicSchedule,
        boardArchivePublic: classes.boardArchivePublic,
      memberCount: sql<number>`(select count(*)::int from class_members where class_members.class_id = classes.id)`,
      role: sql<'student'>`'student'`,
    })
    .from(classMembers)
    .innerJoin(classes, eq(classes.id, classMembers.classId))
    .innerJoin(users, eq(users.id, classes.teacherId))
    .where(where)
    .orderBy(desc(classes.createdAt));
}

export async function createClass(db: DB, teacherId: string, input: { name: string; description: string; color: string; botPublicSchedule?: boolean; boardArchivePublic?: boolean }) {
  const [c] = await db.insert(classes).values({ ...input, teacherId }).returning();
  return c;
}

export async function updateClass(db: DB, classId: string, input: Partial<{ name: string; description: string; color: string; botPublicSchedule: boolean; boardArchivePublic: boolean }>) {
  const [c] = await db.update(classes).set(input).where(eq(classes.id, classId)).returning();
  return c;
}

export async function archiveClass(db: DB, classId: string) {
  await db.update(classes).set({ archivedAt: new Date() }).where(eq(classes.id, classId));
}

export async function listMembers(db: DB, classId: string) {
  return db
    .select({
      userId: users.id,
      name: sql<string>`concat_ws(' ', ${users.name}, nullif(${users.lastName}, ''))`,
      email: users.email,
      joinedAt: classMembers.joinedAt,
    })
    .from(classMembers)
    .innerJoin(users, and(eq(users.id, classMembers.userId), isNull(users.deletedAt)))
    .where(eq(classMembers.classId, classId))
    .orderBy(classMembers.joinedAt);
}

export async function removeMember(db: DB, classId: string, userId: string) {
  await db.delete(classMembers).where(and(eq(classMembers.classId, classId), eq(classMembers.userId, userId)));
}

/** Teacher-to-teacher direct add is out of scope for v1 (1–5 teachers);
 * a teacher may add an existing STUDENT to their own class without a code. */
export async function addStudentDirectly(db: DB, classId: string, studentId: string) {
  const [student] = await db
    .select()
    .from(users)
    .where(and(eq(users.id, studentId), eq(users.role, 'student'), isNull(users.deletedAt)))
    .limit(1);
  if (!student) return false;
  await db
    .insert(classMembers)
    .values({ classId, userId: studentId })
    .onConflictDoNothing();
  return true;
}

export type AddStudentByEmailResult =
  | { ok: true; userId: string; name: string; alreadyMember: boolean }
  | { ok: false; reason: 'studentNotFound' | 'notAStudent' };

/**
 * 2026-10-26 — «ученик забыл пароль, а в списке класса его нет».
 *
 * Учитель ищет уже существующий аккаунт по почте и добавляет его в СВОЙ класс. Пароль здесь
 * не трогается вообще: после добавления ученик появляется в списке, и срабатывает обычный
 * сброс (временный пароль + обязательная смена). Это единственный безопасный способ добраться
 * до аккаунта, который ещё не состоит в классе: сброс требует членства.
 *
 * Почта приходит уже нормализованной схемой (`memberAddSchema` → trim/lowercase), как при
 * входе и регистрации. Членство защищено первичным ключом `(class_id, user_id)` и
 * `onConflictDoNothing`, поэтому два одновременных запроса не создадут дубль; по числу
 * вставленных строк честно различается «добавили» и «уже был».
 */
export async function addStudentByEmail(db: DB, classId: string, email: string): Promise<AddStudentByEmailResult> {
  return db.transaction(async (tx) => {
    const [student] = await tx
      .select({ id: users.id, role: users.role, name: users.name, lastName: users.lastName })
      .from(users)
      .where(and(eq(users.email, email), isNull(users.deletedAt)))
      .limit(1);
    // удалённый аккаунт намеренно выглядит как отсутствующий: добавлять его в класс нельзя
    if (!student) return { ok: false, reason: 'studentNotFound' } as const;
    if (student.role !== 'student') return { ok: false, reason: 'notAStudent' } as const;
    const inserted = await tx
      .insert(classMembers)
      .values({ classId, userId: student.id })
      .onConflictDoNothing()
      .returning({ userId: classMembers.userId });
    return {
      ok: true,
      userId: student.id,
      name: `${student.name} ${student.lastName}`.trim(),
      alreadyMember: inserted.length === 0,
    } as const;
  });
}

/** Move a student from one class to another; both must be owned by the same teacher (v1). */
export async function moveMember(db: DB, teacherId: string, fromClassId: string, toClassId: string, userId: string): Promise<boolean> {
  const [from, to] = await Promise.all([
    db.select({ id: classes.id }).from(classes).where(and(eq(classes.id, fromClassId), eq(classes.teacherId, teacherId))).limit(1),
    db.select({ id: classes.id }).from(classes).where(and(eq(classes.id, toClassId), eq(classes.teacherId, teacherId))).limit(1),
  ]);
  if (!from[0] || !to[0]) return false;
  await db.transaction(async (tx) => {
    await tx.delete(classMembers).where(and(eq(classMembers.classId, fromClassId), eq(classMembers.userId, userId)));
    await tx.insert(classMembers).values({ classId: toClassId, userId }).onConflictDoNothing();
  });
  return true;
}
