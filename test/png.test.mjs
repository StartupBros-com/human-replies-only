// The PNG helper the store images go through: round trips, every row filter a
// PNG encoder may use, flattening alpha, and refusals.
import test from 'node:test';
import assert from 'node:assert/strict';
import { crc32, deflateSync } from 'node:zlib';
import { flattenPng, readPng, writePng } from '../scripts/png.mjs';

const W = 3;
const H = 5;
// 3x5 RGBA, values chosen so neighbouring pixels differ and filters matter.
const rgba = Buffer.from(Array.from({ length: W * H * 4 }, (_, i) => (i * 37 + (i >> 2) * 11) & 0xff));

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), body.length + 4);
  return out;
}

// Encode with filter type f on every row, the way another encoder could.
function encodeFiltered(pixels, width, height, channels, f) {
  const stride = width * channels;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = f;
    for (let i = 0; i < stride; i++) {
      const x = pixels[y * stride + i];
      const a = i >= channels ? pixels[y * stride + i - channels] : 0;
      const b = y ? pixels[(y - 1) * stride + i] : 0;
      const c = y && i >= channels ? pixels[(y - 1) * stride + i - channels] : 0;
      let pred = 0;
      if (f === 1) pred = a;
      else if (f === 2) pred = b;
      else if (f === 3) pred = (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      raw[y * (stride + 1) + 1 + i] = (x - pred) & 0xff;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = channels === 4 ? 6 : 2;
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  // Split the data over two IDAT chunks, which readers must join.
  const z = deflateSync(raw);
  const half = z.length >> 1;
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', z.subarray(0, half)), chunk('IDAT', z.subarray(half)), chunk('IEND', Buffer.alloc(0))]);
}

test('writePng then readPng returns the same pixels, with and without alpha', () => {
  const back = readPng(writePng({ width: W, height: H, channels: 4, pixels: rgba }));
  assert.deepEqual([back.width, back.height, back.channels], [W, H, 4]);
  assert.ok(back.pixels.equals(rgba));
  const rgb = rgba.subarray(0, W * H * 3);
  assert.ok(readPng(writePng({ width: W, height: H, channels: 3, pixels: rgb })).pixels.equals(rgb));
});

test('rows stored with each filter type decode to the original pixels', () => {
  for (const f of [0, 1, 2, 3, 4]) {
    assert.ok(readPng(encodeFiltered(rgba, W, H, 4, f)).pixels.equals(rgba), `filter ${f}`);
  }
});

test('flattenPng drops alpha by compositing over white, and keeps opaque pixels', () => {
  // Opaque red, transparent anything, half-transparent black.
  const px = Buffer.from([255, 0, 0, 255, 12, 34, 56, 0, 0, 0, 0, 128]);
  const out = readPng(flattenPng(writePng({ width: 3, height: 1, channels: 4, pixels: px })));
  assert.equal(out.channels, 3);
  assert.deepEqual([...out.pixels], [255, 0, 0, 255, 255, 255, 127, 127, 127]);
  const rgb = Buffer.from([1, 2, 3, 4, 5, 6]);
  assert.ok(readPng(flattenPng(writePng({ width: 2, height: 1, channels: 3, pixels: rgb }))).pixels.equals(rgb));
});

test('a file that is not a PNG, or a PNG it cannot read, is refused', () => {
  assert.throws(() => readPng(Buffer.from('GIF89a')), /not a PNG/);
  const gray = encodeFiltered(Buffer.from([1, 2, 3, 4]), 2, 2, 1, 0);
  gray[8 + 8 + 9] = 0; // color type 0, grayscale
  assert.throws(() => readPng(gray), /unsupported PNG/);
  assert.throws(() => writePng({ width: 2, height: 2, channels: 4, pixels: Buffer.alloc(3) }), /does not match/);
});
