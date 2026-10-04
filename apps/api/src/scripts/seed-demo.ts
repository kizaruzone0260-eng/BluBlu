import { and, eq, isNull } from 'drizzle-orm';
import { getDb, closeDb } from '../db/index.js';
import { users, classes, classMembers, posts, teacherNotes, events, inviteCodes } from '../db/schema.js';
import { hashPassword } from '../lib/password.js';
import { createInviteCode } from '../services/invites.js';

/**
 * Demo seed (docs/DEMO.md): a ready-to-show instance —
 * teacher + enrolled student + one FRESH one-time invite code per run,
 * class feed (materials/announcement), teacher notes, calendar events
 * (single, weekly recurring, deadline).
 *
 * Idempotent: re-running updates the demo class, revokes stale unused codes
 * and mints a new one. Never prints secrets other than demo credentials —
 * this is a disposable demo account, not a real one.
 */
const TEACHER = { email: 'teacher@demo.klass.local', name: 'Мария Иванова', password: 'DemoTeacher123' };
const STUDENT = { email: 'student@demo.klass.local', name: 'Азиз Каримов', password: 'DemoStudent123' };
const CLASS_NAME = 'Демо-класс 7B';

async function upsertUser(db: ReturnType<typeof getDb>, role: 'teacher' | 'student', cfg: typeof TEACHER, locale: 'ru' | 'uz') {
  const email = cfg.email.toLowerCase();
  const [existing] = await db.select().from(users)
    .where(and(eq(users.email, email), isNull(users.deletedAt)))
    .limit(1);
  if (existing) return existing;
  const passwordHash = await hashPassword(cfg.password);
  const [u] = await db.insert(users).values({ role, name: cfg.name, email, passwordHash, locale }).returning();
  return u!;
}

const day = (offset: number, hour: number) => {
  // wall-clock time in Asia/Tashkent for (today + offset) at hour:00
  const base = new Date();
  base.setDate(base.getDate() + offset);
  const ymd = `${base.getFullYear()}-${String(base.getMonth() + 1).padStart(2, '0')}-${String(base.getDate()).padStart(2, '0')}`;
  // Asia/Tashkent is UTC+5 year-round; demo data uses this single zone.
  return new Date(`${ymd}T${String(hour).padStart(2, '0')}:00:00+05:00`);
};

async function main() {
  const db = getDb(process.env.DATABASE_URL ?? 'postgres://klass:klass@127.0.0.1:5434/klass');

  const teacher = await upsertUser(db, 'teacher', TEACHER, 'ru');
  const student = await upsertUser(db, 'student', STUDENT, 'ru');

  // demo class — reuse by name under this teacher
  let [cls] = await db.select().from(classes)
    .where(and(eq(classes.teacherId, teacher.id), eq(classes.name, CLASS_NAME), isNull(classes.archivedAt)))
    .limit(1);
  if (!cls) {
    [cls] = await db.insert(classes).values({
      teacherId: teacher.id, name: CLASS_NAME, color: '#4f46e5',
      description: 'Демонстрация платформы Klass: материалы, календарь, видеоуроки, доска и уведомления.',
    }).returning();
  }
  await db.insert(classMembers).values({ classId: cls!.id, userId: student.id })
    .onConflictDoNothing();

  // ── feed: two materials + one announcement (created once) ──
  const [hasPosts] = await db.select({ id: posts.id }).from(posts).where(eq(posts.classId, cls!.id)).limit(1);
  if (!hasPosts) {
    await db.insert(posts).values([
      {
        classId: cls!.id, authorId: teacher.id, kind: 'material', pinned: false,
        title: 'Дробы: базовые понятия', topic: 'Математика',
        body: '<p>Что такое дробь. Числитель и знаменатель. Примеры на пицце 🍕 — <strong>ключ</strong> к сравнению дробей.</p><ul><li>1/2 и 2/4 — равны</li><li>Общий знаменатель</li></ul>',
      },
      {
        classId: cls!.id, authorId: teacher.id, kind: 'material', pinned: false,
        title: 'Конспект урока (заметка для самопроверки)', topic: 'Математика',
        body: '<p>После урока сверьте листок ученика с эталоном. Листки учеников видны только учителю.</p>',
      },
      {
        classId: cls!.id, authorId: teacher.id, kind: 'announcement', pinned: true,
        title: 'Добро пожаловать в демо-класс!',
        body: '<p>Здесь есть материалы, календарь и доска. На кнопке «Начать урок» включается видео через LiveKit Cloud.</p>',
      },
    ]);
    await db.insert(teacherNotes).values([
      {
        teacherId: teacher.id, classId: cls!.id, title: 'План: дроби',
        body: '<p>1) Разогреться пиццей. 2) Ввести числитель/знаменатель. 3) Доска: сравнить 1/2 и 2/4. 4) Домашка — листок.</p>',
      },
      {
        teacherId: teacher.id, classId: cls!.id, title: 'Заметки об учениках',
        body: '<p>Азиз хорошо считает устно, путает знаменатель при сравнении — повторить на доске.</p>',
      },
    ]);
  }

  // ── calendar: single lesson, weekly recurring lesson, deadline ──
  const [hasEvents] = await db.select({ id: events.id }).from(events).where(eq(events.classId, cls!.id)).limit(1);
  if (!hasEvents) {
    await db.insert(events).values([
      {
        classId: cls!.id, kind: 'lesson', title: 'Демо-урок: дроби',
        description: 'Нажмите «Начать урок» — видео через LiveKit Cloud, доска открывается автоматически.',
        startsAt: day(0, 16), endsAt: day(0, 17), tz: 'Asia/Tashkent',
      },
      {
        classId: cls!.id, kind: 'lesson', title: 'Математика (по вторникам)',
        startsAt: day(1, 9), endsAt: day(1, 10), tz: 'Asia/Tashkent',
        rrule: 'FREQ=WEEKLY;BYDAY=TU',
      },
      {
        classId: cls!.id, kind: 'deadline', title: 'Домашнее задание №4',
        startsAt: day(3, 23), endsAt: new Date(day(3, 23).getTime() + 59 * 60_000), tz: 'Asia/Tashkent',
      },
    ]);
  }

  // ── fresh one-time invite code: revoke stale unused, mint new ──
  await db.update(inviteCodes).set({ revokedAt: new Date() }).where(and(
    eq(inviteCodes.classId, cls!.id),
    isNull(inviteCodes.usedAt),
    isNull(inviteCodes.revokedAt),
  ));
  const invite = await createInviteCode(db, cls!.id, teacher.id, 7);

  console.log(JSON.stringify({
    teacherEmail: TEACHER.email, teacherPassword: TEACHER.password,
    studentEmail: STUDENT.email, studentPassword: STUDENT.password,
    className: CLASS_NAME, classId: cls!.id,
    inviteCode: invite.code, inviteExpires: invite.expiresAt.toISOString(),
  }, null, 2));

  await closeDb();
}

main().catch((e) => { console.error(e); process.exit(1); });
