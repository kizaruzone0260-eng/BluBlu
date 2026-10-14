/**
 * Часть 4 (2026-10-14): измерение реального размера доски.
 *
 * Вопрос отчёта: сколько досок помещается в 500 МБ базы Supabase. Отвечать на него «на глазок»
 * нельзя, поэтому скрипт поднимает ЛОКАЛЬНЫЙ e2e-кластер Postgres (тот же `apps/e2e/e2edata`,
 * где живут строки после прогонов zz11/zz12/zz20 — их рисовал настоящий Excalidraw настоящей
 * мышью) и читает из него фактические снимки досок.
 *
 * Только чтение: ни миграций, ни TRUNCATE, ни записи. Боевая база здесь не участвует.
 *
 * Запуск: node apps/e2e/scripts/measure-board-size.mjs   (набор e2e должен быть остановлен)
 */
import EmbeddedPostgres from 'embedded-postgres';
import postgres from 'postgres';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '../../..');
const dataDir = path.join(ROOT, 'apps/e2e/e2edata');
const PGPORT = 5455;

console.log('[measure] starting postgres on e2edata…');
const pg = new EmbeddedPostgres({ databaseDir: dataDir, user: 'klass', password: 'klass', port: PGPORT, persistent: true });
await pg.start();
console.log('[measure] postgres started, connecting…');
const sql = postgres(`postgres://klass:klass@127.0.0.1:${PGPORT}/klass`, { max: 3 });

const dim = (rows) => rows.map((r) => Object.fromEntries(
  Object.entries(r).map(([k, v]) => [k, typeof v === 'string' || typeof v === 'number' || v === null ? v : String(v)])));

try {
  console.log('[measure] querying whiteboards…');
  const boards = await sql`
    select count(*)::int as rows,
           coalesce(sum(length(cast(snapshot as text))), 0)::bigint as bytes_total,
           coalesce(round(avg(length(cast(snapshot as text)))), 0)::bigint as bytes_avg,
           coalesce(max(length(cast(snapshot as text))), 0)::bigint as bytes_max,
           coalesce(min(length(cast(snapshot as text))), 0)::bigint as bytes_min,
           (select pg_size_pretty(pg_total_relation_size('whiteboards'))) as table_with_indexes
      from whiteboards`;
  console.log('BOARDS', JSON.stringify(dim(boards)[0]));

  const each = await sql`
    select session_id, page_no,
           jsonb_array_length(coalesce(snapshot -> 'elements', '[]'::jsonb)) as elements,
           length(cast(snapshot as text)) as bytes
      from whiteboards order by bytes desc limit 12`;
  console.log('TOP BOARDS', JSON.stringify(dim(each)));

  const perElement = await sql`
    select count(*)::int as n,
           coalesce(round(avg(length(cast(snapshot as text)) /
             greatest(jsonb_array_length(coalesce(snapshot -> 'elements', '[]'::jsonb)), 1))), 0)::bigint
             as bytes_per_element
      from whiteboards
     where jsonb_array_length(coalesce(snapshot -> 'elements', '[]'::jsonb)) > 0`;
  console.log('PER ELEMENT', JSON.stringify(dim(perElement)[0]));

  const db = await sql`select pg_size_pretty(pg_database_size('klass')) as database_size`;
  console.log('DATABASE', JSON.stringify(dim(db)[0]));

  // оценка на 500 МБ: считаем по измеренному среднему, потолок сцены при этом 2 МБ
  const b = dim(boards)[0];
  const avg = Number(b.bytes_avg) || 0;
  if (avg > 0) {
    console.log('ESTIMATE', JSON.stringify({
      avgBytes: avg,
      boardsIn500mb: Math.floor(500 * 1024 * 1024 / avg),
      worstCaseAtCap: Math.floor(500 * 1024 * 1024 / 2_000_000),
    }));
  }
} finally {
  await sql.end({ timeout: 5 });
  await pg.stop();
}
