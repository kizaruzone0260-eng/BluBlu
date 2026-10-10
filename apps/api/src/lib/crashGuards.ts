import { describeError } from './redact.js';

/**
 * The two crashes that have no `main().catch` and no logger in front of them.
 *
 * Without these handlers Node prints the rejection/exception itself — full message, full stack —
 * and the message is where a driver puts its connection string (measured; see docs/HARDENING.md,
 * «Ошибка — тот же класс риска»). An unhandled `'error'` event on an EventEmitter (pg-boss, a ws
 * socket) also lands in `uncaughtException`, so this is the last net for those paths too.
 *
 * Semantics are Node's own: both cases end the process with a non-zero code. Only the text
 * changes — class and code, never the message.
 *
 * Exported as a function so a test can install it in a real child process and read what the
 * process actually prints; registering it from inside `main()` would leave the boot window
 * unguarded.
 */
export function installCrashGuards(): void {
  process.on('unhandledRejection', (reason) => {
    console.error(`unhandled rejection: ${describeError(reason)}`);
    process.exit(1);
  });
  process.on('uncaughtException', (err) => {
    console.error(`uncaught exception: ${describeError(err)}`);
    process.exit(1);
  });
}
