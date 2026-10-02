// rrule ships CJS; named imports break under plain node ESM — take the namespace.
import rrulePkg from 'rrule';
const { rrulestr } = rrulePkg as unknown as { rrulestr: (s: string, opts?: { dtstart?: Date }) => { between: (a: Date, b: Date, incl: boolean) => Date[] } };
import { and, eq, inArray, isNull, lte } from 'drizzle-orm';
import { randomBytes, createHash } from 'node:crypto';
import { events, classes, classMembers, icsTokens } from '../db/schema.js';
import type { DB } from '../db/index.js';
import { zonedTimeToUtc, utcToWallClock } from '../lib/tz.js';

export interface EventInput {
  kind: 'lesson' | 'deadline' | 'other';
  title: string;
  description: string;
  /** 'YYYY-MM-DDTHH:mm' wall-clock in `tz` */
  startLocal: string;
  durationMin: number;
  tz: string;
  /** weekly repetition: ISO weekdays 1..7 (Mon..Sun); until 'YYYY-MM-DD' optional */
  repeat?: { weekdays: number[]; until?: string } | null;
}

const WD = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];

export function buildRrule(input: EventInput): string | null {
  if (!input.repeat || input.repeat.weekdays.length === 0) return null;
  const parts = ['FREQ=WEEKLY', `BYDAY=${input.repeat.weekdays.map((w) => WD[w - 1]).join(',')}`];
  if (input.repeat.until) {
    // UNTIL lives in the pseudo-UTC (wall-clock) iteration space: end of that day
    const [y, m, d] = input.repeat.until.split('-').map(Number);
    const until = new Date(Date.UTC(y as number, (m as number) - 1, d as number, 23, 59, 59));
    parts.push(`UNTIL=${until.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')}`);
  }
  return parts.join(';');
}

function parseLocal(s: string): { y: number; mo: number; d: number; h: number; mi: number } {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(s);
  if (!m) throw new Error('bad local time');
  return { y: Number(m[1]), mo: Number(m[2]), d: Number(m[3]), h: Number(m[4]), mi: Number(m[5]) };
}

export function startsFromInput(input: EventInput): { startsAt: Date; endsAt: Date } {
  const w = parseLocal(input.startLocal);
  const startMs = zonedTimeToUtc(input.tz, w.y, w.mo, w.d, w.h, w.mi);
  return { startsAt: new Date(startMs), endsAt: new Date(startMs + input.durationMin * 60_000) };
}

export interface Occurrence {
  eventId: string;
  classId: string;
  className: string;
  classColor: string;
  kind: 'lesson' | 'deadline' | 'other';
  title: string;
  description: string;
  tz: string;
  startsAt: string; // ISO UTC
  endsAt: string;
  recurring: boolean;
  uid: string; // event id + occurrence start ms
}

function makeOcc(
  event: typeof events.$inferSelect, className: string, classColor: string,
  startMs: number, durMs: number, recurring: boolean,
): Occurrence {
  return {
    eventId: event.id, classId: event.classId, className, classColor,
    kind: event.kind, title: event.title, description: event.description, tz: event.tz,
    startsAt: new Date(startMs).toISOString(), endsAt: new Date(startMs + durMs).toISOString(),
    recurring, uid: `${event.id}:${startMs}`,
  };
}

const MAX_OCC = 500;

/** Expand one event row into occurrences inside [from, to] (RFC §3.5 wall-clock semantics). */
export function expandEvent(
  e: typeof events.$inferSelect, className: string, classColor: string, from: Date, to: Date,
): Occurrence[] {
  const durationMs = e.endsAt.getTime() - e.startsAt.getTime();
  const exdates = new Set((e.exdates ?? []).map((s) => String(new Date(s).getTime())));
  if (!e.rrule) {
    const s = e.startsAt.getTime();
    if (s >= from.getTime() && s <= to.getTime() && !exdates.has(String(s))) {
      return [makeOcc(e, className, classColor, s, durationMs, false)];
    }
    return [];
  }
  // Iterate in pseudo-UTC space (wall-clock), then map each wall time to a real instant.
  const wall0 = utcToWallClock(e.tz, e.startsAt.getTime());
  const pseudoDtstart = new Date(Date.UTC(wall0.year, wall0.month - 1, wall0.day, wall0.hour, wall0.minute));
  let rule;
  try {
    rule = rrulestr(`RRULE:${e.rrule}`, { dtstart: pseudoDtstart });
  } catch {
    return [];
  }
  const pseudoFrom = new Date(from.getTime() - 259_200_000); // ±3 days safety for DST shifts
  const pseudoTo = new Date(to.getTime() + 259_200_000);
  let pseudoDates: Date[];
  try {
    pseudoDates = rule.between(pseudoFrom, pseudoTo, true).slice(0, MAX_OCC);
  } catch {
    return [];
  }
  const seriesStart = e.startsAt.getTime();
  const out: Occurrence[] = [];
  for (const pd of pseudoDates) {
    const realMs = zonedTimeToUtc(
      e.tz, pd.getUTCFullYear(), pd.getUTCMonth() + 1, pd.getUTCDate(), pd.getUTCHours(), pd.getUTCMinutes(),
    );
    if (realMs < seriesStart) continue;
    if (realMs >= from.getTime() && realMs <= to.getTime() && !exdates.has(String(realMs))) {
      out.push(makeOcc(e, className, classColor, realMs, durationMs, true));
    }
  }
  return out;
}

// ─── CRUD with edit scopes ────────────────────────────────────────────────────

export async function listEventsInRange(
  db: DB, userId: string, role: 'teacher' | 'student', from: Date, to: Date, classFilter?: string,
) {
  const visibleClasses = role === 'teacher'
    ? await db.select({ id: classes.id, name: classes.name, color: classes.color }).from(classes)
        .where(and(
          eq(classes.teacherId, userId),
          isNull(classes.archivedAt),
          classFilter ? eq(classes.id, classFilter) : undefined,
        ))
    : await db.select({ id: classes.id, name: classes.name, color: classes.color }).from(classMembers)
        .innerJoin(classes, and(eq(classes.id, classMembers.classId), isNull(classes.archivedAt)))
        .where(and(eq(classMembers.userId, userId), classFilter ? eq(classes.id, classFilter) : undefined));
  const ids = visibleClasses.map((c) => c.id);
  const meta = new Map(visibleClasses.map((c) => [c.id, c]));
  if (ids.length === 0) return [] as Occurrence[];
  const rows = await db.select().from(events).where(and(inArray(events.classId, ids), lte(events.startsAt, to)));
  const out: Occurrence[] = [];
  for (const e of rows) {
    const c = meta.get(e.classId);
    out.push(...expandEvent(e, c?.name ?? '', c?.color ?? '#4f46e5', from, to));
  }
  out.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  return out;
}

export async function createEvent(db: DB, classId: string, input: EventInput) {
  const { startsAt, endsAt } = startsFromInput(input);
  const [row] = await db.insert(events).values({
    classId, kind: input.kind, title: input.title, description: input.description,
    startsAt, endsAt, tz: input.tz, rrule: buildRrule(input),
  }).returning();
  return row!;
}

export interface EditScope { scope: 'all' | 'this' | 'following'; occurrenceStart?: string }

function occurrenceWall(e: typeof events.$inferSelect, occIso: string) {
  return utcToWallClock(e.tz, new Date(occIso).getTime());
}

/**
 * §3.5 edit scopes:
 *  all       → mutate the row in place
 *  this      → EXDATE this occurrence + create a standalone replacement
 *  following → truncate series (UNTIL before occ) + new series starting at the edited occ
 */
export async function editEvent(
  db: DB, id: string, scope: EditScope, input: EventInput,
): Promise<{ ok: boolean }> {
  const [e] = await db.select().from(events).where(eq(events.id, id)).limit(1);
  if (!e) return { ok: false };

  if (scope.scope === 'all' || !e.rrule) {
    const { startsAt, endsAt } = startsFromInput(input);
    await db.update(events).set({
      kind: input.kind, title: input.title, description: input.description,
      startsAt, endsAt, tz: input.tz, rrule: buildRrule(input), exdates: [],
    }).where(eq(events.id, id));
    return { ok: true };
  }

  const occIso = scope.occurrenceStart ?? e.startsAt.toISOString();
  const occMs = new Date(occIso).getTime();

  if (scope.scope === 'this') {
    await db.update(events)
      .set({ exdates: [...(e.exdates ?? []), new Date(occMs).toISOString()] })
      .where(eq(events.id, id));
    await createEvent(db, e.classId, input);
    return { ok: true };
  }

  // following: truncate old series UNTIL just before occ wall time, create new series
  const wall = occurrenceWall(e, occIso);
  const untilPseudo = new Date(Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute) - 60_000);
  const oldUntil = e.rrule.replace(/;?UNTIL=[^;]*/, '');
  const truncated = `${oldUntil};UNTIL=${untilPseudo.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')}`;
  await db.update(events).set({ rrule: truncated }).where(eq(events.id, id));
  await createEvent(db, e.classId, input);
  return { ok: true };
}

export async function deleteEventOccurrence(
  db: DB, id: string, scope: EditScope,
): Promise<{ ok: boolean }> {
  const [e] = await db.select().from(events).where(eq(events.id, id)).limit(1);
  if (!e) return { ok: false };
  if (scope.scope === 'all' || !e.rrule) {
    await db.delete(events).where(eq(events.id, id));
    return { ok: true };
  }
  const occIso = scope.occurrenceStart ?? e.startsAt.toISOString();
  const occMs = new Date(occIso).getTime();
  if (scope.scope === 'this') {
    await db.update(events)
      .set({ exdates: [...(e.exdates ?? []), new Date(occMs).toISOString()] })
      .where(eq(events.id, id));
    return { ok: true };
  }
  const wall = occurrenceWall(e, occIso);
  const untilPseudo = new Date(Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute) - 60_000);
  const oldUntil = e.rrule.replace(/;?UNTIL=[^;]*/, '');
  await db.update(events)
    .set({ rrule: `${oldUntil};UNTIL=${untilPseudo.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')}` })
    .where(eq(events.id, id));
  return { ok: true };
}

// ─── ICS (§3.5 personal read-only subscription) ──────────────────────────────

export async function rotateIcsToken(db: DB, userId: string): Promise<string> {
  const token = randomBytes(24).toString('base64url');
  const hash = createHash('sha256').update(token).digest('hex');
  await db.insert(icsTokens).values({ userId, tokenHash: hash })
    .onConflictDoUpdate({ target: icsTokens.userId, set: { tokenHash: hash } });
  return token;
}

export async function userByIcsToken(db: DB, token: string) {
  const hash = createHash('sha256').update(token).digest('hex');
  const [row] = await db.select({ userId: icsTokens.userId }).from(icsTokens)
    .where(eq(icsTokens.tokenHash, hash)).limit(1);
  return row?.userId ?? null;
}

const icsEsc = (s: string) => s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
const icsUtc = (iso: string) => iso.replace(/[-:]/g, '').replace(/\.\d{3}/, '');

export function buildIcs(occurrences: Occurrence[], prodId: string): string {
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Klass//EN',
    'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', `X-WR-CALNAME:${icsEsc(prodId)}`,
  ];
  for (const o of occurrences) {
    lines.push(
      'BEGIN:VEVENT',
      `UID:${icsEsc(o.uid)}@klass`,
      `DTSTAMP:${icsUtc(new Date().toISOString())}`,
      `DTSTART:${icsUtc(o.startsAt)}`,
      `DTEND:${icsUtc(o.endsAt)}`,
      `SUMMARY:${icsEsc(`${o.title} (${o.className})`)}`,
      `DESCRIPTION:${icsEsc(o.description)}`,
      'STATUS:CONFIRMED',
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}
