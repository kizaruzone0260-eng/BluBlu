/**
 * The teacher's material library — integration tests through the real dispatcher, the real
 * Postgres and a capturing Telegram transport (no bot token, no AI key, no network).
 *
 * The product rules proven here:
 *  • a book is uploaded ONCE and re-used as an attachment in every later homework;
 *  • recommendations belong to a group: a book of group A is never offered to group B, and a
 *    homework for two groups only offers what both of them may receive;
 *  • the formatter never sees file contents — titles and the teacher's own words only;
 *  • uploading to the library sends nothing to any group; publication still needs the
 *    explicit confirmation;
 *  • archiving removes a book from NEW homeworks and keeps past sends readable; deleting a
 *    material does not rewrite history either;
 *  • an attachment is COPIED out of the teacher's own message, so its type is never guessed;
 *  • a file Telegram refuses is reported as that one part failing, after the parts that did
 *    arrive — never as «nothing was sent» (live test 2026-10-23);
 *  • only the owner can add, rename, link, archive or delete her materials.
 *
 * Each test gets its own teacher and private chat: the dispatcher's in-process rate limit
 * (20 callbacks/minute per chat) is itself a product rule, and these screens press a lot.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { TEST_DATABASE_URL, preparedDb, makeTeacher, acceptPolicy, type TestDB } from './util.js';
import {
  tgDraftMaterials, tgDrafts, tgGroups, tgMaterialGroups, tgMaterials, tgPublications,
  telegramLinks, users,
} from '../../src/db/schema.js';
import { handleUpdate, type BotDeps, type TgUpdate } from '../../src/services/bot.js';
import { CapturingApi } from '../../src/services/botApi.js';
import { hashPassword } from '../../src/lib/password.js';
import { addGroup, latestActiveDraft } from '../../src/services/homework/store.js';
import {
  deleteMaterial, eligibleMaterials, getMaterial, linkMaterialGroup, listDraftMaterials,
  markMaterialsUsed, renameMaterial, saveMaterial, toggleDraftMaterial,
} from '../../src/services/homework/libraryStore.js';
import { makeHomeworkCallback } from '../../src/services/homework/tokens.js';
import type { HwAiRequest, HwAiResult, HwMaterialKind, HomeworkAi } from '../../src/services/homework/types.js';

const suite = TEST_DATABASE_URL ? describe : describe.skip;

const A_CHAT = '-1001';
const B_CHAT = '-1002';
const S_CHAT = 712; // a student
const F_CHAT = 713; // another teacher

class FakeAi implements HomeworkAi {
  requests: HwAiRequest[] = [];
  result: HwAiResult = {
    status: 'ok', title: 'Grammar', formatted: 'ЗАДАНИЕ: —',
    questions: [], warnings: [], provider: 'test-fake',
  };

  /**
   * The teacher's own words are the task. Since the simplified flow she types them into the
   * collecting screen (they arrive as a text material), so the fake reads them from the items
   * when there is no separate instruction.
   */
  async format(req: HwAiRequest): Promise<HwAiResult> {
    this.requests.push(req);
    const words = req.instruction || req.items.find((i) => i.kind === 'text')?.text || '';
    return { ...this.result, formatted: `ЗАДАНИЕ: ${words || '—'}` };
  }
}

suite('telegram material library', () => {
  let t: TestDB;
  let api: CapturingApi;
  let deps: BotDeps;
  let ai: FakeAi;
  let teacherId = '';
  let foreignId = '';
  let T_CHAT = 0;
  let uid = 0;
  let msgId = 0;
  let seq = 0;

  // ─── Telegram fixtures ─────────────────────────────────────────────────────

  const rawCb = (chatId: number | string, data: string): TgUpdate => ({
    update_id: ++uid,
    callback_query: {
      id: `q${uid}`,
      from: { id: Number(chatId) },
      message: { message_id: 5, chat: { id: Number(chatId), type: 'private' } },
      data,
    },
  });

  const msg = (chatId: number | string, text: string): TgUpdate => ({
    update_id: ++uid,
    message: {
      message_id: ++msgId,
      chat: { id: Number(chatId), type: 'private' },
      from: { id: Number(chatId), first_name: 'Teacher' },
      text,
    },
  });

  const docMsg = (
    chatId: number | string, fileId: string, name: string, size = 3_000_000,
    mime = 'application/pdf', caption?: string,
  ): TgUpdate => ({
    update_id: ++uid,
    message: {
      message_id: ++msgId,
      chat: { id: Number(chatId), type: 'private' },
      from: { id: Number(chatId) },
      document: {
        file_id: fileId, file_unique_id: `${fileId}-u`, file_name: name,
        mime_type: mime, file_size: size,
      },
      ...(caption ? { caption } : {}),
    },
  });

  const photoMsg = (chatId: number | string, fileId: string, caption?: string): TgUpdate => ({
    update_id: ++uid,
    message: {
      message_id: ++msgId,
      chat: { id: Number(chatId), type: 'private' },
      from: { id: Number(chatId) },
      photo: [
        { file_id: `${fileId}-s`, file_unique_id: `${fileId}-su-s`, width: 90, height: 90, file_size: 900 },
        { file_id: fileId, file_unique_id: `${fileId}-su`, width: 1600, height: 1200, file_size: 2_000_000 },
      ],
      ...(caption ? { caption } : {}),
    },
  });

  // ─── reading the captured conversation ─────────────────────────────────────

  const go = async (u: TgUpdate) => { await handleUpdate(deps, u); };
  const callsTo = (chatId: number | string) => api.calls.filter((c) => c.chatId === String(chatId));
  const textsTo = (chatId: number | string) => callsTo(chatId)
    .filter((c) => c.text !== undefined).map((c) => c.text as string);
  const lastTextTo = (chatId: number | string) => textsTo(chatId)[textsTo(chatId).length - 1] ?? '';
  const saidAtSomePoint = (chatId: number | string, needle: string) =>
    textsTo(chatId).some((text) => text.includes(needle));
  const clearApi = () => { api.calls.length = 0; };

  function button(label: string, chatId: number | string = T_CHAT): string {
    for (let i = api.calls.length - 1; i >= 0; i--) {
      const call = api.calls[i]!;
      if (call.chatId !== String(chatId)) continue;
      for (const row of call.opts?.buttons ?? []) {
        for (const item of row) if (item.cb && item.text.includes(label)) return item.cb;
      }
    }
    throw new Error(`button "${label}" not found for chat ${chatId}`);
  }

  const press = async (label: string, chatId: number | string = T_CHAT) => {
    await go(rawCb(chatId, button(label, chatId)));
  };

  function lastScreenButtons(): string[] {
    for (let i = api.calls.length - 1; i >= 0; i--) {
      const buttons = api.calls[i]?.opts?.buttons;
      if (buttons?.length) return buttons.flat().map((item) => item.text);
    }
    return [];
  }

  const hasButton = (needle: string) => lastScreenButtons().some((text) => text.includes(needle));

  function assertShortCallbacks(): void {
    for (const item of api.calls.flatMap((c) => c.opts?.buttons?.flat() ?? [])) {
      if (!item.cb) continue;
      expect(Buffer.byteLength(item.cb, 'utf8')).toBeLessThanOrEqual(64);
      expect(item.cb.startsWith('h1.')).toBe(true);
    }
  }

  const sendsTo = (chatId: number | string) => callsTo(chatId).filter((c) => c.kind === 'send');
  const docsTo = (chatId: number | string) => callsTo(chatId).filter((c) => c.kind === 'doc');
  const photosTo = (chatId: number | string) => callsTo(chatId).filter((c) => c.kind === 'photo');
  /** Copies are the preferred send: the original message is re-posted, no bytes move. */
  const copiesTo = (chatId: number | string) => callsTo(chatId).filter((c) => c.kind === 'copy');
  const copiesManyTo = (chatId: number | string) => callsTo(chatId).filter((c) => c.kind === 'copyMany');

  // ─── database helpers ──────────────────────────────────────────────────────

  const groupOf = async (telegramChatId: string) => {
    const [row] = await t.db.select().from(tgGroups).where(and(
      eq(tgGroups.ownerId, teacherId), eq(tgGroups.telegramChatId, telegramChatId),
    ));
    return row!;
  };

  const materialsOfTeacher = () => materialsOf();
  async function materialsOf() {
    return t.db.select().from(tgMaterials).where(eq(tgMaterials.ownerId, teacherId));
  }
  const materialByTitle = async (title: string) => {
    const [row] = await t.db.select().from(tgMaterials).where(and(
      eq(tgMaterials.ownerId, teacherId), eq(tgMaterials.title, title),
    ));
    return row ?? null;
  };
  const draftStatus = async (id: string) =>
    (await (await t.db.select().from(tgDrafts).where(eq(tgDrafts.id, id)))[0])?.status;

  /** Seed a library row without walking the UI (the UI path is covered by its own tests). */
  async function seedMaterial(
    title: string, fileId: string, chatIds: string[], kind: HwMaterialKind = 'book',
    fileName = `${title}.pdf`, mime = 'application/pdf',
  ) {
    const groupIds = [];
    for (const c of chatIds) groupIds.push((await groupOf(c)).id);
    const res = await saveMaterial(t.db, teacherId, {
      title, kind, fileId, fileUniqueId: `${fileId}-u`, fileName, mimeType: mime,
      fileSize: 3_000_000, groupIds,
    });
    if (res.status !== 'created' && res.status !== 'updated') {
      throw new Error(`seed failed: ${res.status}`);
    }
    return res.row;
  }

  /** /homework → groups → Continue → 📚 Materials → tick books → back → she writes her words. */
  async function startHomeworkWithBooks(groups: string[], books: string[], instruction: string) {
    await go(msg(T_CHAT, '/homework'));
    for (const g of groups) await press(g);
    await press('Продолжить');
    await press('📚 Библиотека материалов');
    for (const book of books) await press(book);
    await press('К заданию');
    await go(msg(T_CHAT, instruction));
  }

  /** The whole add dialog: group → file → title → type → save. */
  async function addViaUi(title: string, groupLabel: string, file: TgUpdate, kindLabel = 'Книга') {
    await press('Добавить материал');
    await press(groupLabel);
    await press('✅ Продолжить (');
    await go(file);
    await go(msg(T_CHAT, title));
    await press(kindLabel);
    await press('Сохранить в библиотеку');
  }

  // ─── lifecycle ─────────────────────────────────────────────────────────────

  beforeAll(async () => {
    t = await preparedDb(TEST_DATABASE_URL);
    const foreign = await makeTeacher(t.sql, `libF${Date.now()}@x.io`);
    foreignId = foreign.id;
    const [stu] = await t.db.insert(users).values({
      role: 'student', name: 'Азиз', email: `libS${Date.now()}@x.io`,
      passwordHash: await hashPassword('Secret1234'),
      locale: 'ru', localeExplicit: true, profileCompletedAt: new Date(),
    }).returning();
    await acceptPolicy(t.sql, stu!.id);
    await t.db.insert(telegramLinks).values([
      { userId: stu!.id, chatId: String(S_CHAT) },
      { userId: foreignId, chatId: String(F_CHAT) },
    ]);
  });

  afterAll(async () => { await t?.sql.end(); });

  beforeEach(async () => {
    seq++;
    const teacher = await makeTeacher(t.sql, `lib${Date.now()}-${seq}@x.io`);
    teacherId = teacher.id;
    T_CHAT = 8200 + seq;
    await t.db.insert(telegramLinks).values({ userId: teacherId, chatId: String(T_CHAT) });
    await addGroup(t.db, teacherId, A_CHAT, 'IELTS B2');
    await addGroup(t.db, teacherId, B_CHAT, 'Grammar A2');
    api = new CapturingApi();
    ai = new FakeAi();
    deps = { db: t.db, api, isGroupAdmin: async () => false, homeworkAi: ai };
    uid = 20_000_000 + seq * 100_000;
    msgId = 100;
  });

  // ─── tests ─────────────────────────────────────────────────────────────────

  it('is teacher-only, and the existing /materials command still serves BluBlu classes', async () => {
    await go(msg(S_CHAT, '/library'));
    expect(lastTextTo(S_CHAT)).toContain('только учителю');

    await go(msg(9911, '/library'));
    expect(lastTextTo(9911)).toContain('Sorry, this command is for a teacher');

    // a foreign teacher cannot consume the owner's library button, and cannot reach her rows
    const token = await makeHomeworkCallback(t.db, teacherId, { a: 'lib', x: 'manage' });
    await go(rawCb(F_CHAT, token));
    expect(lastTextTo(F_CHAT)).toContain('устарела');
    await go(rawCb(T_CHAT, token));
    expect(lastTextTo(T_CHAT)).toContain('Управление материалами');

    // /materials is the OLD command, for class materials: untouched by this feature
    await go(msg(T_CHAT, '/materials'));
    expect(lastTextTo(T_CHAT)).toContain('У вас пока нет классов.');
    await go(msg(S_CHAT, '/materials'));
    expect(lastTextTo(S_CHAT)).toContain('только учителю');
    assertShortCallbacks();
  });

  it('adds a book through the dialog, links it to the chosen group and sends nothing anywhere', async () => {
    await go(msg(T_CHAT, '/library'));
    expect(lastTextTo(T_CHAT)).toContain('Библиотека материалов.');
    expect(lastTextTo(T_CHAT)).toContain('содержимое нигде не анализируется');
    await addViaUi('English Grammar in Use', 'IELTS B2',
      docMsg(T_CHAT, 'egau-file', 'English Grammar in Use 5th.pdf'));

    const row = await materialByTitle('English Grammar in Use');
    expect(row).not.toBeNull();
    expect(row!.kind).toBe('book');
    expect(row!.telegramFileId).toBe('egau-file');
    expect(row!.fileUniqueId).toBe('egau-file-u');
    expect(row!.fileName).toBe('English Grammar in Use 5th.pdf');
    expect(row!.mimeType).toBe('application/pdf');
    expect(row!.status).toBe('active');
    expect(row!.lastUsedAt).toBeNull();
    const [link] = await t.db.select().from(tgMaterialGroups)
      .where(eq(tgMaterialGroups.materialId, row!.id));
    expect(link?.groupId).toBe((await groupOf(A_CHAT)).id);
    expect(lastTextTo(T_CHAT)).toContain('сохранён и доступен для повторного использования');

    // nothing reached a study group — the library is not a publication channel
    expect(textsTo(A_CHAT)).toHaveLength(0);
    expect(textsTo(B_CHAT)).toHaveLength(0);
    expect(docsTo(A_CHAT)).toHaveLength(0);

    // «Материалы моих групп» shows the counts, then the list of one group
    clearApi();
    await go(msg(T_CHAT, '/library'));
    await press('Материалы моих групп');
    expect(lastTextTo(T_CHAT)).toContain('IELTS B2 — 1');
    expect(lastTextTo(T_CHAT)).toContain('Grammar A2 — 0');
    await press('IELTS B2');
    expect(lastTextTo(T_CHAT)).toContain('English Grammar in Use');
    assertShortCallbacks();
  });

  it('refuses a non-file, repairs a long title, keeps one row per file and two rows per book', async () => {
    await go(msg(T_CHAT, '/library'));
    await press('Добавить материал');
    await press('IELTS B2');
    await press('✅ Продолжить (');
    await go(msg(T_CHAT, 'это не файл'));
    expect(lastTextTo(T_CHAT)).toContain('Это не файл');
    await go(photoMsg(T_CHAT, 'big-photo'));
    expect(lastTextTo(T_CHAT)).toContain('Как назвать материал?');
    await go(msg(T_CHAT, 'x'.repeat(200)));
    expect(lastTextTo(T_CHAT)).toContain('Название должно быть 1–140 символов');
    await go(msg(T_CHAT, 'Cambridge IELTS 18'));
    await press('Книга');
    // a photo has no file name: the suggestion is dated, never invented content
    expect(saidAtSomePoint(T_CHAT, 'Предложено: ')).toBe(true);
    await press('Сохранить в библиотеку');
    expect(await materialByTitle('Cambridge IELTS 18')).not.toBeNull();

    // the same file once more with a new title: one row, updated, no duplicate
    await go(msg(T_CHAT, '/library'));
    await addViaUi('Cambridge IELTS 18 (new cover)', 'IELTS B2', photoMsg(T_CHAT, 'big-photo'));
    const rows = await materialsOfTeacher();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.title).toBe('Cambridge IELTS 18 (new cover)');
    expect(lastTextTo(T_CHAT)).toContain('дубликат не создали');

    // same title, different file — those really are two books, both kept
    await go(msg(T_CHAT, '/library'));
    await addViaUi('Cambridge IELTS 18 (new cover)', 'Grammar A2',
      docMsg(T_CHAT, 'other-file', 'another.pdf'));
    expect(await materialsOfTeacher()).toHaveLength(2);
    expect(textsTo(A_CHAT)).toHaveLength(0);
  });

  it('recommends a book only to the groups it belongs to', async () => {
    await seedMaterial('Essential Grammar in Use', 'egiu-file', [B_CHAT]);

    // group B alone: offered
    await go(msg(T_CHAT, '/homework'));
    await press('Grammar A2');
    await press('Продолжить');
    await press('📚 Библиотека материалов');
    expect(hasButton('Essential Grammar in Use')).toBe(true);
    await press('Отмена');

    // group A alone: the same book is not a recommendation for it
    await go(msg(T_CHAT, '/homework'));
    await press('IELTS B2');
    await press('Продолжить');
    await press('📚 Библиотека материалов');
    expect(lastTextTo(T_CHAT)).toContain('Для выбранных групп сохранённых материалов нет.');
    expect(hasButton('Essential Grammar in Use')).toBe(false);
    // an empty library is not a dead end: back to collecting, nothing forces a book
    await press('К заданию');
    expect(lastTextTo(T_CHAT)).toContain('Сбор материалов');

    // A + B together: only books attached to BOTH may go to both groups
    await go(msg(T_CHAT, '/homework'));
    await press('IELTS B2');
    await press('Grammar A2');
    await press('Продолжить');
    await press('📚 Библиотека материалов');
    expect(lastTextTo(T_CHAT)).toContain('Для выбранных групп сохранённых материалов нет.');
    await press('К заданию');
    const draft = (await latestActiveDraft(t.db, teacherId))!;
    expect(draft.status).toBe('collecting');
  });

  it('uses a saved book, publishes it as an attachment, and re-uses it without re-uploading', async () => {
    const book = await seedMaterial('English Grammar in Use', 'egau-file', [A_CHAT]);

    // first homework: Unit 1
    await startHomeworkWithBooks(['IELTS B2'], ['English Grammar in Use'], 'Unit 1');
    expect(saidAtSomePoint(T_CHAT, 'Получено — 1')).toBe(true);
    expect(saidAtSomePoint(T_CHAT, 'Сбор материалов')).toBe(true);
    await press('Готово — подготовить задание');
    const preview = lastTextTo(T_CHAT);
    expect(preview).toContain('Материалы: English Grammar in Use');
    expect(preview).toContain('ЗАДАНИЕ: Unit 1');
    expect(preview).toContain('📎 «IELTS B2» — 📕 Книга: English Grammar in Use');

    // what the formatter was given — and what it was NOT given
    expect(ai.requests).toHaveLength(1);
    const req = ai.requests[0]!;
    expect(req.items.map((i) => i.kind)).toEqual(['text']);
    expect(req.items[0]!.text).toBe('Unit 1');
    expect(req.materials).toEqual([{
      title: 'English Grammar in Use', kind: 'book', fileName: 'English Grammar in Use.pdf',
    }]);
    expect(JSON.stringify(req)).not.toContain('bytes');
    expect((req as { photos?: unknown }).photos).toBeUndefined();
    expect('downloadFile' in api).toBe(false); // the transport cannot even fetch a file

    const draft = (await latestActiveDraft(t.db, teacherId))!;
    const snapshots = await listDraftMaterials(t.db, draft.id);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]!.materialId).toBe(book.id);
    expect(snapshots[0]!.telegramFileId).toBe('egau-file');

    // the token must be taken BEFORE the conversation is cleared: clearing removes the very
    // screen the publish button lives on
    const publishToken = button('Опубликовать в группы');
    clearApi();
    await go(rawCb(T_CHAT, publishToken));
    expect(sendsTo(A_CHAT).map((c) => c.text)).toEqual(['ЗАДАНИЕ: Unit 1']);
    expect(docsTo(A_CHAT).map((c) => c.fileId)).toEqual(['egau-file']);
    expect(await draftStatus(draft.id)).toBe('published');
    const [pub] = await t.db.select().from(tgPublications).where(eq(tgPublications.draftId, draft.id));
    expect(pub?.status).toBe('sent');
    expect((await materialByTitle('English Grammar in Use'))!.lastUsedAt).toBeInstanceOf(Date);

    // second homework in the same group: the book is offered again, no re-upload
    await press('Новое задание');
    await press('IELTS B2');
    await press('Продолжить');
    await press('📚 Библиотека материалов');
    expect(hasButton('English Grammar in Use')).toBe(true);
    await press('English Grammar in Use');
    await press('К заданию');
    await go(msg(T_CHAT, 'Unit 2, Exercises 1–5'));
    await press('Готово — подготовить задание');
    expect(lastTextTo(T_CHAT)).toContain('ЗАДАНИЕ: Unit 2, Exercises 1–5');
    const second = (await latestActiveDraft(t.db, teacherId))!;
    expect(second.id).not.toBe(draft.id);

    // the token must be taken BEFORE the conversation is cleared: clearing removes the very
    // screen the publish button lives on
    const secondPublishToken = button('Опубликовать в группы');
    clearApi();
    await go(rawCb(T_CHAT, secondPublishToken));
    expect(sendsTo(A_CHAT).map((c) => c.text)).toEqual(['ЗАДАНИЕ: Unit 2, Exercises 1–5']);
    expect(docsTo(A_CHAT).map((c) => c.fileId)).toEqual(['egau-file']);
    expect(await materialsOfTeacher()).toHaveLength(1); // still one book, two homeworks

    // the first publication is still in the history after the new draft
    await press('История отправок');
    const history = lastTextTo(T_CHAT);
    expect(history).toContain('IELTS B2');
    expect(history).toContain('отправлено');
    assertShortCallbacks();
  });

  it('reports a refused attachment as THAT part, and a retry re-sends only the file', async () => {
    // This is the live scenario of 2026-10-23: the homework text reached the group, the file
    // did not. The old answer was «Publication result (0 of 1 sent)», which was simply untrue.
    await seedMaterial('Cambridge IELTS 18', 'dead-file', [A_CHAT]);
    await startHomeworkWithBooks(['IELTS B2'], ['Cambridge IELTS 18'], 'Unit 3');
    await press('Готово — подготовить задание');
    const draft = (await latestActiveDraft(t.db, teacherId))!;

    const publishToken = button('Опубликовать в группы');
    clearApi();
    api.rejectDocumentChats.add(A_CHAT);
    await go(rawCb(T_CHAT, publishToken));

    // the text really arrived, the file really did not — and that is what the screen says
    expect(sendsTo(A_CHAT)).toHaveLength(1);
    expect(docsTo(A_CHAT)).toHaveLength(0); // refused before it became a message: nothing recorded
    expect(lastTextTo(T_CHAT)).toContain('⚠ IELTS B2 — доставлено 1, не доставлено 1');
    expect(lastTextTo(T_CHAT)).toContain('• текст — отправлено');
    expect(lastTextTo(T_CHAT)).toContain('• Cambridge IELTS 18 — не отправлено');
    expect(saidAtSomePoint(T_CHAT, 'пришлите его снова')).toBe(true);
    const row1 = await t.db.select().from(tgPublications).where(eq(tgPublications.draftId, draft.id));
    expect(row1[0]!.status).toBe('uncertain');
    expect(row1[0]!.parts.map((p) => `${p.kind}:${p.status}`)).toEqual(['text:sent', 'material:failed']);
    expect(await draftStatus(draft.id)).toBe('publish_unknown');
    // the library row is untouched: it needs a new upload, not a purge
    expect((await materialByTitle('Cambridge IELTS 18'))!.telegramFileId).toBe('dead-file');

    // the retry button appears because every part has a DEFINITE outcome — and it sends only
    // the missing file: the group never gets a second copy of the same homework text
    expect(hasButton('Повторить неудачные')).toBe(true);
    api.rejectDocumentChats.delete(A_CHAT);
    // the token must be taken BEFORE the conversation is cleared: clearing removes the very
    // screen the retry button lives on
    const retryToken = button('Повторить неудачные');
    clearApi();
    await go(rawCb(T_CHAT, retryToken));
    expect(sendsTo(A_CHAT)).toHaveLength(0);
    expect(docsTo(A_CHAT).map((c) => c.fileId)).toEqual(['dead-file']);
    const row2 = await t.db.select().from(tgPublications).where(eq(tgPublications.draftId, draft.id));
    expect(row2[0]!.status).toBe('sent');
    expect(row2[0]!.attempts).toBe(2);
    expect(await draftStatus(draft.id)).toBe('published');

    // the same upload path repairs the library row in place: the file_id is replaced, not the book
    const repaired = await saveMaterial(t.db, teacherId, {
      title: 'Cambridge IELTS 18', kind: 'book', fileId: 'fresh-file',
      fileUniqueId: 'dead-file-u', fileName: 'Cambridge IELTS 18.pdf',
      mimeType: 'application/pdf', fileSize: 3_000_000, groupIds: [(await groupOf(A_CHAT)).id],
    });
    expect(repaired.status).toBe('updated');
    expect((await materialByTitle('Cambridge IELTS 18'))!.telegramFileId).toBe('fresh-file');
    expect(await materialsOfTeacher()).toHaveLength(1);
    assertShortCallbacks();
  });

  it('reports an unknown outcome when an attachment fails mid-send and keeps the library', async () => {
    await seedMaterial('Workbook 1', 'wb-file', [A_CHAT], 'workbook', 'Workbook 1.docx',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    await startHomeworkWithBooks(['IELTS B2'], ['Workbook 1'], 'Pages 24–27');
    await press('Готово — подготовить задание');
    const draft = (await latestActiveDraft(t.db, teacherId))!;
    api.failDocumentChats.add(A_CHAT);

    // the token must be taken BEFORE the conversation is cleared: clearing removes the very
    // screen the publish button lives on
    const publishToken = button('Опубликовать в группы');
    clearApi();
    await go(rawCb(T_CHAT, publishToken));
    // the text went out, the file may or may not have: unknown, and never silently retried
    expect(sendsTo(A_CHAT)).toHaveLength(1);
    expect(lastTextTo(T_CHAT)).toContain('статус доставки неизвестен');
    expect(lastTextTo(T_CHAT)).toContain('• Workbook 1');
    expect(hasButton('Повторить неудачные')).toBe(false);
    const [pub] = await t.db.select().from(tgPublications).where(eq(tgPublications.draftId, draft.id));
    expect(pub?.status).toBe('uncertain');
    const row = await materialByTitle('Workbook 1');
    expect(row).not.toBeNull();
    expect(row!.status).toBe('active');
    assertShortCallbacks();
  });

  it('uploads a new book in the middle of a homework and attaches it at once', async () => {
    await go(msg(T_CHAT, '/homework'));
    await press('IELTS B2');
    await press('Продолжить');
    await press('📚 Библиотека материалов');
    await press('Загрузить новый материал');
    expect(lastTextTo(T_CHAT)).toContain('Пришлите файл одним сообщением');
    const upload = docMsg(T_CHAT, 'unit-file', 'My grammar book.pdf');
    const uploadMessageId = (upload.message as { message_id: number }).message_id;
    await go(upload);
    expect(lastTextTo(T_CHAT)).toContain('Предложено: My grammar book');
    await go(msg(T_CHAT, 'Grammar in Use — Local Edition'));
    await press('Рабочая тетрадь');
    expect(lastTextTo(T_CHAT)).toContain('Группы зафиксированы');
    await press('Сохранить в библиотеку');
    expect(lastTextTo(T_CHAT)).toContain('добавлен в библиотеку и выбран для этого задания');
    expect(textsTo(A_CHAT)).toHaveLength(0); // nothing published while filing a book

    // one button back, and she is on the same collecting screen she left
    await press('К заданию');
    expect(lastTextTo(T_CHAT)).toContain('Сбор материалов');
    await go(msg(T_CHAT, 'Unit 4'));
    await press('Готово — подготовить задание');
    expect(lastTextTo(T_CHAT)).toContain('Материалы: Grammar in Use — Local Edition');
    const draft = (await latestActiveDraft(t.db, teacherId))!;
    expect(draft.status).toBe('preview');
    // her own words are a collected material now, not a separate screen
    expect(ai.requests[0]!.items.filter((i) => i.kind === 'text').map((i) => i.text)).toEqual(['Unit 4']);
    expect(ai.requests[0]!.materials[0]!.kind).toBe('workbook');

    // the token must be taken BEFORE the conversation is cleared: clearing removes the very
    // screen the publish button lives on
    const publishToken = button('Опубликовать в группы');
    clearApi();
    await go(rawCb(T_CHAT, publishToken));
    // the book was uploaded in THIS chat, so it is copied from that message — no re-upload
    expect(copiesTo(A_CHAT).map((c) => `${c.fromChatId}:${c.messageId}`))
      .toEqual([`${T_CHAT}:${uploadMessageId}`]);
    expect(docsTo(A_CHAT)).toHaveLength(0);
    const book = await materialByTitle('Grammar in Use — Local Edition');
    expect(book!.kind).toBe('workbook');
    expect(book!.lastUsedAt).toBeInstanceOf(Date);
    assertShortCallbacks();
  });

  it('renames, links to another group, archives and deletes without touching history', async () => {
    const book = await seedMaterial('Old Title', 'old-file', [A_CHAT]);

    // a draft that already chose it keeps the title it was chosen with
    const [draft] = await t.db.insert(tgDrafts).values({ ownerId: teacherId, status: 'collecting' }).returning();
    await toggleDraftMaterial(t.db, draft!.id, teacherId, book.id);
    expect((await listDraftMaterials(t.db, draft!.id))[0]!.title).toBe('Old Title');

    await go(msg(T_CHAT, '/library'));
    await press('Управление материалами');
    await press('Old Title');
    await press('Переименовать');
    await go(msg(T_CHAT, 'English Grammar in Use'));
    expect(saidAtSomePoint(T_CHAT, 'Название изменено на «English Grammar in Use»')).toBe(true);
    expect(saidAtSomePoint(T_CHAT, 'Прошлые публикации остались под прежним названием')).toBe(true);
    expect((await listDraftMaterials(t.db, draft!.id))[0]!.title).toBe('Old Title');

    // «Использовать в другой группе», with a confirmation
    await press('Использовать в другой группе');
    await press('Grammar A2');
    await press('Да, подключить');
    expect(saidAtSomePoint(T_CHAT, 'теперь доступен и в группе «Grammar A2»')).toBe(true);
    expect(await eligibleMaterials(t.db, teacherId, [
      (await groupOf(A_CHAT)).id, (await groupOf(B_CHAT)).id,
    ])).toHaveLength(1);

    // archive: out of new recommendations, still visible in management and restorable
    await press('Убрать из рекомендаций');
    await press('Да, убрать');
    expect(saidAtSomePoint(T_CHAT, 'убран из рекомендаций')).toBe(true);
    expect(await eligibleMaterials(t.db, teacherId, [(await groupOf(A_CHAT)).id])).toHaveLength(0);
    expect(lastTextTo(T_CHAT)).toContain('🗄 архив · English Grammar in Use');
    await press('English Grammar in Use');
    await press('Вернуть в рекомендации');
    expect(saidAtSomePoint(T_CHAT, 'снова предлагается')).toBe(true);

    // a real send first, then delete: the history of that send must survive
    await markMaterialsUsed(t.db, teacherId, [book.id]);
    await t.db.insert(tgPublications).values({
      draftId: draft!.id, groupId: (await groupOf(A_CHAT)).id,
      groupTitle: 'IELTS B2', telegramChatId: A_CHAT, status: 'sent',
    });
    await go(msg(T_CHAT, '/library'));
    await press('Управление материалами');
    await press('English Grammar in Use');
    await press('Удалить из библиотеки');
    await press('Да, удалить');
    expect(saidAtSomePoint(T_CHAT, 'Материал удалён из библиотеки')).toBe(true);
    expect(await materialsOfTeacher()).toHaveLength(0);
    const kept = await listDraftMaterials(t.db, draft!.id);
    expect(kept).toHaveLength(1);
    expect(kept[0]!.materialId).toBeNull();
    expect(kept[0]!.title).toBe('Old Title');
    const [pub] = await t.db.select().from(tgPublications).where(eq(tgPublications.draftId, draft!.id));
    expect(pub?.groupTitle).toBe('IELTS B2');
    expect(await t.db.select().from(tgMaterialGroups)
      .where(eq(tgMaterialGroups.materialId, book.id))).toHaveLength(0);
    assertShortCallbacks();
  });

  it('survives a restart: the library, the draft and its chosen books are in Postgres', async () => {
    await seedMaterial('Persistent Book', 'keep-file', [A_CHAT]);
    await go(msg(T_CHAT, '/homework'));
    await press('IELTS B2');
    await press('Продолжить');
    await press('📚 Библиотека материалов');
    await press('Persistent Book');
    await press('К заданию');
    const draft = (await latestActiveDraft(t.db, teacherId))!;
    expect(draft.status).toBe('collecting');

    // a new process: a new transport and new deps over the same database
    const api2 = new CapturingApi();
    const ai2 = new FakeAi();
    deps = { db: t.db, api: api2, isGroupAdmin: async () => false, homeworkAi: ai2 };
    api = api2;
    ai = ai2;

    await go(msg(T_CHAT, '/library'));
    expect(lastTextTo(T_CHAT)).toContain('Сохранено: 1');
    await go(msg(T_CHAT, '/homework'));
    expect(lastTextTo(T_CHAT)).toContain('Сбор материалов');
    expect(lastTextTo(T_CHAT)).toContain('Выбрано из библиотеки: Persistent Book');
    await go(msg(T_CHAT, 'Unit 5'));
    await press('Готово — подготовить задание');
    expect(lastTextTo(T_CHAT)).toContain('Материалы: Persistent Book');
    // the token must be taken BEFORE the conversation is cleared: clearing removes the very
    // screen the publish button lives on
    const publishToken = button('Опубликовать в группы');
    clearApi();
    await go(rawCb(T_CHAT, publishToken));
    expect(docsTo(A_CHAT).map((c) => c.fileId)).toEqual(['keep-file']);
    expect(await draftStatus(draft.id)).toBe('published');
  });

  it('does not save a pressed button twice and ignores a redelivered file message', async () => {
    await go(msg(T_CHAT, '/library'));
    await press('Добавить материал');
    await press('IELTS B2');
    await press('✅ Продолжить (');
    const file = docMsg(T_CHAT, 'once-file', 'Once.pdf');
    await go(file);
    await go(msg(T_CHAT, 'Once Only'));
    await press('Книга');
    const saveToken = button('Сохранить в библиотеку');

    // the same Telegram message with a new update_id: the confirmation is re-shown, and
    // nothing is stored — there is still no material at all
    await go({ ...file, update_id: ++uid });
    expect(await materialsOfTeacher()).toHaveLength(0);
    expect(lastTextTo(T_CHAT)).toContain('Проверьте и сохраните');

    await go(rawCb(T_CHAT, saveToken));
    expect(await materialsOfTeacher()).toHaveLength(1);
    await go(rawCb(T_CHAT, saveToken));
    expect(lastTextTo(T_CHAT)).toContain('устарела');
    expect(await materialsOfTeacher()).toHaveLength(1);
    expect(textsTo(A_CHAT)).toHaveLength(0);
  });

  it('attaches several books to one homework and still sends no file contents to the AI', async () => {
    await seedMaterial('Book One', 'one-file', [A_CHAT]);
    await seedMaterial('Book Two', 'two-file', [A_CHAT], 'workbook', 'two.docx',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    await startHomeworkWithBooks(['IELTS B2'], ['Book One', 'Book Two'], 'Unit 6 и Unit 7');
    await press('Готово — подготовить задание');
    const req = ai.requests[0]!;
    expect(req.materials.map((m) => m.title)).toEqual(['Book One', 'Book Two']);
    expect(req.items.filter((i) => i.kind === 'text').map((i) => i.text)).toEqual(['Unit 6 и Unit 7']);
    expect(JSON.stringify(req)).not.toContain('bytes');
    const preview = lastTextTo(T_CHAT);
    expect(preview).toContain('Book One, Book Two');
    expect(preview).toContain('📎 «IELTS B2»');

    // the token must be taken BEFORE the conversation is cleared: clearing removes the very
    // screen the publish button lives on
    const publishToken = button('Опубликовать в группы');
    clearApi();
    await go(rawCb(T_CHAT, publishToken));
    expect(sendsTo(A_CHAT)).toHaveLength(1);
    expect(photosTo(A_CHAT)).toHaveLength(0);
    expect(docsTo(A_CHAT).map((c) => c.fileId)).toEqual(['one-file', 'two-file']);
  });

  it('prunes a chosen book when the groups of the draft change', async () => {
    await seedMaterial('Only For A', 'only-a', [A_CHAT]);
    await startHomeworkWithBooks(['IELTS B2'], ['Only For A'], 'Unit 8');
    const draft = (await latestActiveDraft(t.db, teacherId))!;
    expect(await listDraftMaterials(t.db, draft.id)).toHaveLength(1);

    // preview → Change groups → add B: the book that never belonged to B is dropped, and the
    // teacher is told instead of meeting a half-attachment
    await press('Готово — подготовить задание');
    await press('Изменить группы');
    await press('Grammar A2');
    await press('Продолжить');
    expect(saidAtSomePoint(T_CHAT, 'эти материалы убраны из черновика')).toBe(true);
    expect(await listDraftMaterials(t.db, draft.id)).toHaveLength(0);
    expect(await draftStatus(draft.id)).toBe('collecting');
  });

  it('refuses another teacher’s material instead of pretending it exists', async () => {
    const book = await seedMaterial('Private Book', 'priv-file', [A_CHAT]);
    const forged = await makeHomeworkCallback(t.db, foreignId, { a: 'lib', x: 'mat', m: book.id });
    await go(rawCb(F_CHAT, forged));
    // the token is the foreign teacher's own, so it is claimed — but it points at nothing of
    // hers: the id is resolved against HER owner id and simply does not exist
    expect(lastTextTo(F_CHAT)).toContain('Материал не найден или уже удалён');
    expect(await t.db.select().from(tgMaterials)
      .where(and(eq(tgMaterials.id, book.id), eq(tgMaterials.ownerId, foreignId)))).toHaveLength(0);

    // the store refuses the same id for the wrong owner, in every direction
    expect(await getMaterial(t.db, book.id, foreignId)).toBeNull();
    expect(await linkMaterialGroup(t.db, book.id, foreignId, (await groupOf(A_CHAT)).id)).toBe(false);
    expect(await renameMaterial(t.db, book.id, foreignId, 'Hijacked')).toBeNull();
    expect(await deleteMaterial(t.db, book.id, foreignId)).toBe(false);
    const [link] = await t.db.select().from(tgMaterialGroups)
      .where(eq(tgMaterialGroups.materialId, book.id));
    expect(link?.groupId).toBe((await groupOf(A_CHAT)).id);
    expect((await materialByTitle('Private Book'))!.title).toBe('Private Book');
  });

  it('releases the add dialog when the teacher goes back to /homework', async () => {
    // a draft in the library step, then a half-finished “add material” dialog on top of it
    await go(msg(T_CHAT, '/homework'));
    await press('IELTS B2');
    await press('Продолжить');
    await go(msg(T_CHAT, '/library'));
    await press('Добавить материал');
    await press('IELTS B2');
    await press('✅ Продолжить (');
    expect(lastTextTo(T_CHAT)).toContain('Пришлите файл одним сообщением');

    // leaving for /homework must not leave the dialog stealing the next message
    await go(msg(T_CHAT, '/homework'));
    expect(lastTextTo(T_CHAT)).toContain('Сбор материалов');
    await go(docMsg(T_CHAT, 'stray-file', 'stray.pdf'));
    expect(saidAtSomePoint(T_CHAT, 'Как назвать материал?')).toBe(false);
    expect(await materialsOfTeacher()).toHaveLength(0);
    // and the dialog can be started again cleanly
    await go(msg(T_CHAT, '/library'));
    await press('Добавить материал');
    expect(lastTextTo(T_CHAT)).toContain('В каких группах этот материал уместен?');
  });

  it('holds the new tables to the same RLS posture as the rest of the schema', async () => {
    const tables = ['tg_materials', 'tg_material_groups', 'tg_draft_materials'];
    const rows = await t.sql`
      select c.relname, c.relrowsecurity,
             (select count(*) from pg_policies p where p.tablename = c.relname) as policies
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public'
         and c.relname in ('tg_materials','tg_material_groups','tg_draft_materials')`;
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      expect(r.relrowsecurity, `${r.relname} RLS`).toBe(true);
      expect(Number(r.policies), `${r.relname} policies`).toBe(0);
    }
    const roles = await t.sql`select rolname from pg_roles where rolname in ('anon','authenticated')`;
    const names = roles.map((r) => String(r.rolname));
    for (const table of tables) {
      for (const role of names.length ? names : []) {
        const priv = await t.sql`select has_table_privilege(${role}, ${table}, 'select,insert,update,delete') as ok`;
        expect(String(priv[0]?.ok), `${role} on ${table}`).toBe('false');
      }
    }
    await seedMaterial('Visible To Owner', 'vo-file', [A_CHAT]);
    const counted = await t.sql`select count(*)::int as n from tg_materials`;
    expect(Number(counted[0]?.n)).toBeGreaterThan(0);
  });

  it('keeps a teacher without groups out of the add dialog', async () => {
    const orphan = await makeTeacher(t.sql, `libOrphan${Date.now()}@x.io`);
    const chat = 8600 + seq;
    await t.db.insert(telegramLinks).values({ userId: orphan.id, chatId: String(chat) });
    await go(msg(chat, '/library'));
    expect(lastTextTo(chat)).toContain('Сначала подключите группу');
    expect(hasButton('Новое задание')).toBe(true);
    expect(await t.db.select().from(tgMaterials)
      .where(eq(tgMaterials.ownerId, orphan.id))).toHaveLength(0);
    // and the homework path still starts from the same screen, so /bind remains reachable
    await go(msg(chat, '/homework'));
    expect(lastTextTo(chat)).toContain('Пока нет подключённых групп');
  });
});
