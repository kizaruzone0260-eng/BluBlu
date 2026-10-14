/**
 * Часть 5 (2026-10-14): читатель ZIP для проверки .docx из теста.
 *
 * `docx` пишет обычный zip без шифрования, а зависимости-распаковщика в этом пакете нет (и не
 * должно быть — ради одного теста). Поэтому здесь минимальный, честный разбор: центральный
 * каталог → локальные заголовки → данные (stored или deflate). Именно «распакуй и посчитай
 * картинки» из постановки, а не поиск подстроки в байтах.
 */
import { inflateRawSync } from 'node:zlib';

export interface ZipEntry { name: string; data: Buffer }

export function unzip(buf: Buffer): ZipEntry[] {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error('not a zip: end-of-central-directory not found');
  const count = buf.readUInt16LE(eocd + 10);
  const cdStart = buf.readUInt32LE(eocd + 16);
  const entries: ZipEntry[] = [];
  for (let off = cdStart, i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error(`bad central header at ${off}`);
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    /*
     * Данные берутся по ЛОКАЛЬНОМУ заголовку: у него своя длина имени и своего extra-поля, и они
     * не обязаны совпадать с центральными. Ошибка на этом шаге выглядит как «мусор вместо png».
     */
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const start = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(start, start + compSize);
    entries.push({ name, data: method === 0 ? Buffer.from(raw) : inflateRawSync(raw) });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

export const find = (entries: ZipEntry[], name: string): Buffer => {
  const hit = entries.find((e) => e.name === name);
  if (!hit) throw new Error(`zip has no ${name}; got ${entries.map((e) => e.name).join(', ')}`);
  return hit.data;
};

/** Ширина/высота PNG из IHDR — без декодирования картинки. */
export function pngSize(buf: Buffer): { width: number; height: number } {
  if (buf.length < 24) return { width: 0, height: 0 };
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}
