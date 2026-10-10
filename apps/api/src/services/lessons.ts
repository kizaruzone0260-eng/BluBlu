import { and, desc, eq, isNull } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { AccessToken, RoomServiceClient, TrackSource } from 'livekit-server-sdk';
import { lessonSessions } from '../db/schema.js';
import type { DB } from '../db/index.js';
import { env, livekitRoomApiUrl } from '../env.js';

export type LessonSession = typeof lessonSessions.$inferSelect;

export async function startLesson(
  db: DB, teacherId: string, classId: string, eventId?: string,
): Promise<LessonSession> {
  // one active session per class at a time (v1)
  const [existing] = await db.select().from(lessonSessions)
    .where(and(eq(lessonSessions.classId, classId), isNull(lessonSessions.endedAt)))
    .limit(1);
  if (existing) return existing;
  // Hardening (Phase 1к): 64 bits of per-session entropy in the room name.
  // The room itself is never a secret (a valid, membership-gated JWT is still
  // required to join), but a longer random tail removes any guessability.
  const room = `lesson-${classId.slice(0, 8)}-${randomBytes(8).toString('hex')}`;
  const [s] = await db.insert(lessonSessions).values({
    classId, eventId: eventId ?? null, roomName: room, createdBy: teacherId,
  }).returning();
  return s!;
}

export async function endLesson(db: DB, sessionId: string): Promise<LessonSession | null> {
  const [s] = await db.update(lessonSessions)
    .set({ endedAt: new Date() })
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

let roomService: RoomServiceClient | null = null;
export function getRoomService(): RoomServiceClient {
  roomService ??= new RoomServiceClient(
    livekitRoomApiUrl(), env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET,
  );
  return roomService;
}
