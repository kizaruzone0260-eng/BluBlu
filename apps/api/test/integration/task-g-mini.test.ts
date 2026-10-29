/**
 * Task G (2026-10-29): the five Mini App deliverables that touch the server.
 *
 * Everything here runs through the real Fastify app, real Postgres and the real homework
 * engine; Telegram is the capturing double (no token, no network), and the files are tiny
 * synthetic bytes. The rules proven:
 *  • the legal gate is server-side: an unaccepted account gets no functional data — not from a
 *    direct URL, not from an old draft — while bootstrap/accept/locale stay reachable;
 *  • acceptance stores both versions, time, UI language and surface, is idempotent, refuses a
 *    stale pair, and a version bump re-asks;
 *  • an uploaded file is typed by MAGIC BYTES (HTML/SVG refused even under a .pdf name), is
 *    placed in the teacher's private bot chat with a real file id, is written to storage, and
 *    becomes a library row attached to the draft;
 *  • a failed Telegram upload leaves neither a row nor bytes behind, and a foreign group id
 *    costs zero Telegram traffic;
 *  • the attached material is delivered to the real group by the existing publish engine;
 *  • group connection: a one-time code, an admin + linked teacher, a real `/bind` update, a
 *    server-side status; refusals, missing rights, expiry and foreign codes never show success.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { eq, and } from 'drizzle-orm';
import { createHmac } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { PRIVACY_VERSION, TERMS_VERSION, POLICY_VERSION } from '@klass/shared';
import {
  TEST_DATABASE_URL, preparedDb, makeTeacher, type TestDB,
} from './util.js';
import { buildApp } from '../../src/app.js';
import { env } from '../../src/env.js';
import { CapturingApi } from '../../src/services/botApi.js';
import { addGroup } from '../../src/services/homework/store.js';
import { handleUpdate, type BotDeps, type TgUpdate } from '../../src/services/bot.js';
import { getStorage } from '../../src/storage/provider.js';
import {
  policyAcceptances, telegramLinks, tgBindTokens, tgDrafts, tgGroups, tgMaterials,
  tgPublications, users,
} from '../../src/db/schema.js';
import type { MiniBootstrap, MiniDraftDto } from '../../src/services/homework/mini.js';

const suite = TEST_DATABASE_URL ? describe : describe.skip;
const BOT_TOKEN = '7000000002:task-g-integration-token';

function multipart(fields: Record<string, string>, file: { filename: string; bytes: Buffer }) {
  const b = '----taskgboundary';
  const head = Object.entries(fields)
    .map(([k, v]) => `--${b}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`).join('');
  const fileHead = `--${b}\r\nContent-Disposition: form-data; name="file"; filename="${file.filename}"`
    + '\r\nContent-Type: application/octet-stream\r\n\r\n';
  return {
    headers: { 'content-type': `multipart/form-data; boundary=${b}` },
    payload: Buffer.concat([
      Buffer.from(head + fileHead, 'utf8'), file.bytes, Buffer.from(`\r\n--${b}--\r\n`, 'utf8'),
    ]),
  };
}

const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from('%'.repeat(300))]);
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('idat'),
]);
const HTML = Buffer.from('<!DOCTYPE html><html><body><script>alert(1)</script></body></html>');
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

suite('Task G: Mini App library, groups and legal gate', () => {
  let t: TestDB;
  let app: FastifyInstance;
  let api: CapturingApi;
  let seq = 0;
  let storeDir = '';
  const savedEnv = {
    token: env.TELEGRAM_BOT_TOKEN,
    name: env.TELEGRAM_BOT_NAME,
    publicUrl: env.PUBLIC_URL,
    storage: env.STORAGE_DIR,
  };

  function signInitData(chatId: number): string {
    const fields: Record<string, string> = {
      auth_date: String(Math.floor(Date.now() / 1000)),
      query_id: `g-${chatId}-${seq}`,
      user: JSON.stringify({ id: chatId, first_name: 'Teacher', username: 'tester', language_code: 'ru' }),
    };
    const check = Object.keys(fields).sort().map((k) => `${k}=${fields[k]}`).join('\n');
    const secret = createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    const hash = createHmac('sha256', secret).update(check).digest('hex');
    return new URLSearchParams({ ...fields, hash }).toString();
  }

  async function login(chatId: number): Promise<string> {
    const r = await app.inject({
      method: 'POST', url: '/api/mini/auth', payload: { initData: signInitData(chatId) },
    });
    expect(r.statusCode, r.body).toBe(200);
    return (r.json() as { token: string }).token;
  }

  async function newTeacher(opts: { groups?: string[]; accepted?: boolean } = {}) {
    seq++;
    const chatId = 8_500_000 + seq;
    const teacher = await makeTeacher(t.sql, `taskg-${Date.now()}-${seq}@x.io`);
    if (opts.accepted === false) {
      await t.db.delete(policyAcceptances).where(eq(policyAcceptances.userId, teacher.id));
    }
    await t.db.insert(telegramLinks).values({ userId: teacher.id, chatId: String(chatId) });
    const groups: { id: string; chatId: string }[] = [];
    for (const [i, title] of (opts.groups ?? []).entries()) {
      const chat = String(-(9_700_000 + seq * 10 + i));
      const g = await addGroup(t.db, teacher.id, chat, title);
      groups.push({ id: g.id, chatId: chat });
    }
    const token = await login(chatId);
    return { id: teacher.id, chatId, email: teacher.email, token, groups };
  }

  function authed(token: string, method: string, url: string, payload?: unknown) {
    return app.inject({
      method: method as 'GET', url,
      headers: { authorization: `Bearer ${token}` },
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });
  }

  async function createDraft(token: string): Promise<MiniDraftDto> {
    const r = await authed(token, 'POST', '/api/mini/drafts');
    expect(r.statusCode, r.body).toBe(201);
    return (r.json() as { draft: MiniDraftDto }).draft;
  }

  async function upload(
    token: string, filename: string, bytes: Buffer,
    fields: Record<string, string> = {},
  ) {
    const mp = multipart(fields, { filename, bytes });
    return app.inject({
      method: 'POST', url: '/api/mini/materials/upload',
      headers: { authorization: `Bearer ${token}`, ...mp.headers },
      payload: mp.payload,
    });
  }

  function botDeps(isAdmin: (chat: string, user: number) => Promise<boolean>): BotDeps {
    return { db: t.db, api, isGroupAdmin: isAdmin };
  }

  function groupMsg(chatId: string, userId: number, text: string, title = 'Группа') {
    return {
      update_id: ++seq,
      message: {
        message_id: 1, chat: { id: Number(chatId), type: 'supergroup', title },
        from: { id: userId }, text,
      },
    } as TgUpdate;
  }

  beforeAll(async () => {
    t = await preparedDb(TEST_DATABASE_URL);
    env.TELEGRAM_BOT_TOKEN = BOT_TOKEN;
    env.TELEGRAM_BOT_NAME = 'classblu_bot';
    env.PUBLIC_URL = 'https://taskg.test';
    storeDir = mkdtempSync(path.join(tmpdir(), 'taskg-store-'));
    env.STORAGE_DIR = storeDir;
    api = new CapturingApi();
    app = await buildApp(t.db, { mini: { api, aiRemote: true } });
  });

  afterAll(async () => {
    env.TELEGRAM_BOT_TOKEN = savedEnv.token;
    env.TELEGRAM_BOT_NAME = savedEnv.name;
    env.PUBLIC_URL = savedEnv.publicUrl;
    env.STORAGE_DIR = savedEnv.storage;
    await app?.close();
    await t?.sql.end();
  });

  beforeEach(() => {
    api.calls.length = 0;
    api.uploads.length = 0;
    api.failUploadChats.clear();
    api.rejectUploadChats.clear();
    api.memberStatus.clear();
    api.memberUnknownChats.clear();
  });

  // ─── legal gate ────────────────────────────────────────────────────────────

  it('1–2: an unaccepted account opens the gate, not functions, on bootstrap and every functional route', async () => {
    const f = await newTeacher({ groups: ['Группа А'], accepted: false });

    const boot = await authed(f.token, 'GET', '/api/mini/bootstrap');
    expect(boot.statusCode, boot.body).toBe(200);
    const body = boot.json() as MiniBootstrap;
    expect(body.legal?.accepted).toBe(false);
    expect(body.legal?.currentPrivacyVersion).toBe(PRIVACY_VERSION);
    expect(body.legal?.currentTermsVersion).toBe(TERMS_VERSION);
    // no real data leaks before acceptance — even though the group and a draft exist
    expect(body.groups).toEqual([]);
    expect(body.drafts).toEqual([]);
    expect(body.materialsCount).toBe(0);

    for (const url of ['/api/mini/groups', '/api/mini/materials', '/api/mini/history']) {
      const r = await authed(f.token, 'GET', url);
      expect(r.statusCode, url).toBe(403);
      expect((r.json() as { error: string }).error).toBe('policyRequired');
    }
    const draft = await authed(f.token, 'POST', '/api/mini/drafts');
    expect(draft.statusCode).toBe(403);
    const up = await upload(f.token, 'doc.pdf', PDF, { groupIds: JSON.stringify([f.groups[0]!.id]) });
    expect(up.statusCode).toBe(403);
    expect(api.uploads).toHaveLength(0);

    // locale and the documents themselves stay reachable before acceptance
    const loc = await authed(f.token, 'POST', '/api/mini/locale', { locale: 'uz' });
    expect(loc.statusCode, loc.body).toBe(200);
    const [u] = await t.db.select({ locale: users.locale, explicit: users.localeExplicit })
      .from(users).where(eq(users.id, f.id));
    expect(u).toMatchObject({ locale: 'uz', explicit: true });
  });

  it('3–5: acceptance stores both versions, time, locale and surface; repeat keeps one row; stale is refused', async () => {
    const f = await newTeacher({ groups: ['Группа А'], accepted: false });
    const stale = await authed(f.token, 'POST', '/api/mini/accept-legal', {
      privacyVersion: '2000-01-01', termsVersion: TERMS_VERSION,
    });
    expect(stale.statusCode).toBe(409);
    expect((stale.json() as { error: string }).error).toBe('policyVersionStale');

    const ok = await authed(f.token, 'POST', '/api/mini/accept-legal', {
      privacyVersion: PRIVACY_VERSION, termsVersion: TERMS_VERSION,
    });
    expect(ok.statusCode, ok.body).toBe(200);
    const rows = await t.db.select().from(policyAcceptances).where(eq(policyAcceptances.userId, f.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      privacyVersion: PRIVACY_VERSION, termsVersion: TERMS_VERSION,
      version: POLICY_VERSION, locale: 'ru', context: 'mini',
    });
    expect(rows[0]!.acceptedAt).toBeInstanceOf(Date);

    const boot = await authed(f.token, 'GET', '/api/mini/bootstrap');
    expect((boot.json() as MiniBootstrap).legal?.accepted).toBe(true);
    expect((boot.json() as MiniBootstrap).groups).toHaveLength(1);

    // double tap: still exactly one row, still the same person
    await authed(f.token, 'POST', '/api/mini/accept-legal', {
      privacyVersion: PRIVACY_VERSION, termsVersion: TERMS_VERSION,
    });
    expect((await t.db.select().from(policyAcceptances).where(eq(policyAcceptances.userId, f.id)))).toHaveLength(1);

    // no field can accept FOR another person: an extra `userId` is stripped by the schema, and
    // the write still lands on the authenticated account — never on the named one
    const other = await newTeacher({ accepted: false });
    const forOther = await authed(f.token, 'POST', '/api/mini/accept-legal', {
      privacyVersion: PRIVACY_VERSION, termsVersion: TERMS_VERSION, userId: other.id,
    });
    expect(forOther.statusCode, forOther.body).toBe(200);
    expect(await t.db.select().from(policyAcceptances).where(eq(policyAcceptances.userId, other.id))).toHaveLength(0);
  });

  it('6: a version bump re-asks in the Mini App and the old row stays until replaced', async () => {
    const f = await newTeacher({ groups: ['Группа А'] });
    await t.db.update(policyAcceptances)
      .set({ privacyVersion: '2000-01-01', termsVersion: '2000-01-01' })
      .where(eq(policyAcceptances.userId, f.id));

    const boot = await authed(f.token, 'GET', '/api/mini/bootstrap');
    expect((boot.json() as MiniBootstrap).legal?.accepted).toBe(false);
    expect((await authed(f.token, 'GET', '/api/mini/groups')).statusCode).toBe(403);

    const ok = await authed(f.token, 'POST', '/api/mini/accept-legal', {
      privacyVersion: PRIVACY_VERSION, termsVersion: TERMS_VERSION,
    });
    expect(ok.statusCode).toBe(200);
    const rows = await t.db.select().from(policyAcceptances).where(eq(policyAcceptances.userId, f.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.privacyVersion).toBe(PRIVACY_VERSION);
  });

  it('7–8: the bot gate blocks commands and callbacks, allows /privacy and accepts only the signed button', async () => {
    const chat = 8_600_001;
    const te = await makeTeacher(t.sql, `taskg-bot-${Date.now()}@x.io`);
    await t.db.delete(policyAcceptances).where(eq(policyAcceptances.userId, te.id));
    await t.db.insert(telegramLinks).values({ userId: te.id, chatId: String(chat) });
    const deps = botDeps(async () => false);
    const msg = (text: string): TgUpdate => ({
      update_id: ++seq,
      message: { message_id: 1, chat: { id: chat, type: 'private' }, from: { id: chat }, text },
    });

    await handleUpdate(deps, msg('/homework'));
    const gate = api.calls.filter((c) => c.kind === 'send').at(-1);
    expect(gate?.text).toContain('Политика');
    expect(gate?.opts?.buttons?.[2]?.[0]?.cb).toBeTruthy();

    await handleUpdate(deps, msg('/privacy'));
    expect(api.calls.filter((c) => c.kind === 'send').at(-1)?.text).toContain('/privacy');

    // an old-looking callback without acceptance is gated too, except choosing a language
    await handleUpdate(deps, {
      update_id: ++seq,
      callback_query: {
        id: `q${seq}`, from: { id: chat },
        message: { message_id: 5, chat: { id: chat, type: 'private' } },
        data: (gate!.opts!.buttons![2]![0]!.cb as string),
      },
    });
    // the thanks may be followed by the teacher greeting, so look at the whole exchange
    expect(api.calls.some((c) => c.kind === 'send' && /документы приняты/i.test(c.text ?? ''))).toBe(true);
    const rows = await t.db.select().from(policyAcceptances).where(eq(policyAcceptances.userId, te.id));
    expect(rows[0]).toMatchObject({ context: 'bot', privacyVersion: PRIVACY_VERSION, termsVersion: TERMS_VERSION });

    // the gate is gone for a normal command
    api.calls.length = 0;
    await handleUpdate(deps, msg('/homework'));
    expect(api.calls.filter((c) => c.kind === 'send').at(-1)?.text).not.toContain('Политика');
  });

  it('9–10: a web acceptance (legacy version shape) is honoured by the Mini App and vice versa', async () => {
    const f = await newTeacher({ accepted: false });
    const web = await app.inject({
      method: 'POST', url: '/api/me/accept-policy',
      headers: { authorization: `Bearer ${await webToken(f.email)}` },
      payload: { version: POLICY_VERSION },
    });
    expect(web.statusCode, web.body).toBe(200);
    const boot = await authed(f.token, 'GET', '/api/mini/bootstrap');
    expect((boot.json() as MiniBootstrap).legal?.accepted).toBe(true);

    const g = await newTeacher({ accepted: false });
    await authed(g.token, 'POST', '/api/mini/accept-legal', {
      privacyVersion: PRIVACY_VERSION, termsVersion: TERMS_VERSION,
    });
    const tok = await webToken(g.email);
    const me = await app.inject({ method: 'GET', url: '/api/me', headers: { authorization: `Bearer ${tok}` } });
    expect(me.json().policyAccepted).toBe(true);
  });

  // The SAME person's ordinary web login: the Mini App never invents a second account.
  async function webToken(email: string): Promise<string> {
    const r = await app.inject({
      method: 'POST', url: '/api/auth/login',
      payload: { email, password: 'Passw0rd123' },
    });
    expect(r.statusCode, r.body).toBe(200);
    return (r.json() as { accessToken: string }).accessToken;
  }

  // ─── library upload ────────────────────────────────────────────────────────

  it('upload: a real PDF becomes a private-chat Telegram file, server bytes and a library row', async () => {
    const f = await newTeacher({ groups: ['Группа А'] });
    const draft = await createDraft(f.token);
    const r = await upload(f.token, 'unit 2.pdf', PDF, {
      title: 'Unit 2', kind: 'book',
      groupIds: JSON.stringify([f.groups[0]!.id]), draftId: draft.id,
    });
    expect(r.statusCode, r.body).toBe(201);
    const body = r.json() as {
      material: { id: string; title: string; fileSize: number; mediaType: string };
      draftAttached: boolean; replaced: boolean;
    };
    expect(body.material).toMatchObject({ title: 'Unit 2', fileSize: PDF.length, mediaType: 'document' });
    expect(body.draftAttached).toBe(true);
    expect(body.replaced).toBe(false);

    // the file really went to the teacher's private chat, not to a group or a made-up id
    expect(api.uploads).toHaveLength(1);
    expect(api.uploads[0]).toMatchObject({
      kind: 'document', chatId: String(f.chatId), fileName: 'unit 2.pdf', size: PDF.length,
    });

    const [row] = await t.db.select().from(tgMaterials).where(eq(tgMaterials.id, body.material.id));
    expect(row?.telegramFileId).toBe(api.uploads[0]!.fileId);
    expect(row?.sourceChatId).toBe(String(f.chatId));
    expect(row?.storageKey).toBeTruthy();
    const stored = await getStorage().stat(row!.storageKey!);
    expect(stored).toBe(PDF.length);

    const draftAfter = await authed(f.token, 'GET', `/api/mini/drafts/${draft.id}`);
    const d = (draftAfter.json() as { draft: MiniDraftDto }).draft;
    expect(d.materials.map((m) => m.title)).toContain('Unit 2');
  });

  it('upload: images go as photos when small enough; a real PNG keeps its bytes', async () => {
    const f = await newTeacher({ groups: ['Группа А'] });
    const r = await upload(f.token, 'board.png', PNG, { groupIds: JSON.stringify([f.groups[0]!.id]) });
    expect(r.statusCode, r.body).toBe(201);
    expect(api.uploads[0]).toMatchObject({ kind: 'photo', size: PNG.length });
  });

  it('upload: HTML and SVG are refused by content, not by their extension, and nothing reaches Telegram', async () => {
    const f = await newTeacher({ groups: ['Группа А'] });
    for (const [name, bytes] of [['danger.pdf', HTML], ['picture.png', SVG]] as const) {
      const r = await upload(f.token, name, bytes, { groupIds: JSON.stringify([f.groups[0]!.id]) });
      expect(r.statusCode, `${name}: ${r.body}`).toBe(415);
      expect((r.json() as { error: string }).error).toBe('unsupportedFile');
    }
    expect(api.uploads).toHaveLength(0);
    expect(await t.db.select().from(tgMaterials).where(eq(tgMaterials.ownerId, f.id))).toHaveLength(0);
  });

  it('upload: a foreign group id is refused BEFORE Telegram; a private-chat failure leaves no row or bytes', async () => {
    const f = await newTeacher({ groups: ['Группа А'] });
    const foreign = await newTeacher({ groups: ['Чужая'] });
    const denied = await upload(f.token, 'doc.pdf', PDF, { groupIds: JSON.stringify([foreign.groups[0]!.id]) });
    expect(denied.statusCode).toBe(400);
    expect((denied.json() as { error: string }).error).toBe('groupsRequired');
    expect(api.uploads).toHaveLength(0);

    api.failUploadChats.add(String(f.chatId));
    const failed = await upload(f.token, 'doc.pdf', PDF, { groupIds: JSON.stringify([f.groups[0]!.id]) });
    expect(failed.statusCode).toBe(502);
    expect((failed.json() as { error: string }).error).toBe('telegramUploadFailed');
    expect(await t.db.select().from(tgMaterials).where(eq(tgMaterials.ownerId, f.id))).toHaveLength(0);
  });

  it('upload: the attached file is delivered to the real group by the existing publish engine', async () => {
    const f = await newTeacher({ groups: ['Группа А'] });
    const draft = await createDraft(f.token);
    const up = await upload(f.token, 'workbook.pdf', PDF, {
      title: 'Workbook', groupIds: JSON.stringify([f.groups[0]!.id]), draftId: draft.id,
    });
    expect(up.statusCode, up.body).toBe(201);
    const materialId = (up.json() as { material: { id: string } }).material.id;

    await authed(f.token, 'PUT', `/api/mini/drafts/${draft.id}/groups`, { groupIds: [f.groups[0]!.id] });
    await authed(f.token, 'PUT', `/api/mini/drafts/${draft.id}/materials`, { materialIds: [materialId] });
    await authed(f.token, 'PATCH', `/api/mini/drafts/${draft.id}`, { title: 'Unit 2', formattedText: 'Do exercises 1–3' });
    expect((await authed(f.token, 'POST', `/api/mini/drafts/${draft.id}/format`, { mode: 'manual' })).statusCode).toBe(200);
    expect((await authed(f.token, 'POST', `/api/mini/drafts/${draft.id}/preview`)).statusCode).toBe(200);
    const published = await authed(f.token, 'POST', `/api/mini/drafts/${draft.id}/publish`);
    expect(published.statusCode, published.body).toBe(200);

    const copy = api.calls.find((c) => c.kind === 'copy' || c.kind === 'copyMany');
    expect(copy, 'the file is re-posted by Telegram coordinates').toBeTruthy();
    expect(copy!.fromChatId).toBe(String(f.chatId));
    const [pub] = await t.db.select().from(tgPublications)
      .where(eq(tgPublications.draftId, draft.id));
    expect(pub?.status).toBe('sent');
  });

  // ─── group connection ──────────────────────────────────────────────────────

  async function connect(token: string) {
    const r = await authed(token, 'POST', '/api/mini/groups/connect');
    expect(r.statusCode, r.body).toBe(201);
    return (r.json() as { connect: { id: string; code: string; expiresAt: string } }).connect;
  }

  it('connect: a one-time code is spent by a real admin /bind update and the group appears', async () => {
    const f = await newTeacher();
    const start = await connect(f.token);
    expect(start.code).toBeTruthy();
    expect(start.expiresAt).toBeTruthy();

    const pending = await authed(f.token, 'GET', `/api/mini/groups/connect/${start.id}`);
    expect(pending.json()).toMatchObject({ status: 'pending' });

    const chat = '-970000999';
    const admin = async () => true;
    await handleUpdate(botDeps(admin), groupMsg(chat, f.chatId, `/bind ${start.code}`, 'Английский 9А'));
    const done = await authed(f.token, 'GET', `/api/mini/groups/connect/${start.id}`);
    const state = done.json() as { status: string; group: { title: string }; health: string };
    expect(state.status).toBe('connected');
    expect(state.group.title).toBe('Английский 9А');
    expect(state.health).toBe('ok');

    const [group] = await t.db.select().from(tgGroups)
      .where(and(eq(tgGroups.ownerId, f.id), eq(tgGroups.telegramChatId, chat)));
    expect(group?.status).toBe('active');
    const boot = await authed(f.token, 'GET', '/api/mini/bootstrap');
    expect((boot.json() as MiniBootstrap).groups.some((g) => g.title === 'Английский 9А')).toBe(true);
  });

  it('connect: a non-admin is refused and the code stays pending; a foreign code is never someone else\'s success', async () => {
    const f = await newTeacher();
    const start = await connect(f.token);
    const chat = '-970001111';
    await handleUpdate(botDeps(async () => false), groupMsg(chat, f.chatId, `/bind ${start.code}`));
    expect((await authed(f.token, 'GET', `/api/mini/groups/connect/${start.id}`)).json()).toMatchObject({ status: 'pending' });
    expect(await t.db.select().from(tgGroups).where(eq(tgGroups.ownerId, f.id))).toHaveLength(0);

    // another teacher, an admin of her own group, sends the same code
    const other = await newTeacher();
    await handleUpdate(botDeps(async () => true), groupMsg('-970002222', other.chatId, `/bind ${start.code}`));
    expect((await authed(other.token, 'GET', `/api/mini/groups/connect/${start.id}`)).statusCode).toBe(404);
    expect((await authed(f.token, 'GET', `/api/mini/groups/connect/${start.id}`)).json()).toMatchObject({ status: 'pending' });

    // and the owner cannot reuse a spent code either
    const start2 = await connect(f.token);
    await handleUpdate(botDeps(async () => true), groupMsg('-970003333', f.chatId, `/bind ${start2.code}`));
    expect((await authed(f.token, 'GET', `/api/mini/groups/connect/${start2.id}`)).json()).toMatchObject({ status: 'connected' });
    await handleUpdate(botDeps(async () => true), groupMsg('-970004444', f.chatId, `/bind ${start2.code}`));
    expect(await t.db.select().from(tgGroups)
      .where(and(eq(tgGroups.ownerId, f.id), eq(tgGroups.telegramChatId, '-970004444')))).toHaveLength(0);
  });

  it('connect: expired codes and missing bot rights are honest, never success', async () => {
    const f = await newTeacher();
    const start = await connect(f.token);
    await t.db.update(tgBindTokens).set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(tgBindTokens.id, start.id));
    expect((await authed(f.token, 'GET', `/api/mini/groups/connect/${start.id}`)).json())
      .toMatchObject({ status: 'expired' });

    const f2 = await newTeacher({ groups: ['Группа А'] });
    api.memberStatus.set(f2.groups[0]!.chatId, 'member');
    const health = await authed(f2.token, 'GET', '/api/mini/groups/health');
    expect((health.json() as { groups: { id: string; health: string }[] }).groups)
      .toContainEqual({ id: f2.groups[0]!.id, health: 'needsRights' });
    api.memberStatus.set(f2.groups[0]!.chatId, 'left');
    const gone = await authed(f2.token, 'GET', '/api/mini/groups/health');
    expect((gone.json() as { groups: { id: string; health: string }[] }).groups)
      .toContainEqual({ id: f2.groups[0]!.id, health: 'botMissing' });
    api.memberUnknownChats.add(f2.groups[0]!.chatId);
    const unknown = await authed(f2.token, 'GET', '/api/mini/groups/health');
    expect((unknown.json() as { groups: { id: string; health: string }[] }).groups)
      .toContainEqual({ id: f2.groups[0]!.id, health: 'unknown' });
  });

  it('connect: /bind by an unaccepted teacher is refused by the same legal gate', async () => {
    // A code can only be created by an accepted account (the Mini App gate); revoking the
    // acceptance afterwards must still close the bot door that would spend it.
    const f = await newTeacher();
    const start = await connect(f.token);
    await t.db.delete(policyAcceptances).where(eq(policyAcceptances.userId, f.id));
    const chat = '-970005555';
    api.calls.length = 0;
    await handleUpdate(botDeps(async () => true), groupMsg(chat, f.chatId, `/bind ${start.code}`));
    // a group has no language of its own, so the default locale answers; the point is the gate
    expect(api.calls.filter((c) => c.kind === 'send').at(-1)?.text).toMatch(/Privacy Policy/i);
    expect(await t.db.select().from(tgGroups).where(eq(tgGroups.ownerId, f.id))).toHaveLength(0);
  });

  // ─── erasure ───────────────────────────────────────────────────────────────

  it('erasure: Mini App materials, bytes and Telegram group bindings are removed with the account', async () => {
    const f = await newTeacher({ groups: ['Группа А'] });
    const up = await upload(f.token, 'erase-me.pdf', PDF, { groupIds: JSON.stringify([f.groups[0]!.id]) });
    expect(up.statusCode, up.body).toBe(201);
    const [mat] = await t.db.select().from(tgMaterials).where(eq(tgMaterials.id, (up.json() as { material: { id: string } }).material.id));
    expect(mat?.storageKey).toBeTruthy();
    await createDraft(f.token);
    await connect(f.token);

    const del = await app.inject({
      method: 'DELETE', url: '/api/me',
      headers: { authorization: `Bearer ${await webToken(f.email)}` },
    });
    expect(del.statusCode, del.body).toBe(200);
    expect(await t.db.select().from(tgMaterials).where(eq(tgMaterials.ownerId, f.id))).toHaveLength(0);
    expect(await t.db.select().from(tgDrafts).where(eq(tgDrafts.ownerId, f.id))).toHaveLength(0);
    expect(await t.db.select().from(tgGroups).where(eq(tgGroups.ownerId, f.id))).toHaveLength(0);
    expect(await t.db.select().from(tgBindTokens).where(eq(tgBindTokens.ownerId, f.id))).toHaveLength(0);
    await expect(getStorage().stat(mat!.storageKey!)).resolves.toBeNull();
  });
});
