// Generates the app icons from code so the repo ships no binary assets:
// assets/tray.png (32px), assets/icon-256.png, build/icon.ico (PNG-compressed entry).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

export function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// 5x7 "S" glyph.
const S = ['.XXXX', 'X....', 'X....', '.XXX.', '....X', '....X', 'XXXX.'];

export function drawIcon(size) {
  const px = Buffer.alloc(size * size * 4);
  const radius = Math.round(size * 0.22);
  const inCorner = (x, y) => {
    const cx = x < radius ? radius : x >= size - radius ? size - radius - 1 : null;
    const cy = y < radius ? radius : y >= size - radius ? size - radius - 1 : null;
    if (cx === null || cy === null) return false;
    return (x - cx) ** 2 + (y - cy) ** 2 > radius ** 2;
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (inCorner(x, y)) continue; // transparent corner
      const i = (y * size + x) * 4;
      px[i] = 0x00; px[i + 1] = 0x67; px[i + 2] = 0xc0; px[i + 3] = 0xff; // #0067c0
    }
  }
  // Center the glyph at ~60% height.
  const cell = Math.max(1, Math.floor((size * 0.6) / 7));
  const gw = cell * 5, gh = cell * 7;
  const ox = Math.floor((size - gw) / 2), oy = Math.floor((size - gh) / 2);
  for (let r = 0; r < 7; r++) {
    for (let c = 0; c < 5; c++) {
      if (S[r][c] !== 'X') continue;
      for (let dy = 0; dy < cell; dy++) {
        for (let dx = 0; dx < cell; dx++) {
          const i = ((oy + r * cell + dy) * size + (ox + c * cell + dx)) * 4;
          px[i] = 0xff; px[i + 1] = 0xff; px[i + 2] = 0xff; px[i + 3] = 0xff;
        }
      }
    }
  }
  return px;
}

export function encodeIco(pngBuffer, size) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // icon type
  header.writeUInt16LE(1, 4); // one image
  const entry = Buffer.alloc(16);
  entry[0] = size >= 256 ? 0 : size;
  entry[1] = size >= 256 ? 0 : size;
  entry.writeUInt16LE(1, 4);  // planes
  entry.writeUInt16LE(32, 6); // bit count
  entry.writeUInt32LE(pngBuffer.length, 8);
  entry.writeUInt32LE(22, 12); // offset after header+entry
  return Buffer.concat([header, entry, pngBuffer]);
}

export function generate(rootDir = root) {
  fs.mkdirSync(path.join(rootDir, 'assets'), { recursive: true });
  fs.mkdirSync(path.join(rootDir, 'build'), { recursive: true });
  const png256 = encodePng(256, drawIcon(256));
  const png32 = encodePng(32, drawIcon(32));
  fs.writeFileSync(path.join(rootDir, 'assets', 'icon-256.png'), png256);
  fs.writeFileSync(path.join(rootDir, 'assets', 'tray.png'), png32);
  fs.writeFileSync(path.join(rootDir, 'build', 'icon.ico'), encodeIco(png256, 256));
  return true;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  generate();
  console.log('icons written: assets/tray.png, assets/icon-256.png, build/icon.ico');
}
