import postgres from 'postgres';
const admin = postgres('postgres://klass:klass@127.0.0.1:5433/postgres');
const exists = await admin`select 1 from pg_database where datname='klass_r'`;
if (!exists.length) await admin.unsafe('create database klass_r owner klass');
await admin.end();

const db = postgres('postgres://klass:klass@127.0.0.1:5433/klass');
await db.unsafe(`insert into users (id, role, name, email, password_hash, locale, tz, created_at)
  values (gen_random_uuid(), 'teacher', 'Backup Admin', 'bkp'||floor(random()*1e9)::text||'@x.io', 'x', 'ru', 'UTC', now())`);
const teacher = (await db`select id from users where role='teacher' order by created_at limit 1`)[0];
const seeded = await db`select count(*)::int as n from classes`;
if (seeded[0].n < 3) {
  await db`insert into classes (id, teacher_id, name, description, color, created_at)
           values (gen_random_uuid(), ${teacher.id}, 'Smoke A', '', '#000000', now()),
                  (gen_random_uuid(), ${teacher.id}, 'Smoke B', '', '#000000', now()),
                  (gen_random_uuid(), ${teacher.id}, 'Smoke C', '', '#000000', now())`;
}
const n1 = await db`select count(*)::int as n from classes`;
const n2 = await db`select count(*)::int as n from users`;
console.log('SEED counts classes=' + n1[0].n + ' users=' + n2[0].n);
await db.end();
