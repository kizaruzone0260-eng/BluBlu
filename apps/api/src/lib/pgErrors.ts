/**
 * Распознавание нарушения уникальности в ошибке БД (PostgreSQL `23505`).
 *
 * Зачем отдельный модуль. Проверка нужна уже в трёх местах, и в каждом она — не удобство, а
 * единственный способ отличить «гонку выиграл конкурент» от настоящей поломки:
 *  • `services/auth.ts` — две регистрации одного адреса (`users.email`);
 *  • `services/lessons.ts` — два одновременных «Начать урок» (частичный уникальный индекс
 *    `lesson_sessions_one_active_per_class`, SEC-11);
 *  • и любой следующий инвариант, который решено держать в базе, а не в договорённости.
 *
 * Почему не `err.code === '23505'`. drizzle-orm заворачивает ошибку драйвера в собственный
 * `Failed query: …`, и код Postgres оказывается на `err.cause.code`; внутри `db.transaction`
 * форма другая, чем снаружи. Это было доказано воспроизведением (test/integration/auth-nat.test.ts:
 * вторая регистрация занятого адреса отвечала 500 вместо 409), а не рассуждением. Поэтому обход
 * идёт по цепочке `cause` с защитой от циклов.
 */
export function isUniqueViolation(err: unknown): boolean {
  const seen = new Set<unknown>();
  let cur: unknown = err;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    if ((cur as { code?: string }).code === '23505') return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}
