/**
 * Generates the PWA icons without any native dependencies (pure JS rasteriser + zlib PNG encoder).
 * Design: near-black rounded tile, a thin light ring and an orange shutter dot, echoing the orange
 * shutter release on Hasselblad X-system bodies.
 *
 *   node tools/make-icons.mjs
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', 'icons');
mkdirSync(out, { recursive: true });

const BG = [0x0e, 0x0e, 0x10];
const RING = [0xe8, 0xe6, 0xe1];
const DOT = [0xf2, 0x71, 0x1c];

function crc32(buf) {
  let c;
  const table = crc32.table || (crc32.table = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })());
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function encodePNG(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Signed distance helpers (in normalised coordinates, 0..1). */
const sdRoundRect = (x, y, half, r) => {
  const qx = Math.abs(x) - half + r;
  const qy = Math.abs(y) - half + r;
  return Math.min(Math.max(qx, qy), 0) + Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - r;
};
const sdCircle = (x, y, r) => Math.hypot(x, y) - r;
const cover = (d, px) => Math.min(1, Math.max(0, 0.5 - d / px));

/**
 * @param {number} size output pixels
 * @param {{radius: number, transparent: boolean, scale: number}} opts
 *   radius: tile corner radius as a fraction of size (0 = square tile), transparent: outside tile is transparent
 *   scale: shrink the artwork (maskable icons need a safe zone)
 */
function render(size, { radius, transparent, scale }) {
  const ss = 4;
  const px = 1 / (size * ss);
  const rgba = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const nx = ((x + (sx + 0.5) / ss) / size - 0.5);
          const ny = ((y + (sy + 0.5) / ss) / size - 0.5);
          let cr = 0, cg = 0, cb = 0, ca = 0;
          const tile = transparent ? cover(sdRoundRect(nx, ny, 0.5, radius * 1.0), px) : 1;
          if (tile > 0) {
            cr = BG[0]; cg = BG[1]; cb = BG[2]; ca = tile;
            const ax = nx / scale, ay = ny / scale;
            // Thin ring (lens barrel)
            const ringOuter = 0.34, ringWidth = 0.022;
            const ring = cover(Math.abs(sdCircle(ax, ay, ringOuter - ringWidth / 2)) - ringWidth / 2, px / scale);
            cr = cr + (RING[0] - cr) * ring; cg = cg + (RING[1] - cg) * ring; cb = cb + (RING[2] - cb) * ring;
            // Orange shutter dot
            const dot = cover(sdCircle(ax, ay, 0.19), px / scale);
            cr = cr + (DOT[0] - cr) * dot; cg = cg + (DOT[1] - cg) * dot; cb = cb + (DOT[2] - cb) * dot;
            // Small highlight on the dot
            const hl = cover(sdCircle(ax + 0.07, ay + 0.08, 0.045), px / scale) * 0.55 * dot;
            cr = cr + (255 - cr) * hl; cg = cg + (255 - cg) * hl; cb = cb + (255 - cb) * hl;
          }
          r += cr * ca; g += cg * ca; b += cb * ca; a += ca;
        }
      }
      const i = (y * size + x) * 4;
      if (a > 0) { rgba[i] = Math.round(r / a); rgba[i + 1] = Math.round(g / a); rgba[i + 2] = Math.round(b / a); }
      rgba[i + 3] = Math.round((a / (ss * ss)) * 255);
    }
  }
  return encodePNG(size, size, rgba);
}

const files = [
  ['apple-touch-icon.png', 180, { radius: 0, transparent: false, scale: 1 }],
  ['icon-192.png', 192, { radius: 0.22, transparent: true, scale: 1 }],
  ['icon-512.png', 512, { radius: 0.22, transparent: true, scale: 1 }],
  ['icon-512-maskable.png', 512, { radius: 0, transparent: false, scale: 0.8 }],
];
for (const [name, size, opts] of files) {
  writeFileSync(join(out, name), render(size, opts));
  console.log('wrote', name);
}

writeFileSync(join(out, 'icon.svg'), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect width="100" height="100" rx="22" fill="#0e0e10"/>
  <circle cx="50" cy="50" r="33" fill="none" stroke="#e8e6e1" stroke-width="2.2"/>
  <circle cx="50" cy="50" r="19" fill="#f2711c"/>
  <circle cx="43" cy="42" r="4.5" fill="#fff" opacity=".55"/>
</svg>
`);
console.log('wrote icon.svg');
