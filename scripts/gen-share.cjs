// Generates the favicon, the touch icon and the social share image (1200x630) from the ROM you built locally:
// Prof. Oak's trainer sprite and a title-screen style card, using the headless emulator. Outputs go to public/ and
// are git-ignored: the artwork is Nintendo's, so it is rendered from your own build and never committed.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const {boot} = require('./emu.cjs');

const ROOT = path.join(__dirname, '..', 'public');
const ROM = path.join(ROOT, 'rom', 'oakle.gbc');

// ---- tiny PNG writer (RGBA)
const crcTable = Array.from({length: 256}, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = b => { let c = ~0; for (const v of b) c = crcTable[(c ^ v) & 255] ^ (c >>> 8); return ~c >>> 0; };
const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
function png(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, {level: 9})), chunk('IEND', Buffer.alloc(0))]);
}
const canvas = (w, h, bg) => { const px = new Uint8Array(w * h * 4); for (let i = 0; i < w * h; i++) px.set(bg, i * 4); return {w, h, px}; };
const put = (c, x, y, col) => { if (x >= 0 && y >= 0 && x < c.w && y < c.h) c.px.set(col, (y * c.w + x) * 4); };
const rect = (c, x, y, w, h, col) => { for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) put(c, x + i, y + j, col); };
// nearest-neighbour blit of an RGBA image at integer scale
const blit = (c, src, sw, sh, ox, oy, scale) => {
  for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) { const o = (y * sw + x) * 4; if (src[o + 3]) rect(c, ox + x * scale, oy + y * scale, scale, scale, [src[o], src[o + 1], src[o + 2], src[o + 3]]); }
};
/** Makes the near-white background around a sprite transparent: flood fill from the edges, so white inside the outline stays. */
const clearBackground = (px, w, h) => {
  const white = i => px[i * 4] >= 0xe0 && px[i * 4 + 1] >= 0xe0 && px[i * 4 + 2] >= 0xe0;
  const stack = [];
  for (let x = 0; x < w; x++) stack.push(x, (h - 1) * w + x);
  for (let y = 0; y < h; y++) stack.push(y * w, y * w + w - 1);
  while (stack.length) {
    const i = stack.pop();
    if (px[i * 4 + 3] === 0 || !white(i)) continue;
    px[i * 4 + 3] = 0;
    const x = i % w, y = (i / w) | 0;
    if (x > 0) stack.push(i - 1);
    if (x < w - 1) stack.push(i + 1);
    if (y > 0) stack.push(i - w);
    if (y < h - 1) stack.push(i + w);
  }
  return px;
};

// ---- 5x7 pixel font for the few letters we need
const G = {
  A: '01110 10001 10001 11111 10001 10001 10001', B: '11110 10001 10001 11110 10001 10001 11110', D: '11110 10001 10001 10001 10001 10001 11110',
  E: '11111 10000 10000 11110 10000 10000 11111', F: '11111 10000 10000 11110 10000 10000 10000', K: '10001 10010 10100 11000 10100 10010 10001',
  L: '10000 10000 10000 10000 10000 10000 11111', N: '10001 11001 10101 10011 10001 10001 10001', O: '01110 10001 10001 10001 10001 10001 01110',
  P: '11110 10001 10001 11110 10000 10000 10000', R: '11110 10001 10001 11110 10100 10010 10001', T: '11111 00100 00100 00100 00100 00100 00100',
  Y: '10001 10001 01010 00100 00100 00100 00100', M: '10001 11011 10101 10101 10001 10001 10001', W: '10001 10001 10001 10101 10101 11011 10001',
  V: '10001 10001 10001 10001 10001 01010 00100', C: '01110 10001 10000 10000 10000 10001 01110', S: '01111 10000 10000 01110 00001 00001 11110',
  U: '10001 10001 10001 10001 10001 10001 01110', H: '10001 10001 10001 11111 10001 10001 10001', I: '01110 00100 00100 00100 00100 00100 01110',
  G: '01110 10001 10000 10111 10001 10001 01111', '.': '00000 00000 00000 00000 00000 01100 01100', ' ': '00000 00000 00000 00000 00000 00000 00000',
};
const text = (c, s, x, y, scale, col) => {
  let cx = x;
  for (const ch of s) {
    const rows = (G[ch] || G[' ']).split(' ');
    rows.forEach((r, j) => [...r].forEach((b, i) => b === '1' && rect(c, cx + i * scale, y + j * scale, scale, scale, col)));
    cx += 6 * scale;
  }
};

(async () => {
  if (!fs.existsSync(ROM)) { console.log('gen-share: no ROM yet, skipping (run npm run rom first)'); return; }
  const emu = await boot(fs.readFileSync(ROM));
  emu.run(500);
  // walk the intro exactly like a player: dismiss Oak's line, step next to him, talk, then watch the battle intro
  for (let i = 0; i < 16; i++) emu.press('a', 6, 70);
  emu.press('left', 14, 40); emu.press('up', 8, 30); emu.press('a', 6, 120);
  emu.press('a', 4, 10);

  // wait for Oak's trainer pic to finish sliding in: the top-right region fills up and then stops changing
  const REGION_H = 60; // above the player's HUD
  const region = px => { let n = 0; for (let y = 0; y < REGION_H; y++) for (let x = 92; x < 160; x++) if (px[(y * 160 + x) * 4] < 0xe0) n++; return n; };
  const nonWhite = px => { let n = 0; for (let i = 0; i < px.length; i += 4) if (px[i] < 0xe0) n++; return n / (px.length / 4); };
  const boxText = px => { let n = 0; for (let y = 116; y < 136; y++) for (let x = 12; x < 150; x++) if (px[(y * 160 + x) * 4] < 0x60) n++; return n; }; // dialogue text inside the box
  let frame = null, last = -1, stable = 0;
  for (let i = 0; i < 700; i++) {
    emu.run(2);
    const px = emu.pixels(), n = region(px);
    const intro = nonWhite(px) < 0.3 && n > 300 && boxText(px) > 150; // the overworld room is mostly coloured; the battle screen is mostly white; wait for the text
    stable = intro && n === last ? stable + 1 : 0;
    last = n;
    if (stable >= 12) { frame = Uint8Array.from(px); break; }
  }
  if (!frame) { console.log('gen-share: could not capture the battle intro, skipping'); return; }

  // bounding box of Oak in the top-right area
  let x0 = 160, y0 = 144, x1 = -1, y1 = -1;
  for (let y = 0; y < REGION_H; y++) for (let x = 92; x < 160; x++) if (frame[(y * 160 + x) * 4] < 0xe0) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
  const crop = new Uint8Array(bw * bh * 4);
  for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) crop.set(frame.subarray(((y0 + y) * 160 + x0 + x) * 4, ((y0 + y) * 160 + x0 + x) * 4 + 4), (y * bw + x) * 4);

  const sprite = clearBackground(crop.slice(), bw, bh); // Oak with a transparent background, for the icons
  const icon = size => {
    const c = canvas(size, size, [0, 0, 0, 0]);
    const scale = Math.max(1, Math.floor((size * 0.9) / Math.max(bw, bh)));
    blit(c, sprite, bw, bh, Math.floor((size - bw * scale) / 2), Math.floor((size - bh * scale) / 2), scale);
    return png(size, size, c.px);
  };
  fs.writeFileSync(path.join(ROOT, 'favicon.png'), icon(64));
  fs.writeFileSync(path.join(ROOT, 'apple-touch-icon.png'), icon(180));

  // ---- social card 1200x630: title and tagline on the left, the real battle intro on the right
  const og = canvas(1200, 630, [15, 17, 22, 255]), yellow = [255, 210, 63, 255], white = [238, 240, 245, 255], dim = [142, 149, 166, 255];
  rect(og, 0, 0, 1200, 12, yellow);
  text(og, 'OAKLE', 70, 150, 16, yellow);
  text(og, 'BEAT PROF. OAK.', 70, 330, 6, white);
  text(og, 'ONE TRY A DAY.', 70, 390, 6, white);
  text(og, 'NEW TEAM EVERY DAY', 70, 500, 4, dim);
  const sx = 640, sy = 77, s = 3; // 160x144 * 3 = 480x432
  rect(og, sx - 8, sy - 8, 160 * s + 16, 144 * s + 16, yellow);
  blit(og, frame, 160, 144, sx, sy, s);
  fs.writeFileSync(path.join(ROOT, 'og.png'), png(1200, 630, og.px));
  console.log(`gen-share: favicon.png, apple-touch-icon.png, og.png (Oak ${bw}x${bh})`);
})();
