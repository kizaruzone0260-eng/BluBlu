import { describe, it, expect } from 'vitest';
import { zonedTimeToUtc, utcToWallClock } from '../../src/lib/tz.js';
import { expandEvent, buildRrule, type EventInput } from '../../src/services/events.js';

const baseEvent = {
  id: 'e1', classId: 'c1', kind: 'lesson' as const, title: 'Math', description: '',
  tz: 'Asia/Tashkent', rrule: null as string | null, exdates: [] as string[],
  startsAt: new Date('2026-10-05T14:00:00Z'), endsAt: new Date('2026-10-05T14:50:00Z'),
  createdAt: new Date(),
};

describe('tz conversions (§3.5)', () => {
  it('19:00 Asia/Tashkent = 14:00 UTC (UTC+5)', () => {
    expect(zonedTimeToUtc('Asia/Tashkent', 2026, 10, 5, 19, 0)).toBe(Date.parse('2026-10-05T14:00:00Z'));
  });

  it('same instant renders as 16:00 in Berlin (DST +2)', () => {
    const w = utcToWallClock('Europe/Berlin', Date.parse('2026-10-05T14:00:00Z'));
    expect([w.hour, w.minute, w.day]).toEqual([16, 0, 5]);
  });

  it('NY 19:00 crosses DST: EST −5 before Mar 8 2026, EDT −4 after', () => {
    expect(zonedTimeToUtc('America/New_York', 2026, 3, 2, 19, 0)).toBe(Date.parse('2026-03-03T00:00:00Z'));
    expect(zonedTimeToUtc('America/New_York', 2026, 3, 9, 19, 0)).toBe(Date.parse('2026-03-09T23:00:00Z'));
  });
});

describe('recurrence expansion (§3.5)', () => {
  it('weekly MO,WE from 2026-03-02 NY 19:00 keeps 19:00 local across DST', () => {
    const input: EventInput = {
      kind: 'lesson', title: 'X', description: '', startLocal: '2026-03-02T19:00',
      durationMin: 60, tz: 'America/New_York', repeat: { weekdays: [1, 3] },
    };
    const rrule = buildRrule(input);
    expect(rrule).toBe('FREQ=WEEKLY;BYDAY=MO,WE');
    const e = {
      ...baseEvent, tz: 'America/New_York', rrule,
      startsAt: new Date(Date.parse('2026-03-03T00:00:00Z')),
      endsAt: new Date(Date.parse('2026-03-03T01:00:00Z')),
    };
    const occ = expandEvent(e, 'C', '#fff', new Date('2026-03-01T00:00:00Z'), new Date('2026-03-15T23:59:59Z'));
    expect(occ.map((o) => o.startsAt)).toEqual([
      '2026-03-03T00:00:00.000Z', // Mon 3/2 19:00 EST (−5)
      '2026-03-05T00:00:00.000Z', // Wed 3/4 19:00 EST
      '2026-03-09T23:00:00.000Z', // Mon 3/9 19:00 EDT (−4, DST since 3/8)
      '2026-03-11T23:00:00.000Z', // Wed 3/11 19:00 EDT
    ]);
  });

  it('weekly Tashkent lesson produces exactly Mon+Wed occurrences in range', () => {
    const e = {
      ...baseEvent,
      rrule: 'FREQ=WEEKLY;BYDAY=MO,WE',
      startsAt: new Date('2026-10-05T14:00:00Z'),
      endsAt: new Date('2026-10-05T14:50:00Z'),
    };
    const occ = expandEvent(e, 'C', '#fff', new Date('2026-10-05T00:00:00Z'), new Date('2026-10-11T23:59:59Z'));
    expect(occ.map((o) => o.startsAt)).toEqual([
      '2026-10-05T14:00:00.000Z', // Mon
      '2026-10-07T14:00:00.000Z', // Wed
    ]);
    expect(occ[0]!.endsAt).toBe('2026-10-05T14:50:00.000Z');
  });

  it('exdates remove single occurrence', () => {
    const e = { ...baseEvent, rrule: 'FREQ=WEEKLY;BYDAY=MO,WE', exdates: ['2026-10-07T14:00:00.000Z'] };
    const occ = expandEvent(e, 'C', '#fff', new Date('2026-10-05T00:00:00Z'), new Date('2026-10-11T23:59:59Z'));
    expect(occ.map((o) => o.startsAt)).toEqual(['2026-10-05T14:00:00.000Z']);
  });

  it('UNTIL truncates the series', () => {
    const e = { ...baseEvent, rrule: 'FREQ=WEEKLY;BYDAY=MO;UNTIL=20261012T235959Z' };
    const occ = expandEvent(e, 'C', '#fff', new Date('2026-10-05T00:00:00Z'), new Date('2026-10-31T23:59:59Z'));
    expect(occ.map((o) => o.startsAt)).toEqual([
      '2026-10-05T14:00:00.000Z', '2026-10-12T14:00:00.000Z',
    ]);
  });
});
