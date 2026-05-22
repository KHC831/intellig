#!/usr/bin/env node
/* eslint-disable */
// Emits a 128x128 PNG monogram (`IG`) placeholder icon to
// `images/icon.png`. Zero-dep: Node `zlib` for IDAT compression,
// hand-rolled CRC32. Replace this file before final publish — the
// prepublish guard tracks the produced PNG's SHA-256 in
// `scripts/prerelease-state.json`.

import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, '..', 'images', 'icon.png');

const SIZE = 128;
const BG = [0x2b, 0x2b, 0x2b]; // IntelliJ darcula gray
const FG = [0x68, 0x97, 0xbb]; // IntelliJ modified-blue

// 5x7 bitmap font, just `I` and `G`. Each row is 5 bits.
const GLYPH = {
  I: [
    0b11111,
    0b00100,
    0b00100,
    0b00100,
    0b00100,
    0b00100,
    0b11111,
  ],
  G: [
    0b01110,
    0b10001,
    0b10000,
    0b10111,
    0b10001,
    0b10001,
    0b01110,
  ],
};

// 8x font scale -> 40x56 per glyph. Two glyphs side-by-side with 8px gap = 88x56,
// centered in 128x128.
const SCALE = 8;
const GLYPH_W = 5 * SCALE;
const GLYPH_H = 7 * SCALE;
const GAP = SCALE;
const TEXT_W = GLYPH_W * 2 + GAP;
const X0 = Math.floor((SIZE - TEXT_W) / 2);
const Y0 = Math.floor((SIZE - GLYPH_H) / 2);

const pixels = Buffer.alloc(SIZE * SIZE * 4);
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const i = (y * SIZE + x) * 4;
    pixels[i] = BG[0];
    pixels[i + 1] = BG[1];
    pixels[i + 2] = BG[2];
    pixels[i + 3] = 0xff;
  }
}

function paintGlyph(ch, originX) {
  const rows = GLYPH[ch];
  for (let ry = 0; ry < 7; ry++) {
    const row = rows[ry];
    for (let rx = 0; rx < 5; rx++) {
      const on = (row >> (4 - rx)) & 1;
      if (!on) continue;
      const px0 = originX + rx * SCALE;
      const py0 = Y0 + ry * SCALE;
      for (let dy = 0; dy < SCALE; dy++) {
        for (let dx = 0; dx < SCALE; dx++) {
          const px = px0 + dx;
          const py = py0 + dy;
          const i = (py * SIZE + px) * 4;
          pixels[i] = FG[0];
          pixels[i + 1] = FG[1];
          pixels[i + 2] = FG[2];
          pixels[i + 3] = 0xff;
        }
      }
    }
  }
}

paintGlyph('I', X0);
paintGlyph('G', X0 + GLYPH_W + GAP);

// Pack into PNG scanlines: filter byte (0 = None) + RGBA row.
const raw = Buffer.alloc(SIZE * (1 + SIZE * 4));
for (let y = 0; y < SIZE; y++) {
  raw[y * (1 + SIZE * 4)] = 0;
  pixels.copy(raw, y * (1 + SIZE * 4) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}

const idat = deflateSync(raw, { level: 9 });

// CRC32 (PNG spec).
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcInput = Buffer.concat([typeBuf, data]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
ihdr[10] = 0;
ihdr[11] = 0;
ihdr[12] = 0;

const png = Buffer.concat([
  sig,
  chunk('IHDR', ihdr),
  chunk('IDAT', idat),
  chunk('IEND', Buffer.alloc(0)),
]);

writeFileSync(OUT, png);

import { createHash } from 'node:crypto';
const sha = createHash('sha256').update(png).digest('hex');
console.log(`[generate-placeholder-icon] wrote ${OUT} (${png.length} bytes)`);
console.log(`[generate-placeholder-icon] sha256=${sha}`);
