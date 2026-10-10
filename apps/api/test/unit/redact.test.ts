import { describe, it, expect } from 'vitest';
import pino from 'pino';
import { accessLogOptions } from '../../src/app';
import { describeError, redactSecrets, safeErrorMessage } from '../../src/lib/redact';

/**
 * Error text is the one string in this app that nobody owns: postgres-js puts the connection
 * string into it, grammY puts the Bot API URL (which IS a token) into it, the LiveKit SDK puts the
 * server address into it. `redactSecrets` is the single place that decides what may be printed.
 *
 * Every value below is FICTITIOUS (`.invalid` is a reserved TLD that can never resolve). The real
 * secrets are never read, never constructed and never printed — including by these assertions,
 * which check that a marker is ABSENT rather than comparing against a real string.
 */
const FAKE_PG = 'postgres://user:fakepass@db.example.invalid:5432/klass';
const FAKE_PG_URL = 'postgresql://user:fakepass@db.example.invalid:5432/klass';
const FAKE_WS = 'wss://livekit.example.invalid/rtc/v1';
const FAKE_BEARER = 'eyJhbGciOi.fake.bearer';
const FAKE_BOT_TOKEN = '123456789:AAfaketokenfaketokenfaketoken12';
const FAKE_BOT_URL = `https://api.telegram.org/bot${FAKE_BOT_TOKEN}/sendMessage`;

describe('redactSecrets (audit: no credential in any printed error)', () => {
  it('cuts a postgres connection string, both spellings', () => {
    const out = redactSecrets(`connect ${FAKE_PG} failed`);
    expect(out).not.toContain('fakepass');
    expect(out).not.toContain('db.example.invalid');
    expect(out).toContain('connect postgres://[redacted] failed');
    expect(redactSecrets(`pool ${FAKE_PG_URL}`)).not.toContain('fakepass');
  });

  it('cuts a websocket (LiveKit) address and a bearer token', () => {
    expect(redactSecrets(`cannot reach ${FAKE_WS}`)).not.toContain('livekit.example.invalid');
    expect(redactSecrets(`Authorization: Bearer ${FAKE_BEARER} rejected`)).not.toContain(FAKE_BEARER);
  });

  it('cuts a Telegram bot token in a URL and bare', () => {
    const viaUrl = redactSecrets(`Bad Request: ${FAKE_BOT_URL} → 401`);
    expect(viaUrl).not.toContain(FAKE_BOT_TOKEN);
    expect(viaUrl).toContain('401'); // the useful part survives
    expect(redactSecrets(`token is ${FAKE_BOT_TOKEN}`)).not.toContain(FAKE_BOT_TOKEN);
  });

  it('cuts key=value and key: "value" credential pairs', () => {
    expect(redactSecrets('retry with password=fakepass123')).not.toContain('fakepass123');
    expect(redactSecrets('{"token": "faketok3n"}')).not.toContain('faketok3n');
    expect(redactSecrets('api_key=fakekey999')).not.toContain('fakekey999');
  });

  it('an Error object is redacted through its message', () => {
    expect(redactSecrets(new Error(`connect ${FAKE_PG} refused`))).not.toContain('fakepass');
  });

  /** The other half of the contract: a redactor that ate everything would be "safe" and useless. */
  it('leaves ordinary diagnostic text alone', () => {
    const plain = 'invalid input syntax for type integer: "x" at column 12';
    expect(redactSecrets(plain)).toBe(plain);
    const link = 'see https://blublu.example.invalid/lesson for the class';
    expect(redactSecrets(link)).toBe(link); // an https page link is not a credential
    expect(redactSecrets(undefined)).toBe('');
    expect(redactSecrets(42)).toBe('42');
  });
});

describe('describeError (what a boot line may say)', () => {
  it('prints class and code, never the message', () => {
    const e = new Error(`connect ${FAKE_PG} failed`) as Error & { code: string };
    e.code = 'ECONNREFUSED';
    const line = describeError(e);
    expect(line).toBe('Error (ECONNREFUSED)');
    expect(line).not.toContain('fakepass');
    expect(line).not.toContain('connect');
  });

  it('keeps a Postgres SQLSTATE, which is the actually useful code', () => {
    const e = Object.assign(new Error('password authentication failed for user "klass"'),
      { name: 'PostgresError', sqlstate: '28P01' });
    expect(describeError(e)).toContain('28P01');
    expect(describeError(e)).toContain('PostgresError');
  });

  it('looks inside an AggregateError (where ECONNREFUSED usually hides)', () => {
    const agg = Object.assign(new Error('all connections failed'),
      { name: 'AggregateError', errors: [{ code: 'ECONNREFUSED' }, { code: 'ECONNREFUSED' }] });
    expect(describeError(agg)).toBe('AggregateError (ECONNREFUSED)');
  });

  it('survives values that are not errors at all', () => {
    expect(describeError(undefined)).toBe('undefined');
    expect(describeError('boom')).toBe('string');
    expect(describeError({ name: 'LiveKitError', status: 412 })).toContain('412');
  });

  /**
   * Measured shape (drizzle over postgres-js, fictitious URL): the thrown object is a
   * `DrizzleQueryError` whose own `name` is the plain string "Error", with no code — the network
   * code lives on `.cause`. Without walking one level down, a boot line says only "Error".
   */
  it('takes the class from the constructor and the code from the cause chain', () => {
    class DrizzleQueryError extends Error {
      constructor(message: string, readonly override cause?: unknown) { super(message); }
    }
    const inner = Object.assign(new Error(`connect ${FAKE_PG} failed`), { code: 'ENOTFOUND' });
    const thrown = new DrizzleQueryError('Failed query: CREATE SCHEMA "drizzle"\nparams: ', inner);
    const line = describeError(thrown);
    expect(line).toBe('DrizzleQueryError (ENOTFOUND)');
    expect(line).not.toContain('CREATE SCHEMA');
    expect(line).not.toContain('fakepass');
  });
});

describe('safeErrorMessage (what the logger may write about an error)', () => {
  it('drops drizzle\'s bound parameters, keeps the query', () => {
    const msg = 'Failed query: insert into chat_messages (text) values ($1)\nparams: pupil@example.invalid, Привет как дела';
    const out = safeErrorMessage(new Error(msg));
    expect(out).toContain('Failed query');
    expect(out, 'the bound values are somebody\'s data, not diagnosis').not.toContain('pupil@example.invalid');
    expect(out).not.toContain('Привет как дела');
    expect(out).not.toContain('params');
  });

  it('still cuts credential shapes that sit before the params marker', () => {
    expect(safeErrorMessage(new Error(`connect ${FAKE_PG} failed\nparams: 1`))).not.toContain('fakepass');
    expect(safeErrorMessage(`Bearer ${FAKE_BEARER}`)).not.toContain(FAKE_BEARER);
  });
});

/**
 * Again the rule from the access-log audit: assert on what the LOGGER writes, not on the helper.
 * `accessLogOptions` is the object the server hands Fastify, so this is the real pipeline.
 */
describe('the err serializer in accessLogOptions', () => {
  const serializeThroughPino = (err: unknown): string => {
    const lines: string[] = [];
    const logger = pino(accessLogOptions, { write: (s: string) => { lines.push(String(s)); } });
    logger.error({ err }, 'unhandled error');
    return lines.join('');
  };

  it('writes class, code and a redacted message', () => {
    const e = new Error(`connect ${FAKE_PG} failed`) as Error & { code: string };
    e.code = 'ECONNREFUSED';
    e.stack = `Error: connect ${FAKE_PG} failed\n    at boot (server.ts:100:3)`;
    const out = serializeThroughPino(e);
    expect(out).not.toContain('fakepass');
    expect(out).not.toContain('db.example.invalid');
    // the first line of a stack repeats the message, so the stack must be redacted too…
    expect(out.match(/\[redacted\]/g)?.length ?? 0, '…and it appears in message and stack').toBeGreaterThanOrEqual(2);
    // …while the frames themselves stay: they are not the secret, and without them a 500 is useless
    expect(out).toContain('server.ts:100');
    expect(out).toContain('unhandled error');
    expect(out).toContain('ECONNREFUSED');
  });

  it('redacts a bot token that grammY put into the message', () => {
    const out = serializeThroughPino(new Error(`401: Unauthorized, request to ${FAKE_BOT_URL} failed`));
    expect(out).not.toContain(FAKE_BOT_TOKEN);
    expect(out).toContain('Unauthorized');
  });

  it('writes a failing query without its bound parameters', () => {
    const out = serializeThroughPino(new Error(
      'Failed query: select * from users where email = $1\nparams: pupil@example.invalid',
    ));
    expect(out).toContain('Failed query');
    expect(out, 'the parameters are the pupil\'s data, not a diagnostic').not.toContain('pupil@example.invalid');
  });

  it('is wired under the key pino actually reads', () => {
    // the bug class this file exists for: a serializer registered as `errr`/`error` is ignored
    const serializers = accessLogOptions.serializers as Record<string, unknown>;
    expect(typeof serializers.err).toBe('function');
    expect(typeof serializers.req).toBe('function');
    expect(serializers).not.toHaveProperty('request');
    expect(serializers).not.toHaveProperty('error');
  });
});
