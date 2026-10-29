import { hash, verify, type Options } from '@node-rs/argon2';
import { randomBytes } from 'node:crypto';
import { env } from '../env.js';

// Algorithm.Argon2id === 2; referenced numerically because isolatedModules
// forbids ambient const-enum access. Keep in sync with @node-rs/argon2 docs.
const ARGON2ID = 2 as Options['algorithm'];

const opts: Options = {
  algorithm: ARGON2ID,
  memoryCost: env.ARGON2_MEMORY_COST, // KiB
  timeCost: env.ARGON2_TIME_COST,
  parallelism: env.ARGON2_PARALLELISM,
  outputLen: 32,
};

export async function hashPassword(password: string): Promise<string> {
  return hash(password, opts);
}

export async function verifyPassword(hash$: string, password: string): Promise<boolean> {
  try {
    return await verify(hash$, password);
  } catch {
    return false;
  }
}

/**
 * Единственный генератор временного пароля (B3, 2026-10-16). До этого их было два: маршрут
 * «учитель сбросил пароль ученика» давал 10 символов, а скрипт владельца — 12, с одним и тем
 * же алфавитом, записанным дважды. Разъезд именно в длине заметен человеку: он не может
 * отличить «сказали 10, а в инструкции 12» от «недосмотрел». Здесь одна функция, одна длина,
 * один алфавит; скрипт владельца импортирует её из `dist/lib/password.js`.
 *
 * Алфавит без неоднозначных знаков (I l 1 O 0) — пароль диктуют голосом и набирают с телефона.
 * 55 знаков × 12 ≈ 2^69 переборов. Политика требует ≥10 знаков и ДВА вида символов —
 * ниже эти виды гарантируются, чтобы временный пароль всегда проходил собственную политику.
 */
export const TEMP_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
export const TEMP_PASSWORD_LENGTH = 12;

export function tempPassword(len = TEMP_PASSWORD_LENGTH): string {
  const upper = TEMP_ALPHABET.replace(/[^A-Z]/g, '');
  const lower = TEMP_ALPHABET.replace(/[^a-z]/g, '');
  const b = randomBytes(len + 2);
  const chars = Array.from({ length: len }, (_, i) => TEMP_ALPHABET[b[i]! % TEMP_ALPHABET.length]);
  /*
   * Первый знак — заглавная, последний — строчная. С 2026-10-28 (аудит SEC-12) политика
   * (`@klass/shared::passwordPolicy`) требует два вида символов из четырёх, а случайные 12
   * знаков могут целиком оказаться строчными (шанс ~7 из 100 000) или без букв вообще —
   * такой пароль собственный policy-фильтр отклонил бы, и сброс выдал бы значение, которое
   * нельзя сразу использовать. Две разные классовые буквы по краям дают гарантию при любой
   * генерации. Цена — энтропия 10·log2(55) + log2(24) + log2(23) ≈ 67,0 бита вместо 68–69.
   */
  if (len >= 2) {
    chars[0] = upper[b[len]! % upper.length];
    chars[len - 1] = lower[b[len + 1]! % lower.length];
  }
  return chars.join('');
}
