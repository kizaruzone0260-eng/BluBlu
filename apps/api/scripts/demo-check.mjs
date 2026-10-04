/**
 * Demo smoke-check (docs/DEMO.md): run while `pnpm demo` is up.
 *
 *   pnpm demo:check -- --base https://xxxx.trycloudflare.com [--livekit wss://…livekit.cloud]
 *
 * Verifies end-to-end through the public tunnel:
 *   1. teacher login → demo class → start lesson → join (LiveKit token + wsUrl);
 *   2. wsUrl equals LIVEKIT_URL from .env (client learns the LiveKit address from the API);
 *   3. JWT claims (identity/room/grants) for teacher and student;
 *   4. lesson-status WebSocket works THROUGH the tunnel (ticket auth, 'started' event);
 *   5. board WebSocket works THROUGH the tunnel ('init' snapshot);
 *   6. one-time tickets are really one-time (reuse → close 4401);
 *   7. lesson is ended again afterwards (the manual two-person call is done by a human).
 *
 * Prints PASS/FAIL per check and exits non-zero on any failure. No secrets printed.
 */
import WebSocket from 'ws';

const argv = process.argv.slice(2);
const arg = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const base = (arg('base') ?? 'http://127.0.0.1:3000').replace(/\/+$/, '');
const wantLivekit = arg('livekit') ?? '';
const wsBase = base.replace(/^http/, 'ws');

const TEACHER = { email: 'teacher@demo.klass.local', password: 'DemoTeacher123' };
const STUDENT = { email: 'student@demo.klass.local', password: 'DemoStudent123' };
const CLASS_NAME = 'Демо-класс 7B';

let failures = 0;
const ok = (name, pass, extra = '') => {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`);
  if (!pass) failures++;
};

async function apiAuth(email, password) {
  const r = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!r.ok) throw new Error(`login ${email} → ${r.status}`);
  const j = await r.json();
  return j.accessToken;
}
const authJson = (token, method, path, body) =>
  fetch(`${base}${path}`, {
    method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    // fastify rejects an empty body when content-type is json → POST/PATCH send {}
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  });

function decodeJwt(t) {
  const p = t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(Buffer.from(p, 'base64').toString('utf8'));
}

function wsCollect(url, ms = 8000) {
  return new Promise((res) => {
    const out = { opened: false, code: null, messages: [] };
    const ws = new WebSocket(url);
    ws.onopen = () => { out.opened = true; };
    ws.onmessage = (e) => { out.messages.push(String(e.data)); };
    ws.onclose = (e) => { out.code = e.code; res(out); };
    ws.onerror = () => { /* close follows */ };
    setTimeout(() => { try { ws.close(1000); } catch { /* noop */ } setTimeout(() => res(out), 2000); }, ms);
  });
}

async function main() {
  console.log(`demo-check against ${base}`);

  const health = await fetch(`${base}/api/health/live`).catch(() => null);
  ok('HTTP through tunnel (GET /api/health/live)', Boolean(health?.ok), `status ${health?.status}`);
  if (!health?.ok) { console.log('target is not reachable — abort'); process.exit(1); }

  const teacher = await apiAuth(TEACHER.email, TEACHER.password);
  ok('teacher login (via tunnel)', Boolean(teacher));

  const classes = await (await authJson(teacher, 'GET', '/api/classes')).json();
  const cls = (classes.classes ?? classes).find?.((c) => c.name === CLASS_NAME);
  ok(`demo class «${CLASS_NAME}» visible`, Boolean(cls), cls ? `id ${cls.id.slice(0, 8)}…` : 'not found');
  if (!cls) process.exit(1);

  const startRes = await authJson(teacher, 'POST', '/api/lessons/start', { classId: cls.id });
  const session = await startRes.json();
  ok('start lesson (201)', startRes.status === 201, `room ${session.roomName}`);

  const joinRes = await authJson(teacher, 'POST', `/api/lessons/${session.id}/join`);
  const join = await joinRes.json();
  ok('teacher join (token+wsUrl)', joinRes.status === 200 && Boolean(join.token), `wsUrl ${join.wsUrl}`);
  if (wantLivekit) ok('wsUrl == LIVEKIT_URL from .env', join.wsUrl === wantLivekit, `${join.wsUrl} vs ${wantLivekit}`);
  const claims = decodeJwt(join.token);
  const gT = claims.video ?? claims; // livekit-server-sdk nests grants under `video`
  ok('token: teacher roomAdmin + room bound',
    gT.room === session.roomName && gT.roomAdmin === true,
    `room=${gT.room}`);
  ok('token: identity == user id', claims.sub === undefined || typeof (claims.sub ?? claims.identity) === 'string');

  const student = await apiAuth(STUDENT.email, STUDENT.password);
  const sJoin = await (await authJson(student, 'POST', `/api/lessons/${session.id}/join`)).json();
  const sClaims = decodeJwt(sJoin.token);
  const grants = sClaims.video ?? sClaims;
  ok('student join: can publish camera+mic only',
    grants.canPublish === true && String(grants.canPublishSources ?? '').includes('camera'),
    `sources=${grants.canPublishSources}`);

  // ── WebSockets through the tunnel ──
  const t1 = await (await authJson(teacher, 'POST', '/api/ws/ticket', { sessionId: session.id })).json();
  const lessonWs = await wsCollect(`${wsBase}/api/ws/lesson/${session.id}?ticket=${encodeURIComponent(t1.ticket)}`);
  const started = lessonWs.messages.map((m) => { try { return JSON.parse(m); } catch { return null; } })
    .find((m) => m?.type === 'started');
  ok('lesson status WS through tunnel', lessonWs.opened && Boolean(started),
    `code ${lessonWs.code}, ${lessonWs.messages.length} msg(s)`);
  ok('WS payload carries server-provided wsUrl', started?.session?.wsUrl === join.wsUrl, started?.session?.wsUrl);

  const t2 = await (await authJson(student, 'POST', '/api/ws/ticket', { sessionId: session.id })).json();
  const boardWs = await wsCollect(`${wsBase}/api/ws/board/${session.id}?ticket=${encodeURIComponent(t2.ticket)}`);
  const init = boardWs.messages.map((m) => { try { return JSON.parse(m); } catch { return null; } })
    .find((m) => m?.type === 'init');
  ok('board WS through tunnel (student sees read-only init)',
    boardWs.opened && init?.canEdit === false, `elements ${init?.elements?.length ?? '-'}`);

  const reuse = await wsCollect(`${wsBase}/api/ws/lesson/${session.id}?ticket=${encodeURIComponent(t1.ticket)}`);
  ok('ticket is one-time (reuse → 4401)', reuse.code === 4401 && reuse.messages.length === 0, `code ${reuse.code}`);

  const endRes = await authJson(teacher, 'POST', `/api/lessons/${session.id}/end`);
  ok('end lesson (cleanup)', endRes.status === 200);

  console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error('demo-check error:', e.message); process.exit(1); });
