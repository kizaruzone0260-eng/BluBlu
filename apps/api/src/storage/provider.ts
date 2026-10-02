import fs from 'node:fs';
import path from 'node:path';
import { env } from '../env.js';

/**
 * StorageProvider (§3.3): v1 local disk volume; an S3-compatible impl can be
 * swapped without touching business logic. Keys are opaque (UUID.extension).
 */
export interface Range { start: number; end?: number }

export interface StoredRead { stream: fs.ReadStream; size: number }

export interface StorageProvider {
  put(key: string, data: Buffer): Promise<void>;
  /** Open for reading, optionally a byte range. Returns null if missing. */
  open(key: string, range?: Range): Promise<{ stream: fs.ReadStream; start: number; end: number; size: number } | null>;
  stat(key: string): Promise<number | null>; // size or null
  delete(key: string): Promise<void>;
}

export class DiskStorage implements StorageProvider {
  private root: string;

  constructor(root = env.STORAGE_DIR) {
    this.root = path.resolve(root);
    fs.mkdirSync(this.root, { recursive: true });
  }

  /** Keys are UUID.ext by construction; still resolve-safed. */
  private p(key: string): string {
    const clean = key.replace(/[^A-Za-z0-9._-]/g, '');
    return path.join(this.root, clean);
  }

  async put(key: string, data: Buffer): Promise<void> {
    await fs.promises.writeFile(this.p(key), data);
  }

  async stat(key: string): Promise<number | null> {
    try {
      const s = await fs.promises.stat(this.p(key));
      return s.size;
    } catch {
      return null;
    }
  }

  async open(key: string, range?: Range) {
    const size = await this.stat(key);
    if (size === null) return null;
    const start = range?.start ?? 0;
    const end = Math.min(range?.end ?? size - 1, size - 1);
    if (start >= size || start > end) return null;
    const stream = fs.createReadStream(this.p(key), { start, end });
    return { stream, start, end, size };
  }

  async delete(key: string): Promise<void> {
    await fs.promises.rm(this.p(key), { force: true });
  }
}

let storage: StorageProvider | null = null;
export function getStorage(): StorageProvider {
  storage ??= new DiskStorage();
  return storage;
}

/** Test hook */
export function setStorage(s: StorageProvider | null) {
  storage = s;
}
