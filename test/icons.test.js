import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { encodePng, drawIcon, encodeIco, generate } from '../scripts/make-icons.js';

test('encodePng produces a valid PNG signature and IHDR dimensions', () => {
  const png = encodePng(32, drawIcon(32));
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(png.readUInt32BE(16), 32); // width
  assert.equal(png.readUInt32BE(20), 32); // height
});

test('encodeIco wraps the PNG with a single 256px entry', () => {
  const png = encodePng(256, drawIcon(256));
  const ico = encodeIco(png, 256);
  assert.equal(ico.readUInt16LE(2), 1);  // type: icon
  assert.equal(ico.readUInt16LE(4), 1);  // one image
  assert.equal(ico[6], 0);               // 0 means 256
  assert.equal(ico.readUInt32LE(14), png.length);
  assert.deepEqual([...ico.subarray(22, 30)], [...png.subarray(0, 8)]);
});

test('generate writes the three icon files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-i-'));
  generate(dir);
  for (const f of ['assets/tray.png', 'assets/icon-256.png', 'build/icon.ico']) {
    assert.ok(fs.existsSync(path.join(dir, f)), f);
  }
});
