/**
 * `pnpm bot:status` — read-only status of the Telegram bot in the configuration it is
 * deployed with. It answers exactly one operational question: is the bot reachable, is the
 * webhook pointed at this deployment, and is Telegram able to deliver to it.
 *
 *   pnpm bot:status                                  # token from TELEGRAM_BOT_TOKEN in env
 *   pnpm bot:status -- --env <path-to-cloud.env>     # token read from the file, never printed
 *   pnpm bot:status -- --env … --chat <chatId>       # also check the per-chat command menu
 *   pnpm bot:status -- --env … --probe               # also hit our own webhook gate (POST {})
 *
 * What it does: getMe, getWebhookInfo, getMyCommands (default scope, all_private_chats for
 * ru/uz/en, and the chat scope when --chat is given). It writes nothing to Telegram and
 * nothing to the database. `--probe` POSTs an EMPTY body (no update_id, so nothing is
 * processed) to /webhook/telegram to show the gate's own statuses.
 *
 * Secrecy: the token is only ever placed in the request URL by fetch; every string this
 * script prints goes through mask() first, which removes the token, any `bot<digits>:…`
 * shape and any connection string. `secret_token` is deliberately NOT sent by any of these
 * methods — the Bot API does not report it, which is why the registration arguments are
 * asserted in code (lib/prodConfig.ts + test/unit/prod-config.test.ts) and the gate itself
 * is probed with --probe.
 *
 * TELEGRAM_API_BASE only exists for tests: it lets test/integration/bot-status.test.ts run
 * this exact file against a local fake Bot API and assert the printed output.
 */
import fs from 'node:fs';

const args = process.argv.slice(2);
const arg = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const envFile = arg('env');
const read = {};
if (envFile) {
  if (!fs.existsSync(envFile)) { console.error(`env file not found: ${envFile}`); process.exit(2); }
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const i = line.indexOf('='); if (i <= 0) continue;
    const k = line.slice(0, i).trim(); if (!/^[A-Z0-9_]+$/.test(k)) continue;
    read[k] = line.slice(i + 1).trim();
  }
}
const cfg = (k) => process.env[k] || read[k] || '';

const token = cfg('TELEGRAM_BOT_TOKEN');
if (!token) {
  console.error('no bot token: set TELEGRAM_BOT_TOKEN in the environment or pass --env <cloud.env> '
    + '(the value in the file was empty). The token is never printed.');
  process.exit(2);
}
const API_BASE = (process.env.TELEGRAM_API_BASE || 'https://api.telegram.org').replace(/\/+$/, '');
const webhookSecret = cfg('TELEGRAM_WEBHOOK_SECRET');
const publicUrl = cfg('PUBLIC_URL');
const domain = cfg('DOMAIN');
const chatArg = arg('chat');
const probe = args.includes('--probe');

const mask = (s) => String(s)
  .replaceAll(token, '***')
  .replace(/bot\d{6,12}:[0-9A-Za-z_-]{10,}/g, 'bot***:***')
  .replaceAll(webhookSecret || '\u0000', '***')
  .replace(/postgres(ql)?:\/\/[^\s"']*/g, 'postgres://***')
  .replace(/password[=:][^\s"',}]+/gi, 'password=***');
const out = (...a) => console.log(...a.map((x) => (typeof x === 'string' ? mask(x) : x)));

let failures = 0;
const check = (name, ok_, detail = '') => {
  out(`${ok_ ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok_) failures++;
};

/** One Bot API call. Returns the `result`, or throws with the description (masked). */
async function call(method, payload) {
  const res = await fetch(`${API_BASE}/bot${token}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload ?? {}),
  }).catch((e) => { throw new Error(`network: ${mask(e.message)}`); });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { throw new Error(`${method}: http ${res.status} ${text.slice(0, 120)}`); }
  if (!json.ok) throw new Error(`${method}: error_code=${json.error_code} ${json.description ?? ''}`);
  return json.result;
}

const ago = (epoch) => (epoch ? `${new Date(epoch * 1000).toISOString()} (${Math.round((Date.now() / 1000 - epoch) / 60)} min ago)` : '—');

out(`bot:status  api=${API_BASE}  token from ${process.env.TELEGRAM_BOT_TOKEN ? 'environment' : envFile}`);

// ── getMe ─────────────────────────────────────────────────────────────────────
let me = null;
try { me = await call('getMe'); } catch (e) { check('getMe', false, String(e.message)); }
if (me) {
  out(`  bot            @${me.username} — "${me.first_name}" (id ${me.id})`);
  out(`  capabilities   can_join_groups=${me.can_join_groups} read_all_group_messages=${me.can_read_all_group_messages} inline=${me.supports_inline_queries}`);
  check('the bot answers getMe', Boolean(me.username), `@${me.username ?? ''}`);
  const expected = cfg('TELEGRAM_BOT_NAME');
  if (expected) check('TELEGRAM_BOT_NAME matches the live username', expected === me.username, `configured "${expected}", live "@${me.username}"`);
}

// ── getWebhookInfo ────────────────────────────────────────────────────────────
let hook = null;
try { hook = await call('getWebhookInfo'); } catch (e) { check('getWebhookInfo', false, String(e.message)); }
if (hook) {
  let host = '', path = '';
  if (hook.url) { try { const u = new URL(hook.url); host = u.host; path = u.pathname; } catch { host = `<unparseable: ${hook.url}>`; } }
  out(`  webhook url    ${host}${path}`);
  out(`  ip_address     ${hook.ip_address || '— (Telegram resolves the host itself)'}`);
  out(`  max_connections ${hook.max_connections ?? '— (default 40)'}`);
  out(`  allowed_updates ${hook.allowed_updates?.length ? hook.allowed_updates.join(',') : '— (all)'}`);
  out(`  pending        ${hook.pending_update_count} update(s) queued at Telegram`);
  out(`  last_error     ${ago(hook.last_error_date)} ${hook.last_error_message ? mask(hook.last_error_message) : '(none)'}`);
  if (hook.last_synchronization_error_date) out(`  last_sync_error ${ago(hook.last_synchronization_error_date)}`);

  check('a webhook is registered', Boolean(hook.url), hook.url ? '' : 'setWebhook never ran or its answer was lost');
  const base = publicUrl.trim() ? publicUrl.trim().replace(/\/+$/, '')
    : (domain?.trim() ? `https://${domain.trim().replace(/^https?:\/\//, '')}` : '');
  if (!base) {
    out('  NOTE  PUBLIC_URL/DOMAIN are empty in the configuration read here, so the webhook url cannot be'
      + ' compared locally. Compare it with the address the deployed service actually answers on.');
  } else {
    const want = `${new URL(base).host}/webhook/telegram`;
    check('webhook url is this deployment + /webhook/telegram', `${host}${path}` === want, `expected ${want}, got ${host}${path || '(none)'}`);
  }
  check('no pending backlog', hook.pending_update_count === 0, `${hook.pending_update_count} queued`);
  check('no failed delivery recorded', !hook.last_error_message, hook.last_error_message ? mask(hook.last_error_message) : '');
  out('  NOTE  getWebhookInfo does not report secret_token; the registration arguments are asserted in'
    + ' lib/prodConfig.ts (webhookRegistration) and the gate itself is proven by --probe / by tests.');
}

// ── getMyCommands: default, all_private_chats × ru/uz/en, chat scope ──────────
const LANGS = ['ru', 'uz', 'en'];
const names = (cmds) => (cmds ?? []).map((c) => `/${c.command}`).join(' ');
async function menu(label, scope, lang) {
  try {
    const cmds = await call('getMyCommands', lang ? { scope, language_code: lang } : { scope });
    out(`  ${label.padEnd(26)} ${String(cmds.length).padStart(2)}: ${names(cmds)}`);
    return cmds;
  } catch (e) { check(`getMyCommands ${label}`, false, String(e.message)); return null; }
}
out('command menus');
await menu('default scope', {});
for (const lang of LANGS) await menu(`all_private_chats ${lang}`, { type: 'all_private_chats' }, lang);
if (chatArg) {
  for (const lang of LANGS) await menu(`chat ${maskChat(chatArg)} ${lang}`, { type: 'chat', chat_id: Number(chatArg) }, lang);
}
function maskChat(id) { const s = String(id); return s.length <= 4 ? s : `***${s.slice(-4)}`; }

// ── what the code would have installed (from the built menu constants) ────────
try {
  const dist = new URL('../dist/services/botApi.js', import.meta.url);
  if (fs.existsSync(dist)) {
    const m = await import(dist.href);
    const setOf = (list) => list.map(([c]) => `/${c}`).sort().join(' ');
    const expected = { basic: setOf(m.BASIC_COMMANDS), student: setOf(m.STUDENT_COMMANDS), teacher: setOf(m.TEACHER_COMMANDS) };
    out(`expected from code  basic(${expected.basic.split(' ').length}) = ${expected.basic}`);
    out(`                  student(${expected.student.split(' ').length}) = ${expected.student}`);
    out(`                  teacher(${expected.teacher.split(' ').length}) = ${expected.teacher}`);
  } else {
    out(`expected from code  skipped — ${dist.pathname} is not built yet (run pnpm --filter @klass/api build)`);
  }
} catch (e) { out(`expected from code  skipped — ${mask(e.message)}`); }

// ── --probe: our own gate, the only part of this that does not need Telegram ──
if (probe) {
  const base = (arg('base') || publicUrl || '').replace(/\/+$/, '');
  if (!base) { out('probe  skipped: pass --base https://<deployed-host> (or set PUBLIC_URL)'); }
  else {
    const HEAD = 'x-telegram-bot-api-secret-token';
    const post = async (label, headers) => {
      const t = Date.now();
      try {
        const r = await fetch(`${base}/webhook/telegram`, {
          method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{}',
        });
        const body = await r.text();
        out(`probe  ${label.padEnd(28)} status=${r.status} ${Date.now() - t}ms body=${mask(body).slice(0, 120)}`);
        return { status: r.status, ms: Date.now() - t, body };
      } catch (e) { out(`probe  ${label.padEnd(28)} ERROR ${mask(e.message)}`); return null; }
    };
    out('probe  POST {} (no update_id ⇒ nothing is processed, no row is written)');
    await post('no secret header', {});
    await post('wrong secret header', { [HEAD]: 'obviously-wrong-secret-value-000000' });
    if (webhookSecret) await post('configured secret header', { [HEAD]: webhookSecret });
    else out('probe  the local configuration has no TELEGRAM_WEBHOOK_SECRET — only the two rejections were sent');
  }
}

out(failures ? `\nbot:status ${failures} problem(s)` : '\nbot:status OK');
// exitCode, not process.exit(): on Windows an exit() while stdout is still an async pipe can abort
// the process inside libuv (observed as 0xC0000409), which would hide the report this tool exists
// to print. Nothing keeps the loop alive once the calls are done, so the process ends by itself.
process.exitCode = failures ? 1 : 0;
