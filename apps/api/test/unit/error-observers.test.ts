/**
 * Task 7 (2026-10-10) — the error paths that belong to a LIBRARY rather than to us.
 *
 * Each test here has two halves on purpose: it first shows what the library prints by itself
 * (measured, not assumed), then what our handler prints for the same object. Values are fictitious:
 * a chat text marker, a bot token in the shape Telegram uses, a connection string against `.invalid`.
 */
import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { inspect } from 'node:util';
import { readFileSync } from 'node:fs';
import { GrammyError, HttpError } from 'grammy';
import { attachErrorLogging, botErrorLine } from '../../src/lib/errorObservers';
import { errorLine } from '../../src/lib/redact';

const CHAT_TEXT = 'ЧАТ-ТЕКСТ-МАРКЕР-не-в-лог';
const BOT_TOKEN = '123456789:AAfaketokenfaketokenfaketoken12';
const FAKE_PG = 'postgres://user:fakepass@db.invalid:5432/klass';

const grammyErr = new GrammyError(
  "Call to 'sendMessage' failed!",
  { error_code: 401, description: 'Unauthorized', parameters: {} } as never,
  'sendMessage',
  { chat_id: 555, text: CHAT_TEXT } as never,
);
const httpErr = new HttpError("Network request for 'sendMessage' failed!",
  Object.assign(new Error(`fetch failed https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`),
    { code: 'UND_ERR_CONNECT_TIMEOUT' }));
// grammY's BotError: name 'BotError', `.error` is the real one, `.ctx` carries the whole update
const botErr = Object.assign(new Error('middleware failed'), { name: 'BotError', error: grammyErr });

describe('grammY: what the library prints vs what we print', () => {
  it('the default print of a GrammyError contains the message that was being sent', () => {
    // grammY's built-in handler is `console.error("Error in middleware…", update_id, err.error)`,
    // and Node renders an error's own enumerable properties — among them `payload`.
    const printed = inspect(grammyErr);
    expect(printed, 'this is the leak the custom handler exists to stop').toContain(CHAT_TEXT);
    expect(printed).toContain('sendMessage');
  });

  it('botErrorLine names the class and the Telegram code, and nothing else', () => {
    const line = botErrorLine(botErr);
    expect(line).toBe('telegram bot: GrammyError (401)');
    expect(line).not.toContain(CHAT_TEXT);
    expect(line).not.toContain('Unauthorized'); // the description is Telegram's text, not ours
  });

  it('an HttpError keeps its class and takes the code from the wrapped fetch error', () => {
    const line = botErrorLine(httpErr);
    expect(line).toBe('telegram bot: HttpError (UND_ERR_CONNECT_TIMEOUT)');
    expect(line, 'the request URL contains the bot token').not.toContain(BOT_TOKEN);
    expect(line).not.toContain('api.telegram.org');
  });

  it('a non-BotError is not unwrapped (the class is the diagnosis)', () => {
    expect(botErrorLine(new Error('plain'))).toBe('telegram bot: Error');
  });
});

describe('attachErrorLogging (pg-boss, lesson/board/chat sockets)', () => {
  it('an emitter without a listener throws — that is the crash it prevents', () => {
    const bare = new EventEmitter();
    expect(() => bare.emit('error', new Error('boom'))).toThrow();
  });

  it('with the listener the error is logged as class+code and the process survives', () => {
    const emitter = new EventEmitter();
    const lines: string[] = [];
    attachErrorLogging(emitter, 'pg-boss', (l) => lines.push(l));
    const err = Object.assign(new Error(`connect ${FAKE_PG} refused`), { code: 'ECONNREFUSED' });
    expect(() => emitter.emit('error', err)).not.toThrow();
    expect(lines).toEqual(['pg-boss: Error (ECONNREFUSED)']);
    expect(lines[0]).not.toContain('fakepass');
    expect(lines[0]).not.toContain('db.invalid');
  });

  /**
   * The three call sites are part of the contract: the helper existing but not being wired is the
   * exact mistake this whole line of work is about (a sanitizer that was correct and never called).
   */
  it('is wired into the lesson socket, the board socket, the chat socket and pg-boss', () => {
    const files = [
      '../../src/lib/wsHub.ts', '../../src/routes/board.ts', '../../src/routes/chat.ts',
      '../../src/services/notifyQueue.ts',
    ];
    for (const f of files) {
      const src = readFileSync(new URL(f, import.meta.url), 'utf8');
      expect(src, f).toContain('attachErrorLogging(');
    }
  });
});

describe('LiveKit and the HTTP surface', () => {
  it('a LiveKit error line keeps the code and loses the server address', () => {
    const err = Object.assign(
      new Error(`bad gateway for wss://livekit.invalid/rtc/v1?key=${BOT_TOKEN}`),
      { status: 502 },
    );
    const line = errorLine('livekit', err);
    expect(line).toBe('livekit: Error (502)');
    expect(line).not.toContain('livekit.invalid');
    expect(line).not.toContain(BOT_TOKEN);
  });
});
