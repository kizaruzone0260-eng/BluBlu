import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TEST_DATABASE_URL, preparedDb, makeTeacher, type TestDB } from './util.js';
import { buildApp } from '../../src/app.js';
import { classes, classMembers, inviteCodes, users } from '../../src/db/schema.js';
import { hashInviteCode } from '../../src/lib/invite.js';
import { hashPassword } from '../../src/lib/password.js';
import { TokenVerifier } from 'livekit-server-sdk';
import { eq } from 'drizzle-orm';

const suite = TEST_DATABASE_URL ? describe : describe.skip;

suite('stage 4: lesson sessions, rights, moderation API', () => {
  let t: TestDB;
  let classId = '';
  let teacher: { id: string; email: string; password: string; token: string };
  let studentId = '';
  let studentToken = '';

  const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
  const genCode = () => Array.from({ length: 8 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join('');

  beforeAll(async () => {
    t = await preparedDb(TEST_DATABASE_URL);
    teacher = await makeTeacher(t.sql, `les${Date.now()}@x.io`) as typeof teacher;
    const [cls] = await t.db.insert(classes).values({ teacherId: teacher.id, name: 'Lesson class' }).returning();
    classId = cls!.id;
    const code = genCode();
    await t.db.insert(inviteCodes).values({
      classId, codeHash: hashInviteCode(code, process.env.JWT_SECRET!),
      createdBy: teacher.id, expiresAt: new Date(Date.now() + 86400000),
    });
    const app = await buildApp(t.db);
    const studentEmail = `les${Date.now()}@x.io`;
    const r = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { name: 'Pupil', email: studentEmail, password: 'Secret1234', code } });
    studentToken = r.json().accessToken as string;
    const [u] = await t.db.select({ id: users.id }).from(users).where(eq(users.email, studentEmail)).limit(1);
    studentId = u!.id;
    await app.close();
  });
  afterAll(async () => { await t?.sql.end(); });

  async function fresh() {
    const app = await buildApp(t.db);
    const l = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: teacher.email, password: teacher.password } });
    teacher.token = l.json().accessToken as string;
    return app;
  }
  const auth = (tk: string) => ({ authorization: `Bearer ${tk}` });

  it('teacher starts lesson (idempotent), outsider 404, student 403', async () => {
    const app = await fresh();
    const bad = await app.inject({ method: 'POST', url: '/api/lessons/start', headers: auth(studentToken), payload: { classId } });
    expect(bad.statusCode).toBe(403);
    const other = await makeTeacher(t.sql, `lesx${Date.now()}@x.io`);
    const ol = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: other.email, password: other.password } });
    const fo = await app.inject({ method: 'POST', url: '/api/lessons/start', headers: auth(ol.json().accessToken), payload: { classId } });
    expect(fo.statusCode).toBe(404);
    const st = await app.inject({ method: 'POST', url: '/api/lessons/start', headers: auth(teacher.token), payload: { classId } });
    expect(st.statusCode).toBe(201);
    const st2 = await app.inject({ method: 'POST', url: '/api/lessons/start', headers: auth(teacher.token), payload: { classId } });
    expect(st2.json().id).toBe(st.json().id); // same active session
    await app.close();
    return void 0;
  });

  it('join issues LiveKit JWT with role-based grants; ended session → 404', async () => {
    const app = await fresh();
    const st = await app.inject({ method: 'POST', url: '/api/lessons/start', headers: auth(teacher.token), payload: { classId } });
    const sessionId = st.json().id as string;

    const sj = await app.inject({ method: 'POST', url: `/api/lessons/${sessionId}/join`, headers: auth(studentToken) });
    expect(sj.statusCode).toBe(200);
    const verifier = new TokenVerifier(process.env.LIVEKIT_API_KEY ?? 'devkey', process.env.LIVEKIT_API_SECRET ?? 'devsecretdevsecretdevsecret123456');
    const claims = await verifier.verify(sj.json().token as string);
    expect(claims.video?.room).toBe(st.json().roomName);
    expect((claims as { sub?: string }).sub).toBeTruthy();
    expect(claims.video?.canPublish).toBe(true);
    expect(claims.video?.roomAdmin).toBeFalsy();

    const tj = await app.inject({ method: 'POST', url: `/api/lessons/${sessionId}/join`, headers: auth(teacher.token) });
    const tclaims = await verifier.verify(tj.json().token as string);
    expect(tclaims.video?.roomAdmin).toBe(true);

    // foreign student → 404
    const outApp = await fresh();
    const oc = genCode();
    const [otherClass] = await t.db.insert(classes).values({ teacherId: teacher.id, name: 'Other L' }).returning();
    await t.db.insert(inviteCodes).values({ classId: otherClass!.id, codeHash: hashInviteCode(oc, process.env.JWT_SECRET!), createdBy: teacher.id, expiresAt: new Date(Date.now() + 86400000) });
    const reg = await outApp.inject({ method: 'POST', url: '/api/auth/register', payload: { name: 'Out L', email: `ol${Date.now()}@x.io`, password: 'Secret1234', code: oc } });
    const oj = await outApp.inject({ method: 'POST', url: `/api/lessons/${sessionId}/join`, headers: auth(reg.json().accessToken) });
    expect(oj.statusCode).toBe(404);
    await outApp.close();

    // end → join 404
    const en = await app.inject({ method: 'POST', url: `/api/lessons/${sessionId}/end`, headers: auth(teacher.token) });
    expect(en.statusCode).toBe(200);
    const sj2 = await app.inject({ method: 'POST', url: `/api/lessons/${sessionId}/join`, headers: auth(studentToken) });
    expect(sj2.statusCode).toBe(404);
    await app.close();
  });

  it('lecture mode persists and tightens join tokens; layout changes stored', async () => {
    const app = await fresh();
    const st = await app.inject({ method: 'POST', url: '/api/lessons/start', headers: auth(teacher.token), payload: { classId } });
    const sessionId = st.json().id as string;
    // no media server locally → route must not 500
    const lm = await app.inject({ method: 'POST', url: `/api/lessons/${sessionId}/lecture-mode`, headers: auth(teacher.token), payload: { on: true } });
    expect(lm.statusCode).toBe(200);
    const sj = await app.inject({ method: 'POST', url: `/api/lessons/${sessionId}/join`, headers: auth(studentToken) });
    const verifier = new TokenVerifier(process.env.LIVEKIT_API_KEY ?? 'devkey', process.env.LIVEKIT_API_SECRET ?? 'devsecretdevsecretdevsecret123456');
    const claims = await verifier.verify(sj.json().token as string);
    expect(claims.video?.canPublish).toBe(false);
    // mute route degrades gracefully (502 only when list fails and target given? we return ok with muted=0)
    const mute = await app.inject({ method: 'POST', url: `/api/lessons/${sessionId}/mute`, headers: auth(teacher.token), payload: { all: true } });
    expect([200, 502]).toContain(mute.statusCode);
    const lay = await app.inject({ method: 'PATCH', url: `/api/lessons/${sessionId}/layout`, headers: auth(teacher.token), payload: { layout: 'stage' } });
    expect(lay.statusCode).toBe(200);
    const layS = await app.inject({ method: 'PATCH', url: `/api/lessons/${sessionId}/layout`, headers: auth(studentToken), payload: { layout: 'gallery' } });
    expect(layS.statusCode).toBe(403);
    const act = await app.inject({ method: 'GET', url: `/api/lessons/active?classId=${classId}`, headers: auth(studentToken) });
    expect(act.json().session.layout).toBe('stage');
    expect(act.json().session.lectureMode).toBe(true);
    await app.inject({ method: 'POST', url: `/api/lessons/${sessionId}/end`, headers: auth(teacher.token) });
    await app.close();
  });

  it('WS lesson status: initial snapshot + started/ended broadcasts', async () => {
    const app = await fresh();
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const st = await app.inject({ method: 'POST', url: '/api/lessons/start', headers: auth(teacher.token), payload: { classId } });
    const sessionId = st.json().id as string;

    const tr = await app.inject({ method: 'POST', url: '/api/ws/ticket', headers: auth(studentToken), payload: { sessionId } });
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws/lesson/${sessionId}?ticket=${encodeURIComponent(tr.json().ticket as string)}`);
    const msgs: Record<string, unknown>[] = [];
    ws.addEventListener('message', (ev) => msgs.push(JSON.parse(String(ev.data))));
    await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = (e) => rej(e); });
    await new Promise((r) => setTimeout(r, 150));
    expect(msgs[0]?.type).toBe('started');

    await app.inject({ method: 'POST', url: `/api/lessons/${sessionId}/end`, headers: auth(teacher.token) });
    await new Promise((r) => setTimeout(r, 200));
    expect(msgs.some((m) => m.type === 'ended')).toBe(true);
    ws.close();

    // invalid ticket socket gets closed with 4401
    const bad = new WebSocket(`ws://127.0.0.1:${port}/api/ws/lesson/${sessionId}?ticket=nope`);
    const code = await new Promise<number>((res) => {
      bad.onclose = (e) => res(e.code);
      bad.onerror = () => res(-1);
    });
    expect(code).toBe(4401);
    await app.close();
  });
});
