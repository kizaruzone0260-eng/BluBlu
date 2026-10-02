import { hash, verify, type Options } from '@node-rs/argon2';
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
