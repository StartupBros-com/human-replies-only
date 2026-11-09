// Just enough PNG reading and writing for the store images. The Chrome Web
// Store wants screenshots and promo tiles without an alpha channel, and
// Chromium's screenshots carry one. Handles 8-bit, non-interlaced truecolor
// (color type 2) and truecolor with alpha (6); anything else throws.
import { crc32, deflateSync, inflateSync } from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// { width, height, channels: 3 | 4, pixels } with pixels row-major, unfiltered.
export function readPng(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 8 || !buf.subarray(0, 8).equals(SIGNATURE)) throw new Error('not a PNG file');
  let at = 8;
  let ihdr = null;
  const idat = [];
  while (at + 8 <= buf.length) {
    const len = buf.readUInt32BE(at);
    const type = buf.toString('latin1', at + 4, at + 8);
    const data = buf.subarray(at + 8, at + 8 + len);
    if (type === 'IHDR') {
      ihdr = { width: data.readUInt32BE(0), height: data.readUInt32BE(4), depth: data[8], colorType: data[9], interlace: data[12] };
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    at += 12 + len;
  }
  if (!ihdr) throw new Error('PNG has no IHDR chunk');
  const { width, height, depth, colorType, interlace } = ihdr;
  if (depth !== 8 || interlace !== 0 || (colorType !== 2 && colorType !== 6)) {
    throw new Error(`unsupported PNG: bit depth ${depth}, color type ${colorType}, interlace ${interlace}`);
  }
  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(idat));
  if (raw.length !== height * (stride + 1)) throw new Error('PNG image data has the wrong length');
  const pixels = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const row = pixels.subarray(y * stride, (y + 1) * stride);
    const up = y ? pixels.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? row[i - channels] : 0;
      const b = up ? up[i] : 0;
      const c = up && i >= channels ? up[i - channels] : 0;
      let v = src[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (filter !== 0) throw new Error(`bad PNG filter type ${filter} on row ${y}`);
      row[i] = v & 0xff;
    }
  }
  return { width, height, channels, pixels };
}

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), body.length + 4);
  return out;
}

// An 8-bit PNG, every row stored with filter type 0.
export function writePng({ width, height, channels, pixels }) {
  const colorType = channels === 4 ? 6 : channels === 3 ? 2 : 0;
  if (!colorType) throw new Error('channels must be 3 or 4');
  const stride = width * channels;
  if (pixels.length !== height * stride) throw new Error('pixel data does not match width, height and channels');
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = colorType;
  return Buffer.concat([SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// The same image as a PNG without alpha, each pixel composited over `background`.
export function flattenPng(buf, background = [255, 255, 255]) {
  const img = readPng(buf);
  if (img.channels === 3) return writePng(img);
  const n = img.width * img.height;
  const out = Buffer.alloc(n * 3);
  for (let i = 0; i < n; i++) {
    const alpha = img.pixels[i * 4 + 3];
    for (let k = 0; k < 3; k++) {
      out[i * 3 + k] = Math.round((img.pixels[i * 4 + k] * alpha + background[k] * (255 - alpha)) / 255);
    }
  }
  return writePng({ width: img.width, height: img.height, channels: 3, pixels: out });
}
