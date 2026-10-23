/**
 * Delivery, language and outcome reporting — the failures the live test of 2026-10-23 found.
 *
 * What happened in the real chat: a teacher sent a PNG «as a file». Telegram stores that in
 * `message.document`, so its `file_id` is a DOCUMENT id, and the publication called
 * `sendPhoto` with it — «400 Bad Request: can't use file of type Document as Photo». The text
 * of the homework had already been delivered (message 10 and 11 in the group), yet the answer
 * she saw was «Publication result (0 of 1 sent): result unknown». Three separate product
 * rules come out of that and are proven here:
 *
 *  • an attachment is COPIED out of the teacher's own message (`copyMessage`, and
 *    `copyMessages` for one album), which keeps the media type, the caption and the file name
 *    without downloading or re-uploading anything;
 *  • the type is only ever guessed from what was RECORDED (photo vs document), never from the
 *    MIME type — `image/png` is both a photo and a file;
 *  • the result is reported per part, so «text delivered, file refused» is never shown as
 *    «nothing was sent», and a part whose answer never arrived is never re-sent;
 *  • the teacher's own interface is English, including the command menu of her chat, which
 *    Telegram otherwise localizes from the CLIENT language.
 *
 * No bot token, no AI key, no network: the transport is CapturingApi and the formatter is the
 * shipped offline one (`AI_PROVIDER=none` is what the deployment runs).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { TEST_DATABASE_URL, preparedDb, type TestDB } from './util.js';
import { tgDraftItems, tgDrafts, tgMaterials, tgPublications, telegramLinks, users } from '../../src/db/schema.js';
import { handleUpdate, type BotDeps, type TgUpdate } from '../../src/services/bot.js';
import { CapturingApi, TEACHER_COMMANDS } from '../../src/services/botApi.js';
import { hashPassword } from '../../src/lib/password.js';
import { LOCAL_AI } from '../../src/services/homework/ai.js';
import { addGroup, listItems, latestActiveDraft } from '../../src/services/homework/store.js';
import { listDraftMaterials } from '../../src/services/homework/libraryStore.js';

const suite = TEST_DATABASE_URL ? describe : describe.skip;

const GROUP_A = '-1007001';
const GROUP_B = '-1007002';
const CYRILLIC = /[\u0400-\u04FF]/;

suite('homework delivery, language and outcomes', () => {
  let t: TestDB;
  let api: CapturingApi;
  let deps: BotDeps;
  let teacherId = '';
  let uid = 0;
  let msgId = 0;
  let seq = 0;
  let T_CHAT = 0;

  const rawCb = (data: string, chatId = T_CHAT): TgUpdate => ({
    update_id: ++uid,
    callback_query: {
      id: `q${uid}`, from: { id: chatId },
      message: { message_id: 5, chat: { id: chatId, type: 'private' } },
      data,
    },
  });

  const msg = (text: string, chatId = T_CHAT): TgUpdate => ({
    update_id: ++uid,
    message: {
      message_id: ++msgId, chat: { id: chatId, type: 'private' },
      from: { id: chatId, first_name: 'Teacher' }, text,
    },
  });

  /** A PNG sent «as a file»: Telegram puts it in `document`, and the id is a document id. */
  const documentPng = (fileId: string, name = 'card.png', chatId = T_CHAT): TgUpdate => ({
    update_id: ++uid,
    message: {
      message_id: ++msgId, chat: { id: chatId, type: 'private' }, from: { id: chatId },
      document: {
        file_id: fileId, file_unique_id: `${fileId}-u`, file_name: name,
        mime_type: 'image/png', file_size: 265_485,
      },
    },
  });

  const photo = (fileId: string, chatId = T_CHAT): TgUpdate => ({
    update_id: ++uid,
    message: {
      message_id: ++msgId, chat: { id: chatId, type: 'private' }, from: { id: chatId },
      photo: [
        { file_id: `${fileId}-s`, file_unique_id: `${fileId}-su-s`, width: 90, height: 90, file_size: 900 },
        { file_id: fileId, file_unique_id: `${fileId}-su`, width: 1600, height: 1200, file_size: 2_000_000 },
      ],
    },
  });

  /** Two photos sent together: the same album id, one message each. */
  const album = (base: string, count: number, chatId = T_CHAT): TgUpdate[] => {
    const group = `album-${base}`;
    return Array.from({ length: count }, (_, i) => ({
      update_id: ++uid,
      message: {
        message_id: ++msgId, chat: { id: chatId, type: 'private' }, from: { id: chatId },
        media_group_id: group,
        photo: [
          { file_id: `${base}-${i}`, file_unique_id: `${base}-${i}-u`, width: 800, height: 600, file_size: 100_000 },
        ],
      },
    }) as TgUpdate);
  };

  const go = async (u: TgUpdate) => { await handleUpdate(deps, u); };
  const callsTo = (chatId: string | number) => api.calls.filter((c) => c.chatId === String(chatId));
  const textsTo = (chatId: string | number) => callsTo(chatId)
    .filter((c) => c.text !== undefined).map((c) => c.text as string);
  const lastTextTo = (chatId: string | number) => textsTo(chatId)[textsTo(chatId).length - 1] ?? '';
  const clearApi = () => { api.calls.length = 0; };
  const sendsTo = (chatId: string | number) => callsTo(chatId).filter((c) => c.kind === 'send');
  const docsTo = (chatId: string | number) => callsTo(chatId).filter((c) => c.kind === 'doc');
  const photosTo = (chatId: string | number) => callsTo(chatId).filter((c) => c.kind === 'photo');
  const copiesTo = (chatId: string | number) => callsTo(chatId).filter((c) => c.kind === 'copy');
  const copiesManyTo = (chatId: string | number) => callsTo(chatId).filter((c) => c.kind === 'copyMany');

  function button(label: string, chatId: string | number = T_CHAT): string {
    for (let i = api.calls.length - 1; i >= 0; i--) {
      const call = api.calls[i]!;
      if (call.chatId !== String(chatId)) continue;
      for (const row of call.opts?.buttons ?? []) {
        for (const item of row) if (item.cb && item.text.includes(label)) return item.cb;
      }
    }
    throw new Error(`button "${label}" not found for chat ${chatId}`);
  }
  const press = async (label: string, chatId: string | number = T_CHAT) => {
    await go(rawCb(button(label, chatId), chatId));
  };
  const hasButton = (needle: string, chatId: string | number = T_CHAT) => {
    for (let i = api.calls.length - 1; i >= 0; i--) {
      const call = api.calls[i]!;
      if (call.chatId !== String(chatId)) continue;
      const buttons = call.opts?.buttons;
      if (!buttons?.length) continue;
      return buttons.flat().some((item) => item.text.includes(needle));
    }
    return false;
  };

  const draftRow = async (id: string) =>
    (await t.db.select().from(tgDrafts).where(eq(tgDrafts.id, id)))[0]!;
  const pubsOf = (draftId: string) =>
    t.db.select().from(tgPublications).where(eq(tgPublications.draftId, draftId));

  /** The whole new flow up to the preview, with the files she sent herself. */
  async function toPreview(updates: TgUpdate[], words: string, groups = ['Group A']): Promise<string> {
    await go(msg('/homework'));
    for (const g of groups) await press(g);
    await press('✅ Continue (');
    for (const u of updates) await go(u);
    await go(msg(words));
    await press('Done — prepare homework');
    const draft = (await latestActiveDraft(t.db, teacherId))!;
    return draft.id;
  }

  beforeAll(async () => {
    t = await preparedDb(TEST_DATABASE_URL);
  });
  afterAll(async () => { await t?.sql.end(); });

  beforeEach(async () => {
    // an English account — the language the deployed teacher actually uses
    seq++;
    const [teacher] = await t.db.insert(users).values({
      role: 'teacher', name: 'Said', email: `dl${Date.now()}-${seq}@x.io`,
      passwordHash: await hashPassword('Passw0rd123'),
      locale: 'en', localeExplicit: true, profileCompletedAt: new Date(),
    }).returning();
    teacherId = teacher!.id;
    T_CHAT = 9100 + seq;
    uid = 30_000_000 + seq * 100_000;
    msgId = 100;
    await t.db.insert(telegramLinks).values({ userId: teacherId, chatId: String(T_CHAT) });
    await addGroup(t.db, teacherId, GROUP_A, 'Group A');
    await addGroup(t.db, teacherId, GROUP_B, 'Group B');
    api = new CapturingApi();
    deps = { db: t.db, api, isGroupAdmin: async () => false, homeworkAi: LOCAL_AI };
  });

  it('shows the teacher nothing but English: screens, buttons and the menu of her chat', async () => {
    await go(msg('/homework'));
    await press('Group A');
    await press('✅ Continue (');
    await go(photo('pic-1'));
    await go(msg('Read page 12 and do 3 and 4.'));
    await press('Done — prepare homework');

    const russian = textsTo(T_CHAT).filter((text) => CYRILLIC.test(text));
    expect(russian).toEqual([]);
    // the buttons she is offered are English too
    const labels = api.calls.flatMap((c) => c.opts?.buttons?.flat().map((item) => item.text) ?? []);
    expect(labels.filter((text) => CYRILLIC.test(text))).toEqual([]);
    expect(labels.some((text) => text.includes('Publish to groups'))).toBe(true);
    expect(labels.some((text) => text.includes('📚 Material library'))).toBe(true);
    // and the short acknowledgement is the compact one the live test asked for
    expect(textsTo(T_CHAT).some((text) => text.includes('Received — 2'))).toBe(true);
  });

  it('installs the English command list for her chat under every client language', async () => {
    await go(msg('/homework'));
    const menuCalls = api.calls.filter((c) => c.kind === 'cmds');
    expect(menuCalls.length).toBeGreaterThanOrEqual(4);
    const langs = menuCalls.map((c) => c.lang);
    // ru, uz, en and the language-less fallback: Telegram picks by the CLIENT language, so all
    // four slots must hold English or a Russian client still shows Russian
    for (const lang of ['ru', 'uz', 'en', '']) expect(langs).toContain(lang);
    for (const call of menuCalls.filter((c) => c.chatId === String(T_CHAT))) {
      const list = call.commands as { command: string; description: string }[];
      expect(list.map((c) => c.command)).toEqual(TEACHER_COMMANDS.map(([cmd]) => cmd));
      for (const item of list) expect(CYRILLIC.test(item.description)).toBe(false);
      expect(list.some((c) => c.command === 'library')).toBe(true);
      expect(list.some((c) => c.command === 'homework')).toBe(true);
    }
  });

  it('copies a PNG that arrived as a document instead of calling sendPhoto', async () => {
    const upload = documentPng('doc-png-file', 'Global_Problems_Vocabulary_Card.png');
    const sourceMessageId = (upload.message as { message_id: number }).message_id;
    const draftId = await toPreview([upload], 'Unit 1');

    // the type is recorded from the message, not guessed from image/png
    const [item] = await listItems(t.db, draftId);
    expect(item?.kind).toBe('document');
    expect(item?.mimeType).toBe('image/png');
    expect(item?.sourceChatId).toBe(String(T_CHAT));
    expect(item?.sourceMessageId).toBe(sourceMessageId);

    // the token must be taken BEFORE the conversation is cleared: clearing removes the very
    // screen the publish button lives on
    const publishToken = button('Publish to groups');
    clearApi();
    await go(rawCb(publishToken));
    // one text message and one COPY of her own message — no upload, and never a photo call
    expect(sendsTo(GROUP_A)).toHaveLength(1);
    expect(sendsTo(GROUP_A)[0]!.text).toContain('HOMEWORK');
    expect(sendsTo(GROUP_A)[0]!.text).toContain('Unit 1');
    expect(copiesTo(GROUP_A).map((c) => `${c.fromChatId}:${c.messageId}`))
      .toEqual([`${T_CHAT}:${sourceMessageId}`]);
    expect(photosTo(GROUP_A)).toHaveLength(0);
    expect(docsTo(GROUP_A)).toHaveLength(0);
    const [pub] = await pubsOf(draftId);
    expect(pub?.status).toBe('sent');
    expect(pub?.parts.map((p) => `${p.kind}:${p.status}:${p.method}`))
      .toEqual(['text:sent:text', 'document:sent:copy']);
    expect(await draftStatus(draftId)).toBe('published');
  });

  it('keeps an album together with one copyMessages call', async () => {
    const shots = album('shot', 3);
    const ids = shots.map((s) => (s.message as { message_id: number }).message_id);
    const draftId = await toPreview(shots, 'Look at the three pictures');
    const items = await listItems(t.db, draftId);
    const pictures = items.filter((i) => i.kind === 'photo');
    expect(pictures).toHaveLength(3);
    expect(new Set(pictures.map((i) => i.sourceMediaGroupId))).toEqual(new Set(['album-shot']));

    // the token must be taken BEFORE the conversation is cleared: clearing removes the very
    // screen the publish button lives on
    const publishToken = button('Publish to groups');
    clearApi();
    await go(rawCb(publishToken));
    expect(copiesManyTo(GROUP_A).map((c) => c.messageIds)).toEqual([ids]);
    expect(copiesTo(GROUP_A)).toHaveLength(0); // three separate copies would split the album
    expect(photosTo(GROUP_A)).toHaveLength(0);
  });

  it('falls back to the stored file_id with the RIGHT type when the source message is gone', async () => {
    const upload = photo('pic-9');
    const sourceMessageId = (upload.message as { message_id: number }).message_id;
    const draftId = await toPreview([upload], 'Unit 7');
    const publishToken = button('Publish to groups');
    clearApi();
    // the teacher deleted her own message: Telegram refuses the copy with 400
    api.missingSources.add(`${T_CHAT}:${sourceMessageId}`);
    await go(rawCb(publishToken));

    expect(copiesTo(GROUP_A)).toHaveLength(0);
    expect(photosTo(GROUP_A).map((c) => c.fileId)).toEqual(['pic-9']); // a photo id → sendPhoto
    expect(docsTo(GROUP_A)).toHaveLength(0);
    const [pub] = await pubsOf(draftId);
    expect(pub?.status).toBe('sent');
    expect(pub?.parts[1]!.method).toBe('file_id');
  });

  it('reports a refused file as that file, with the text still credited as delivered', async () => {
    const upload = documentPng('doc-bad', 'worksheet.png');
    const sourceMessageId = (upload.message as { message_id: number }).message_id;
    const draftId = await toPreview([upload], 'Unit 8');
    const publishToken = button('Publish to groups');
    clearApi();
    api.missingSources.add(`${T_CHAT}:${sourceMessageId}`);
    api.rejectDocumentChats.add(GROUP_A); // and the fallback is refused too
    await go(rawCb(publishToken));

    expect(sendsTo(GROUP_A)).toHaveLength(1);
    const screen = lastTextTo(T_CHAT);
    expect(screen).toContain('⚠ Group A — 1 delivered, 1 not delivered');
    expect(screen).toContain('• text — sent');
    expect(screen).toContain('• worksheet.png — not sent');
    expect(screen).toContain('send it here again');
    // never a silent duplicate: the text is not sent a second time on retry
    const [pub] = await pubsOf(draftId);
    expect(pub?.parts.map((p) => p.status)).toEqual(['sent', 'failed']);
    expect(await draftStatus(draftId)).toBe('publish_unknown');

    const retryToken = button('Retry failed');
    api.rejectDocumentChats.delete(GROUP_A);
    clearApi();
    await go(rawCb(retryToken));
    expect(sendsTo(GROUP_A)).toHaveLength(0);
    expect(docsTo(GROUP_A).map((c) => c.fileId)).toEqual(['doc-bad']);
    expect(await draftStatus(draftId)).toBe('published');
  });

  it('leaves an interrupted send unknown and offers no retry at all', async () => {
    const upload = documentPng('doc-unknown', 'chapter.pdf');
    const sourceMessageId = (upload.message as { message_id: number }).message_id;
    const draftId = await toPreview([upload], 'Unit 9');
    const publishToken = button('Publish to groups');
    clearApi();
    api.missingSources.add(`${T_CHAT}:${sourceMessageId}`);
    api.failDocumentChats.add(GROUP_A); // a transport failure: no answer, so nothing is known
    await go(rawCb(publishToken));

    const screen = lastTextTo(T_CHAT);
    expect(screen).toContain('? Group A — delivery status unknown');
    expect(screen).toContain('• chapter.pdf — delivery status unknown — check the group');
    expect(hasButton('Retry failed')).toBe(false);
    const [pub] = await pubsOf(draftId);
    expect(pub?.status).toBe('uncertain');
    // and the store itself refuses to re-send it
    const { retryFailedPublications } = await import('../../src/services/homework/publish.js');
    api.failDocumentChats.delete(GROUP_A);
    clearApi();
    const again = await retryFailedPublications(t.db, api, draftId, teacherId);
    expect(again.kind).toBe('noTargets');
    expect(callsTo(GROUP_A)).toHaveLength(0);
  });

  it('never puts a file byte in front of the formatter, for PDF, DOCX and PNG alike', async () => {
    const pdf = {
      update_id: ++uid,
      message: {
        message_id: ++msgId, chat: { id: T_CHAT, type: 'private' }, from: { id: T_CHAT },
        document: {
          file_id: 'pdf-1', file_unique_id: 'pdf-1-u', file_name: 'Grammar.pdf',
          mime_type: 'application/pdf', file_size: 4_000_000,
        },
      },
    } as TgUpdate;
    const draftId = await toPreview([pdf, documentPng('doc-x', 'sheet.docx')], 'Units 5 and 6');
    const { buildAttachments } = await import('../../src/services/homework/publish.js');
    const attachments = buildAttachments(await listDraftMaterials(t.db, draftId), await listItems(t.db, draftId));
    // what publication knows about the files: identifiers, a type and a name. Never contents.
    expect(attachments.map((a) => a.label)).toEqual(['Grammar.pdf', 'sheet.docx']);
    expect(JSON.stringify(attachments)).not.toContain('base64');
    const wire = JSON.stringify(textsTo(T_CHAT));
    expect(wire).toContain('Grammar.pdf');
    expect('downloadFile' in api).toBe(false); // the transport cannot fetch a file at all
    expect(await listItems(t.db, draftId)).toHaveLength(3); // two files and her words
  });

  it('sends the same copied attachment into two groups and reports each one', async () => {
    const upload = photo('pic-both');
    const draftId = await toPreview([upload], 'Unit 10', ['Group A', 'Group B']);
    // the token must be taken BEFORE the conversation is cleared: clearing removes the very
    // screen the publish button lives on
    const publishToken = button('Publish to groups');
    clearApi();
    await go(rawCb(publishToken));
    expect(copiesTo(GROUP_A)).toHaveLength(1);
    expect(copiesTo(GROUP_B)).toHaveLength(1);
    const rows = await pubsOf(draftId);
    expect(rows.map((r) => r.status)).toEqual(['sent', 'sent']);
    const screen = lastTextTo(T_CHAT);
    expect(screen).toContain('✓ Group A — sent');
    expect(screen).toContain('✓ Group B — sent');
    expect(screen).toContain('Done: the homework was published to every selected group');
  });

  it('keeps copy coordinates and the draft through a restart', async () => {
    const upload = documentPng('doc-keep', 'workbook.pdf');
    const sourceMessageId = (upload.message as { message_id: number }).message_id;
    const draftId = await toPreview([upload], 'Unit 11');

    // a new process over the same database: nothing is recomputed from memory
    const api2 = new CapturingApi();
    api = api2;
    deps = { db: t.db, api: api2, isGroupAdmin: async () => false, homeworkAi: LOCAL_AI };
    await go(msg('/homework'));
    // the draft resumes exactly where she left it: the preview, with the same chosen files
    expect(lastTextTo(T_CHAT)).toContain('Homework preview for groups');
    const [kept] = await t.db.select().from(tgDraftItems).where(eq(tgDraftItems.draftId, draftId));
    expect(kept.sourceChatId).toBe(String(T_CHAT));
    expect(kept.sourceMessageId).toBe(sourceMessageId);
    const publishToken = button('Publish to groups');
    clearApi();
    await go(rawCb(publishToken));
    expect(copiesTo(GROUP_A).map((c) => c.messageId)).toEqual([sourceMessageId]);
  });

  it('files a book from the library dialog and copies it later without a re-upload', async () => {
    await go(msg('/homework'));
    await press('Group A');
    await press('✅ Continue (');
    await press('📚 Material library');
    await press('➕ Upload a new material');
    const upload = documentPng('lib-png', 'Global_Problems_Vocabulary_Card.png');
    const sourceMessageId = (upload.message as { message_id: number }).message_id;
    await go(upload);
    await go(msg('Vocabulary card'));
    await press('📄 Other material');
    await press('💾 Save to the library');
    const [book] = await t.db.select().from(tgMaterials).where(eq(tgMaterials.ownerId, teacherId));
    expect(book?.mediaType).toBe('document');
    expect(book?.sourceChatId).toBe(String(T_CHAT));
    expect(book?.sourceMessageId).toBe(sourceMessageId);

    // back in the draft, choose it and publish: the ORIGINAL message is copied
    await press('Go to the homework');
    await go(msg('Unit 12'));
    await press('Done — prepare homework');
    const preview = lastTextTo(T_CHAT);
    expect(preview).toContain('Materials: Vocabulary card');
    // the id must be read BEFORE the send: a published draft is not an active one any more
    const draft = (await latestActiveDraft(t.db, teacherId))!;
    // the token must be taken BEFORE the conversation is cleared: clearing removes the very
    // screen the publish button lives on
    const publishToken = button('Publish to groups');
    clearApi();
    await go(rawCb(publishToken));
    expect(copiesTo(GROUP_A).map((c) => `${c.fromChatId}:${c.messageId}`))
      .toEqual([`${T_CHAT}:${sourceMessageId}`]);
    expect(docsTo(GROUP_A)).toHaveLength(0);
    expect((await pubsOf(draft.id))[0]!.parts.map((p) => p.kind)).toEqual(['text', 'material']);
    expect(await draftStatus(draft.id)).toBe('published');
  });

  it('retries only the missing file when two attachments share one label', async () => {
    // Photos have no file name, so both parts are labelled «photo». A retry that decided
    // "already sent" by label alone would skip the second picture forever — positions decide.
    const first = photo('pic-a');
    const second = photo('pic-b');
    const idA = (first.message as { message_id: number }).message_id;
    const idB = (second.message as { message_id: number }).message_id;
    const draftId = await toPreview([first, second], 'Two pictures');

    const publishToken = button('Publish to groups');
    clearApi();
    // the second original message is gone and Telegram refuses the fallback too
    api.missingSources.add(`${T_CHAT}:${idB}`);
    api.rejectPhotoChats.add(GROUP_A);
    await go(rawCb(publishToken));

    const [pub1] = await pubsOf(draftId);
    expect(pub1!.parts.map((p) => `${p.kind}:${p.status}`))
      .toEqual(['text:sent', 'photo:sent', 'photo:failed']);
    expect(hasButton('Retry failed')).toBe(true);

    const retryToken = button('Retry failed');
    api.missingSources.delete(`${T_CHAT}:${idB}`);
    api.rejectPhotoChats.delete(GROUP_A);
    clearApi();
    await go(rawCb(retryToken));
    // the first picture is NOT copied again, the second one finally arrives
    expect(copiesTo(GROUP_A).map((c) => c.messageId)).toEqual([idB]);
    const [pub2] = await pubsOf(draftId);
    expect(pub2!.status).toBe('sent');
    expect(pub2!.parts.filter((p) => p.kind === 'photo')).toHaveLength(2);
    expect(await draftStatus(draftId)).toBe('published');
  });

  const draftStatus = async (id: string) => (await draftRow(id)).status;
});
