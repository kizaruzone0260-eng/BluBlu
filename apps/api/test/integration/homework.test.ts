/**
 * Telegram homework assistant — end-to-end integration tests through the real
 * dispatcher, real Postgres and a capturing Telegram transport.
 *
 * What is proven here (the product rules, not the implementation):
 *  • a group can be connected with /bind; groups stay silent for everything else;
 *  • only a linked teacher gets the surface — checked on the server, not in the UI;
 *  • text, links, photos and documents are collected once, and a redelivered
 *    Telegram message cannot be stored twice;
 *  • one screen collects everything (text, files, saved library books) behind three buttons;
 *  • the formatter never receives a byte of a file — only text, titles and names;
 *  • material collection never sends anything to a group;
 *  • only the explicit Publish button sends; the same button cannot send twice;
 *  • editing invalidates buttons rendered from the old revision;
 *  • a definite refusal is retryable and is retried without touching delivered groups;
 *  • an ambiguous failure is `uncertain` and is never retried;
 *  • the result is reported per part: text and each attachment have their own outcome;
 *  • every callback_data value fits Telegram's 64-byte limit.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { TEST_DATABASE_URL, preparedDb, makeTeacher, acceptPolicy, type TestDB } from './util.js';
import { tgDrafts, tgGroups, tgPublications, telegramLinks, users, auditLog } from '../../src/db/schema.js';
import { handleUpdate, type BotDeps, type TgUpdate } from '../../src/services/bot.js';
import { CapturingApi } from '../../src/services/botApi.js';
import { hashPassword } from '../../src/lib/password.js';
import {
  addGroup, createDraft, itemCount, latestActiveDraft, listItems, transitionDraft,
} from '../../src/services/homework/store.js';
import { makeHomeworkCallback } from '../../src/services/homework/tokens.js';
import {
  canRetry, publishDraft, retryFailedPublications, splitText,
} from '../../src/services/homework/publish.js';
import type { HwAiRequest, HwAiResult, HomeworkAi } from '../../src/services/homework/types.js';

const suite = TEST_DATABASE_URL ? describe : describe.skip;

const A_CHAT = -1001;
const B_CHAT = -1002;
const C_CHAT = -1003; // connected through /bind in the first test
const S_CHAT = 702;
const F_CHAT = 703; // a different teacher

class FakeAi implements HomeworkAi {
  requests: HwAiRequest[] = [];
  failNext = false;
  result: HwAiResult = {
    status: 'ok',
    title: 'Дроби',
    formatted: 'ДОМАШНЕЕ ЗАДАНИЕ\n\nстр. 42, упражнение 7',
    questions: [],
    warnings: [],
    provider: 'test-fake',
  };

  async format(req: HwAiRequest): Promise<HwAiResult> {
    this.requests.push(req);
    if (this.failNext) {
      this.failNext = false;
      throw new Error('test provider is down');
    }
    return this.result;
  }
}

suite('telegram homework assistant', () => {
  let t: TestDB;
  let api: CapturingApi;
  let deps: BotDeps;
  let ai: FakeAi;
  let teacherId = '';
  let studentId = '';
  let foreignId = '';
  let T_CHAT = 0;
  let uid = 0;
  let msgId = 0;
  let seq = 0;
  const admins = new Set<string>();

  // ─── Telegram fixtures ─────────────────────────────────────────────────────

  const rawCb = (chatId: number, data: string): TgUpdate => ({
    update_id: ++uid,
    callback_query: {
      id: `q${uid}`,
      from: { id: chatId },
      message: { message_id: 5, chat: { id: chatId, type: 'private' } },
      data,
    },
  });

  const msg = (chatId: number, text: string, type = 'private', title?: string): TgUpdate => ({
    update_id: ++uid,
    message: {
      message_id: ++msgId,
      chat: { id: chatId, type, ...(title ? { title } : {}) },
      from: { id: chatId, first_name: 'Teacher' },
      text,
    },
  });

  const groupMsg = (text: string, title: string, fromId: number): TgUpdate => ({
    update_id: ++uid,
    message: {
      message_id: ++msgId,
      chat: { id: C_CHAT, type: 'supergroup', title },
      from: { id: fromId, first_name: 'Member' },
      text,
    },
  });

  const photoMsg = (chatId: number, fileId: string, size: number, caption: string): TgUpdate => ({
    update_id: ++uid,
    message: {
      message_id: ++msgId,
      chat: { id: chatId, type: 'private' },
      from: { id: chatId },
      photo: [
        { file_id: `${fileId}-small`, file_unique_id: `${fileId}-u-small`, width: 90, height: 90, file_size: 1000 },
        { file_id: fileId, file_unique_id: `${fileId}-u`, width: 1280, height: 720, file_size: size },
      ],
      caption,
    },
  });

  const docMsg = (chatId: number, fileId: string, name: string, size: number): TgUpdate => ({
    update_id: ++uid,
    message: {
      message_id: ++msgId,
      chat: { id: chatId, type: 'private' },
      from: { id: chatId },
      document: {
        file_id: fileId, file_unique_id: `${fileId}-u`, file_name: name,
        mime_type: 'application/pdf', file_size: size,
      },
    },
  });

  // ─── reading the captured conversation ─────────────────────────────────────

  const go = async (u: TgUpdate) => { await handleUpdate(deps, u); };
  const callsTo = (chatId: number) => api.calls.filter((c) => c.chatId === String(chatId));
  const textsTo = (chatId: number) => callsTo(chatId)
    .filter((c) => c.text !== undefined).map((c) => c.text as string);
  const lastTextTo = (chatId: number) => textsTo(chatId)[textsTo(chatId).length - 1] ?? '';
  const clearApi = () => { api.calls.length = 0; };

  function button(label: string, chatId = T_CHAT): string {
    for (let i = api.calls.length - 1; i >= 0; i--) {
      const call = api.calls[i]!;
      if (call.chatId !== String(chatId)) continue;
      for (const row of call.opts?.buttons ?? []) {
        for (const item of row) if (item.cb && item.text.includes(label)) return item.cb;
      }
    }
    throw new Error(`button "${label}" not found for chat ${chatId}`);
  }

  const press = async (label: string, chatId = T_CHAT) => {
    await go(rawCb(chatId, button(label, chatId)));
  };

  function lastScreenButtons(): string[] {
    for (let i = api.calls.length - 1; i >= 0; i--) {
      const buttons = api.calls[i]?.opts?.buttons;
      if (buttons?.length) return buttons.flat().map((item) => item.text);
    }
    return [];
  }

  function assertShortCallbacks(): void {
    const all = api.calls.flatMap((c) => c.opts?.buttons?.flat() ?? []);
    expect(all.length).toBeGreaterThan(0);
    for (const item of all) {
      if (!item.cb) continue;
      expect(Buffer.byteLength(item.cb, 'utf8')).toBeLessThanOrEqual(64);
      expect(item.cb.startsWith('h1.')).toBe(true);
    }
  }

  const draftRow = async (id: string) => {
    const [row] = await t.db.select().from(tgDrafts).where(eq(tgDrafts.id, id));
    return row!;
  };
  /**
   * SEC-14 (2026-10-28): `audit()` пишется fire-and-forget, поэтому ждём строку, а не «немного
   * времени»: тест должен проверять наличие следа, а не скорость машины.
   */
  const waitHomeworkAudit = async (draftId: string) => {
    const deadline = Date.now() + 3000;
    for (;;) {
      const rows = (await t.db.select().from(auditLog).where(eq(auditLog.action, 'homework_publish')))
        .filter((r) => (r.target as { draftId?: string }).draftId === draftId);
      if (rows.length) return rows;
      if (Date.now() > deadline) throw new Error('в audit_log нет записи homework_publish для черновика');
      await new Promise((r) => setTimeout(r, 25));
    }
  };
  const pubsOf = (draftId: string) =>
    t.db.select().from(tgPublications).where(eq(tgPublications.draftId, draftId));
  const groupRow = async (chatId: string) => {
    const [row] = await t.db.select().from(tgGroups).where(and(
      eq(tgGroups.ownerId, teacherId), eq(tgGroups.telegramChatId, chatId),
    ));
    return row!;
  };

  /**
   * /homework → tick the named groups → Continue. One step: the draft goes straight to
   * collecting, where text, files and saved library books are all handled together.
   */
  async function openHomework(groups: string[]): Promise<void> {
    await go(msg(T_CHAT, '/homework'));
    for (const name of groups) await press(name);
    await press('Продолжить');
  }

  // ─── lifecycle ─────────────────────────────────────────────────────────────

  beforeAll(async () => {
    t = await preparedDb(TEST_DATABASE_URL);
    const teacher = await makeTeacher(t.sql, `hwT${Date.now()}@x.io`);
    teacherId = teacher.id;
    const foreign = await makeTeacher(t.sql, `hwF${Date.now()}@x.io`);
    foreignId = foreign.id;
    const [stu] = await t.db.insert(users).values({
      role: 'student', name: 'Сидор', email: `hwS${Date.now()}@x.io`,
      passwordHash: await hashPassword('Secret1234'),
      locale: 'ru', localeExplicit: true, profileCompletedAt: new Date(),
    }).returning();
    studentId = stu!.id;
    await acceptPolicy(t.sql, studentId);
    await t.db.insert(telegramLinks).values([
      { userId: studentId, chatId: String(S_CHAT) },
      { userId: foreignId, chatId: String(F_CHAT) },
    ]);
  });

  afterAll(async () => { await t?.sql.end(); });

  beforeEach(async () => {
    // A fresh teacher + chat per test: the dispatcher's in-process rate limit
    // (20 callbacks/min per chat) must not leak between scenarios, and drafts
    // can never bleed into the next test.
    seq++;
    const teacher = await makeTeacher(t.sql, `hw${Date.now()}-${seq}@x.io`);
    teacherId = teacher.id;
    T_CHAT = 7200 + seq;
    await t.db.insert(telegramLinks).values({ userId: teacherId, chatId: String(T_CHAT) });
    await addGroup(t.db, teacherId, String(A_CHAT), 'Группа А');
    await addGroup(t.db, teacherId, String(B_CHAT), 'Группа Б');
    api = new CapturingApi();
    ai = new FakeAi();
    admins.clear();
    deps = {
      db: t.db,
      api,
      isGroupAdmin: async (chatId, tgUserId) => admins.has(`${chatId}:${tgUserId}`),
      homeworkAi: ai,
    };
    uid = 9_000_000 + seq * 100_000;
    msgId = 100;
  });

  // ─── tests ─────────────────────────────────────────────────────────────────

  it('connects a group with /bind, refuses other accounts without burning the code, and stays silent otherwise', async () => {
    await go(msg(T_CHAT, '/homework'));
    await press('Подключить группу');
    const code = lastTextTo(T_CHAT).match(/Код для подключения группы: ([A-Z2-9]{8})/)?.[1];
    expect(code).toBeTruthy();

    // not an administrator. These four answers go out BEFORE the owner's account is known,
    // so they are English by design (live test: a Russian line inside an English screen);
    // the messages after a successful bind follow the owner's own locale again.
    await go(groupMsg(`/bind ${code}`, 'Офлайн группа', T_CHAT));
    expect(lastTextTo(C_CHAT)).toContain('Only an administrator of this group');

    // administrator, but this Telegram account has no BluBlu link
    admins.add(`${C_CHAT}:999`);
    await go(groupMsg(`/bind ${code}`, 'Офлайн группа', 999));
    expect(lastTextTo(C_CHAT)).toContain('created by another account');

    // administrator linked to a DIFFERENT teacher: the code must survive
    admins.add(`${C_CHAT}:${F_CHAT}`);
    await go(groupMsg(`/bind ${code}`, 'Офлайн группа', F_CHAT));
    expect(lastTextTo(C_CHAT)).toContain('created by another account');
    expect(await t.db.select().from(tgGroups).where(and(
      eq(tgGroups.ownerId, teacherId), eq(tgGroups.telegramChatId, String(C_CHAT)),
    ))).toHaveLength(0);

    // the account that created it succeeds
    admins.add(`${C_CHAT}:${T_CHAT}`);
    await go(groupMsg(`/bind ${code}`, 'Офлайн группа', T_CHAT));
    expect(lastTextTo(C_CHAT)).toContain('подключена');
    expect(lastTextTo(T_CHAT)).toContain('Вернитесь в личный чат');
    const [bound] = await t.db.select().from(tgGroups).where(and(
      eq(tgGroups.ownerId, teacherId), eq(tgGroups.telegramChatId, String(C_CHAT)),
    ));
    expect(bound?.title).toBe('Офлайн группа');
    expect(bound?.status).toBe('active');

    // one-time: the same code cannot connect a second group
    await go(groupMsg(`/bind ${code}`, 'Офлайн группа', T_CHAT));
    expect(lastTextTo(C_CHAT)).toContain('Code not found');

    await go(groupMsg('/bind', 'Офлайн группа', T_CHAT));
    expect(lastTextTo(C_CHAT)).toContain('Format: /bind CODE');

    // the historical group silence is intact for everything but /bind
    const before = api.calls.length;
    await go(groupMsg('/schedule', 'Офлайн группа', T_CHAT));
    await go(groupMsg('/announce', 'Офлайн группа', T_CHAT));
    await go(groupMsg('просто сообщение', 'Офлайн группа', T_CHAT));
    expect(api.calls.length).toBe(before);
  });

  it('denies students and unlinked chats on the server, and a foreign teacher cannot consume the teacher’s button', async () => {
    await go(msg(S_CHAT, '/homework'));
    expect(lastTextTo(S_CHAT)).toContain('только учителю');
    const before = api.calls.length;
    await go(msg(S_CHAT, 'Параграф 5'));
    expect(api.calls.length).toBe(before); // no draft, no acknowledgement
    expect(await t.db.select().from(tgDrafts).where(eq(tgDrafts.ownerId, studentId))).toHaveLength(0);

    // the student is stopped BEFORE the one-time token is claimed
    const teacherToken = await makeHomeworkCallback(t.db, teacherId, { a: 'hist' });
    await go(rawCb(S_CHAT, teacherToken));
    expect(lastTextTo(S_CHAT)).toContain('только учителю');
    await go(rawCb(T_CHAT, teacherToken));
    expect(lastTextTo(T_CHAT)).toContain('Последние отправки:');

    // another teacher is refused too, and still cannot consume the button
    const token2 = await makeHomeworkCallback(t.db, teacherId, { a: 'hist' });
    await go(rawCb(F_CHAT, token2));
    expect(lastTextTo(F_CHAT)).toContain('устарела');
    await go(rawCb(T_CHAT, token2));
    expect(lastTextTo(T_CHAT)).toContain('Последние отправки:');

    // a chat with no BluBlu account at all: no account means no chosen language either,
    // so the answer is the product default (English), not a guessed Russian
    await go(msg(9999, '/homework'));
    expect(lastTextTo(9999)).toContain('Sorry, this command is for a teacher');
  });

  it('collects text, links, photos and documents exactly once and never sends them during collection', async () => {
    await openHomework(['Группа А']);

    const photoUpdate = photoMsg(T_CHAT, 'photo-big', 512_000, 'Схема к задаче');
    await go(msg(T_CHAT, 'стр. 42, упражнение 7'));
    expect(lastTextTo(T_CHAT)).toContain('Получено — 1');
    await go(msg(T_CHAT, 'https://example.com/lesson-7'));
    expect(lastTextTo(T_CHAT)).toContain('Получено — 2');
    await go(photoUpdate);
    expect(lastTextTo(T_CHAT)).toContain('Получено — 3');
    await go(docMsg(T_CHAT, 'doc-1', 'task.pdf', 128_000));
    expect(lastTextTo(T_CHAT)).toContain('Получено — 4');

    // Telegram redelivers the SAME message with a new update_id: nothing is duplicated
    const acks = textsTo(T_CHAT).length;
    await go({ ...photoUpdate, update_id: ++uid });
    expect(textsTo(T_CHAT).length).toBe(acks);

    const draft = (await latestActiveDraft(t.db, teacherId))!;
    expect(draft.status).toBe('collecting');
    expect(await itemCount(t.db, draft.id)).toBe(4);
    const items = await listItems(t.db, draft.id);
    expect(items.map((i) => i.kind)).toEqual(['text', 'link', 'photo', 'document']);
    expect(items[2]!.fileId).toBe('photo-big'); // the largest size wins
    expect(items[3]!.fileName).toBe('task.pdf');

    expect(textsTo(A_CHAT)).toHaveLength(0);
    assertShortCallbacks();
  });

  it('collects on ONE screen with three actions and can be cancelled there', async () => {
    await go(msg(T_CHAT, '/homework'));
    await press('Группа А');
    await press('Продолжить');
    const screen = lastTextTo(T_CHAT);
    expect(screen).toContain('Сбор материалов');
    // the live test complained about screens and buttons; this is the whole screen: three
    // actions, nothing else — Done, the library, Cancel
    expect(lastScreenButtons()).toEqual([
      'Готово — подготовить задание', '📚 Библиотека материалов', 'Отмена',
    ]);
    const draft = (await latestActiveDraft(t.db, teacherId))!;
    expect(draft.status).toBe('collecting');
    expect(textsTo(A_CHAT)).toHaveLength(0);
    assertShortCallbacks();

    // the library opens from here and returns to the same screen
    await press('📚 Библиотека материалов');
    expect(lastTextTo(T_CHAT)).toContain('Для выбранных групп сохранённых материалов нет.');
    expect(lastScreenButtons()).toContain('➕ Загрузить новый материал');
    expect(lastScreenButtons().join('|')).toContain('К заданию');
    await press('К заданию');
    expect(lastScreenButtons()).toEqual([
      'Готово — подготовить задание', '📚 Библиотека материалов', 'Отмена',
    ]);

    await press('Отмена');
    expect(lastTextTo(T_CHAT)).toContain('Черновик отменён');
    expect(await latestActiveDraft(t.db, teacherId)).toBeNull();
  });

  it('formats with the injected AI and shows a preview without publishing', async () => {
    await openHomework(['Группа А']);
    await go(msg(T_CHAT, 'Параграф 12, задачи 3 и 4'));
    await go(photoMsg(T_CHAT, 'photo-big', 200_000, 'Чертёж'));
    await go(docMsg(T_CHAT, 'doc-1', 'task.pdf', 100_000));

    await press('Готово — подготовить задание');
    const screen = lastTextTo(T_CHAT);
    expect(screen).toContain('Предпросмотр задания для групп (1)');
    expect(screen).toContain('Кому: Группа А');
    expect(screen).toContain('ДОМАШНЕЕ ЗАДАНИЕ');
    expect(screen).toContain('Публикация не начнётся без нажатия');
    // the preview names what each group will get as a file
    expect(screen).toContain('📎 «Группа А»');
    expect(screen).toContain('task.pdf');

    expect(ai.requests).toHaveLength(1);
    const req = ai.requests[0]!;
    expect(req.items.map((i) => i.kind)).toEqual(['text', 'photo', 'document']);
    expect(req.instruction).toBe('');
    expect(req.materials).toEqual([]);
    // the file-contents ban is structural: the request object has no bytes to leak
    const wire = JSON.stringify(req);
    expect(wire).not.toContain('fake-image-bytes');
    expect(wire).not.toContain('bytes');
    expect((req as { photos?: unknown }).photos).toBeUndefined();
    expect((req as { unreadableDocuments?: unknown }).unreadableDocuments).toBeUndefined();

    const draft = (await latestActiveDraft(t.db, teacherId))!;
    expect(draft.status).toBe('preview');
    expect(draft.aiProvider).toBe('test-fake');
    expect(textsTo(A_CHAT)).toHaveLength(0);
    assertShortCallbacks();
  });

  it('publishes only on the explicit button, exactly once, and shows history', async () => {
    await openHomework(['Группа А']);
    await go(msg(T_CHAT, 'Упражнение 5'));
    await press('Готово — подготовить задание');
    const draft = (await latestActiveDraft(t.db, teacherId))!;
    const publishToken = button('Опубликовать в группы');

    clearApi();
    await go(rawCb(T_CHAT, publishToken));
    expect(textsTo(A_CHAT)).toEqual([ai.result.formatted]);

    const after = await draftRow(draft.id);
    expect(after.status).toBe('published');
    /*
     * SEC-14 (2026-10-28): «кто и когда раздал задание классам» обязано быть в журнале, и только
     * фактом со счётчиками — ни текста задания, ни названия группы.
     */
    const audited = await waitHomeworkAudit(draft.id);
    expect(audited, 'ровно одна запись на публикацию').toHaveLength(1);
    expect(audited[0]!.actorId).toBe(teacherId);
    expect(audited[0]!.target).toMatchObject({ draftId: draft.id, status: 'published', groups: 1, failed: 0 });
    const wire = JSON.stringify(audited[0]!.target);
    expect(wire, 'текст задания не копируется в журнал').not.toContain(ai.result.formatted);
    expect(wire, 'названия групп не копируются в журнал').not.toContain('Группа А');
    const pubs = await pubsOf(draft.id);
    expect(pubs).toHaveLength(1);
    expect(pubs[0]!.status).toBe('sent');
    expect(lastTextTo(T_CHAT)).toContain('✓ Группа А — отправлено');
    expect(lastTextTo(T_CHAT)).toContain('Готово: задание опубликовано во все выбранные группы');

    // the very same button is one-time: a double press cannot duplicate the send
    await go(rawCb(T_CHAT, publishToken));
    expect(textsTo(A_CHAT)).toHaveLength(1);
    expect(lastTextTo(T_CHAT)).toContain('устарела');

    // and the state machine itself refuses a second publication
    const again = await publishDraft(t.db, api, draft.id, teacherId);
    expect(again.kind).toBe('already');
    expect(textsTo(A_CHAT)).toHaveLength(1);

    await press('История отправок');
    const history = lastTextTo(T_CHAT);
    expect(history).toContain('Последние отправки:');
    expect(history).toContain('Группа А');
    expect(history).toContain('отправлено');
    assertShortCallbacks();
  });

  it('edits the final text and adds materials; buttons from the old preview are refused', async () => {
    await openHomework(['Группа А']);
    await go(msg(T_CHAT, 'Черновой текст'));
    await press('Готово — подготовить задание');
    const stalePublish = button('Опубликовать в группы');
    const staleAdd = button('Добавить материалы');

    await press('Редактировать текст');
    expect(lastTextTo(T_CHAT)).toContain('Пришлите новый текст задания');
    await go(msg(T_CHAT, 'Исправленный текст задания'));
    // the confirmation goes first, then the fresh preview (which is the last message)
    expect(textsTo(T_CHAT).some((text) => text.includes('Текст заменён'))).toBe(true);
    expect(lastTextTo(T_CHAT)).toContain('Исправленный текст задания');
    const draft = (await latestActiveDraft(t.db, teacherId))!;
    expect(draft.status).toBe('preview');
    expect(draft.formattedText).toBe('Исправленный текст задания');

    // the fresh preview still has a usable Add button; capture it before the
    // captured conversation is cleared for the send-count assertions
    const freshAdd = button('Добавить материалы');

    // a publish button rendered before the edit must not send
    clearApi();
    await go(rawCb(T_CHAT, stalePublish));
    expect(textsTo(A_CHAT)).toHaveLength(0);
    expect((await draftRow(draft.id)).status).toBe('preview');
    expect(lastTextTo(T_CHAT)).toContain('повторной отправки не будет');

    // an add button from the same old revision is refused as stale
    await go(rawCb(T_CHAT, staleAdd));
    expect(lastTextTo(T_CHAT)).toContain('устарела');
    expect((await draftRow(draft.id)).status).toBe('preview');

    // the fresh button works and keeps collecting
    await go(rawCb(T_CHAT, freshAdd));
    expect(lastTextTo(T_CHAT)).toContain('Сбор материалов');
    await go(msg(T_CHAT, 'Дополнительно: задача 9'));
    expect(lastTextTo(T_CHAT)).toContain('Получено — 2');

    ai.result = { ...ai.result, formatted: 'ОБНОВЛЁННОЕ ЗАДАНИЕ\n\nвсе материалы' };
    await press('Готово — подготовить задание');
    expect(lastTextTo(T_CHAT)).toContain('ОБНОВЛЁННОЕ ЗАДАНИЕ');
    expect((await draftRow(draft.id)).status).toBe('preview');
  });

  it('recovers a failed formatting attempt and accepts answers to AI clarification', async () => {
    await openHomework(['Группа А']);
    await go(msg(T_CHAT, 'Сделать проект'));

    ai.failNext = true;
    await press('Готово — подготовить задание');
    expect(lastTextTo(T_CHAT)).toContain('Не удалось оформить задание');
    const failedDraft = (await latestActiveDraft(t.db, teacherId))!;
    expect(failedDraft.status).toBe('collecting');
    expect(failedDraft.lastError).not.toBe('');
    expect(await itemCount(t.db, failedDraft.id)).toBe(1); // materials are not lost

    await press('Готово — подготовить задание'); // the fresh Done button in the failure message
    expect(lastTextTo(T_CHAT)).toContain('Предпросмотр задания для групп (1)');

    await press('Отмена');
    expect(lastTextTo(T_CHAT)).toContain('Черновик отменён');

    await openHomework(['Группа А']);
    await go(msg(T_CHAT, 'Сделать проект'));
    ai.result = {
      status: 'needs_clarification', title: 'Проект', formatted: 'Проект',
      questions: ['Какой срок сдачи?'], warnings: [], provider: 'test-fake',
    };
    await press('Готово — подготовить задание');
    expect(lastTextTo(T_CHAT)).toContain('Нужно уточнение');
    expect(lastTextTo(T_CHAT)).toContain('Какой срок сдачи?');

    // the answer becomes another material; nothing is published at this point
    await go(msg(T_CHAT, 'Срок — пятница'));
    expect(lastTextTo(T_CHAT)).toContain('Получено — 2');
    const clarified = (await latestActiveDraft(t.db, teacherId))!;
    expect(clarified.status).toBe('needs_clarification');

    ai.result = {
      status: 'ok', title: 'Проект', formatted: 'ПРОЕКТ\n\nСрок — пятница',
      questions: [], warnings: [], provider: 'test-fake',
    };
    await press('Готово — подготовить задание');
    expect(lastTextTo(T_CHAT)).toContain('Предпросмотр задания для групп (1)');
    expect(textsTo(A_CHAT)).toHaveLength(0);
  });

  it('retries only a definite refusal; an ambiguous failure is never retried', async () => {
    await openHomework(['Группа А', 'Группа Б']);
    await go(msg(T_CHAT, 'Задание для двух групп'));
    await press('Готово — подготовить задание');
    const first = (await latestActiveDraft(t.db, teacherId))!;
    const publishToken = button('Опубликовать в группы');

    // Telegram refuses group B with 403: nothing was delivered there
    api.rejectChats.add(String(B_CHAT));
    clearApi();
    await go(rawCb(T_CHAT, publishToken));
    expect(textsTo(A_CHAT)).toHaveLength(1);
    expect(textsTo(B_CHAT)).toHaveLength(0);
    // each group gets its own honest line — not one number for the whole run
    expect(lastTextTo(T_CHAT)).toContain('✓ Группа А — отправлено');
    expect(lastTextTo(T_CHAT)).toContain('✗ Группа Б — ошибка');
    let rows = await pubsOf(first.id);
    expect(rows.find((r) => r.telegramChatId === String(B_CHAT))?.status).toBe('failed');
    expect((await draftRow(first.id)).status).toBe('failed');
    expect(lastScreenButtons()).toContain('Повторить неудачные');

    const retryToken = button('Повторить неудачные');
    api.rejectChats.delete(String(B_CHAT));
    clearApi();
    await go(rawCb(T_CHAT, retryToken));
    expect(textsTo(A_CHAT)).toHaveLength(0); // a delivered group is not sent again
    expect(textsTo(B_CHAT)).toHaveLength(1);
    expect(lastTextTo(T_CHAT)).toContain('✓ Группа Б — отправлено');
    expect((await draftRow(first.id)).status).toBe('published');
    rows = await pubsOf(first.id);
    // attempts counts the first send too: one refusal + one retry
    expect(rows.find((r) => r.telegramChatId === String(B_CHAT))?.attempts).toBe(2);

    // second scenario: the transport breaks in a way that does not prove a refusal
    await openHomework(['Группа А']);
    await go(msg(T_CHAT, 'Неоднозначная отправка'));
    await press('Готово — подготовить задание');
    const second = (await latestActiveDraft(t.db, teacherId))!;
    const publish2 = button('Опубликовать в группы');
    api.failChats.add(String(A_CHAT));
    clearApi();
    await go(rawCb(T_CHAT, publish2));
    expect(lastTextTo(T_CHAT)).toContain('статус доставки неизвестен');
    expect(lastScreenButtons()).not.toContain('Повторить неудачные');
    expect((await draftRow(second.id)).status).toBe('publish_unknown');
    const uncertainRows = await pubsOf(second.id);
    expect(uncertainRows).toHaveLength(1);
    expect(uncertainRows[0]!.status).toBe('uncertain');
    expect(canRetry(uncertainRows)).toBe(false);

    // even a direct API call cannot turn uncertainty into a duplicate send
    api.failChats.delete(String(A_CHAT));
    clearApi();
    const retry = await retryFailedPublications(t.db, api, second.id, teacherId);
    expect(retry.kind).toBe('noTargets');
    expect(textsTo(A_CHAT)).toHaveLength(0);
  });

  it('returns a stuck formatting pass to collecting, but never a half-sent publication', async () => {
    // this is the restart path: the process died mid-format or mid-publish, and the boot
    // sweep has to guess the safest thing. A stuck format is harmless to undo; a stuck
    // publication may already be in front of the class, so it must NOT become retryable.
    const { sweepHomeworkState } = await import('../../src/services/homework/store.js');
    const { FORMATTING_STALE_MS, PUBLISHING_STALE_MS } = await import('../../src/services/homework/constants.js');
    const old = (ms: number) => new Date(Date.now() - ms - 60_000);

    const stuck = await createDraft(t.db, teacherId);
    await transitionDraft(t.db, stuck.id, teacherId, ['selecting'], 'formatting');
    await t.db.update(tgDrafts).set({ updatedAt: old(FORMATTING_STALE_MS) })
      .where(eq(tgDrafts.id, stuck.id));

    const halfSent = await createDraft(t.db, teacherId);
    await transitionDraft(t.db, halfSent.id, teacherId, ['selecting'], 'preview');
    await transitionDraft(t.db, halfSent.id, teacherId, ['preview'], 'publishing');
    await t.db.insert(tgPublications).values({
      draftId: halfSent.id, groupId: (await groupRow(String(A_CHAT))).id, groupTitle: 'Группа А',
      telegramChatId: String(A_CHAT), status: 'sending',
    });
    await t.db.update(tgDrafts).set({ updatedAt: old(PUBLISHING_STALE_MS) })
      .where(eq(tgDrafts.id, halfSent.id));
    await t.db.update(tgPublications).set({ updatedAt: old(PUBLISHING_STALE_MS) })
      .where(eq(tgPublications.draftId, halfSent.id));

    // a format that is merely slow must not be touched
    const running = await createDraft(t.db, teacherId);
    await transitionDraft(t.db, running.id, teacherId, ['selecting'], 'formatting');

    await sweepHomeworkState(t.db);

    expect((await draftRow(stuck.id)).status).toBe('collecting');
    expect((await draftRow(stuck.id)).lastError).toContain('interrupted');
    expect((await draftRow(running.id)).status).toBe('formatting');
    expect((await draftRow(halfSent.id)).status).toBe('publish_unknown');
    const rows = await pubsOf(halfSent.id);
    expect(rows[0]!.status).toBe('uncertain');
    // and it is not silently retryable
    api.calls.length = 0;
    const retry = await retryFailedPublications(t.db, api, halfSent.id, teacherId);
    expect(retry.kind).toBe('noTargets');
    expect(textsTo(A_CHAT)).toHaveLength(0);
  });

  it('lets a re-linked account take over the same Telegram chat', async () => {
    // the operator row is keyed by the CHAT as well as the user: when a chat is unlinked and
    // linked to another BluBlu account, /homework must work for the new owner instead of
    // throwing on the unique chat key on every press
    await go(msg(T_CHAT, '/homework'));
    expect(lastTextTo(T_CHAT)).toContain('Домашнее задание. Выберите группы');

    await t.db.delete(telegramLinks).where(eq(telegramLinks.chatId, String(T_CHAT)));
    const second = await makeTeacher(t.sql, `hwre${Date.now()}@x.io`);
    await t.db.insert(telegramLinks).values({ userId: second.id, chatId: String(T_CHAT) });

    api.calls.length = 0;
    await go(msg(T_CHAT, '/homework'));
    const screen = lastTextTo(T_CHAT);
    expect(screen).toContain('Домашнее задание. Выберите группы');
    // the new owner starts clean: the previous teacher's groups are not hers
    expect(screen).toContain('Пока нет подключённых групп');
    expect(await t.db.select().from(tgDrafts).where(eq(tgDrafts.ownerId, second.id))).toHaveLength(1);
  });

  it('keeps callback_data under 64 bytes and splits long publications below the Telegram limit', async () => {
    await openHomework(['Группа А']);
    assertShortCallbacks();

    const long = 'x'.repeat(9_000);
    const chunks = splitText(long);
    expect(chunks).toHaveLength(3);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(3_800);
    expect(chunks.join('')).toBe(long);

    const withNewline = `${'a'.repeat(3_000)}\n${'b'.repeat(2_000)}`;
    const [first, second] = splitText(withNewline);
    expect(first).toBe('a'.repeat(3_000));
    expect(second).toBe('b'.repeat(2_000));
  });
});
