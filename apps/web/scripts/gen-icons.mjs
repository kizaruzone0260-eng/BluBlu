import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';

/**
 * Tiny lossless PNG writer: teal (brand accent) square with a white letter B
 * (5×8 bitmap scaled to the middle 60% of the icon). Placeholder until a
 * designer logo arrives.
 */
const BG = [15, 118, 110];   // #0f766e
const FG = [255, 255, 255];
const GLYPH = [
  '11110',
  '10001',
  '10001',
  '11110',
  '10001',
  '10001',
  '10001',
  '11110',
];
function crc32(buf) {
  let c, table = [];
  for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; }
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, c]);
}
function png(size) {
  const box = Math.floor(size * 0.6);
  const cell = box / 5;
  const offX = Math.floor((size - box) / 2);
  const offY = Math.floor((size - cell * 8) / 2);
  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 3);
    for (let x = 0; x < size; x++) {
      let px = FG;
      const gx = Math.floor((x - offX) / cell);
      const gy = Math.floor((y - offY) / cell);
      const inGlyph = x >= offX && y >= offY && gx >= 0 && gx < 5 && gy >= 0 && gy < 8;
      if (!inGlyph || GLYPH[gy]?.[gx] !== '1') px = BG;
      row[1 + x * 3] = px[0]; row[2 + x * 3] = px[1]; row[3 + x * 3] = px[2];
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
writeFileSync('public/icon-192.png', png(192));
writeFileSync('public/icon-512.png', png(512));
console.log('icons written (BluBlu B, teal)');
