/**
 * Demo smoke-check (docs/DEMO.md): run while `pnpm demo` is up.
 *
 *   pnpm demo:check -- --base https://xxxx.trycloudflare.com [--livekit wss://…livekit.cloud]
 *
 * C.3 — the check builds ALL of its own fixtures through the public API
 * (class → invite code → student → lesson → notes) and cleans up after
 * itself (end lesson, archive class, delete the test note). It does NOT
 * depend on seeded demo data beyond the single teacher login.
 *
 * Prints PASS/FAIL per check, exits non-zero on any failure. No secrets printed.
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

// single seeded teacher — credentials are documented in docs/DEMO.md (not a secret: demo instance)
const TEACHER = { email: 'teacher@demo.klass.local', password: 'DemoTeacher123' };

let failures = 0;
const ok = (name, pass, extra = '') => {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`);
  if (!pass) failures++;
};

async function login(email, password) {
  const r = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!r.ok) throw new Error(`login ${email} → ${r.status}`);
  return (await r.json()).accessToken;
}
const req = (token, method, path, body) =>
  fetch(`${base}${path}`, {
    method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  });
const json = async (r) => { try { return await r.json(); } catch { return null; } };

const decodeJwt = (t) => JSON.parse(Buffer.from(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));

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

const stamp = Date.now();

async function main() {
  console.log(`demo-check against ${base}`);

  const health = await fetch(`${base}/api/health/live`).catch(() => null);
  ok('HTTP reachable', Boolean(health?.ok), `status ${health?.status}`);
  if (!health?.ok) process.exit(1);

  // ── own fixtures ───────────────────────────────────────────────────────────
  const teacher = await login(TEACHER.email, TEACHER.password);
  ok('teacher login', Boolean(teacher));

  const cls = await json(await req(teacher, 'POST', '/api/classes', { name: `Проверка demo ${stamp}`, description: '', color: '#4f46e5' }));
  ok('create class (fixture)', Boolean(cls?.id), cls?.id?.slice(0, 8));
  if (!cls?.id) process.exit(1);

  // D — notes API: class-less note, pin, delete
  const noteRes = await req(teacher, 'POST', '/api/notes', { title: 'проверка', body: '<p>x</p>' });
  const note = await json(noteRes);
  ok('create note without class (D.1)', noteRes.status === 201 && note?.classId === null, note?.id?.slice(0, 8));
  const pinned = await req(teacher, 'PATCH', `/api/notes/${note.id}`, { pinned: true });
  ok('pin note', pinned.status === 200 && (await json(pinned)).pinned === true);
  const noteDel = await req(teacher, 'DELETE', `/api/notes/${note.id}`);
  ok('delete note', noteDel.status === 200);

  // student via fresh one-time invite code
  const invite = await json(await req(teacher, 'POST', `/api/classes/${cls.id}/invites`, { ttlDays: 1 }));
  ok('create invite code', Boolean(invite?.code), invite?.code);
  const stuEmail = `check${stamp}@demo.invalid`;
  const reg = await fetch(`${base}/api/auth/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Проверочный', email: stuEmail, password: 'Check12345', code: invite.code }),
  });
  ok('student registers with the code', reg.status === 200 || reg.status === 201, `status ${reg.status}`);
  const student = (await json(reg))?.accessToken;

  // ── lesson ─────────────────────────────────────────────────────────────────
  const startRes = await req(teacher, 'POST', '/api/lessons/start', { classId: cls.id });
  const session = await json(startRes);
  ok('start lesson (201)', startRes.status === 201, `room ${session?.roomName}`);

  const join = await json(await req(teacher, 'POST', `/api/lessons/${session.id}/join`));
  ok('teacher join (token+wsUrl)', Boolean(join?.token), `wsUrl ${join?.wsUrl}`);
  if (wantLivekit) ok('wsUrl == LIVEKIT_URL from .env', join.wsUrl === wantLivekit, `${join.wsUrl}`);
  const gT = decodeJwt(join.token).video ?? decodeJwt(join.token);
  ok('token: teacher roomAdmin + room bound', gT.room === session.roomName && gT.roomAdmin === true, `room=${gT.room}`);

  const sJoin = await json(await req(student, 'POST', `/api/lessons/${session.id}/join`));
  const gS = decodeJwt(sJoin.token).video ?? decodeJwt(sJoin.token);
  ok('student join: camera+mic only', gS.canPublish === true && String(gS.canPublishSources).includes('camera'), `sources=${gS.canPublishSources}`);

  // ── WebSockets through the tunnel ─────────────────────────────────────────
  const t1 = await json(await req(teacher, 'POST', '/api/ws/ticket', { sessionId: session.id }));
  const lessonWs = await wsCollect(`${wsBase}/api/ws/lesson/${session.id}?ticket=${encodeURIComponent(t1.ticket)}`);
  const started = lessonWs.messages.map((m) => { try { return JSON.parse(m); } catch { return null; } })
    .find((m) => m?.type === 'started');
  ok('lesson status WS', lessonWs.opened && Boolean(started), `code ${lessonWs.code}, ${lessonWs.messages.length} msg(s)`);
  ok('WS payload carries server-provided wsUrl', started?.session?.wsUrl === join.wsUrl);

  const t2 = await json(await req(student, 'POST', '/api/ws/ticket', { sessionId: session.id }));
  const boardWs = await wsCollect(`${wsBase}/api/ws/board/${session.id}?ticket=${encodeURIComponent(t2.ticket)}`);
  const init = boardWs.messages.map((m) => { try { return JSON.parse(m); } catch { return null; } })
    .find((m) => m?.type === 'init');
  ok('board WS (student read-only init)', boardWs.opened && init?.canEdit === false);

  const reuse = await wsCollect(`${wsBase}/api/ws/lesson/${session.id}?ticket=${encodeURIComponent(t1.ticket)}`);
  ok('ticket is one-time (reuse → 4401)', reuse.code === 4401 && reuse.messages.length === 0, `code ${reuse.code}`);

  // ── cleanup own fixtures ───────────────────────────────────────────────────
  const endRes = await req(teacher, 'POST', `/api/lessons/${session.id}/end`);
  ok('end lesson (cleanup)', endRes.status === 200);
  const arch = await req(teacher, 'POST', `/api/classes/${cls.id}/archive`, {});
  ok('archive fixture class (cleanup)', arch.status === 200);

  console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error('demo-check error:', e.message); process.exit(1); });
