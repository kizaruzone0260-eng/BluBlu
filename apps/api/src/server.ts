import { env } from './env.js';
import { getDb, closeDb } from './db/index.js';
import { buildApp } from './app.js';
import path from 'node:path';
import fs from 'node:fs';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { LogTransport, TelegramTransport } from './services/notify.js';
import { createBot } from './services/telegramBot.js';
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
  // bot task §1: default-scope command menu (basic set) refreshed at every boot
  if (bot && env.TELEGRAM_TRANSPORT === 'telegram') {
    const { applyMenu, grammyApi } = await import('./services/botApi.js');
    await applyMenu(grammyApi(bot), 'basic').catch((e: Error) => console.warn(errorLine('setMyCommands failed', e)));
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

  const app = await buildApp(db);

  // Task 2г: say out loud which Origins the deployment will accept, and warn about the
  // configuration drift that caused the video-lesson outage. Origins are public host
  // names — no secret value is ever logged here.
  const { originBootSummary } = await import('./lib/origin.js');
  const origins = originBootSummary();
  console.log(`origins: allowed=[${origins.allowed.join(', ') || '—'}] sameHost=on`);
  for (const w of origins.warnings) console.warn(`origin config warning: ${w}`);

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
