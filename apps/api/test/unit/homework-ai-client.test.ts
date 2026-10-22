/**
 * The OpenAI-compatible client, proved against a local stand-in provider.
 *
 * There is no real AI key in this environment, so the honest position is: the *contract* is
 * verified, the *vendor* is not. What is verified here is exactly what would otherwise first
 * show up in a live lesson:
 *  • the request shape (POST {AI_BASE_URL}/chat/completions, bearer key, model, two messages,
 *    the user content is ONE text part — never an image part, never base64 of a file);
 *  • the teacher's instruction and the material titles are the only file-adjacent data leaving;
 *  • a provider error, a timeout, a non-JSON answer and a wrong JSON shape all reject without
 *    dragging the API key or the provider's echoed body into the message;
 *  • a fenced JSON answer still parses, and an invented page number comes back as a warning;
 *  • a half-configured provider refuses to boot (subprocess: env.ts exits and prints key
 *    NAMES, never values).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { spawnSync } from 'node:child_process';
import { writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const SECRET_KEY = 'sk-LIVEPROVIDER-DO-NOT-PRINT-1234567890';
const MODEL = 'test-model-1';

interface Seen {
  method?: string; url?: string; auth?: string; ctype?: string;
  body?: Record<string, unknown>; raw?: string;
}

let server: http.Server | undefined;
let port = 0;
let mode = 'ok';
const seen: Seen[] = [];

const reply = (res: http.ServerResponse, code: number, body: unknown) => {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
};
const content = (text: string) => ({ choices: [{ message: { content: text } }] });

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      let body: Record<string, unknown> = {};
      try { body = JSON.parse(raw) as Record<string, unknown>; } catch { /* raw is enough */ }
      seen.push({
        method: req.method, url: req.url, auth: req.headers.authorization,
        ctype: String(req.headers['content-type'] ?? ''), body, raw,
      });
      switch (mode) {
        case 'fenced':
          return reply(res, 200, content('```json\n'
            + JSON.stringify({ title: 'Задание', formatted: 'Параграф 5', questions: [], warnings: [] })
            + '\n```'));
        case 'garbage':
          return reply(res, 200, content('извините, я не умею JSON'));
        case 'shape':
          return reply(res, 200, content('{"formatted": 123, "questions": "нет"}'));
        case 'empty':
          return reply(res, 200, content('   \n '));
        case 'questions':
          return reply(res, 200, content(JSON.stringify({
            title: 'Проект', formatted: 'Проект сделать',
            questions: ['Когда сдавать?'], warnings: ['Проверьте объём'],
          })));
        case 'invented':
          return reply(res, 200, content(JSON.stringify({
            title: 'Задание', formatted: 'Сделать стр. 99 к пятнице', questions: [], warnings: [],
          })));
        case 'prose':
          // some vendors wrap the JSON in a polite sentence
          return reply(res, 200, content(
            'Конечно! Вот готовое сообщение:\n'
            + JSON.stringify({ title: 'Задание', formatted: 'Unit 2', questions: [], warnings: [] }),
          ));
        case 'parts':
          // a content PARTS array instead of one string (OpenRouter-style responses)
          return reply(res, 200, {
            choices: [{ message: { content: [
              { type: 'text', text: '{"title":"Задание","formatted":"Unit 3","questions":[],"warnings":[]}' },
            ] } }],
          });
        case 'error':
          // a provider that echoes the key it was given: the client must not carry it outward
          return reply(res, 500, { error: { message: `invalid api key: ${SECRET_KEY}` } });
        case 'slow':
          setTimeout(() => reply(res, 200, content(JSON.stringify({ formatted: 'поздно' }))), 1_500);
          return;
        default:
          return reply(res, 200, content(JSON.stringify({
            title: 'Грамматика', formatted: 'Выполнить Unit 1 по English Grammar in Use',
            questions: [], warnings: [],
          })));
      }
    });
  });
  await new Promise<void>((resolve) => {
    server!.listen(0, '127.0.0.1', () => {
      port = (server!.address() as AddressInfo).port;
      resolve();
    });
  });

  process.env.AI_PROVIDER = 'openai-compatible';
  process.env.AI_BASE_URL = `http://127.0.0.1:${port}/v1/`; // trailing slash on purpose
  process.env.AI_API_KEY = SECRET_KEY;
  process.env.AI_MODEL = MODEL;
  process.env.AI_TIMEOUT_MS = '1000';
});

afterAll(async () => {
  await new Promise<void>((resolve) => { server?.close(() => resolve()); });
  for (const k of ['AI_PROVIDER', 'AI_BASE_URL', 'AI_API_KEY', 'AI_MODEL', 'AI_TIMEOUT_MS']) {
    delete process.env[k];
  }
});

/** env is parsed once at import, so the module is loaded after the AI_* setup. */
const loadAi = () => import('../../src/services/homework/ai.js');

const baseRequest = () => ({
  lang: 'ru' as const,
  instruction: 'Unit 1, Exercises 1–5.',
  items: [{
    id: 'i1', kind: 'document' as const, text: '', url: '', fileName: 'egau.pdf',
    mimeType: 'application/pdf', caption: '', forwarded: false,
  }],
  materials: [{ title: 'English Grammar in Use', kind: 'book' as const, fileName: 'egau.pdf' }],
});

describe('the request the OpenAI-compatible client actually sends', () => {
  it('posts to {base}/chat/completions with a bearer key and one text part', async () => {
    const { makeHomeworkAi } = await loadAi();
    mode = 'ok';
    seen.length = 0;
    const res = await makeHomeworkAi().format(baseRequest());
    expect(res.provider).toBe(`openai-compatible:${MODEL}`);
    expect(res.formatted).toContain('Unit 1');

    expect(seen).toHaveLength(1);
    const r = seen[0]!;
    expect(r.method).toBe('POST');
    // the trailing slash in AI_BASE_URL did not produce //chat/completions
    expect(r.url).toBe('/v1/chat/completions');
    expect(r.auth).toBe(`Bearer ${SECRET_KEY}`);
    expect(r.ctype).toBe('application/json');
    const messages = r.body!.messages as { role: string; content: unknown }[];
    expect(messages.map((m) => m.role)).toEqual(['system', 'user']);
    expect(typeof messages[1]!.content).toBe('string');
    expect(r.body!.model).toBe(MODEL);
  });

  it('sends only the instruction, the titles and the typed text — never file contents', async () => {
    const { makeHomeworkAi } = await loadAi();
    mode = 'ok';
    seen.length = 0;
    await makeHomeworkAi().format({
      ...baseRequest(),
      items: [
        { ...baseRequest().items[0]!, kind: 'photo', fileName: '', mimeType: 'image/jpeg', caption: 'Схема' },
        { ...baseRequest().items[0]! },
      ],
    });
    const raw = seen[0]!.raw ?? '';
    expect(raw).toContain('Unit 1, Exercises 1–5.');
    expect(raw).toContain('English Grammar in Use');
    expect(raw).toContain('egau.pdf'); // a name is metadata, and it is all the model gets
    expect(raw).not.toContain('image_url');
    expect(raw).not.toContain('base64');
    expect(raw).not.toContain('data:image');
    expect(raw).not.toContain('JVBERi'); // the first base64 bytes of any real PDF
    const system = String((seen[0]!.body!.messages as { content: string }[])[0]!.content);
    expect(system).toContain('are NOT provided');
    expect(system).toContain('Never invent');
  });

  it('parses a fenced JSON answer and flags numbers the teacher never wrote', async () => {
    const { makeHomeworkAi } = await loadAi();
    mode = 'fenced';
    const fenced = await makeHomeworkAi().format(baseRequest());
    expect(fenced.status).toBe('ok');
    expect(fenced.formatted).toBe('Параграф 5');

    mode = 'invented';
    const invented = await makeHomeworkAi().format(baseRequest());
    expect(invented.warnings.join(' ')).toContain('99');
    expect(invented.warnings.join(' ')).toContain('пятниц');
    // the attachment warning stays: files leave unread
    expect(invented.warnings.join(' ')).toContain('English Grammar in Use');
  });

  it('keeps the clarification path: questions become needs_clarification', async () => {
    const { makeHomeworkAi } = await loadAi();
    mode = 'questions';
    const res = await makeHomeworkAi().format(baseRequest());
    expect(res.status).toBe('needs_clarification');
    expect(res.questions).toEqual(['Когда сдавать?']);
  });

  it('tolerates the two answer shapes real vendors actually return', async () => {
    const { makeHomeworkAi } = await loadAi();
    // a JSON object wrapped in a polite sentence
    mode = 'prose';
    const prose = await makeHomeworkAi().format(baseRequest());
    expect(prose.formatted).toBe('Unit 2');
    // `content` as an array of parts instead of one string
    mode = 'parts';
    const parts = await makeHomeworkAi().format(baseRequest());
    expect(parts.formatted).toBe('Unit 3');
    expect(parts.status).toBe('ok');
    mode = 'ok';
  });

  it('warns about a deadline written in words that the teacher never gave', async () => {
    const { makeHomeworkAi } = await loadAi();
    mode = 'invented';
    const res = await makeHomeworkAi().format(baseRequest());
    const warnings = res.warnings.join(' ');
    expect(warnings).toContain('пятниц');
    expect(warnings).toContain('99');
    // and stays silent when the teacher herself named the day
    const mine = await makeHomeworkAi().format({
      ...baseRequest(), instruction: 'Unit 1, сдать к пятнице',
    });
    expect(mine.warnings.join(' ')).not.toContain('пятниц');
    mode = 'ok';
  });
});

describe('provider failures stay survivable and leak nothing', () => {
  it('a 5xx rejects with the status only — the provider body is not echoed', async () => {
    const { makeHomeworkAi } = await loadAi();
    mode = 'error';
    let message = '';
    try { await makeHomeworkAi().format(baseRequest()); } catch (e) { message = String((e as Error).message); }
    expect(message).toContain('HTTP 500');
    expect(message).not.toContain(SECRET_KEY);
    expect(message).not.toContain('sk-');
  });

  it('a non-JSON answer, a wrong shape and an empty answer each reject clearly', async () => {
    const { makeHomeworkAi } = await loadAi();
    const grab = async (next: string) => {
      mode = next;
      try { await makeHomeworkAi().format(baseRequest()); return ''; } catch (e) { return String((e as Error).message); }
    };
    const garbage = await grab('garbage');
    expect(garbage).toContain('no JSON object');
    expect(garbage).not.toContain('извините'); // the provider's text is not pasted into the error
    expect(await grab('shape')).toContain('unexpected JSON shape');
    expect(await grab('empty')).toContain('empty answer');
    mode = 'ok';
  });

  it('a stuck provider is cut off by AI_TIMEOUT_MS and the client still works after', async () => {
    const { makeHomeworkAi } = await loadAi();
    mode = 'slow';
    const started = Date.now();
    let message = '';
    try { await makeHomeworkAi().format(baseRequest()); } catch (e) { message = String(e); }
    const elapsed = Date.now() - started;
    expect(message).toBeTruthy();
    expect(message).not.toContain(SECRET_KEY);
    expect(message).not.toContain('127.0.0.1'); // the endpoint is not echoed either
    expect(elapsed).toBeLessThan(1_400); // the 1000 ms ceiling, not the server's 1500 ms
    expect(elapsed).toBeGreaterThanOrEqual(900);
    mode = 'ok';
    const after = await makeHomeworkAi().format(baseRequest());
    expect(after.formatted).toContain('Unit 1');
  });
});

describe('a half-configured AI provider refuses to boot', () => {
  // subprocess on purpose: env.ts calls process.exit(1), which would kill this worker.
  // The probe file lives in the OS temp dir and imports env.js by absolute path.
  const probeFile = path.join(tmpdir(), `blublu-env-probe-${process.pid}.mjs`);
  const envPath = pathToFileURL(path.resolve(process.cwd(), 'src/env.js')).href;
  const run = (vars: Record<string, string>) => {
    writeFileSync(probeFile,
      `import(${JSON.stringify(envPath)}).then(() => console.log("BOOTED"))\n`, 'utf8');
    // one process, no shell: `node --import tsx` keeps this probe from forking a second
    // Node just to read a config file (a full-suite worker died on a constrained laptop the
    // first time this test spawned `pnpm exec tsx`)
    const res = spawnSync(process.execPath, ['--import', 'tsx', probeFile], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 120_000,
      env: {
        ...process.env, NODE_ENV: 'test',
        JWT_SECRET: 'test-secret-test-secret-test-secret-0123456789',
        AI_PROVIDER: 'openai-compatible',
        AI_BASE_URL: 'http://127.0.0.1:9/v1',
        AI_API_KEY: 'super-secret-value-999999',
        AI_MODEL: MODEL,
        AI_TIMEOUT_MS: '30000',
        ...vars,
      },
    });
    return `${res.stdout ?? ''}${res.stderr ?? ''}`;
  };

  it('boots with key + model, and refuses without them, naming keys only', () => {
    try {
      expect(run({})).toContain('BOOTED');
      const noModel = run({ AI_MODEL: '' });
      expect(noModel).toContain('config invalid');
      expect(noModel).toContain('AI_MODEL');
      expect(noModel).not.toContain('BOOTED');
      expect(noModel).not.toContain('super-secret-value-999999');

      const noKey = run({ AI_API_KEY: '' });
      expect(noKey).toContain('config invalid');
      expect(noKey).toContain('AI_API_KEY');
      expect(noKey).not.toContain('BOOTED');
    } finally {
      rmSync(probeFile, { force: true });
    }
  }, 240_000);
});

describe('the offline provider is the default and needs no network', () => {
  it('AI_PROVIDER=none (or no key) formats locally', async () => {
    const { LOCAL_AI } = await loadAi();
    const local = await LOCAL_AI.format(baseRequest());
    expect(local.provider).toBe('local');
    expect(local.formatted).toContain('ДОМАШНЕЕ ЗАДАНИЕ');
    expect(local.formatted).toContain('Unit 1, Exercises 1–5.');
    expect(local.formatted).toContain('Материал: English Grammar in Use');

    // a fresh module registry over an environment that chose `none`: the factory must give
    // the offline implementation, not a network client. (Deleting the key instead is not a
    // real deployment shape — `openai-compatible` without a key refuses to boot, asserted
    // above.)
    vi.resetModules();
    const savedProvider = process.env.AI_PROVIDER;
    process.env.AI_PROVIDER = 'none';
    const fresh = await loadAi();
    const offline = await fresh.makeHomeworkAi().format(baseRequest());
    expect(offline.provider).toBe('local');
    process.env.AI_PROVIDER = savedProvider;
    vi.resetModules();
  });
});
