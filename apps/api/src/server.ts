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

  // Telegram webhook registration (best-effort; server admin does it too)
  const bot = createBot();
  const transport = bot && env.TELEGRAM_TRANSPORT === 'telegram'
    ? new TelegramTransport(bot)
    : new LogTransport();
  await initNotifyWorker(db, transport);
  // housekeeping: expired/used one-time WS tickets
  setInterval(() => {
    import('./services/wsTicket.js').then((m) => m.sweepWsTickets(db)).catch(() => undefined);
  }, 10 * 60_000).unref?.();
  if (bot && env.DOMAIN && env.TELEGRAM_WEBHOOK_SECRET && env.TELEGRAM_MODE === 'webhook') {
    try {
      await bot.api.setWebhook(`https://${env.DOMAIN}/webhook/telegram`, {
        secret_token: env.TELEGRAM_WEBHOOK_SECRET,
        drop_pending_updates: false,
      });
    } catch (e) {
      console.warn('setWebhook failed:', (e as Error).message);
    }
  }
  // Demo (docs/DEMO.md): TELEGRAM_MODE=polling — long-polling, no public webhook required.
  if (bot && env.TELEGRAM_MODE === 'polling') {
    const [{ processUpdate }, { botDeps }] = await Promise.all([
      import('./services/telegramBot.js'),
      import('./routes/telegram.js'),
    ]);
    try {
      await bot.api.deleteWebhook({ drop_pending_updates: false });
    } catch (e) {
      console.warn('deleteWebhook failed:', (e as Error).message);
    }
    bot.on('message', async (ctx) => {
      const res = await processUpdate(botDeps(db, bot), ctx.update as Parameters<typeof processUpdate>[1]);
      if (res.handled && res.reply) {
        try { await ctx.reply(res.reply); } catch { /* sender blocked the bot */ }
      }
    });
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
