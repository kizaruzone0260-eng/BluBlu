/**
 * Часть 4: продолжение замера — сколько весит ОДИН элемент доски по типам.
 *
 * `measure-board-size.mjs` даёт средний размер строки; для оценки «сколько досок влезает в
 * 500 МБ» важнее другой вопрос: рисованные мышью штрихи (type=draw) несут массив точек и весят
 * заметно больше фигур. Считаем по типам ровно там, где они реально лежат — в снимках доски.
 *
 * Только чтение локального e2e-кластера. Запуск: node apps/e2e/scripts/measure-board-elements.mjs
 */
import EmbeddedPostgres from 'embedded-postgres';
import postgres from 'postgres';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '../../..');
const pg = new EmbeddedPostgres({
  databaseDir: path.join(ROOT, 'apps/e2e/e2edata'), user: 'klass', password: 'klass', port: 5455, persistent: true,
});
await pg.start();
const sql = postgres('postgres://klass:klass@127.0.0.1:5455/klass', { max: 3 });
const dim = (rows) => rows.map((r) => Object.fromEntries(
  Object.entries(r).map(([k, v]) => [k, typeof v === 'string' || typeof v === 'number' || v === null ? v : String(v)])));

try {
  const byType = await sql`
    select coalesce(el ->> 'type', '(null)') as type, count(*)::int as n,
           round(avg(length(el #>> '{}')))::bigint as avg_bytes,
           max(length(el #>> '{}'))::bigint as max_bytes,
           round(avg(jsonb_array_length(coalesce(el -> 'points', '[]'::jsonb))))::int as avg_points
      from whiteboards, jsonb_array_elements(snapshot -> 'elements') el
     group by 1 order by avg_bytes desc nulls last`;
  console.log('ELEMENTS BY TYPE', JSON.stringify(dim(byType)));

  // самый тяжёлый элемент и сколько в нём точек — это и есть «плечо» оценки на реальный урок
  const heaviest = await sql`
    select el ->> 'type' as type, length(el #>> '{}')::int as bytes,
           jsonb_array_length(coalesce(el -> 'points', '[]'::jsonb)) as points
      from whiteboards, jsonb_array_elements(snapshot -> 'elements') el
     order by bytes desc limit 5`;
  console.log('HEAVIEST ELEMENTS', JSON.stringify(dim(heaviest)));
} finally {
  await sql.end({ timeout: 5 });
  await pg.stop();
}
