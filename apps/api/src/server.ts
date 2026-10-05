import { env } from './env.js';
import { getDb, closeDb } from './db/index.js';
import { buildApp } from './app.js';
import path from 'node:path';
import fs from 'node:fs';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { LogTransport, TelegramTransport } from './services/notify.js';
import { createBot } from './services/telegramBot.js';
import { initNotifyWorker } from './services/notifyQueue.js';

async function main() {
  const db = getDb(env.DATABASE_URL);

  // Versioned migrations applied at boot (§4 надёжность). Fails fast if broken.
  const migrationsFolder = env.NODE_ENV === 'production'
    ? path.join(process.cwd(), 'dist', 'db', 'migrations')
    : path.join(process.cwd(), 'src', 'db', 'migrations');
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
  const webhookBase = env.PUBLIC_URL || (env.DOMAIN ? `https://${env.DOMAIN}` : '');
  if (bot && webhookBase && env.TELEGRAM_WEBHOOK_SECRET && env.TELEGRAM_MODE === 'webhook') {
    try {
      await bot.api.setWebhook(`${webhookBase}/webhook/telegram`, {
        secret_token: env.TELEGRAM_WEBHOOK_SECRET,
        drop_pending_updates: false,
      });
      console.log(`telegram webhook registered for ${webhookBase.replace(/^https:\/\//, '')}`); // host only, no secrets
    } catch (e) {
      // understandable reason, token scrubbed (grammY messages may embed nothing secret, belt-and-braces)
      const msg = String((e as Error).message ?? e).replaceAll(env.TELEGRAM_BOT_TOKEN, '***');
      console.warn(`telegram webhook registration FAILED (bot is up, Telegram will not reach it until this works): ${msg}`);
    }
  } else if (bot && env.TELEGRAM_MODE === 'webhook') {
    console.warn('telegram webhook skipped: set PUBLIC_URL (or DOMAIN) and TELEGRAM_WEBHOOK_SECRET');
  }
  // bot task §1: default-scope command menu (basic set) refreshed at every boot
  if (bot && env.TELEGRAM_TRANSPORT === 'telegram') {
    const { applyMenu, grammyApi } = await import('./services/botApi.js');
    await applyMenu(grammyApi(bot), 'basic').catch((e: Error) => console.warn('setMyCommands failed:', e.message));
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
      console.warn('deleteWebhook failed:', (e as Error).message);
    }
    const deps = botDeps(db, bot);
    bot.on('message', async (ctx) => { await handleUpdate(deps, ctx.update as never); });
    bot.on('callback_query', async (ctx) => { await handleUpdate(deps, ctx.update as never); });
    bot.catch((err) => console.warn('telegram polling error:', (err.error as Error)?.message ?? String(err.error)));
    void bot.start().catch((e: Error) => console.warn('telegram polling stopped:', e.message));
  }

  const app = await buildApp(db);
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

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
