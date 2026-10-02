import { cpSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';

const src = path.resolve('src/db/migrations');
const dest = path.resolve('dist/db/migrations');
if (!existsSync(src)) {
  console.error(`no migrations in ${src} — run: pnpm db:generate`);
  process.exit(1);
}
mkdirSync(path.dirname(dest), { recursive: true });
cpSync(src, dest, { recursive: true });
console.log('migrations copied to dist');
