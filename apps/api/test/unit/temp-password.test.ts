/**
 * Часть B3 (2026-10-16): временный пароль генерится в одном месте.
 *
 * До правки в репозитории жили две функции `tempPassword` с одним и тем же алфавитом, но
 * РАЗНОЙ длиной: маршрут «учитель сбросил пароль ученика» давал 10 знаков, скрипт владельца
 * `reset-teacher` — 12. Человек, которому диктуют пароль, этого не различит, а подсказка
 * («сбросьте пароль, он 12 знаков») расходится с реальностью. Тест держит и генератор, и то,
 * что второго не появилось: алфавит и `randomBytes` для паролей живут только в `lib/password.ts`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { passwordPolicy } from '@klass/shared';
import { tempPassword, TEMP_ALPHABET, TEMP_PASSWORD_LENGTH } from '../../src/lib/password.js';

const API_ROOT = path.resolve(__dirname, '..', '..'); // apps/api

function tsAndMjs(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue;
    if (statSync(full).isDirectory()) out.push(...tsAndMjs(full));
    else if (/\.(ts|mjs)$/.test(name)) out.push(full);
  }
  return out;
}

const files = tsAndMjs(path.join(API_ROOT, 'src')).concat(tsAndMjs(path.join(API_ROOT, 'scripts')));
const HOME = 'src/lib/password.ts';

describe('B3: один генератор временного пароля', () => {
  it('длина 12, алфавит без неоднозначных знаков, пароль проходит политику регистрации', () => {
    expect(TEMP_PASSWORD_LENGTH).toBe(12);
    // знаки, которые путают при диктовке голосом и наборе с телефона
    for (const ambiguous of ['I', 'l', '1', 'O', '0']) {
      expect(TEMP_ALPHABET, `алфавит не должен содержать «${ambiguous}»`).not.toContain(ambiguous);
    }
    for (let i = 0; i < 200; i++) {
      const p = tempPassword();
      expect(p).toHaveLength(TEMP_PASSWORD_LENGTH);
      expect([...p].every((c) => TEMP_ALPHABET.includes(c)), p).toBe(true);
      // политика требует ≥10 и ДВА вида символов: временный пароль обязан проходить её ВСЕГДА,
      // иначе сброс даёт аккаунт, который не может сменить пароль на такой же
      expect(passwordPolicy.safeParse(p).success, `политика отклонила «${p}»`).toBe(true);
    }
    expect(new Set(Array.from({ length: 50 }, () => tempPassword())).size, 'значения не повторяются').toBeGreaterThan(40);
  });

  it('второго генератора в коде нет: алфавит и crypto-сырьё для паролей живут в одном файле', () => {
    const alphabetCopies: string[] = [];
    const tempFnCopies: string[] = [];
    for (const f of files) {
      const rel = path.relative(API_ROOT, f).replace(/\\/g, '/');
      const src = readFileSync(f, 'utf8');
      if (src.includes(TEMP_ALPHABET) && rel !== HOME) alphabetCopies.push(rel);
      if (src.includes('TEMP_ALPHABET') && rel !== HOME) alphabetCopies.push(`${rel} (импорт)`);
      if (/(function|const)\s+tempPassword\s*[=(]/.test(src) && rel !== HOME) tempFnCopies.push(rel);
    }
    expect(alphabetCopies, `алфавит продублирован в: ${alphabetCopies.join(', ')}`).toEqual([]);
    expect(tempFnCopies, `второй tempPassword в: ${tempFnCopies.join(', ')}`).toEqual([]);
  });

  it('и маршрут учителя, и скрипт владельца импортируют его', () => {
    const route = readFileSync(path.join(API_ROOT, 'src/routes/classes.ts'), 'utf8');
    expect(route).toMatch(/import\s*\{\s*tempPassword\s*\}\s*from\s*'\.\.\/lib\/password\.js'/);
    const script = readFileSync(path.join(API_ROOT, 'scripts/reset-teacher.mjs'), 'utf8');
    expect(script, 'скрипт владельца берёт генератор из dist, а не переписывает его').toMatch(/tempPassword/);
    expect(script).not.toMatch(/randomBytes/);
    expect(script).toMatch(/dist\/lib\/password\.js/);
  });
});
