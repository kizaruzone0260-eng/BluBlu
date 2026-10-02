/**
 * Timezone helpers built on Intl (no external tz data): convert between an
 * IANA zone wall-clock time and UTC instants, DST-correct for our supported
 * range. Used for recurring events: the RULE repeats in wall-clock local time
 * of the event's zone (19:00 Tashkent stays 19:00 for everyone).
 */

export function tzOffsetMinutes(tz: string, utcMs: number): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts: Record<string, string> = {};
  for (const p of dtf.formatToParts(new Date(utcMs))) {
    if (p.type !== 'literal') parts[p.type] = p.value;
  }
  const hour = parts.hour === '24' ? 0 : Number(parts.hour);
  const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), hour, Number(parts.minute), Number(parts.second));
  return Math.round((asUtc - Math.floor(utcMs / 1000) * 1000) / 60000);
}

/** Wall-clock components in `tz` → UTC ms. Two-pass converges for all real zones. */
export function zonedTimeToUtc(tz: string, year: number, month: number, day: number, hour: number, minute: number): number {
  const wall = Date.UTC(year, month - 1, day, hour, minute, 0);
  let ts = wall - tzOffsetMinutes(tz, wall) * 60_000;
  const off2 = tzOffsetMinutes(tz, ts);
  ts = wall - off2 * 60_000;
  return ts;
}

export interface WallClock { year: number; month: number; day: number; hour: number; minute: number; weekday: number }

export function utcToWallClock(tz: string, utcMs: number): WallClock {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false, weekday: 'short',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
  const parts: Record<string, string> = {};
  for (const p of dtf.formatToParts(new Date(utcMs))) {
    if (p.type !== 'literal') parts[p.type] = p.value;
  }
  const wd = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 }[parts.weekday ?? 'SU'] ?? 0;
  const hour = parts.hour === '24' ? 0 : Number(parts.hour);
  return {
    year: Number(parts.year), month: Number(parts.month), day: Number(parts.day),
    hour, minute: Number(parts.minute), weekday: wd,
  };
}

/** ISO 8601 weekday (Mon=1..Sun=7) of a UTC instant in zone `tz`. */
export function isoWeekdayInTz(tz: string, utcMs: number): number {
  const w = utcToWallClock(tz, utcMs).weekday;
  return w === 0 ? 7 : w;
}
