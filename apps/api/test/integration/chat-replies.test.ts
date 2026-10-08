/**
 * Chat replies (task 2, 2026-10-08) — rights, the same-class rule, the snippet lifecycle,
 * what survives a physical delete, and the privilege posture the migration must not change.
 *
 * A separate file on purpose: chat.test.ts (item 8) stays exactly as it was.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import WebSocket from 'ws';
import { TEST_DATABASE_URL, preparedDb, type TestDB } from './util.js';
import { buildApp } from '../../src/app.js';
import { classes, users, classMembers, chatMessages } from '../../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { hashPassword } from '../../src/lib/password.js';
import { chatRateReset } from '../../src/routes/chat.js';
import type { FastifyInstance } from 'fastify';

const suite = TEST_DATABASE_URL ? describe : describe.skip;

/** the long text used for the snippet cap: repeated Cyrillic + Uzbek letters */
const LONG = 'Привет, oʻzbek gʻoya! '.repeat(12);

suite('chat replies (task 2)', () => {
  let t: TestDB;
  let app: FastifyInstance;
  let teacherTok = '';
  let aTok = '';
  let bTok = '';
  let classId = '';
  let otherClassId = '';
  /** token → user id: the chat rate window is keyed by the USER, so a reset needs the id */
  const idOf = new Map<string, string>();

  beforeAll(async () => {
    t = await preparedDb(TEST_DATABASE_URL);
    app = await buildApp(t.db);
    const pw = await hashPassword('Passw0rd123');
    const [teacher] = await t.db.insert(users).values({ role: 'teacher', name: 'RepTeacher', email: 'rpt@x.io', passwordHash: pw, locale: 'ru', tz: 'UTC' }).returning();
    const [sa] = await t.db.insert(users).values({ role: 'student', name: 'Ответ А', email: 'rpa@x.io', passwordHash: pw, locale: 'ru', tz: 'UTC' }).returning();
    const [sb] = await t.db.insert(users).values({ role: 'student', name: 'Ответ Б', email: 'rpb@x.io', passwordHash: pw, locale: 'ru', tz: 'UTC' }).returning();
    const [c1] = await t.db.insert(classes).values({ teacherId: teacher!.id, name: 'Чат ответы' }).returning();
    const [c2] = await t.db.insert(classes).values({ teacherId: teacher!.id, name: 'Чат чужой' }).returning();
    classId = c1!.id; otherClassId = c2!.id;
    await t.db.insert(classMembers).values([
      { classId, userId: sa!.id }, { classId, userId: sb!.id },
      { classId: otherClassId, userId: sa!.id },   // A is in both classes, B only in the first
    ]);
    const login = async (email: string) => {
      const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'Passw0rd123' } });
      return `Bearer ${r.json().accessToken}`;
    };
    teacherTok = await login('rpt@x.io');
    aTok = await login('rpa@x.io');
    bTok = await login('rpb@x.io');
    idOf.set(teacherTok, teacher!.id);
    idOf.set(aTok, sa!.id);
    idOf.set(bTok, sb!.id);
  });
  afterAll(async () => { await app?.close(); await t?.sql.end(); });

  const a = (tok: string) => ({ authorization: tok });
  const post = (tok: string, url: string, body: unknown) =>
    app.inject({ method: 'POST', url, headers: a(tok), payload: body as object });
  const get = (tok: string, url: string) => app.inject({ method: 'GET', url, headers: a(tok) });
  const msgUrl = (cls: string) => `/api/classes/${cls}/chat/messages`;
  /**
   * Every user gets a fresh rate window, so a limit test never leaks into another one.
   * The window is keyed by user id (chatRateCheck(req.user.id)) — resetting the token would
   * silently do nothing, and these tests post more than 5 messages per sender per 10 s.
   */
  const unmetered = async (...toks: string[]) => {
    for (const tok of toks) {
      const id = idOf.get(tok);
      if (!id) throw new Error('unmetered() was handed a token this suite did not issue');
      chatRateReset(id);
    }
  };

  it('a reply carries replyTo with the author and the current text of the original', async () => {
    await unmetered(teacherTok, aTok);
    const orig = await post(teacherTok, msgUrl(classId), { text: 'К контрольной — глава 4' });
    expect(orig.statusCode).toBe(201);
    const origId = orig.json().id as string;

    const rep = await post(aTok, msgUrl(classId), { text: 'А страница 88?', replyToId: origId });
    expect(rep.statusCode).toBe(201);
    const body = rep.json();
    expect(body.replyTo.id, 'the quote points at the original').toBe(origId);
    expect(body.replyTo.snippet, 'and shows its current text').toBe('К контрольной — глава 4');
    expect((body.replyTo.authorName as string).length, 'the author of the original is named').toBeGreaterThan(0);
    expect(body.replyTo.deleted, 'a live original is not deleted').toBe(false);

    const list = await get(aTok, msgUrl(classId));
    const seen = list.json().messages.find((m: { id: string }) => m.id === body.id);
    expect(seen.replyTo, 'the history returns the same quote').toMatchObject({ id: origId, snippet: 'К контрольной — глава 4' });
  });

  it('replying to another class and to a nonexistent id answer with the SAME 404', async () => {
    await unmetered(teacherTok, aTok);
    const inOther = await post(teacherTok, msgUrl(otherClassId), { text: 'из чужого класса' });
    expect(inOther.statusCode).toBe(201);

    const cross = await post(aTok, msgUrl(classId), { text: 'хочу чужое', replyToId: inOther.json().id });
    const ghost = await post(aTok, msgUrl(classId), { text: 'хочу несуществующее', replyToId: '00000000-0000-0000-0000-000000000000' });
    expect(cross.statusCode, 'a foreign-class message is not answerable here').toBe(404);
    expect(ghost.statusCode).toBe(404);
    expect(ghost.json()).toEqual(cross.json());   // no oracle about which ids exist
  });

  it('a non-uuid replyToId is invalidInput, not a 500', async () => {
    await unmetered(aTok);
    const r = await post(aTok, msgUrl(classId), { text: 'мусор в ссылке', replyToId: 'not-a-uuid' });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe('invalidInput');
  });

  it('answering your own message is allowed', async () => {
    await unmetered(bTok);
    const own = await post(bTok, msgUrl(classId), { text: 'не забыть домашку' });
    const rep = await post(bTok, msgUrl(classId), { text: 'и тетрадь тоже', replyToId: own.json().id });
    expect(rep.statusCode).toBe(201);
    expect(rep.json().replyTo.id).toBe(own.json().id);
  });

  it('the snippet follows the CURRENT text and is capped at 120 code points', async () => {
    await unmetered(teacherTok, aTok);
    const orig = await post(teacherTok, msgUrl(classId), { text: LONG });
    const rep = await post(aTok, msgUrl(classId), { text: 'уточнение', replyToId: orig.json().id });
    const snippet = rep.json().replyTo.snippet as string;
    expect([...snippet].length, 'never longer than 120 characters').toBeLessThanOrEqual(120);
    expect(snippet, 'no half of a surrogate pair, no raw newlines').not.toMatch(/[\r\n]/);

    const edit = await app.inject({
      method: 'PATCH', url: `${msgUrl(classId)}/${orig.json().id}`, headers: a(teacherTok),
      payload: { text: 'Глава 5, не 4!' },
    });
    expect(edit.statusCode).toBe(200);
    const list = await get(aTok, msgUrl(classId));
    const seen = list.json().messages.find((m: { id: string }) => m.id === rep.json().id);
    expect(seen.replyTo.snippet, 'the quote shows the edited text').toBe('Глава 5, не 4!');
  });

  it('deleting the original keeps the answer and marks the quote deleted', async () => {
    await unmetered(teacherTok, aTok);
    const orig = await post(teacherTok, msgUrl(classId), { text: 'это исчезнет' });
    const rep = await post(aTok, msgUrl(classId), { text: 'а это останется', replyToId: orig.json().id });
    expect(rep.statusCode).toBe(201);

    const del = await app.inject({
      method: 'DELETE', url: `${msgUrl(classId)}/${orig.json().id}`, headers: a(teacherTok),
    });
    expect(del.statusCode).toBe(200);

    const list = await get(aTok, msgUrl(classId));
    const seen = list.json().messages.find((m: { id: string }) => m.id === rep.json().id);
    expect(seen, 'the answer itself was not taken by the delete').toBeTruthy();
    expect(seen.replyTo, 'the quote says the original is gone').toMatchObject({
      id: orig.json().id, deleted: true, snippet: '',
    });
    expect(seen.replyTo.authorName, 'nothing of the deleted message is kept').toBeNull();

    const row = await t.db.select({ replyToId: chatMessages.replyToId, replyRefId: chatMessages.replyRefId })
      .from(chatMessages).where(eq(chatMessages.id, rep.json().id)).limit(1);
    expect(row[0]?.replyToId, 'the FK was set to NULL by ON DELETE SET NULL').toBeNull();
    expect(row[0]?.replyRefId, 'the plain reference survived — that is what makes deleted:true knowable')
      .toBe(orig.json().id);
  });

  it('a muted student cannot answer, and the quote never becomes HTML', async () => {
    await unmetered(teacherTok, bTok);
    const orig = await post(bTok, msgUrl(classId), { text: '<img src=x onerror=alert(1)>' });
    expect(orig.json().replyTo).toBeNull();
    const quote = await post(aTok, msgUrl(classId), { text: 'цитата', replyToId: orig.json().id });
    expect(quote.statusCode).toBe(201);
    expect(quote.json().replyTo.snippet).toBe('<img src=x onerror=alert(1)>');
    expect(JSON.stringify(quote.json()), 'the API never wraps it in markup').not.toContain('&lt;');

    const [other] = await t.db.select({ id: users.id }).from(users).where(eq(users.email, 'rpb@x.io')).limit(1);
    const mute = await post(teacherTok, `/api/classes/${classId}/chat/mutes`, { userId: other!.id, until: null });
    expect(mute.statusCode).toBe(200);
    await unmetered(bTok);
    const blocked = await post(bTok, msgUrl(classId), { text: 'ответ поверх заглушки', replyToId: quote.json().id });
    expect(blocked.statusCode, 'the same rules as a normal post apply to an answer').toBe(403);
    expect(blocked.json().error).toBe('chatMuted');
    await app.inject({ method: 'DELETE', url: `/api/classes/${classId}/chat/mutes/${other!.id}`, headers: a(teacherTok) });
  });

  it('the length limit is unchanged for an answer', async () => {
    await unmetered(teacherTok, aTok);
    const orig = await post(teacherTok, msgUrl(classId), { text: 'длина' });
    const tooLong = await post(aTok, msgUrl(classId), { text: 'а'.repeat(2001), replyToId: orig.json().id });
    expect(tooLong.statusCode).toBe(400);
    const empty = await post(aTok, msgUrl(classId), { text: '   ', replyToId: orig.json().id });
    expect(empty.statusCode).toBe(400);
  });

  it('the WS frame of an answer carries replyTo, and a delete of the original is broadcast', async () => {
    await unmetered(teacherTok, aTok, bTok);
    const tk = await post(bTok, `/api/classes/${classId}/chat/ticket`, {});
    expect(tk.statusCode).toBe(200);
    // buildApp() alone never listens — the same guard chat.test.ts uses for its WS tests
    if (!app.server.listening) await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    expect(port, 'the app is listening on an ephemeral port').toBeGreaterThan(0);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws/chat/${classId}?ticket=${encodeURIComponent(String(tk.json().ticket))}`);
    const frames: Record<string, unknown>[] = [];
    await new Promise<void>((res, rej) => {
      ws.on('open', () => res());
      ws.on('error', rej);
      setTimeout(() => rej(new Error('chat ws did not open')), 8_000);
    });
    ws.on('message', (d: Buffer) => frames.push(JSON.parse(d.toString()) as Record<string, unknown>));
    const ready = await new Promise<boolean>((res) => {
      const t0 = setTimeout(() => res(false), 8_000);
      const iv = setInterval(() => {
        if (frames.some((f) => f.type === 'ready')) { clearTimeout(t0); clearInterval(iv); res(true); }
      }, 50);
    });
    expect(ready, 'the socket joined the room').toBe(true);

    const orig = await post(teacherTok, msgUrl(classId), { text: 'оригинал для realtime' });
    const rep = await post(aTok, msgUrl(classId), { text: 'ответ для realtime', replyToId: orig.json().id });
    expect(rep.statusCode).toBe(201);
    await new Promise((r) => setTimeout(r, 800));
    const msgFrames = frames.filter((f) => f.type === 'message') as { message: { replyTo: { id: string } | null } }[];
    expect(msgFrames.some((f) => f.message.replyTo?.id === orig.json().id),
      'the pushed message carries the quote').toBe(true);

    await app.inject({ method: 'DELETE', url: `${msgUrl(classId)}/${orig.json().id}`, headers: a(teacherTok) });
    await new Promise((r) => setTimeout(r, 800));
    expect(frames.some((f) => f.type === 'deleted' && f.messageId === orig.json().id),
      'and the delete is pushed too, so the client can mark its quotes deleted').toBe(true);
    ws.close();
  });

  it('migration 0023 left the privilege posture alone: RLS on, anon/authenticated with no rights', async () => {
    const rows = await t.sql`
      select relname, relrowsecurity, relforcerowsecurity
        from pg_class where relname = 'chat_messages'`;
    expect(rows[0]?.relrowsecurity, 'chat_messages still has RLS enabled').toBe(true);

    // has_table_privilege ERRORS on a role that does not exist, so ask first: the local/CI cluster
    // may have no Supabase roles at all, and then there is nothing to grant and nothing to prove.
    const roles = await t.sql`
      select rolname from pg_roles where rolname in ('anon', 'authenticated')`;
    const have = new Set(roles.map((r) => String((r as { rolname: string }).rolname)));
    if (have.has('anon')) {
      const p = await t.sql`
        select pg_catalog.has_table_privilege('anon', 'chat_messages', 'select') as s_select,
               pg_catalog.has_table_privilege('anon', 'chat_messages', 'insert') as s_insert,
               pg_catalog.has_column_privilege('anon', 'chat_messages', 'reply_to_id', 'select') as s_reply,
               pg_catalog.has_column_privilege('anon', 'chat_messages', 'reply_ref_id', 'select') as s_ref`;
      const q = (p[0] ?? {}) as Record<string, boolean>;
      expect(q.s_select, 'anon cannot read').toBe(false);
      expect(q.s_insert, 'anon cannot write').toBe(false);
      expect(q.s_reply, 'the new FK column is not reachable either').toBe(false);
      expect(q.s_ref, 'nor the new reference column').toBe(false);
    }
    if (have.has('authenticated')) {
      const p = await t.sql`
        select pg_catalog.has_table_privilege('authenticated', 'chat_messages', 'select') as a_select,
               pg_catalog.has_table_privilege('authenticated', 'chat_messages', 'update') as a_update,
               pg_catalog.has_table_privilege('authenticated', 'chat_messages', 'references') as a_ref`;
      const q = (p[0] ?? {}) as Record<string, boolean>;
      expect(q.a_select, 'authenticated cannot read').toBe(false);
      expect(q.a_update, 'authenticated cannot update').toBe(false);
      expect(q.a_ref, 'and cannot reference the new FK either').toBe(false);
    }
  });

  it('the FK really is ON DELETE SET NULL and both indexes exist', async () => {
    // pg_catalog, not information_schema: that view exposes no delete rule at all, and its
    // tables are only reachable schema-qualified (measured: "relation referential_constraints
    // does not exist" on the first run of this test)
    const fks = await t.sql`
      select con.conname as name, con.confdeltype::text as del, att.attname as col, ref.relname as refers
        from pg_constraint con
        join pg_class cls on cls.oid = con.conrelid
        join pg_class ref on ref.oid = con.confrelid
        join pg_attribute att on att.attrelid = con.conrelid and att.attnum = con.conkey[1]
       where cls.relname = 'chat_messages' and con.contype = 'f' and att.attname = 'reply_to_id'`;
    expect(fks.length, 'reply_to_id is a foreign key').toBeGreaterThanOrEqual(1);
    expect(fks.every((f) => String((f as { refers: string }).refers) === 'chat_messages'),
      'and it points back at chat_messages itself').toBe(true);
    expect(fks.every((f) => String((f as { del: string }).del) === 'n'),
      'and it sets NULL instead of taking the answer with it').toBe(true);

    const refNoFk = await t.sql`
      select count(*)::int as n from pg_constraint con
        join pg_class cls on cls.oid = con.conrelid
        join pg_attribute att on att.attrelid = con.conrelid and att.attnum = con.conkey[1]
       where cls.relname = 'chat_messages' and con.contype = 'f' and att.attname = 'reply_ref_id'`;
    expect((refNoFk[0] as { n: number }).n, 'reply_ref_id deliberately carries NO constraint')
      .toBe(0);

    const idx = await t.sql`
      select indexname from pg_indexes where tablename = 'chat_messages'
        and indexname in ('chat_messages_reply_to_idx', 'chat_messages_reply_ref_idx')`;
    expect(idx.length, 'both lookup indexes exist').toBe(2);
  });
});
