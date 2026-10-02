import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TEST_DATABASE_URL, preparedDb, makeTeacher, type TestDB } from './util.js';
import { buildApp } from '../../src/app.js';
import { classes, inviteCodes } from '../../src/db/schema.js';
import { hashInviteCode } from '../../src/lib/invite.js';
import { randomUUID } from 'node:crypto';

const suite = TEST_DATABASE_URL ? describe : describe.skip;

suite('stage 3: calendar, repeats, edit scopes, ICS', () => {
  let t: TestDB;
  let classId = '';
  let teacher: { id: string; email: string; password: string; token: string };
  let studentToken = '';

  const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
  const genCode = () => Array.from({ length: 8 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join('');

  beforeAll(async () => {
    t = await preparedDb(TEST_DATABASE_URL);
    teacher = await makeTeacher(t.sql, `cal${Date.now()}@x.io`) as typeof teacher;
    const [cls] = await t.db.insert(classes).values({ teacherId: teacher.id, name: 'Cal class' }).returning();
    classId = cls!.id;
    const code = genCode();
    await t.db.insert(inviteCodes).values({
      classId, codeHash: hashInviteCode(code, process.env.JWT_SECRET!),
      createdBy: teacher.id, expiresAt: new Date(Date.now() + 86400000),
    });
    const app = await buildApp(t.db);
    const r = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { name: 'Pupil', email: `cal${Date.now()}@x.io`, password: 'Secret1234', code } });
    studentToken = r.json().accessToken as string;
    await app.close();
  });
  afterAll(async () => { await t?.sql.end(); });

  const auth = (tk: string) => ({ authorization: `Bearer ${tk}` });
  async function fresh() {
    const app = await buildApp(t.db);
    const l = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: teacher.email, password: teacher.password } });
    teacher.token = l.json().accessToken as string;
    return app;
  }

  const lesson = {
    kind: 'lesson', title: 'Math weekly', description: '',
    startLocal: '2026-10-05T19:00', durationMin: 50, tz: 'Asia/Tashkent',
    repeat: { weekdays: [1, 3] },
  };

  it('creates weekly lesson; member student sees Mon+Wed; foreign teacher sees nothing', async () => {
    const app = await fresh();
    const cr = await app.inject({ method: 'POST', url: `/api/classes/${classId}/events`, headers: auth(teacher.token), payload: lesson });
    expect(cr.statusCode).toBe(201);
    const evId = cr.json().id as string;
    // startsAt stored UTC: 19:00 Tashkent → 14:00Z
    expect(cr.json().startsAt).toMatch(/T14:00:00/);

    const list = await app.inject({
      method: 'GET',
      url: `/api/events?from=2026-10-05T00:00:00Z&to=2026-10-11T23:59:59Z`,
      headers: auth(studentToken),
    });
    const occ = list.json() as { eventId: string; startsAt: string }[];
    expect(occ.filter((o) => o.eventId === evId).map((o) => o.startsAt)).toEqual([
      '2026-10-05T14:00:00.000Z', '2026-10-07T14:00:00.000Z',
    ]);

    const foreign = await makeTeacher(t.sql, `calx${Date.now()}@x.io`);
    const fl = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: foreign.email, password: foreign.password } });
    const fList = await app.inject({
      method: 'GET', url: `/api/events?from=2026-10-01T00:00:00Z&to=2026-10-31T00:00:00Z`,
      headers: auth(fl.json().accessToken),
    });
    expect((fList.json() as unknown[]).length).toBe(0);
    const fPatch = await app.inject({
      method: 'PATCH', url: `/api/events/${evId}`,
      headers: auth(fl.json().accessToken),
      payload: { scope: 'all', changes: lesson },
    });
    expect(fPatch.statusCode).toBe(404);
    await app.close();
  });

  it('edit scope "this": replaces single occurrence, series continues', async () => {
    const app = await fresh();
    const cr = await app.inject({ method: 'POST', url: `/api/classes/${classId}/events`, headers: auth(teacher.token), payload: lesson });
    const evId = cr.json().id as string;
    const patch = await app.inject({
      method: 'PATCH', url: `/api/events/${evId}`, headers: auth(teacher.token),
      payload: {
        scope: 'this', occurrenceStart: '2026-10-07T14:00:00.000Z',
        changes: { ...lesson, title: 'Substitution class', startLocal: '2026-10-07T19:00', repeat: null },
      },
    });
    expect(patch.statusCode).toBe(200);
    const list = await app.inject({
      method: 'GET', url: `/api/events?from=2026-10-05T00:00:00Z&to=2026-10-11T23:59:59Z`, headers: auth(teacher.token),
    });
    const occ = (list.json() as { title: string; startsAt: string }[])
      .filter((o) => o.startsAt.startsWith('2026-10-0'))
      .map((o) => `${o.startsAt.slice(0, 10)}=${o.title}`).sort();
    expect(occ).toContain('2026-10-05=Math weekly');
    expect(occ).toContain('2026-10-07=Substitution class');
    await app.close();
  });

  it('edit scope "following": truncates old series and starts new one', async () => {
    const app = await fresh();
    const [base] = await t.db.insert(classes).values({ teacherId: teacher.id, name: 'Cal2' }).returning();
    const cr = await app.inject({
      method: 'POST', url: `/api/classes/${base!.id}/events`, headers: auth(teacher.token),
      payload: { ...lesson, startLocal: '2026-10-05T19:00' },
    });
    const evId = cr.json().id as string;
    await app.inject({
      method: 'PATCH', url: `/api/events/${evId}`, headers: auth(teacher.token),
      payload: {
        scope: 'following', occurrenceStart: '2026-10-12T14:00:00.000Z',
        changes: { ...lesson, title: 'Algebra', startLocal: '2026-10-12T20:00' },
      },
    });
    const list = await app.inject({
      method: 'GET', url: `/api/events?from=2026-10-05T00:00:00Z&to=2026-10-25T23:59:59Z&classId=${base!.id}`, headers: auth(teacher.token),
    });
    const occ = list.json() as { title: string; startsAt: string }[];
    const math = occ.filter((o) => o.title === 'Math weekly').map((o) => o.startsAt.slice(0, 10));
    const algebra = occ.filter((o) => o.title === 'Algebra').map((o) => `${o.startsAt.slice(0, 10)} ${o.startsAt.slice(11, 16)}`);
    // old series: 10/05, 10/07, 10/09(Mon? MO,WE → 05,07,12? wait weekdays MO,WE: 05,07, then 12…)—truncated before 10/12
    expect(math).toEqual(['2026-10-05', '2026-10-07']);
    // new series from 10/12 20:00 local (15:00Z), MO,WE: 12,14,19,21
    expect(algebra).toEqual(['2026-10-12 15:00', '2026-10-14 15:00', '2026-10-19 15:00', '2026-10-21 15:00']);
    await app.close();
  });

  it('delete scope "this" removes only one occurrence', async () => {
    const app = await fresh();
    const [base] = await t.db.insert(classes).values({ teacherId: teacher.id, name: 'Cal3' }).returning();
    const cr = await app.inject({ method: 'POST', url: `/api/classes/${base!.id}/events`, headers: auth(teacher.token), payload: { ...lesson, repeat: { weekdays: [1] } } });
    const evId = cr.json().id as string;
    const del = await app.inject({
      method: 'DELETE', url: `/api/events/${evId}?scope=this&occurrenceStart=${encodeURIComponent('2026-10-12T14:00:00.000Z')}`,
      headers: auth(teacher.token),
    });
    expect(del.statusCode).toBe(200);
    const list = await app.inject({ method: 'GET', url: `/api/events?from=2026-10-05T00:00:00Z&to=2026-10-19T23:59:59Z&classId=${base!.id}`, headers: auth(teacher.token) });
    expect((list.json() as { startsAt: string }[]).map((o) => o.startsAt.slice(0, 10))).toEqual(['2026-10-05', '2026-10-19']);
    await app.close();
  });

  it('ICS subscription: token works, bad token 404, UTC DTSTART', async () => {
    const app = await fresh();
    const [base] = await t.db.insert(classes).values({ teacherId: teacher.id, name: 'Cal4' }).returning();
    await app.inject({ method: 'POST', url: `/api/classes/${base!.id}/events`, headers: auth(teacher.token), payload: { ...lesson, repeat: { weekdays: [1], until: '2026-12-31' } } });
    const tk = await app.inject({ method: 'POST', url: '/api/me/ical-token', headers: auth(teacher.token) });
    const token = tk.json().token as string;
    const ics = await app.inject({ method: 'GET', url: `/api/ical/${token}` });
    expect(ics.statusCode).toBe(200);
    expect(ics.headers['content-type']).toContain('text/calendar');
    expect(ics.body).toContain('BEGIN:VCALENDAR');
    expect(ics.body).toContain('DTSTART:20261005T140000Z');
    expect(ics.body).toContain('Math weekly');
    const bad = await app.inject({ method: 'GET', url: '/api/ical/wrongtoken' });
    expect(bad.statusCode).toBe(404);
    await app.close();
  });
});
