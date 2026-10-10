/**
 * `pnpm bot:status` is an operator-facing tool, so it is tested the way every other output
 * surface in this repo is: by the text the process prints, against a stand-in Bot API.
 *
 * Everything here is FICTITIOUS: the token, the webhook secret, the chat id and the bot name
 * are made-up strings. The point is to prove three things at once:
 *   • the tool actually performs getMe / getWebhookInfo / getMyCommands (default scope,
 *     all_private_chats per language, and the chat scope when --chat is given);
 *   • its output carries the facts the audit needs (host and path, pending queue, max
 *     connections, allowed_updates, ip_address, last error) and says nothing else;
 *   • no credential ever reaches stdout — not the token, not the webhook secret, not the
 *     chat id in full — which is what makes the tool safe to run in front of other people.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SCRIPT = path.resolve('scripts/bot-status.mjs');

const TOKEN = '777000:FICTIONAL-faketoken-faketoken-faketoken77';
const HOOK_SECRET = 'fictitious-webhook-secret-0123456789';
const CHAT_ID = '9981234567890';

type State = {
  webhookUrl: string; pending: number; lastError?: string; ip?: string;
  commands: Record<string, string[]>;
};

const calls: { method: string; body: Record<string, unknown>; path: string }[] = [];
let server: http.Server | null = null;
let base = '';
let state: State = { webhookUrl: '', pending: 0, commands: {} };

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown> : {};
      const method = url.pathname.split('/').pop() ?? '';
      calls.push({ method, body, path: url.pathname });
      const send = (result: unknown) => res.end(JSON.stringify({ ok: true, result }));
      if (method === 'getMe') return send({ id: 777, is_bot: true, username: 'fictitious_blublu_bot', first_name: 'BluBlu Test', can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false });
      if (method === 'getWebhookInfo') {
        return send({
          url: state.webhookUrl, pending_update_count: state.pending,
          ...(state.lastError ? { last_error_date: Math.floor(Date.now() / 1000) - 120, last_error_message: state.lastError } : {}),
          ...(state.ip ? { ip_address: state.ip } : {}),
          max_connections: 40, allowed_updates: ['message', 'callback_query'],
        });
      }
      if (method === 'getMyCommands') {
        const scope = body.scope as { type?: string; chat_id?: number } | undefined;
        const lang = String(body.language_code ?? '');
        const key = scope?.type === 'chat' ? `chat:${lang}` : scope?.type === 'all_private_chats' ? `private:${lang}` : 'default';
        const list = state.commands[key] ?? [];
        return send(list.map((command) => ({ command, description: `d-${command}` })));
      }
      return res.end(JSON.stringify({ ok: false, error_code: 400, description: `unhandled ${method}` }));
    });
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server?.close(() => r()));
});

function run(extraArgs: string[], envFileText: string): Promise<{ code: number | null; out: string }> {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'botstatus-')), 'cloud.env');
  fs.writeFileSync(file, envFileText, 'utf8');
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, '--env', file, ...extraArgs], {
      env: { ...process.env, TELEGRAM_API_BASE: base, TELEGRAM_BOT_TOKEN: '' },
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    let out = '';
    child.stdout.on('data', (b) => { out += b.toString(); });
    child.stderr.on('data', (b) => { out += b.toString(); });
    const kill = setTimeout(() => child.kill(), 20_000);
    child.on('exit', (code) => { clearTimeout(kill); fs.rmSync(file, { force: true }); resolve({ code, out }); });
    child.on('error', (e) => { clearTimeout(kill); resolve({ code: -1, out: `spawn failed: ${e.message}` }); });
  });
}

const envFile = (publicUrl: string) => [
  `TELEGRAM_BOT_TOKEN=${TOKEN}`,
  `TELEGRAM_BOT_NAME=fictitious_blublu_bot`,
  `TELEGRAM_WEBHOOK_SECRET=${HOOK_SECRET}`,
  `PUBLIC_URL=${publicUrl}`,
].join('\n');

describe('bot:status output (audit item 4)', () => {
  it('prints the operator facts of a healthy webhook and nothing secret', async () => {
    calls.length = 0;
    state = {
      webhookUrl: `${base}/webhook/telegram`, pending: 0, ip: '203.0.113.9',
      commands: {
        default: ['start', 'help'],
        'private:ru': ['start', 'help', 'language', 'contact'],
        'private:uz': ['start', 'help', 'language', 'contact'],
        'private:en': ['start', 'help', 'language', 'contact'],
      },
    };
    const { code, out } = await run([], envFile(base));
    expect(out, `the process ran to completion:\n${out}`).toContain('@fictitious_blublu_bot');
    expect(out).toContain(`${new URL(base).host}/webhook/telegram`);   // host and path, no credentials
    expect(out).toMatch(/pending\s+0 update\(s\)/);
    expect(out).toMatch(/max_connections\s+40/);
    expect(out).toContain('message,callback_query');                    // allowed_updates
    expect(out).toContain('203.0.113.9');                               // ip_address
    expect(out).toMatch(/last_error\s+— \(none\)/);
    expect(out).toMatch(/all_private_chats ru\s+4: \/start \/help \/language \/contact/);
    expect(code, out).toBe(0);
    // the requests themselves: which methods, and that none of them sends a secret_token
    expect(calls.map((c) => c.method)).toEqual([
      'getMe', 'getWebhookInfo', 'getMyCommands', 'getMyCommands', 'getMyCommands', 'getMyCommands',
    ]);
    expect(calls.every((c) => !('secret_token' in c.body))).toBe(true);
    // …and the output: the token, the webhook secret and the api.telegram.org URL shape are absent
    expect(out).not.toContain(TOKEN);
    expect(out).not.toContain(HOOK_SECRET);
    expect(out).not.toContain('FICTIONAL-faketoken');
  });

  it('refuses to hide a broken delivery: 403 from our own gate, backlog, wrong host, exit 1', async () => {
    calls.length = 0;
    state = {
      webhookUrl: 'https://somewhere-else.example/webhook/telegram', pending: 17,
      lastError: 'Forbidden: response from the webhook was 403', commands: {},
    };
    const { code, out } = await run([], envFile(base));
    expect(code, out).toBe(1);
    expect(out).toContain('FAIL  webhook url is this deployment + /webhook/telegram');
    expect(out).toContain('FAIL  no pending backlog — 17 queued');
    expect(out).toContain('FAIL  no failed delivery recorded');
    // the error text itself is printed (it is what the operator has to act on) but it is masked
    expect(out).toContain('response from the webhook was 403');
    expect(out).not.toContain(TOKEN);
  });

  it('--chat asks for the chat scope by numeric id and prints the id masked', async () => {
    calls.length = 0;
    state = {
      webhookUrl: `${base}/webhook/telegram`, pending: 0,
      commands: {
        'chat:ru': ['schedule', 'next', 'classes', 'materials', 'announce', 'settings', 'language', 'help'],
        'chat:uz': [], 'chat:en': [],
      },
    };
    const { code, out } = await run(['--chat', CHAT_ID], envFile(base));
    expect(code, out).toBe(0);
    const chat = calls.filter((c) => (c.body.scope as { type?: string })?.type === 'chat');
    expect(chat).toHaveLength(3); // ru, uz, en
    expect(chat[0]!.body.scope).toEqual({ type: 'chat', chat_id: Number(CHAT_ID) });
    expect(out).toContain('***7890');                 // the label carries only the tail
    expect(out).not.toContain(CHAT_ID);               // never the whole id
  });

  it('without a token it says so and exits 2 — it never invents a bot', async () => {
    const { code, out } = await run([], 'PUBLIC_URL=' + base);
    expect(code).toBe(2);
    expect(out).toContain('no bot token');
    expect(out).not.toContain(TOKEN);
  });
});
