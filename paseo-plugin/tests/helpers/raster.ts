import { deflateSync } from 'node:zlib';

/** Small valid, distinct originals for multi-image delivery and browser checks. */
export function fixturePng(red: number, green: number, blue: number, width = 96, height = 64): Buffer {
  const chunk = (name: string, bytes: Buffer) => {
    const type = Buffer.from(name), size = Buffer.alloc(4), crc = Buffer.alloc(4);
    size.writeUInt32BE(bytes.length);
    let value = 0xffffffff;
    for (const byte of Buffer.concat([type, bytes])) { value ^= byte; for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ value >>> 1 : value >>> 1; }
    crc.writeUInt32BE((value ^ 0xffffffff) >>> 0);
    return Buffer.concat([size, type, bytes, crc]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const pixels = Buffer.alloc(height * (width * 3 + 1));
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) pixels.set([red, green, blue], y * (width * 3 + 1) + x * 3 + 1);
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}
