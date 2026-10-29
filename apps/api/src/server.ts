import { env } from './env.js';
import { getDb, closeDb } from './db/index.js';
import { buildApp } from './app.js';
import path from 'node:path';
import fs from 'node:fs';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { LogTransport, TelegramTransport } from './services/notify.js';
import { createBot } from './services/telegramBot.js';
import { createEmailTransport } from './services/email.js';
import { initNotifyWorker } from './services/notifyQueue.js';
import { effectiveMigrationsFolder, webhookRegistration } from './lib/prodConfig.js';
import { describeError, errorLine } from './lib/redact.js';
import { botErrorLine } from './lib/errorObservers.js';
import { installCrashGuards } from './lib/crashGuards.js';

async function main() {
  const db = getDb(env.DATABASE_URL);

  // Versioned migrations applied at boot (§4 надёжность). Fails fast if broken.
  const migrationsFolder = effectiveMigrationsFolder(env.NODE_ENV, process.cwd());
  if (fs.existsSync(migrationsFolder)) {
    await migrate(db, { migrationsFolder });
  } else {
    console.warn(`migrations folder not found: ${migrationsFolder}`);
  }

  // Cloud deploys: create the owner teacher from SEED_TEACHER_* (no-op when unset;
  // the password is never logged).
  const { seedTeacherAtBoot } = await import('./services/seed.js');
  await seedTeacherAtBoot(db);

  // Homework: a process that died while formatting or publishing leaves a draft whose
  // status no longer reflects reality. Resolve it at boot (stale formatting → collecting,
  // stale publishing → publish_unknown, sending → uncertain) instead of making the teacher
  // wait for the ten-minute housekeeping tick. Never re-sends anything.
  {
    const { sweepHomeworkState } = await import('./services/homework/store.js');
    await sweepHomeworkState(db).catch((e) => console.warn(errorLine('homework sweep', e)));
  }

  // Telegram bot (null when TELEGRAM_BOT_TOKEN is empty — §3.9/§5)
  const bot = createBot();
  const transport = bot && env.TELEGRAM_TRANSPORT === 'telegram'
    ? new TelegramTransport(bot)
    : new LogTransport();
  await initNotifyWorker(db, transport);
  // housekeeping: expired/used one-time WS tickets (lesson + chat) + bot dialogs
  setInterval(() => {
    import('./services/wsTicket.js').then((m) => m.sweepWsTickets(db)).catch(() => undefined);
    import('./services/chat.js').then((m) => m.sweepChatTickets(db)).catch(() => undefined);
    import('./services/bot.js').then((m) => m.sweepBotState(db)).catch(() => undefined);
    // homework: expired callback/bind tokens and drafts left mid-format or mid-publish by a
    // restarted process. A stuck publication becomes `publish_unknown`, never retryable.
    import('./services/homework/store.js').then((m) => m.sweepHomeworkState(db)).catch(() => undefined);
    // часть A5 (2026-10-16): история очереди уведомлений. 30 дней — и ряд с финальным статусом
    // больше ничего не объясняет; живые `pending`/`sending` уборка не трогает.
    import('./services/notify.js')
      .then((m) => m.sweepNotifications(db))
      .then((n) => { if (n) console.log(`notify: удалено рядов старше 30 дн. — ${n}`); })
      .catch(() => undefined);
    // B2: строки счётчика перебора без активной блокировки и суточной давности.
    import('./services/auth.js')
      .then((m) => m.sweepLoginAttempts(db))
      .then((n) => { if (n) console.log(`auth: удалено строк счётчика старше 24 ч — ${n}`); })
      .catch(() => undefined);
    // SEC-13: просроченные refresh-строки. Заменённые, но ещё живые не удаляются: они нужны
    // ротации (grace) и обнаружению повторного использования семейства.
    import('./services/auth.js')
      .then((m) => m.sweepRefreshTokens(db))
      .then((n) => { if (n) console.log(`auth: удалено просроченных refresh-токенов — ${n}`); })
      .catch(() => undefined);
    // Часть F: строки неподтверждённой регистрации. Человек запросил письмо и не вернулся —
    // его адрес держится в базе сутки после истечения кода, дальше нечего хранить: аккаунта нет,
    // письмо не доставлено, а адрес заявителя — персональные данные.
    import('./services/emailVerify.js')
      .then((m) => m.sweepEmailVerifications(db))
      .then((n) => { if (n) console.log(`email: удалено неподтверждённых кодов старше 24 ч — ${n}`); })
      .catch(() => undefined);
    // часть 4: срок хранения архива. 0 (по умолчанию) — функция выключена, и sweepArchive
    // возвращает 0, не трогая базу.
    if (env.BOARD_ARCHIVE_RETENTION_DAYS > 0) {
      import('./services/lessonArchive.js')
        .then((m) => m.sweepArchive(db, env.BOARD_ARCHIVE_RETENTION_DAYS))
        .then((n) => { if (n) console.log(`archive: удалено записей старше ${env.BOARD_ARCHIVE_RETENTION_DAYS} дн. — ${n}`); })
        .catch(() => undefined);
    }
  }, 10 * 60_000).unref?.();
  // Telegram webhook registration (best-effort; server admin does it too).
  // Item 5: PUBLIC_URL (Render/cloudflared address) is used when DOMAIN is not set.
  // The arguments themselves are decided in prodConfig.webhookRegistration — the Bot API never
  // reports secret_token back, so that object is the only proof the registration is authenticated.
  const reg = webhookRegistration({
    publicUrl: env.PUBLIC_URL, domain: env.DOMAIN, secret: env.TELEGRAM_WEBHOOK_SECRET,
    mode: env.TELEGRAM_MODE, hasBot: Boolean(bot),
  });
  if (reg && bot) {
    try {
      await bot.api.setWebhook(reg.url, {
        secret_token: reg.secret_token, drop_pending_updates: reg.drop_pending_updates,
      });
      console.log(`telegram webhook registered for ${reg.url.replace(/^https:\/\//, '').replace(/\/webhook\/telegram$/, '')}`); // host only, no secrets
    } catch (e) {
      // understandable reason, with every credential shape the library may have put in it removed
      // (grammY messages can carry the Bot API URL, which IS a token)
      console.warn(`telegram webhook registration FAILED (bot is up, Telegram will not reach it until this works): ${errorLine('telegram', e)}`);
    }
  } else if (bot && env.TELEGRAM_MODE === 'webhook') {
    console.warn('telegram webhook skipped: set PUBLIC_URL (or DOMAIN) and TELEGRAM_WEBHOOK_SECRET');
  }
  /*
   * Часть A4 (2026-10-16): вебхук отвечает Telegram сразу после записи в `bot_updates`, а
   * действие выполняет в фоне. Значит обновление может остаться незавершённым — фон упал, или
   * сервис уснул/перезапустился посреди него. Здесь такие строки добираются: окно — 10 минут
   * от `seen_at`, дальше повтор уже бессмыслен (пользователь давно получил бы другой ответ).
   * В лог идут только счётчики: в тексте обновления есть то, что написал человек.
   */
  {
    const [{ reprocessUnfinished }, { botDeps }] = await Promise.all([
      import('./services/bot.js'), import('./routes/telegram.js'),
    ]);
    try {
      const r = await reprocessUnfinished(botDeps(db, bot));
      if (r.attempted) {
        console.log(`telegram: добито незавершённых обновлений — ${r.done}/${r.attempted} (ошибок — ${r.failed})`);
      }
    } catch (e) {
      console.warn(`telegram reprocess skipped: ${errorLine('telegram', e)}`);
    }
  }
  // bot task §1: default-scope command menu (basic set) refreshed at every boot
  if (bot && env.TELEGRAM_TRANSPORT === 'telegram') {
    const { applyMenu, grammyApi } = await import('./services/botApi.js');
    await applyMenu(grammyApi(bot), 'basic').catch((e: Error) => console.warn(errorLine('setMyCommands failed', e)));
    /*
     * Task F.1: the Mini App button is installed into the chat menu of every linked teacher.
     * It is persistent, so this is not needed on every boot — but doing it here means teachers
     * who linked BEFORE this version see the button without sending /start again. Background
     * on purpose: boot must not wait for N Telegram calls, and a failure is only a log line.
     */
    void import('./services/bot.js')
      .then(({ syncTeacherMiniMenus }) => syncTeacherMiniMenus(db, grammyApi(bot)))
      .then((r) => { if (r.teachers) console.log(`telegram menu buttons: ${r.updated}/${r.teachers} teacher chats updated`); })
      .catch((e: Error) => console.warn(errorLine('setChatMenuButton failed', e)));
  }
  // Demo (docs/DEMO.md): TELEGRAM_MODE=polling — long-polling, no public webhook required.
  if (bot && env.TELEGRAM_MODE === 'polling') {
    const [{ handleUpdate }, { botDeps }] = await Promise.all([
      import('./services/bot.js'),
      import('./routes/telegram.js'),
    ]);
    try {
      await bot.api.deleteWebhook({ drop_pending_updates: false });
    } catch (e) {
      console.warn(errorLine('deleteWebhook failed', e));
    }
    const deps = botDeps(db, bot);
    bot.on('message', async (ctx) => { await handleUpdate(deps, ctx.update as never); });
    bot.on('callback_query', async (ctx) => { await handleUpdate(deps, ctx.update as never); });
    // grammY's own default handler prints the whole error object, and a GrammyError carries the
    // request payload — the text that was being sent to the class. Class and code only.
    bot.catch((err) => console.warn(botErrorLine(err)));
    void bot.start().catch((e: Error) => console.warn(errorLine('telegram polling stopped', e)));
  }

  const app = await buildApp(db, { email: createEmailTransport(env) });
  /*
   * Часть F (2026-10-16): одна строка о том, ходят ли письма. Печатается ровно имя провайдера —
   * ни адреса, ни ключей, ни `SMTP_USER`. При `none` (умолчание) строка тоже нужна: «почта
   * выключена» — это состояние продакшена, о котором молчать нельзя, иначе неотправленное письмо
   * выглядит как баг формы.
   */
  console.log(`email: провайдер ${env.EMAIL_PROVIDER}`);

  // Task 2г: say out loud which Origins the deployment will accept, and warn about the
  // configuration drift that caused the video-lesson outage. Origins are public host
  // names — no secret value is ever logged here.
  const { originBootSummary } = await import('./lib/origin.js');
  const origins = originBootSummary();
  console.log(`origins: allowed=[${origins.allowed.join(', ') || '—'}] sameHost=on`);
  for (const w of origins.warnings) console.warn(`origin config warning: ${w}`);

  /*
   * SEC-14: прогреваем фиктивный хеш до первого входа. Он считается теми же env-параметрами,
   * что и настоящие, поэтому первая попытка «нет такого аккаунта» не должна включать в себя
   * ещё и генерацию. Отказ не роняет старт: если Argon2 не работает, вход всё равно сломан,
   * и падать на прогреве — значит не дать приложению даже сказать об этом.
   */
  {
    const { dummyPasswordHash } = await import('./services/auth.js');
    await dummyPasswordHash().catch((e) => console.warn(errorLine('dummy hash warm-up', e)));
  }

  await app.listen({ port: env.PORT, host: env.HOST });

  const shutdown = async () => {
    app.log.info('shutting down');
    const { stopNotifyWorker } = await import('./services/notifyQueue.js');
    await stopNotifyWorker();
    await app.close();
    await closeDb();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

// A rejection nobody caught would otherwise be printed by Node itself — with the driver's full
// message, which is where a connection string lives (measured: postgres-js puts it there). The
// guards keep Node's own semantics (both cases end the process) and change only the text.
installCrashGuards();

// Boot failure: class and code only. This is the one place with no log pipeline left, and a
// driver/migration error is exactly where a connection string tends to appear.
main().catch((err) => {
  console.error(`boot failed: ${describeError(err)}`);
  process.exit(1);
});
