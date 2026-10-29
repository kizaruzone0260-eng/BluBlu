import { and, desc, eq, isNull } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { AccessToken, RoomServiceClient, TrackSource } from 'livekit-server-sdk';
import { lessonSessions } from '../db/schema.js';
import type { DB } from '../db/index.js';
import { env, livekitRoomApiUrl } from '../env.js';
import { isUniqueViolation } from '../lib/pgErrors.js';

export type LessonSession = typeof lessonSessions.$inferSelect;

/**
 * Начать урок — или вернуть уже идущий.
 *
 * SEC-11 (2026-10-28). Здесь была настоящая гонка: SELECT активной сессии и INSERT — два запроса,
 * и между ними окно. Два одновременных «Начать урок» (двойной клик, две вкладки, повтор после
 * таймаута) создавали ДВЕ активные сессии одного класса: у каждой своя комната LiveKit и своя
 * доска, ученики попадали в разные уроки, а завершение одного оставляло второй висеть.
 *
 * Предпроверка ниже осталась: в обычном случае она даёт идемпотентный ответ без исключения. Но
 * инвариант теперь держит частичный уникальный индекс `lesson_sessions_one_active_per_class`
 * (см. schema.ts). Если гонку выиграл конкурент, INSERT падает с 23505 — это не ошибка для
 * учителя, а знак «урок уже начат»: перечитываем активную сессию и возвращаем её. Повторная
 * попытка нужна и на единственном другом уникальном поле — `room_name`: случайное совпадение
 * 64-битного хвоста практически невозможно, но правильная реакция на него — новый хвост, а не
 * 500. Все прочие ошибки уходят наружу, как раньше.
 */
export async function startLesson(
  db: DB, teacherId: string, classId: string, eventId?: string,
): Promise<LessonSession> {
  for (let attempt = 0; attempt < 2; attempt++) {
    // one active session per class at a time (v1)
    const [existing] = await db.select().from(lessonSessions)
      .where(and(eq(lessonSessions.classId, classId), isNull(lessonSessions.endedAt)))
      .limit(1);
    if (existing) return existing;
    // Hardening (Phase 1к): 64 bits of per-session entropy in the room name.
    // The room itself is never a secret (a valid, membership-gated JWT is still
    // required to join), but a longer random tail removes any guessability.
    const room = `lesson-${classId.slice(0, 8)}-${randomBytes(8).toString('hex')}`;
    try {
      const [s] = await db.insert(lessonSessions).values({
        classId, eventId: eventId ?? null, roomName: room, createdBy: teacherId,
      }).returning();
      return s!;
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
      // либо активную сессию создал конкурент (перечитает следующая итерация), либо совпал
      // room_name — тогда новая попытка возьмёт новый случайный хвост
    }
  }
  throw new Error('startLesson: could not create or find an active session');
}

export async function endLesson(db: DB, sessionId: string): Promise<LessonSession | null> {
  const [s] = await db.update(lessonSessions)
    // Часть 1: снимок устройств живёт ровно столько, сколько урок. Завершение урока стирает его,
    // иначе «кто что держал до лекции» остаётся в базе после занятия без всякой цели.
    .set({ endedAt: new Date(), lecturePreDevices: {} })
    .where(and(eq(lessonSessions.id, sessionId), isNull(lessonSessions.endedAt)))
    .returning();
  return s ?? null;
}

export async function getActiveSessionForClass(db: DB, classId: string) {
  const [s] = await db.select().from(lessonSessions)
    .where(and(eq(lessonSessions.classId, classId), isNull(lessonSessions.endedAt)))
    .limit(1);
  return s ?? null;
}

export async function getSession(db: DB, sessionId: string) {
  const [s] = await db.select().from(lessonSessions).where(eq(lessonSessions.id, sessionId)).limit(1);
  return s ?? null;
}

export async function getActiveSessionForEvent(db: DB, eventId: string) {
  const rows = await db.select().from(lessonSessions)
    .where(and(eq(lessonSessions.eventId, eventId), isNull(lessonSessions.endedAt)))
    .orderBy(desc(lessonSessions.startedAt)).limit(1);
  return rows[0] ?? null;
}

/** §3.6/§7: join token only for class members while the session is active. */
export async function buildJoinToken(opts: {
  room: string; identity: string; name: string;
  isTeacher: boolean; lectureMode: boolean;
}): Promise<string> {
  const at = new AccessToken(env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET, {
    identity: opts.identity, name: opts.name, ttl: env.RTC_TOKEN_TTL,
  });
  if (opts.isTeacher) {
    // camera + mic + screen with audio + room moderation
    at.addGrant({
      room: opts.room, roomJoin: true, roomAdmin: true,
      canPublish: true, canSubscribe: true, canPublishData: true,
    });
  } else {
    // default: camera+mic, NO screenshare (canPublishSources supersedes canPublish);
    // lecture mode: nothing until granted live
    at.addGrant({
      room: opts.room, roomJoin: true,
      canPublish: !opts.lectureMode, canSubscribe: true, canPublishData: true,
      canPublishSources: opts.lectureMode
        ? []
        : [TrackSource.CAMERA, TrackSource.MICROPHONE],
    });
  }
  return at.toJwt();
}

/** Live permissions for students (lecture-mode toggling, screen grants). */
export const studentPermission = (lectureMode: boolean, screenShare = false) => ({
  canPublish: !lectureMode,
  canSubscribe: true,
  canPublishData: true,
  canPublishSources: lectureMode
    ? []
    : screenShare
      ? [TrackSource.CAMERA, TrackSource.MICROPHONE, TrackSource.SCREEN_SHARE]
      : [TrackSource.CAMERA, TrackSource.MICROPHONE],
});

/** The shape LiveKit reports for one participant (only the fields we reason about). */
export interface CurrentPermission {
  canPublish?: boolean;
  canSubscribe?: boolean;
  canPublishData?: boolean;
  canPublishSources?: TrackSource[];
}

/**
 * «Дать слово» (task 2Б, 2026-10-10) — the permission of ONE student, computed, never a room-wide
 * change.
 *
 * Two measured facts shape it:
 *  - in lecture mode a student's token says `canPublish: false, canPublishSources: []`, so the
 *    floor really has to lift that — a signal alone would leave them unable to speak;
 *  - LiveKit refuses a remote UNMUTE (`MutePublishedTrack` with `muted: false` answers
 *    412 "remote unmute not enabled"; measured in the CI run of 2026-10-10), so the server can
 *    never turn a student's microphone on. The grant therefore makes publishing POSSIBLE, and the
 *    student's own client is the one that unmutes.
 *
 * The SDK also warns that a permission update is atomic — "all desired permissions would need to
 * be set" — so this composes instead of overwriting: a screen-share the teacher already granted
 * survives giving and taking the floor, and taking the floor returns exactly the baseline of the
 * lesson (`studentPermission`), which is why revoking cannot leave anybody able to publish.
 */
export function floorPermission(
  current: CurrentPermission | undefined, lectureMode: boolean, on: boolean,
) {
  const sources = current?.canPublishSources ?? [];
  const hadScreen = sources.includes(TrackSource.SCREEN_SHARE);
  const base = studentPermission(lectureMode, hadScreen);
  if (!on) return base;
  const withMic = base.canPublishSources.includes(TrackSource.MICROPHONE)
    ? base.canPublishSources
    : [...base.canPublishSources, TrackSource.MICROPHONE];
  return { ...base, canPublish: true, canPublishSources: withMic };
}

/**
 * Часть 1 (2026-10-13): снимок «что горело» с НИХНЕЙ стороны.
 *
 * Берётся из `listParticipants` ДО того, как режим лекции отзовет публикацию. Причина, по которой
 * это делает сервер, а не клиент: комната отзывает трек (`LocalTrackUnpublished`) раньше, чем
 * доходит наш кадр `lectureMode` (замер CI: права отозваны в 11305, треки сняты в 11323, кадр
 * `lectureMode on=true` в 19306), — клиентский снимок по кадру показывал `false/false`. Замер
 * сделан в момент, который сервер сам же и меняет, поэтому порядок прихода событий на него не
 * влияет, и он переживает перезагрузку страницы ученика посреди лекции.
 *
 * Track «горит» = опубликован и не замучен; `muted` читаем как «не true», потому что protobuf по
 * умолчанию опускает false из JSON, а трек выключенного устройства LiveKit оставляет замученным.
 */
export function lecturePreDevices(
  parts: {
    identity: string;
    tracks?: { source?: TrackSource; muted?: boolean }[];
  }[],
  teacherIdentity: string,
): Record<string, { mic: boolean; cam: boolean }> {
  const map: Record<string, { mic: boolean; cam: boolean }> = {};
  for (const part of parts) {
    if (part.identity === teacherIdentity) continue; // учитель говорит всегда
    const tracks = part.tracks ?? [];
    const live = (src: TrackSource) => tracks.some((tr) => tr.source === src && tr.muted !== true);
    map[part.identity] = { mic: live(TrackSource.MICROPHONE), cam: live(TrackSource.CAMERA) };
  }
  return map;
}

/**
 * Участник ушёл посреди запроса — это НЕ поломка медиа-сервера.
 *
 * Выключение лекции идёт по списку участников, полученному секундой раньше, и за эту секунду
 * ученик успевает выйти (обрыв связи, закрытая вкладка, переподключение после `DUPLICATE_IDENTITY`).
 * LiveKit отвечает 404 `not_found`, и до правки это попадало в `failed` → 502 → `lectureMode`
 * оставался `true`: один выпавший ученик блокировал конец лекции для всего класса, хотя возвращать
 * ему было нечего. Настоящий отказ сервера (таймаут, 5xx, соединение) так и остаётся 502 без
 * записи состояния — этот контракт проверяет интеграционный тест.
 *
 * Форма ошибки — `ServerError` из livekit-server-sdk: `{ status, code }` (проверяется на живом
 * логе CI-прогона 2026-10-13: `"status": "404", "code": "not_found"`).
 */
export function isParticipantGone(error: unknown): boolean {
  const e = error as { status?: number; code?: string } | undefined;
  return e?.status === 404 || e?.code === 'not_found';
}

let roomService: RoomServiceClient | null = null;
export function getRoomService(): RoomServiceClient {
  roomService ??= new RoomServiceClient(
    livekitRoomApiUrl(), env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET,
  );
  return roomService;
}
