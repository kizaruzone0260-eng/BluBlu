/**
 * The homework + library flow over the REAL production entry point.
 *
 * The other two suites call the dispatcher directly. Telegram never does: it POSTs an update
 * to `/webhook/telegram` with the secret header, the route answers 200 immediately and the
 * work happens in the background queue (`queueBotUpdate` → `processUpdate`). This file drives
 * the teacher's whole journey through that HTTP path, with the app's own wiring —
 * `botDeps()` gives the flow the capturing transport and the **offline** formatter, because
 * `AI_PROVIDER=none` is what a deployment without an AI key actually runs.
 *
 * Proven here, and nowhere else in the suite:
 *  • a homework and a library material survive the webhook gate, the `bot_updates` ledger and
 *    the background drain;
 *  • a redelivered `update_id` performs the action exactly once;
 *  • publish really reaches the group chat through the transport, with the file attached;
 *  • no AI key, no bot token, no network: `TELEGRAM_BOT_TOKEN` here is a fiction and the
 *    transport is the capturing one.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { TEST_DATABASE_URL, preparedDb, makeTeacher, type TestDB } from './util.js';
import { buildApp } from '../../src/app.js';
import { botUpdates, tgDrafts, tgMaterials, tgPublications, telegramLinks } from '../../src/db/schema.js';
import { env } from '../../src/env.js';
import { capturingApi, drainBotUpdates } from '../../src/routes/telegram.js';
import { addGroup, listItems as listDraftItems } from '../../src/services/homework/store.js';
import { listDraftMaterials } from '../../src/services/homework/libraryStore.js';
import pino from 'pino';
import type { FastifyInstance } from 'fastify';

const suite = TEST_DATABASE_URL ? describe : describe.skip;

const SECRET = 'fictitious-webhook-secret-0123456789';
const HEAD = 'x-telegram-bot-api-secret-token';
const TEACHER_CHAT = 5_500_001;
const GROUP_CHAT = '-1005500001';

suite('вебхук: домашнее задание и библиотека через /webhook/telegram', () => {
  let t: TestDB;
  let app: FastifyInstance;
  let teacherId = '';
  let uid = 0;
  let hookSeq = 0;

  const api = () => capturingApi(t.db, null);

  const post = async (payload: unknown) => {
    const res = await app.inject({
      method: 'POST', url: '/webhook/telegram',
      headers: { [HEAD]: SECRET }, payload,
    });
    expect(res.statusCode).toBe(200);
    await drainBotUpdates();
    return res;
  };

  const sendText = (text: string, chatId: number | string = TEACHER_CHAT) => post({
    update_id: ++uid,
    message: {
      message_id: 900 + uid, chat: { id: Number(chatId), type: String(chatId).startsWith('-') ? 'supergroup' : 'private' },
      from: { id: Number(chatId) }, text,
    },
  });

  const pressButton = (data: string) => post({
    update_id: ++uid,
    callback_query: {
      id: `q${uid}`, from: { id: TEACHER_CHAT },
      message: { message_id: 940 + uid, chat: { id: TEACHER_CHAT, type: 'private' } },
      data,
    },
  });

  /** Posts a document into the teacher's chat and returns the Telegram message id it used. */
  const sendDocument = async (fileId: string, name: string, caption = '') => {
    const next = ++uid;
    await post({
      update_id: next,
      message: {
        message_id: 960 + next, chat: { id: TEACHER_CHAT, type: 'private' },
        from: { id: TEACHER_CHAT },
        document: {
          file_id: fileId, file_unique_id: `${fileId}-u`, file_name: name,
          mime_type: 'application/pdf', file_size: 2_000_000,
        },
        ...(caption ? { caption } : {}),
      },
    });
    // a copy is addressed by (chat, message), so the tests assert exactly this pair
    return 960 + next;
  };

  /** The newest button whose label contains `label` — exactly what Telegram would show. */
  function button(label: string, chatId: number | string = TEACHER_CHAT): string {
    const calls = api().calls;
    for (let i = calls.length - 1; i >= 0; i--) {
      const call = calls[i]!;
      if (call.chatId !== String(chatId)) continue;
      for (const row of call.opts?.buttons ?? []) {
        for (const item of row) if (item.cb && item.text.includes(label)) return item.cb;
      }
    }
    throw new Error(`button "${label}" not found for chat ${chatId}`);
  }

  const textsTo = (chatId: number | string) =>
    api().calls.filter((c) => c.chatId === String(chatId) && c.text !== undefined).map((c) => c.text as string);
  const docsTo = (chatId: string) => api().calls.filter((c) => c.chatId === chatId && c.kind === 'doc');
  const photosTo = (chatId: string) => api().calls.filter((c) => c.chatId === chatId && c.kind === 'photo');
  const copiesTo = (chatId: string) => api().calls.filter((c) => c.chatId === chatId && c.kind === 'copy');

  beforeAll(async () => {
    t = await preparedDb(TEST_DATABASE_URL);
    // фиктивные значения: настоящий токен здесь не нужен — транспорт захватывающий
    process.env.TELEGRAM_BOT_TOKEN = '777000:FICTIONAL-faketoken-faketoken-faketoken77';
    env.TELEGRAM_WEBHOOK_SECRET = SECRET;
    app = await buildApp(t.db, { logger: pino({ level: 'error' }, { write: () => undefined }) as never });
  });

  afterAll(async () => {
    await app?.close();
    delete process.env.TELEGRAM_BOT_TOKEN;
    await t?.sql.end();
  });

  beforeEach(async () => {
    const teacher = await makeTeacher(t.sql, `hook${Date.now()}-${++hookSeq}@x.io`);
    teacherId = teacher.id;
    // the transport is a process singleton: each test starts from an empty conversation
    api().calls.length = 0;
    // chat_id is unique: the app under test keeps one link per chat across the whole file,
    // so the previous teacher's row is released before this test claims the chat
    await t.db.delete(telegramLinks).where(eq(telegramLinks.chatId, String(TEACHER_CHAT)));
    await t.db.insert(telegramLinks).values({ userId: teacherId, chatId: String(TEACHER_CHAT) });
    await addGroup(t.db, teacherId, GROUP_CHAT, 'IELTS B2 (тест)');
  });

  it('проходит весь путь: книга в библиотеку → ДЗ → предпросмотр → публикация во вторую группу', async () => {
    // ── библиотека: /library → добавить → группа → файл → название → тип → сохранить
    await sendText('/library');
    expect(textsTo(TEACHER_CHAT).at(-1)).toContain('Библиотека материалов.');
    await pressButton(button('Добавить материал'));
    await pressButton(button('IELTS B2 (тест)'));
    await pressButton(button('✅ Продолжить ('));
    const uploadMessageId = await sendDocument('egau-file', 'English Grammar in Use 5th.pdf');
    await sendText('English Grammar in Use');
    await pressButton(button('📕 Книга'));
    await pressButton(button('💾 Сохранить в библиотеку'));

    const [book] = await t.db.select().from(tgMaterials).where(eq(tgMaterials.ownerId, teacherId));
    expect(book?.title).toBe('English Grammar in Use');
    expect(book?.telegramFileId).toBe('egau-file');
    expect(book?.status).toBe('active');
    // в группу на складе книги не ушло ни сообщения
    expect(textsTo(GROUP_CHAT)).toHaveLength(0);

    // ── задание: /homework → группа → библиотека → книга → свои слова → готово
    await sendText('/homework');
    await pressButton(button('IELTS B2 (тест)'));
    await pressButton(button('✅ Продолжить'));
    await pressButton(button('📚 Библиотека материалов'));
    await pressButton(button('English Grammar in Use'));
    await pressButton(button('К заданию'));
    await sendText('Unit 1, Exercises 1–5.');
    await pressButton(button('Готово — подготовить задание'));

    const [draft] = await t.db.select().from(tgDrafts).where(eq(tgDrafts.ownerId, teacherId))
      .orderBy(tgDrafts.updatedAt);
    const previews = textsTo(TEACHER_CHAT);
    const preview = previews.filter((x) => x.includes('Предпросмотр задания для групп'))
      .at(-1) ?? '';
    // THIS is the offline formatter speaking, with no AI key anywhere in the environment
    expect(preview).toContain('ДОМАШНЕЕ ЗАДАНИЕ');
    expect(preview).toContain('Материал: English Grammar in Use');
    expect(preview).toContain('Unit 1, Exercises 1–5.');
    expect(preview).toContain('📎 «IELTS B2 (тест)»');
    expect(preview).toContain('Публикация не начнётся без нажатия');
    expect(draft?.status).toBe('preview');
    // her own words are a collected material of the draft, not a separate screen
    expect((await listDraftItems(t.db, draft!.id)).map((i) => i.text)).toEqual(['Unit 1, Exercises 1–5.']);
    expect((await listDraftMaterials(t.db, draft!.id))[0]?.title).toBe('English Grammar in Use');
    // the group has still received nothing
    expect(textsTo(GROUP_CHAT)).toHaveLength(0);

    // ── публикация: одно нажатие — и только оно отправляет
    await pressButton(button('Опубликовать в группы'));
    expect(textsTo(GROUP_CHAT)).toHaveLength(1);
    expect(textsTo(GROUP_CHAT)[0]).toContain('ДОМАШНЕЕ ЗАДАНИЕ');
    expect(textsTo(GROUP_CHAT)[0]).toContain('Unit 1, Exercises 1–5.');
    // the book was uploaded in the teacher's own chat ⇒ Telegram COPIES that message: no
    // download, no re-upload, and the file keeps the type it really has
    expect(copiesTo(GROUP_CHAT).map((c) => `${c.fromChatId}:${c.messageId}`))
      .toEqual([`${TEACHER_CHAT}:${uploadMessageId}`]);
    expect(docsTo(GROUP_CHAT)).toHaveLength(0);
    expect(photosTo(GROUP_CHAT)).toHaveLength(0);
    const after = await t.db.select().from(tgDrafts).where(eq(tgDrafts.id, draft!.id));
    expect(after[0]?.status).toBe('published');
    const [pub] = await t.db.select().from(tgPublications).where(eq(tgPublications.draftId, draft!.id));
    expect(pub?.status).toBe('sent');
    const [booked] = await t.db.select().from(tgMaterials).where(eq(tgMaterials.id, book!.id));
    expect(booked?.lastUsedAt).toBeInstanceOf(Date);
  }, 60_000);

  it('повторная доставка того же update_id не публикует задание дважды', async () => {
    await sendText('/homework');
    await pressButton(button('IELTS B2 (тест)'));
    await pressButton(button('✅ Продолжить'));
    await sendText('Прочитать параграф 5');
    await pressButton(button('Готово — подготовить задание'));
    const [draft] = await t.db.select().from(tgDrafts).where(eq(tgDrafts.ownerId, teacherId));
    const publishToken = button('Опубликовать в группы');

    const duplicate = {
      update_id: 7_777_001,
      callback_query: {
        id: 'q-dup', from: { id: TEACHER_CHAT },
        message: { message_id: 10_001, chat: { id: TEACHER_CHAT, type: 'private' } },
        data: publishToken,
      },
    };
    await post(duplicate);
    const sentOnce = textsTo(GROUP_CHAT).length;
    const docsOnce = docsTo(GROUP_CHAT).length;
    expect(sentOnce).toBeGreaterThan(0);

    // Telegram redelivers the SAME update_id: the ledger drops it before the dispatcher runs
    await post(duplicate);
    await post(duplicate);
    expect(textsTo(GROUP_CHAT)).toHaveLength(sentOnce);
    expect(docsTo(GROUP_CHAT)).toHaveLength(docsOnce);
    const rows = await t.db.select({ id: botUpdates.updateId }).from(botUpdates)
      .where(eq(botUpdates.updateId, 7_777_001));
    expect(rows).toHaveLength(1);
    expect((await t.db.select().from(tgPublications).where(eq(tgPublications.draftId, draft!.id)))).toHaveLength(1);
  }, 60_000);

  it('вебхук без секрета не трогает ни черновик, ни журнал', async () => {
    const before = api().calls.length;
    const res = await app.inject({
      method: 'POST', url: '/webhook/telegram',
      payload: { update_id: ++uid, message: { message_id: 1, chat: { id: TEACHER_CHAT, type: 'private' }, from: { id: TEACHER_CHAT }, text: '/homework' } },
    });
    await drainBotUpdates();
    expect(res.statusCode).toBe(403);
    expect(api().calls.length).toBe(before);
    expect(await t.db.select().from(tgDrafts).where(eq(tgDrafts.ownerId, teacherId))).toHaveLength(0);
    expect(await t.db.select().from(tgMaterials).where(and(
      eq(tgMaterials.ownerId, teacherId),
    ))).toHaveLength(0);
  });
});
