/**
 * Task F — the Telegram Mini App, end to end through the real Fastify app, real Postgres and the
 * real homework engine with a capturing Telegram transport.
 *
 * What is proven here (the product rules, not the implementation):
 *  • the only door is a SIGNED initData; the account comes from the existing `telegram_links`,
 *    never from the request body, and a linked student / an unlinked chat gets a precise answer;
 *  • the session minted for the Mini App is not accepted by the regular API and vice versa;
 *  • unlinking the Telegram account revokes the session on the very next request;
 *  • the teacher sees only her own ACTIVE groups, with real counts and statuses;
 *  • draft data is isolated per teacher; a foreign group/material is refused on the server;
 *  • the library's «recommended for EVERY selected group» rule holds, and changing groups
 *    reports exactly which chosen books were dropped;
 *  • the formatter receives text, titles and link URLs — never a file, its id or its bytes;
 *  • a weak/failed model cannot lose the teacher's wording: the original is appended verbatim
 *    with a warning, and an AI error returns the local fallback WITHOUT writing anything;
 *  • nothing is sent before an explicit publish on a draft in `preview`; the draft needs groups
 *    and actual content;
 *  • publication goes through the existing engine: one row per group, per-part outcomes,
 *    per-group partial success, idempotent duplicate publish;
 *  • retry touches only definite failures; an uncertain outcome is never retried;
 *  • a group that is no longer the teacher's active group stops the publish before any send;
 *  • the per-teacher publish budget answers 429 without touching Telegram;
 *  • the bot keeps working: `/start` and `/mini` carry a `web_app` button on https, `/homework`
 *    still opens its screen, and an http deployment honestly says the Mini App needs HTTPS;
 *  • `/mini` is the one document allowed to load the Telegram SDK and be framed by Telegram;
 *    every other page keeps the strict policy.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { eq, and } from 'drizzle-orm';
import { createHmac } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { TEST_DATABASE_URL, preparedDb, makeTeacher, acceptPolicy, type TestDB } from './util.js';
import { buildApp } from '../../src/app.js';
import { env } from '../../src/env.js';
import { CapturingApi } from '../../src/services/botApi.js';
import {
  addGroup, createDraft, getDraft,
} from '../../src/services/homework/store.js';
import { saveMaterial } from '../../src/services/homework/libraryStore.js';
import { TEACHER_COMMANDS } from '../../src/services/botApi.js';
import { handleUpdate, type BotDeps, type TgUpdate } from '../../src/services/bot.js';
import { hashPassword } from '../../src/lib/password.js';
import {
  auditLog, telegramLinks, tgDrafts, tgGroups, tgPublications, users,
} from '../../src/db/schema.js';
import type {
  MiniBootstrap, MiniDraftDto, MiniPublishResult,
} from '../../src/services/homework/mini.js';
import type { HwAiRequest, HwAiResult, HomeworkAi } from '../../src/services/homework/types.js';

const suite = TEST_DATABASE_URL ? describe : describe.skip;
const BOT_TOKEN = '7000000001:mini-app-integration-token';

class FakeAi implements HomeworkAi {
  requests: HwAiRequest[] = [];
  failNext = false;
  result: HwAiResult = {
    status: 'ok',
    title: 'Дроби',
    // Deliberately drops the instruction, the link and the material title — finalizeFormatted
    // must append all three verbatim, and the teacher must see why.
    formatted: 'ДОМАШНЕЕ ЗАДАНИЕ\n\nстр. 42',
    questions: ['Проверить № 7?'],
    warnings: [],
    provider: 'test-fake',
  };

  async format(req: HwAiRequest): Promise<HwAiResult> {
    this.requests.push(req);
    if (this.failNext) {
      this.failNext = false;
      throw new Error('fictitious formatter is down');
    }
    return this.result;
  }
}

suite('Telegram Mini App', () => {
  let t: TestDB;
  let app: FastifyInstance;
  let api: CapturingApi;
  let ai: FakeAi;
  let seq = 0;
  let distDir = '';
  const savedEnv = {
    token: env.TELEGRAM_BOT_TOKEN,
    name: env.TELEGRAM_BOT_NAME,
    publicUrl: env.PUBLIC_URL,
    webDist: env.WEB_DIST,
  };

  // ─── launch signing (independent of the code under test) ───────────────────

  function signInitData(chatId: number, opts: {
    token?: string; authDate?: number; user?: unknown;
  } = {}): string {
    const fields: Record<string, string> = {
      auth_date: String(opts.authDate ?? Math.floor(Date.now() / 1000)),
      query_id: `q-${chatId}-${seq}`,
      user: JSON.stringify(opts.user ?? {
        id: chatId, first_name: 'Teacher', username: 'tester', language_code: 'ru',
      }),
    };
    const check = Object.keys(fields).sort().map((k) => `${k}=${fields[k]}`).join('\n');
    const secret = createHmac('sha256', 'WebAppData')
      .update(opts.token ?? BOT_TOKEN).digest();
    const hash = createHmac('sha256', secret).update(check).digest('hex');
    return new URLSearchParams({ ...fields, hash }).toString();
  }

  // ─── fixtures ──────────────────────────────────────────────────────────────

  async function login(chatId: number): Promise<string> {
    const r = await app.inject({
      method: 'POST', url: '/api/mini/auth', payload: { initData: signInitData(chatId) },
    });
    expect(r.statusCode, r.body).toBe(200);
    return (r.json() as { token: string }).token;
  }

  interface Fixture {
    id: string;
    chatId: number;
    token: string;
    groups: { id: string; title: string; chatId: number }[];
  }

  async function newTeacher(opts: {
    locale?: string; groups?: string[]; mustChangePassword?: boolean;
  } = {}): Promise<Fixture> {
    seq++;
    const chatId = 8_100_000 + seq;
    const teacher = await makeTeacher(t.sql, `mini-${Date.now()}-${seq}@x.io`);
    if (opts.locale) {
      await t.db.update(users).set({ locale: opts.locale }).where(eq(users.id, teacher.id));
    }
    if (opts.mustChangePassword) {
      await t.db.update(users).set({ mustChangePassword: true }).where(eq(users.id, teacher.id));
    }
    await t.db.insert(telegramLinks).values({ userId: teacher.id, chatId: String(chatId) });
    const groups: Fixture['groups'] = [];
    for (const [i, title] of (opts.groups ?? []).entries()) {
      const groupChat = -(9_100_000 + seq * 10 + i);
      const g = await addGroup(t.db, teacher.id, String(groupChat), title);
      groups.push({ id: g.id, title, chatId: groupChat });
    }
    const token = opts.mustChangePassword ? '' : await login(chatId);
    return { id: teacher.id, chatId, token, groups };
  }

  async function addMaterial(ownerId: string, groupIds: string[], opts: {
    title: string; unique: string; fileName?: string; sourceChatId?: string; sourceMessageId?: number;
  }) {
    const r = await saveMaterial(t.db, ownerId, {
      title: opts.title,
      kind: 'book',
      fileId: `file-${opts.unique}`,
      fileUniqueId: `uniq-${opts.unique}`,
      fileName: opts.fileName ?? `${opts.unique}.pdf`,
      mimeType: 'application/pdf',
      fileSize: 4_096,
      groupIds,
      mediaType: 'document',
      sourceChatId: opts.sourceChatId ?? null,
      sourceMessageId: opts.sourceMessageId ?? null,
    });
    if (r.status !== 'created' && r.status !== 'updated') {
      throw new Error(`material fixture failed: ${r.status}`);
    }
    return r.row;
  }

  function authed(token: string | null, method: string, url: string, payload?: unknown) {
    return app.inject({
      method: method as 'GET',
      url,
      headers: token ? { authorization: `Bearer ${token}` } : {},
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });
  }

  async function newDraft(token: string): Promise<MiniDraftDto> {
    const r = await authed(token, 'POST', '/api/mini/drafts');
    expect(r.statusCode, r.body).toBe(201);
    return (r.json() as { draft: MiniDraftDto }).draft;
  }

  async function setGroups(token: string, id: string, ids: string[]) {
    return authed(token, 'PUT', `/api/mini/drafts/${id}/groups`, { groupIds: ids });
  }

  async function patchDraft(token: string, id: string, body: Record<string, unknown>) {
    return authed(token, 'PATCH', `/api/mini/drafts/${id}`, body);
  }

  async function format(token: string, id: string, mode: 'ai' | 'manual') {
    return authed(token, 'POST', `/api/mini/drafts/${id}/format`, { mode });
  }

  async function preview(token: string, id: string) {
    return authed(token, 'POST', `/api/mini/drafts/${id}/preview`);
  }

  async function publish(token: string, id: string): Promise<MiniPublishResult> {
    const r = await authed(token, 'POST', `/api/mini/drafts/${id}/publish`);
    expect(r.statusCode, r.body).toBe(200);
    return r.json() as MiniPublishResult;
  }

  async function retry(token: string, id: string): Promise<MiniPublishResult> {
    const r = await authed(token, 'POST', `/api/mini/drafts/${id}/retry`);
    expect(r.statusCode, r.body).toBe(200);
    return r.json() as MiniPublishResult;
  }

  const pubsOf = (draftId: string) =>
    t.db.select().from(tgPublications).where(eq(tgPublications.draftId, draftId));

  const draftRow = async (id: string) => {
    const [row] = await t.db.select().from(tgDrafts).where(eq(tgDrafts.id, id));
    return row!;
  };

  const callsTo = (chatId: number) => api.calls.filter((c) => c.chatId === String(chatId));

  /** A draft that is ready to be confirmed: groups + instruction, formatted, in `preview`. */
  async function readyDraft(f: Fixture, extra: {
    instruction?: string; groups?: string[]; materials?: string[];
  } = {}): Promise<MiniDraftDto> {
    const draft = await newDraft(f.token);
    const groupIds = extra.groups ?? f.groups.map((g) => g.id);
    expect((await setGroups(f.token, draft.id, groupIds)).statusCode).toBe(200);
    const patch = await patchDraft(f.token, draft.id, {
      title: 'Дроби',
      instruction: extra.instruction ?? 'Реши № 7 на стр. 42',
      links: [{ url: 'https://example.com/lesson-7', label: 'Конспект' }],
    });
    expect(patch.statusCode, patch.body).toBe(200);
    if (extra.materials?.length) {
      const put = await authed(f.token, 'PUT', `/api/mini/drafts/${draft.id}/materials`, {
        materialIds: extra.materials,
      });
      expect(put.statusCode, put.body).toBe(200);
    }
    const fmt = await format(f.token, draft.id, 'manual');
    expect(fmt.statusCode, fmt.body).toBe(200);
    const p = await preview(f.token, draft.id);
    expect(p.statusCode, p.body).toBe(200);
    return (p.json() as { draft: MiniDraftDto }).draft;
  }

  // ─── lifecycle ─────────────────────────────────────────────────────────────

  beforeAll(async () => {
    t = await preparedDb(TEST_DATABASE_URL);
    env.TELEGRAM_BOT_TOKEN = BOT_TOKEN;
    env.TELEGRAM_BOT_NAME = 'classblu_bot';
    env.PUBLIC_URL = 'https://mini.test';
    distDir = mkdtempSync(path.join(tmpdir(), 'mini-dist-'));
    writeFileSync(path.join(distDir, 'index.html'), '<!doctype html><title>t</title><p>shell</p>');
    env.WEB_DIST = distDir;
    api = new CapturingApi();
    ai = new FakeAi();
    app = await buildApp(t.db, { mini: { api, ai, aiRemote: true } });
  });

  afterAll(async () => {
    env.TELEGRAM_BOT_TOKEN = savedEnv.token;
    env.TELEGRAM_BOT_NAME = savedEnv.name;
    env.PUBLIC_URL = savedEnv.publicUrl;
    env.WEB_DIST = savedEnv.webDist;
    await app?.close();
    await t?.sql.end();
  });

  beforeEach(() => {
    api.calls.length = 0;
    api.failChats.clear();
    api.rejectChats.clear();
    api.failCopyChats.clear();
    api.missingFiles.clear();
    api.missingSources.clear();
    ai.requests.length = 0;
    ai.failNext = false;
  });

  // ─── 1. the door ──────────────────────────────────────────────────────────

  it('opens only with a signed launch, and the account comes from the existing Telegram link', async () => {
    const f = await newTeacher({ groups: ['Группа А'] });
    const body = signInitData(f.chatId);
    const r = await app.inject({
      method: 'POST', url: '/api/mini/auth', payload: { initData: body },
    });
    expect(r.statusCode).toBe(200);
    const auth = r.json() as {
      token: string; expiresAt: string;
      teacher: { id: string; name: string; locale: string; tz: string };
      bot: { username: string | null };
    };
    expect(auth.teacher.id).toBe(f.id);
    expect(auth.teacher.locale).toBe('ru');
    expect(auth.teacher.tz).toBe('Asia/Tashkent');
    expect(auth.bot.username).toBe('classblu_bot');
    expect(auth.token.split('.')).toHaveLength(3);
    // 8h, not the regular 15m and not forever
    expect(new Date(auth.expiresAt).getTime() - Date.now()).toBeGreaterThan(7.9 * 3600_000);
    // the raw launch and the bot token never come back in the answer
    expect(r.body).not.toContain(BOT_TOKEN);
    expect(r.body).not.toContain('first_name');

    // the identity is read from the SIGNED user, not from a second field a client could set
    const forged = await app.inject({
      method: 'POST', url: '/api/mini/auth',
      payload: { initData: body, userId: f.id, role: 'teacher' },
    });
    expect(forged.statusCode).toBe(200); // extra body fields are ignored, not trusted
    expect((forged.json() as { teacher: { id: string } }).teacher.id).toBe(f.id);

    // the audit trail names the login without carrying the launch
    const deadline = Date.now() + 3000;
    for (;;) {
      const rows = await t.db.select().from(auditLog)
        .where(and(eq(auditLog.actorId, f.id), eq(auditLog.action, 'mini_login')));
      if (rows.length) {
        expect(JSON.stringify(rows)).not.toContain('query_id');
        break;
      }
      if (Date.now() > deadline) throw new Error('no mini_login audit row');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  });

  it('refuses a tampered/expired launch, an unlinked chat, a student and a forced password change', async () => {
    const f = await newTeacher({ groups: ['Группа А'] });
    const good = new URLSearchParams(signInitData(f.chatId));
    good.set('auth_date', String(Number(good.get('auth_date')) - 60));
    const tampered = await app.inject({
      method: 'POST', url: '/api/mini/auth', payload: { initData: good.toString() },
    });
    expect(tampered.statusCode).toBe(401);
    expect((tampered.json() as { error: string }).error).toBe('invalidInitData');

    const old = await app.inject({
      method: 'POST', url: '/api/mini/auth',
      payload: { initData: signInitData(f.chatId, { authDate: Math.floor(Date.now() / 1000) - 25 * 3600 }) },
    });
    expect(old.statusCode).toBe(401);

    const unlinked = await app.inject({
      method: 'POST', url: '/api/mini/auth',
      payload: { initData: signInitData(7_777_777) },
    });
    expect(unlinked.statusCode).toBe(403);
    expect((unlinked.json() as { error: string }).error).toBe('miniNotLinked');

    seq++;
    const studentChat = 8_200_000 + seq;
    const [student] = await t.db.insert(users).values({
      role: 'student', name: 'Ученица', email: `mini-student-${Date.now()}@x.io`,
      passwordHash: await hashPassword('Secret1234'), locale: 'ru', localeExplicit: true,
      profileCompletedAt: new Date(),
    }).returning();
    await t.db.insert(telegramLinks).values({ userId: student!.id, chatId: String(studentChat) });
    const asStudent = await app.inject({
      method: 'POST', url: '/api/mini/auth',
      payload: { initData: signInitData(studentChat) },
    });
    expect(asStudent.statusCode).toBe(403);
    expect((asStudent.json() as { error: string }).error).toBe('miniTeacherOnly');

    seq++;
    const pwChat = 8_300_000 + seq;
    const pwTeacher = await makeTeacher(t.sql, `mini-pw-${Date.now()}-${seq}@x.io`);
    await t.db.update(users).set({ mustChangePassword: true }).where(eq(users.id, pwTeacher.id));
    await t.db.insert(telegramLinks).values({ userId: pwTeacher.id, chatId: String(pwChat) });
    const asPw = await app.inject({
      method: 'POST', url: '/api/mini/auth', payload: { initData: signInitData(pwChat) },
    });
    expect(asPw.statusCode).toBe(403);
    expect((asPw.json() as { error: string }).error).toBe('passwordChangeRequired');

    const malformed = await app.inject({
      method: 'POST', url: '/api/mini/auth', payload: { initData: '' },
    });
    expect(malformed.statusCode).toBe(400);
    expect((malformed.json() as { error: string }).error).toBe('invalidInput');
  });

  it('answers 503 honestly when the bot token is not configured, never a fake session', async () => {
    const f = await newTeacher({ groups: ['Группа А'] });
    env.TELEGRAM_BOT_TOKEN = '';
    try {
      const r = await app.inject({
        method: 'POST', url: '/api/mini/auth', payload: { initData: signInitData(f.chatId) },
      });
      expect(r.statusCode).toBe(503);
      expect((r.json() as { error: string }).error).toBe('miniUnavailable');
    } finally {
      env.TELEGRAM_BOT_TOKEN = BOT_TOKEN;
    }
  });

  it('keeps the Mini App session and the regular web session on separate keys', async () => {
    const f = await newTeacher({ groups: ['Группа А'] });

    const noToken = await app.inject({ method: 'GET', url: '/api/mini/bootstrap' });
    expect(noToken.statusCode).toBe(401);
    expect((noToken.json() as { error: string }).error).toBe('sessionExpired');

    const bogus = await authed('not-a-token', 'GET', '/api/mini/bootstrap');
    expect(bogus.statusCode).toBe(401);

    // a regular access token cannot enter the Mini App
    const regular = await app.inject({
      method: 'POST', url: '/api/auth/login',
      payload: { email: (await t.db.select().from(users).where(eq(users.id, f.id)))[0]!.email, password: 'Passw0rd123' },
    });
    expect(regular.statusCode).toBe(200);
    const access = (regular.json() as { accessToken: string }).accessToken;
    const withAccess = await authed(access, 'GET', '/api/mini/bootstrap');
    expect(withAccess.statusCode).toBe(401);

    // …and the Mini App token cannot read the regular API
    const me = await authed(f.token, 'GET', '/api/me');
    expect(me.statusCode).toBe(401);
  });

  it('revokes the session as soon as the Telegram account is unlinked', async () => {
    const f = await newTeacher({ groups: ['Группа А'] });
    expect((await authed(f.token, 'GET', '/api/mini/bootstrap')).statusCode).toBe(200);
    await t.db.delete(telegramLinks).where(eq(telegramLinks.userId, f.id));
    const r = await authed(f.token, 'GET', '/api/mini/bootstrap');
    expect(r.statusCode).toBe(401);
    expect((r.json() as { error: string }).error).toBe('sessionExpired');
  });

  // ─── 2. the teacher home ─────────────────────────────────────────────────

  it('shows only the teacher’s own ACTIVE groups with real counts and statuses', async () => {
    const f = await newTeacher({ groups: ['Группа А', 'Группа Б'] });
    const removed = await addGroup(t.db, f.id, '-9100999', 'Закрытая группа');
    await t.db.update(tgGroups).set({ status: 'removed' }).where(eq(tgGroups.id, removed.id));

    const foreign = await newTeacher({ groups: ['Чужая группа'] });
    await addMaterial(f.id, [f.groups[0]!.id], {
      title: 'Алгебра', unique: `boot-${seq}`, sourceChatId: String(f.chatId), sourceMessageId: 10,
    });
    // a bot-origin draft must not appear in the Mini App's «continue» list
    await createDraft(t.db, f.id, 'bot', 'collecting');
    const miniDraft = await newDraft(f.token);

    const r = await authed(f.token, 'GET', '/api/mini/bootstrap');
    expect(r.statusCode).toBe(200);
    const boot = r.json() as MiniBootstrap;

    expect(boot.groups.map((g) => g.title).sort()).toEqual(['Группа А', 'Группа Б']);
    for (const g of boot.groups) {
      expect(g.status).toBe('active');
      expect(g.chatShort).toMatch(/^…\d{4}$/);
    }
    expect(boot.groups.find((g) => g.title === 'Группа А')?.materialCount).toBe(1);
    expect(boot.groups.some((g) => g.title === 'Чужая группа')).toBe(false);
    expect(boot.groups.some((g) => g.title === 'Закрытая группа')).toBe(false);
    expect(boot.materialsCount).toBe(1);
    expect(boot.drafts.map((d) => d.id)).toEqual([miniDraft.id]);
    expect(boot.drafts[0]!.status).toBe('collecting');
    expect(boot.ai.remote).toBe(true);
    expect(boot.limits.groups).toBeGreaterThan(0);
    expect(foreign.id).not.toBe(f.id);

    const groupsOnly = await authed(f.token, 'GET', '/api/mini/groups');
    expect(groupsOnly.statusCode).toBe(200);
    expect((groupsOnly.json() as { groups: { title: string }[] }).groups).toHaveLength(2);

    const history = await authed(f.token, 'GET', '/api/mini/history');
    expect(history.statusCode).toBe(200);
    expect((history.json() as { drafts: { id: string }[] }).drafts[0]!.id).toBe(miniDraft.id);
  });

  // ─── 3. the editor ──────────────────────────────────────────────────────

  it('validates fields, keeps links exact and refuses a foreign draft without leaking it', async () => {
    const f = await newTeacher({ groups: ['Группа А'] });
    const other = await newTeacher({ groups: ['Группа Другая'] });
    const draft = await newDraft(f.token);

    const bad = await patchDraft(f.token, draft.id, {
      links: [{ url: 'javascript:alert(1)' }],
    });
    expect(bad.statusCode).toBe(400);
    expect((bad.json() as { error: string }).error).toBe('invalidInput');

    const tooMany = await patchDraft(f.token, draft.id, {
      links: Array.from({ length: 6 }, (_, i) => ({ url: `https://e.com/${i}` })),
    });
    expect(tooMany.statusCode).toBe(400);

    const badDate = await patchDraft(f.token, draft.id, { dueAt: 'not-a-date' });
    expect(badDate.statusCode).toBe(400);

    const ok = await patchDraft(f.token, draft.id, {
      title: '  Дроби  ',
      instruction: 'Реши № 7\nи № 8',
      dueAt: '2026-11-01T15:00:00.000Z',
      links: [
        { url: 'https://example.com/a?x=1&y=2', label: 'Конспект' },
        { url: 'https://example.com/b', label: '' },
      ],
    });
    expect(ok.statusCode, ok.body).toBe(200);
    const saved = (ok.json() as { draft: MiniDraftDto }).draft;
    expect(saved.title).toBe('Дроби');
    expect(saved.instruction).toBe('Реши № 7\nи № 8');
    expect(saved.dueAt).toBe('2026-11-01T15:00:00.000Z');
    expect(saved.links.map((l) => l.url)).toEqual([
      'https://example.com/a?x=1&y=2', 'https://example.com/b',
    ]);
    expect(saved.links[0]!.label).toBe('Конспект');

    // editing the link list replaces it, not appends
    const replaced = await patchDraft(f.token, draft.id, {
      links: [{ url: 'https://example.com/only', label: 'Один' }],
    });
    expect(replaced.statusCode).toBe(200);
    expect((replaced.json() as { draft: MiniDraftDto }).draft.links).toHaveLength(1);

    // a second teacher cannot read, patch or republish someone else's draft
    expect((await authed(other.token, 'GET', `/api/mini/drafts/${draft.id}`)).statusCode).toBe(404);
    expect((await patchDraft(other.token, draft.id, { title: 'hijack' })).statusCode).toBe(400);
    expect((await publish(other.token, draft.id)).kind).toBe('notReady');
    expect((await publish(other.token, draft.id)).draft).toBeNull();
    expect(await pubsOf(draft.id)).toHaveLength(0);
  });

  it('accepts only owned active groups and reports the books dropped by a group change', async () => {
    const f = await newTeacher({ groups: ['Группа А', 'Группа Б'] });
    const other = await newTeacher({ groups: ['Чужая группа'] });
    const [a, b] = f.groups;

    const draft = await newDraft(f.token);
    const foreign = await setGroups(f.token, draft.id, [other.groups[0]!.id]);
    expect(foreign.statusCode).toBe(403);
    expect((foreign.json() as { error: string }).error).toBe('groupNotAllowed');

    expect((await setGroups(f.token, draft.id, [a!.id, a!.id])).statusCode).toBe(403);
    expect((await setGroups(f.token, draft.id, [a!.id, b!.id])).statusCode).toBe(200);

    // a book attached only to Group A is eligible while Group A is selected…
    const onlyA = await addMaterial(f.id, [a!.id], {
      title: 'Только для А', unique: `only-a-${seq}`,
      sourceChatId: String(f.chatId), sourceMessageId: 20,
    });
    const put = await authed(f.token, 'PUT', `/api/mini/drafts/${draft.id}/materials`, {
      materialIds: [onlyA.id],
    });
    expect(put.statusCode, put.body).toBe(403);
    expect((put.json() as { error: string }).error).toBe('materialNotAllowed');

    // …and with Group A alone it becomes eligible
    expect((await setGroups(f.token, draft.id, [a!.id])).statusCode).toBe(200);
    const attach = await authed(f.token, 'PUT', `/api/mini/drafts/${draft.id}/materials`, {
      materialIds: [onlyA.id],
    });
    expect(attach.statusCode, attach.body).toBe(200);
    expect((attach.json() as { draft: MiniDraftDto }).draft.materials.map((m) => m.title))
      .toEqual(['Только для А']);

    // switching to a group the book is not recommended for drops it and says so
    const switched = await setGroups(f.token, draft.id, [b!.id]);
    expect(switched.statusCode).toBe(200);
    const body = switched.json() as { draft: MiniDraftDto; droppedMaterials: string[] };
    expect(body.droppedMaterials).toEqual(['Только для А']);
    expect(body.draft.materials).toEqual([]);

    // a foreign material is refused even with a valid group
    const foreignMaterial = await addMaterial(other.id, [other.groups[0]!.id], {
      title: 'Чужая книга', unique: `foreign-${seq}`,
    });
    const denied = await authed(f.token, 'PUT', `/api/mini/drafts/${draft.id}/materials`, {
      materialIds: [foreignMaterial.id],
    });
    expect(denied.statusCode).toBe(403);

    // and so is a group id that is not a UUID at all (the shape check answers before the service)
    const malformedGroup = await setGroups(f.token, draft.id, ['not-a-uuid']);
    expect(malformedGroup.statusCode).toBe(400);
    expect((malformedGroup.json() as { error: string }).error).toBe('invalidInput');
  });

  it('offers only books recommended for EVERY selected group, with search over metadata', async () => {
    const f = await newTeacher({ groups: ['Группа А', 'Группа Б'] });
    const [a, b] = f.groups;
    const both = await addMaterial(f.id, [a!.id, b!.id], {
      title: 'Алгебра 7 класс', unique: `both-${seq}`, fileName: 'algebra.pdf',
    });
    const onlyA = await addMaterial(f.id, [a!.id], {
      title: 'Рабочая тетрадь', unique: `work-${seq}`, fileName: 'workbook.pdf',
    });

    const draft = await newDraft(f.token);

    const noGroups = await authed(f.token, 'GET', `/api/mini/materials?draftId=${draft.id}`);
    expect(noGroups.statusCode).toBe(200);
    expect((noGroups.json() as { materials: unknown[]; reason?: string }).reason).toBe('noGroups');

    await setGroups(f.token, draft.id, [a!.id, b!.id]);
    const eligible = await authed(f.token, 'GET', `/api/mini/materials?draftId=${draft.id}`);
    const eligibleBody = eligible.json() as { materials: { id: string }[] };
    expect(eligibleBody.materials.map((m) => m.id)).toEqual([both.id]);
    expect(eligibleBody.materials.some((m) => m.id === onlyA.id)).toBe(false);

    const found = await authed(f.token, 'GET', `/api/mini/materials?draftId=${draft.id}&q=algebra`);
    expect((found.json() as { materials: { id: string }[] }).materials.map((m) => m.id)).toEqual([both.id]);
    const empty = await authed(f.token, 'GET', `/api/mini/materials?draftId=${draft.id}&q=nothing`);
    expect((empty.json() as { materials: unknown[] }).materials).toEqual([]);

    // the whole library (no draft) is the library screen, not the recommendation screen
    const library = await authed(f.token, 'GET', '/api/mini/materials');
    expect((library.json() as { materials: { id: string }[] }).materials.map((m) => m.id).sort())
      .toEqual([both.id, onlyA.id].sort());

    // another teacher's draft id is not a search oracle either
    const other = await newTeacher({ groups: ['Чужая группа'] });
    const peek = await authed(other.token, 'GET', `/api/mini/materials?draftId=${draft.id}`);
    expect((peek.json() as { materials: unknown[]; reason?: string }).reason).toBe('notFound');
  });

  // ─── 4. formatting ──────────────────────────────────────────────────────

  it('sends the formatter text, titles and link URLs only — never a file or its identifier', async () => {
    const f = await newTeacher({ groups: ['Группа А'], locale: 'ru' });
    const [a] = f.groups;
    const material = await addMaterial(f.id, [a!.id], {
      title: 'Алгебра', unique: `ai-${seq}`, fileName: 'algebra.pdf',
      sourceChatId: String(f.chatId), sourceMessageId: 33,
    });

    const draft = await newDraft(f.token);
    await setGroups(f.token, draft.id, [a!.id]);
    await authed(f.token, 'PUT', `/api/mini/drafts/${draft.id}/materials`, {
      materialIds: [material.id],
    });
    await patchDraft(f.token, draft.id, {
      title: 'Дроби',
      instruction: 'Реши № 7 на стр. 42',
      links: [{ url: 'https://example.com/lesson-7', label: 'Конспект' }],
    });

    const r = await format(f.token, draft.id, 'ai');
    expect(r.statusCode, r.body).toBe(200);
    const body = r.json() as {
      draft: MiniDraftDto; warnings: string[]; questions: string[]; provider: string; usedAi: boolean;
    };
    expect(body.usedAi).toBe(true);
    expect(body.provider).toBe('test-fake');
    expect(body.questions).toEqual(['Проверить № 7?']);

    expect(ai.requests).toHaveLength(1);
    const request = ai.requests[0]!;
    expect(request.lang).toBe('ru');
    expect(request.instruction).toBe('Реши № 7 на стр. 42');
    expect(request.materials).toEqual([
      { title: 'Алгебра', kind: 'book', fileName: 'algebra.pdf' },
    ]);
    expect(request.items.map((i) => i.url)).toContain('https://example.com/lesson-7');

    // The whole serialized request is inspected: a file id, a message id or a byte payload
    // would have to be visible here to be sent at all.
    const wire = JSON.stringify(request);
    for (const forbidden of [
      'telegramFileId', 'file_id', 'fileUniqueId', 'uniq-', 'sourceChatId',
      'sourceMessageId', 'base64', 'data:application', 'JVBERi',
    ]) {
      expect(wire).not.toContain(forbidden);
    }
    for (const item of request.items) {
      expect(Object.keys(item).sort()).toEqual([
        'caption', 'fileName', 'forwarded', 'id', 'kind', 'mimeType', 'text', 'url',
      ]);
    }

    // the model dropped the instruction, the link and the material title — all three are
    // appended verbatim, and the teacher sees a warning for each forced addition
    expect(body.draft.formattedText).toContain('Реши № 7 на стр. 42');
    expect(body.draft.formattedText).toContain('https://example.com/lesson-7');
    expect(body.draft.formattedText).toContain('Алгебра');
    expect(body.warnings.length).toBe(3);
    expect(body.draft.warnings).toEqual(body.warnings);
    expect(body.draft.title).toBe('Дроби');
  });

  it('formats locally without a provider and keeps every field when the provider fails', async () => {
    const f = await newTeacher({ groups: ['Группа А'], locale: 'ru' });
    const [a] = f.groups;
    const draft = await newDraft(f.token);
    await setGroups(f.token, draft.id, [a!.id]);
    await patchDraft(f.token, draft.id, {
      title: 'Дроби', instruction: 'стр. 42, упражнение 7',
      links: [{ url: 'https://example.com/l', label: '' }],
    });

    const manual = await format(f.token, draft.id, 'manual');
    expect(manual.statusCode).toBe(200);
    const manualBody = manual.json() as { draft: MiniDraftDto; provider: string; usedAi: boolean };
    expect(manualBody.usedAi).toBe(false);
    expect(manualBody.provider).toBe('local');
    expect(manualBody.draft.formattedText).toContain('стр. 42, упражнение 7');
    expect(ai.requests).toHaveLength(0);

    const before = manualBody.draft.formattedText;
    ai.failNext = true;
    const failed = await format(f.token, draft.id, 'ai');
    expect(failed.statusCode).toBe(502);
    const failedBody = failed.json() as { error: string; fallback: string };
    expect(failedBody.error).toBe('aiUnavailable');
    expect(failedBody.fallback).toContain('стр. 42, упражнение 7');

    // nothing was written: the previous final text and every field survive the provider failure
    const kept = await authed(f.token, 'GET', `/api/mini/drafts/${draft.id}`);
    const keptDraft = (kept.json() as { draft: MiniDraftDto }).draft;
    expect(keptDraft.formattedText).toBe(before);
    expect(keptDraft.instruction).toBe('стр. 42, упражнение 7');
    expect(keptDraft.title).toBe('Дроби');

    // and manual formatting still works after the failure
    expect((await format(f.token, draft.id, 'manual')).statusCode).toBe(200);
  });

  it('refuses AI when no provider is configured instead of pretending to format', async () => {
    const f = await newTeacher({ groups: ['Группа А'] });
    const localApp = await buildApp(t.db, { mini: { api, ai, aiRemote: false } });
    try {
      const auth = await localApp.inject({
        method: 'POST', url: '/api/mini/auth', payload: { initData: signInitData(f.chatId) },
      });
      const token = (auth.json() as { token: string }).token;
      const created = await localApp.inject({
        method: 'POST', url: '/api/mini/drafts', headers: { authorization: `Bearer ${token}` },
      });
      const draftId = (created.json() as { draft: MiniDraftDto }).draft.id;
      const r = await localApp.inject({
        method: 'POST', url: `/api/mini/drafts/${draftId}/format`,
        headers: { authorization: `Bearer ${token}` }, payload: { mode: 'ai' },
      });
      expect(r.statusCode).toBe(409);
      expect((r.json() as { error: string }).error).toBe('aiUnavailable');
      expect(ai.requests).toHaveLength(0);
    } finally {
      await localApp.close();
    }
  });

  // ─── 5. confirmation and publication ─────────────────────────────────────

  it('needs groups and content before preview, and never publishes without confirmation', async () => {
    const f = await newTeacher({ groups: ['Группа А'] });
    const [a] = f.groups;
    const draft = await newDraft(f.token);

    const noGroups = await preview(f.token, draft.id);
    expect(noGroups.statusCode).toBe(400);
    expect((noGroups.json() as { error: string }).error).toBe('groupsRequired');

    await setGroups(f.token, draft.id, [a!.id]);
    const empty = await preview(f.token, draft.id);
    expect(empty.statusCode).toBe(400);
    expect((empty.json() as { error: string }).error).toBe('emptyHomework');

    // a draft that is only collecting has no Publish at all
    const early = await publish(f.token, draft.id);
    expect(early.kind).toBe('notReady');
    expect(api.calls).toHaveLength(0);
    expect(await pubsOf(draft.id)).toHaveLength(0);

    await patchDraft(f.token, draft.id, { instruction: 'стр. 42' });
    const p = await preview(f.token, draft.id);
    expect(p.statusCode, p.body).toBe(200);
    const dto = (p.json() as { draft: MiniDraftDto }).draft;
    expect(dto.status).toBe('preview');
    expect(dto.canPublish).toBe(true);
    expect(dto.formattedText).toContain('стр. 42');
    // opening the preview sends nothing
    expect(api.calls).toHaveLength(0);
    expect(await pubsOf(draft.id)).toHaveLength(0);

    // preview is idempotent
    expect((await preview(f.token, draft.id)).statusCode).toBe(200);
    expect(api.calls).toHaveLength(0);
  });

  it('publishes through the existing engine: one row per group, per-part outcomes, idempotent repeat', async () => {
    const f = await newTeacher({ groups: ['Группа А', 'Группа Б'] });
    const [a, b] = f.groups;
    const material = await addMaterial(f.id, [a!.id, b!.id], {
      title: 'Алгебра', unique: `pub-${seq}`, fileName: 'algebra.pdf',
      sourceChatId: String(f.chatId), sourceMessageId: 44,
    });
    const draft = await readyDraft(f, { materials: [material.id] });
    expect(draft.status).toBe('preview');
    expect(draft.canPublish).toBe(true);
    expect(api.calls).toHaveLength(0);

    const result = await publish(f.token, draft.id);
    expect(result.kind).toBe('done');
    expect(result.draft?.status).toBe('published');
    expect(result.draft?.publications).toHaveLength(2);
    for (const pub of result.draft!.publications) {
      expect(pub.status).toBe('sent');
      expect(pub.parts.map((p) => p.kind)).toEqual(['text', 'material']);
      expect(pub.parts.every((p) => p.status === 'sent')).toBe(true);
      expect(pub.delivered).toBe(2);
    }

    // one text + one copied book per group — the book is copied, not re-uploaded
    for (const g of [a!, b!]) {
      const calls = callsTo(g.chatId);
      expect(calls.map((c) => c.kind)).toEqual(['send', 'copy']);
      expect(calls[0]!.text).toContain('Реши № 7 на стр. 42');
      expect(calls[1]!.fromChatId).toBe(String(f.chatId));
      expect(calls[1]!.messageId).toBe(44);
    }

    const rows = await pubsOf(draft.id);
    expect(rows.map((r) => r.status)).toEqual(['sent', 'sent']);
    expect((await draftRow(draft.id)).status).toBe('published');

    // a second press cannot send anything: the draft is no longer in `preview`, and the
    // engine is never entered at all (`already` is reserved for a lost CAS race inside it)
    const before = api.calls.length;
    const again = await publish(f.token, draft.id);
    expect(again.kind).toBe('notReady');
    expect(again.draft?.status).toBe('published');
    expect(api.calls.length).toBe(before);
    expect(await pubsOf(draft.id)).toHaveLength(2);

    // a published draft is no longer editable or cancellable
    expect((await patchDraft(f.token, draft.id, { title: 'x' })).statusCode).toBe(409);
    expect((await setGroups(f.token, draft.id, [a!.id])).statusCode).toBe(409);
    const cancel = await authed(f.token, 'POST', `/api/mini/drafts/${draft.id}/cancel`);
    expect(cancel.statusCode).toBe(409);
  });

  it('delivers per group: one refusal leaves the other group sent, and retry touches only the failure', async () => {
    const f = await newTeacher({ groups: ['Группа А', 'Группа Б'] });
    const [a, b] = f.groups;
    const draft = await readyDraft(f);
    api.rejectChats.add(String(b!.chatId)); // Telegram's own 4xx — a definite failure

    const first = await publish(f.token, draft.id);
    expect(first.kind).toBe('done');
    expect(first.draft?.status).toBe('failed');
    const byGroup = new Map(first.draft!.publications.map((p) => [p.groupTitle, p]));
    expect(byGroup.get('Группа А')?.status).toBe('sent');
    expect(byGroup.get('Группа Б')?.status).toBe('failed');
    expect(byGroup.get('Группа Б')?.parts[0]!.status).toBe('failed');
    expect(byGroup.get('Группа А')?.delivered).toBe(1);
    expect(first.draft?.canRetry).toBe(true);
    expect((await draftRow(draft.id)).status).toBe('failed');

    const callsA = callsTo(a!.chatId).length;
    const callsB = callsTo(b!.chatId).length;
    expect(callsA).toBe(1);
    // a refused send is recorded as the publication's outcome, not as a transport call
    expect(callsB).toBe(0);

    api.rejectChats.clear();
    const second = await retry(f.token, draft.id);
    expect(second.kind).toBe('done');
    expect(second.draft?.status).toBe('published');
    // the delivered group is not touched again; the failed one gets exactly one more attempt
    expect(callsTo(a!.chatId).length).toBe(callsA);
    expect(callsTo(b!.chatId).length).toBe(callsB + 1);
    const rows = await pubsOf(draft.id);
    expect(rows.map((r) => [r.groupTitle, r.status]).sort()).toEqual([
      ['Группа А', 'sent'], ['Группа Б', 'sent'],
    ]);
    // the first attempt is counted on the row itself, so a retried group stands at two
    expect(rows.find((r) => r.groupTitle === 'Группа Б')?.attempts).toBe(2);
    expect(rows.find((r) => r.groupTitle === 'Группа А')?.attempts).toBe(1);

    // the draft closed as `published` on the last successful delivery, so a third attempt is
    // refused up front (`noTargets` is reserved for an open draft with nothing retryable left)
    const third = await retry(f.token, draft.id);
    expect(third.kind).toBe('notReady');
    expect(third.draft?.status).toBe('published');
    expect(callsTo(b!.chatId).length).toBe(callsB + 1);
  });

  it('never retries an ambiguous outcome, where a message may already have arrived', async () => {
    const f = await newTeacher({ groups: ['Группа А'] });
    const [a] = f.groups;
    const draft = await readyDraft(f);
    api.failChats.add(String(a!.chatId)); // no answer at all: the outcome is unknown

    const first = await publish(f.token, draft.id);
    expect(first.kind).toBe('done');
    expect(first.draft?.status).toBe('publish_unknown');
    const pub = first.draft!.publications[0]!;
    expect(pub.status).toBe('uncertain');
    expect(pub.parts[0]!.status).toBe('unknown');
    expect(first.draft?.canRetry).toBe(false);

    const calls = api.calls.length;
    api.failChats.clear();
    const second = await retry(f.token, draft.id);
    expect(second.kind).toBe('noTargets');
    expect(api.calls.length).toBe(calls);
    expect((await pubsOf(draft.id))[0]!.status).toBe('uncertain');
    expect((await draftRow(draft.id)).status).toBe('publish_unknown');
  });

  it('stops a publish before any send when a selected group is no longer the teacher’s', async () => {
    const f = await newTeacher({ groups: ['Группа А'] });
    const [a] = f.groups;
    const draft = await readyDraft(f);

    // Someone else’s account now owns the row: the target list still names it, but the
    // publish-time ownership check must refuse it.
    const other = await newTeacher({ groups: [] });
    await t.db.update(tgGroups).set({ ownerId: other.id }).where(eq(tgGroups.id, a!.id));

    const result = await publish(f.token, draft.id);
    expect(result.kind).toBe('groupUnavailable');
    expect(result.unavailableGroups).toEqual(['Группа А']);
    expect(api.calls).toHaveLength(0);
    expect(await pubsOf(draft.id)).toHaveLength(0);
    expect((await draftRow(draft.id)).status).toBe('preview');
  });

  it('cancels an editable draft once and then treats it as closed', async () => {
    const f = await newTeacher({ groups: ['Группа А'] });
    const draft = await newDraft(f.token);
    const first = await authed(f.token, 'POST', `/api/mini/drafts/${draft.id}/cancel`);
    expect(first.statusCode).toBe(200);
    expect((await draftRow(draft.id)).status).toBe('cancelled');
    expect((await authed(f.token, 'POST', `/api/mini/drafts/${draft.id}/cancel`)).statusCode).toBe(409);
    expect((await publish(f.token, draft.id)).kind).toBe('notReady');
    expect(api.calls).toHaveLength(0);
  });

  it('caps publishes per teacher with 429 and never lets a retry loop reach Telegram', async () => {
    const f = await newTeacher({ groups: ['Группа А'] });
    const draft = await readyDraft(f);

    const first = await publish(f.token, draft.id);
    expect(first.kind).toBe('done');
    const sent = api.calls.length;
    expect(sent).toBe(1);

    for (let i = 0; i < 9; i++) {
      const r = await authed(f.token, 'POST', `/api/mini/drafts/${draft.id}/publish`);
      expect(r.statusCode, r.body).toBe(200);
      expect((r.json() as MiniPublishResult).kind).toBe('notReady');
    }
    const limited = await authed(f.token, 'POST', `/api/mini/drafts/${draft.id}/publish`);
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBe('60');
    expect((limited.json() as { error: string }).error).toBe('tooManyRequests');
    expect(api.calls.length).toBe(sent);
  });

  // ─── 6. the bot keeps working ────────────────────────────────────────────

  describe('bot integration', () => {
    // Telegram sends every update with a new id; the dispatcher stores the id for idempotency,
    // so reusing one would silently drop the second command.
    let updateId = 0;
    const msg = (chatId: number, text: string): TgUpdate => ({
      update_id: ++updateId,
      message: {
        message_id: 1,
        chat: { id: chatId, type: 'private' },
        from: { id: chatId, first_name: 'Teacher' },
        text,
      },
    });

    function botDeps(): BotDeps {
      return { db: t.db, api, isGroupAdmin: async () => true, homeworkAi: ai };
    }

    const lastCall = (chatId: number) => {
      const calls = callsTo(chatId);
      return calls[calls.length - 1];
    };

    it('carries the Mini App in /start and /mini and installs the persistent menu button', async () => {
      const f = await newTeacher({ groups: ['Группа А'] });
      const deps = botDeps();

      await handleUpdate(deps, msg(f.chatId, '/start'));
      const hello = lastCall(f.chatId);
      expect(hello?.text).toContain('Меню учителя активно');
      // the greeting itself says where homework is built and how to reopen it later
      expect(hello?.text).toContain('мини-приложении');
      expect(hello?.text).toContain('/mini');
      expect(hello?.opts?.buttons?.[0]?.[0]).toEqual({
        text: 'Открыть BluBlu', webApp: 'https://mini.test/mini',
      });
      // ...and the same door is installed next to the message field, where it survives a restart
      const menu = api.calls.filter((c) => c.kind === 'menubtn' && c.chatId === String(f.chatId)).at(-1);
      expect(menu?.menu).toEqual({
        type: 'web_app', text: 'Открыть BluBlu', url: 'https://mini.test/mini',
      });

      // reopening the bot is just another /start: the button and the greeting are both there
      api.calls.length = 0;
      await handleUpdate(deps, msg(f.chatId, '/start'));
      expect(lastCall(f.chatId)?.opts?.buttons?.[0]?.[0]?.webApp).toBe('https://mini.test/mini');
      expect(api.calls.filter((c) => c.kind === 'menubtn').at(-1)?.menu).toMatchObject({
        type: 'web_app', url: 'https://mini.test/mini',
      });

      api.calls.length = 0;
      await handleUpdate(deps, msg(f.chatId, '/mini'));
      const intro = lastCall(f.chatId);
      expect(intro?.text).toContain('мини-приложении');
      expect(intro?.text).toContain('/mini');
      expect(intro?.opts?.buttons?.[0]?.[0]?.webApp).toBe('https://mini.test/mini');

      // the command list Telegram client menu is built from names the door, not the technology
      const entry = TEACHER_COMMANDS.find(([c]) => c === 'mini');
      expect(entry?.[1]).toEqual({
        ru: 'Открыть BluBlu', uz: 'BluBlu’ni ochish', en: 'Open BluBlu',
      });

      // students and unlinked chats are refused, with no inline button and a DEFAULT chat menu
      api.calls.length = 0;
      const studentChat = 8_400_001;
      const [student] = await t.db.insert(users).values({
        role: 'student', name: 'Ученик', email: `mini-bot-student-${Date.now()}@x.io`,
        passwordHash: await hashPassword('Secret1234'), locale: 'ru', localeExplicit: true,
        profileCompletedAt: new Date(),
      }).returning();
      await acceptPolicy(t.sql, student!.id);
      await t.db.insert(telegramLinks).values({ userId: student!.id, chatId: String(studentChat) });
      await handleUpdate(deps, msg(studentChat, '/mini'));
      expect(lastCall(studentChat)?.text).toContain('только учителю');
      expect(lastCall(studentChat)?.opts?.buttons).toBeUndefined();
      expect(api.calls.filter((c) => c.kind === 'menubtn' && c.chatId === String(studentChat)).at(-1)?.menu)
        .toEqual({ type: 'default' });

      await handleUpdate(deps, msg(8_400_002, '/mini'));
      expect(lastCall(8_400_002)?.text).toContain('linked account');
      expect(lastCall(8_400_002)?.opts?.buttons).toBeUndefined();
      expect(api.calls.filter((c) => c.kind === 'menubtn' && c.chatId === '8400002').at(-1)?.menu)
        .toEqual({ type: 'default' });
    });

    it('removes the Mini App menu button when the teacher unlinks with /stop', async () => {
      const f = await newTeacher({ groups: ['Группа А'] });
      const deps = botDeps();
      await handleUpdate(deps, msg(f.chatId, '/start'));
      expect(api.calls.filter((c) => c.kind === 'menubtn' && c.chatId === String(f.chatId)).at(-1)?.menu)
        .toMatchObject({ type: 'web_app' });

      api.calls.length = 0;
      await handleUpdate(deps, msg(f.chatId, '/stop'));
      expect(api.calls.filter((c) => c.kind === 'menubtn' && c.chatId === String(f.chatId)).at(-1)?.menu)
        .toEqual({ type: 'default' });

      // an unlinked chat that sends /start again does not get a button back
      api.calls.length = 0;
      await handleUpdate(deps, msg(f.chatId, '/start'));
      expect(lastCall(f.chatId)?.opts?.buttons).toBeUndefined();
      expect(api.calls.filter((c) => c.kind === 'menubtn' && c.chatId === String(f.chatId)).at(-1)?.menu)
        .toEqual({ type: 'default' });
    });

    it('keeps /homework working on the same bot, unchanged', async () => {
      const f = await newTeacher({ groups: ['Группа А', 'Группа Б'] });
      const deps = botDeps();
      await handleUpdate(deps, msg(f.chatId, '/homework'));
      const screen = lastCall(f.chatId);
      expect(screen?.text).toContain('Домашнее задание');
      const labels = (screen?.opts?.buttons ?? []).flat().map((b) => b.text).join(' | ');
      expect(labels).toContain('Группа А');
      expect(labels).toContain('Группа Б');
      // and nothing was sent to any group
      expect(callsTo(f.groups[0]!.chatId)).toHaveLength(0);
      expect(callsTo(f.groups[1]!.chatId)).toHaveLength(0);
    });

    it('answers a teacher honestly when the Mini App has no https site, and keeps /homework as the way', async () => {
      const f = await newTeacher({ groups: ['Группа А'] });
      const deps = botDeps();
      env.PUBLIC_URL = '';
      try {
        // the greeting itself must not pretend the door exists: no button Telegram refuses,
        // an actionable sentence instead, and the chat menu reset to Telegram's default
        await handleUpdate(deps, msg(f.chatId, '/start'));
        const hello2 = lastCall(f.chatId);
        expect(hello2?.text).toContain('Меню учителя активно');
        expect(hello2?.text).toContain('не подключено');
        expect(hello2?.text).toContain('/homework');
        expect(hello2?.opts?.buttons).toBeUndefined();
        expect(api.calls.filter((c) => c.kind === 'menubtn').at(-1)?.menu).toEqual({ type: 'default' });

        api.calls.length = 0;
        await handleUpdate(deps, msg(f.chatId, '/mini'));
        const call = lastCall(f.chatId);
        expect(call?.text).toContain('по HTTPS');
        expect(call?.text).toContain('/homework');
        expect(call?.opts?.buttons).toBeUndefined();
        expect(api.calls.filter((c) => c.kind === 'menubtn').at(-1)?.menu).toEqual({ type: 'default' });
      } finally {
        env.PUBLIC_URL = 'https://mini.test';
      }
    });
  });

  // ─── 7. the document policy ──────────────────────────────────────────────

  it('is the only document allowed to load the Telegram SDK and be framed by Telegram', async () => {
    const mini = await app.inject({ method: 'GET', url: '/mini' });
    expect(mini.statusCode).toBe(200);
    expect(String(mini.headers['content-type'])).toContain('text/html');
    const miniCsp = String(mini.headers['content-security-policy']);
    expect(miniCsp).toContain("script-src 'self' https://telegram.org");
    expect(miniCsp).toContain("frame-ancestors 'self' https://telegram.org https://*.telegram.org");
    expect(mini.headers['x-frame-options']).toBeUndefined();
    expect(String(mini.headers['cache-control'])).toBe('no-cache');

    for (const url of ['/', '/guest']) {
      const r = await app.inject({ method: 'GET', url });
      expect(r.statusCode, url).toBe(200);
      const csp = String(r.headers['content-security-policy']);
      expect(csp, url).toContain("script-src 'self'");
      expect(csp, url).not.toContain('telegram.org');
      expect(csp, url).toContain("frame-ancestors 'none'");
      expect(String(r.headers['x-frame-options']), url).toBe('SAMEORIGIN');
    }

    // An unknown page keeps the strict policy too — the 404 shell is still a document.
    const unknownPage = await app.inject({ method: 'GET', url: '/some/deep/page' });
    expect(unknownPage.statusCode).toBe(404);
    expect(String(unknownPage.headers['content-security-policy'])).not.toContain('telegram.org');

    // /mini is a real standalone route for the server too — the soft-404 list names it.
    const exact = await app.inject({ method: 'GET', url: '/mini' });
    expect(exact.statusCode).toBe(200);
    // A sub-path is not a route (the SPA matches /mini exactly), but the response still belongs
    // to the Mini App document: the widened policy follows the path, not the status code.
    for (const r of [exact, await app.inject({ method: 'GET', url: '/mini/deep-link' })]) {
      expect(String(r.headers['content-security-policy'])).toContain('telegram.org');
      expect(r.headers['x-frame-options']).toBeUndefined();
    }
  });
});
