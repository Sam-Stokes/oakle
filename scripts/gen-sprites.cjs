// Fetches the small Pokemon pictures for the "Your team today" panel at build time and saves them as
// public/sprites/<species id>.png with a transparent background. The id is the ROM's internal species number, which is
// what public/days/*.json carries in `party`. They are Nintendo's artwork, so they are downloaded into a git-ignored
// folder (like the ROM and the share art) and never committed. Source: the Game Boy Color (Yellow) sprites in
// github.com/PokeAPI/sprites. Offline or blocked: it warns and the page simply shows the team without pictures.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SRC = path.join(__dirname, '..', 'rom', 'pokeyellow-pristine');
const OUT = path.join(__dirname, '..', 'public', 'sprites');
const BASE = 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/versions/generation-i/yellow/gbc/';
const norm = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const read = f => fs.readFileSync(path.join(SRC, f), 'utf8');

/** internal species id -> national Pokedex number, from the game's own tables (names cross-checked). */
function speciesToDex() {
  const dexNumber = new Map(); // normalised name -> number, in pokedex_constants.asm order
  let n = 0;
  for (const l of read('constants/pokedex_constants.asm').split('\n')) { const m = /^\s*const\s+DEX_(\w+)/.exec(l); if (m) dexNumber.set(norm(m[1]), ++n); }
  // one `db` per internal id, in order; unused ids are `db 0`
  const order = [...read('data/pokemon/dex_order.asm').matchAll(/^\s*db\s+(?:DEX_(\w+)|(0))\b/gm)].map(m => m[1] ?? null);
  const out = new Map();
  for (const l of read('constants/pokemon_constants.asm').split('\n')) {
    const m = /^\s*const\s+(\w+)\s*;\s*\$?([0-9a-fA-F]{2})\b/.exec(l);
    if (!m) continue;
    const id = parseInt(m[2], 16), dexName = order[id - 1];
    if (id > 0 && dexName && norm(dexName) === norm(m[1]) && dexNumber.has(norm(dexName))) out.set(id, dexNumber.get(norm(dexName)));
  }
  return out;
}

// ---- a tiny PNG codec: indexed colour in, RGBA out
function decodeIndexed(buf) {
  let pos = 8, w = 0, h = 0, depth = 0, type = 0, plte = null;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos), kind = buf.toString('latin1', pos + 4, pos + 8), data = buf.subarray(pos + 8, pos + 8 + len);
    if (kind === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); depth = data[8]; type = data[9]; }
    if (kind === 'PLTE') plte = data;
    if (kind === 'IDAT') idat.push(data);
    pos += 12 + len;
  }
  if (type !== 3 || !plte || depth > 8) throw new Error('expected an indexed PNG');
  const raw = zlib.inflateSync(Buffer.concat(idat)), stride = Math.ceil((w * depth) / 8), rgba = new Uint8Array(w * h * 4);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let i = 0; i < stride; i++) {
      const a = i ? line[i - 1] : 0, b = prev[i], c = i ? prev[i - 1] : 0;
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      line[i] = (line[i] + (f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : f === 4 ? (pa <= pb && pa <= pc ? a : pb <= pc ? b : c) : 0)) & 255;
    }
    for (let x = 0; x < w; x++) {
      const bit = x * depth, idx = (line[bit >> 3] >> (8 - depth - (bit & 7))) & ((1 << depth) - 1);
      rgba.set([plte[idx * 3], plte[idx * 3 + 1], plte[idx * 3 + 2], 255], (y * w + x) * 4);
    }
    prev = line;
  }
  return {w, h, rgba};
}

/** Makes the near-white background around the sprite transparent. Flood fill from the edges, so white inside the outline stays. */
function clearBackground({w, h, rgba}) {
  const white = i => rgba[i * 4] >= 0xf0 && rgba[i * 4 + 1] >= 0xf0 && rgba[i * 4 + 2] >= 0xf0;
  const stack = [];
  for (let x = 0; x < w; x++) stack.push(x, (h - 1) * w + x);
  for (let y = 0; y < h; y++) stack.push(y * w, y * w + w - 1);
  while (stack.length) {
    const i = stack.pop();
    if (rgba[i * 4 + 3] === 0 || !white(i)) continue;
    rgba[i * 4 + 3] = 0;
    const x = i % w, y = (i / w) | 0;
    if (x > 0) stack.push(i - 1);
    if (x < w - 1) stack.push(i + 1);
    if (y > 0) stack.push(i - w);
    if (y < h - 1) stack.push(i + w);
  }
  return {w, h, rgba};
}

const crcTable = Array.from({length: 256}, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = b => { let c = ~0; for (const v of b) c = crcTable[(c ^ v) & 255] ^ (c >>> 8); return ~c >>> 0; };
const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
function encodeRgba({w, h, rgba}) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, {level: 9})), chunk('IEND', Buffer.alloc(0))]);
}

async function main() {
  if (!fs.existsSync(path.join(SRC, 'data', 'pokemon', 'dex_order.asm'))) { console.log('gen-sprites: no pret source yet, skipping (run npm run rom first)'); return; }
  const map = speciesToDex();
  fs.mkdirSync(OUT, {recursive: true});
  const todo = [...map].filter(([id]) => !fs.existsSync(path.join(OUT, `${id}.png`)));
  let failed = 0;
  const queue = [...todo];
  await Promise.all(Array.from({length: 8}, async () => {
    for (let job; (job = queue.shift());) {
      const [id, dex] = job;
      try {
        const r = await fetch(`${BASE}${dex}.png`);
        if (!r.ok) throw new Error(String(r.status));
        fs.writeFileSync(path.join(OUT, `${id}.png`), encodeRgba(clearBackground(decodeIndexed(Buffer.from(await r.arrayBuffer())))));
      } catch { failed++; }
    }
  }));
  console.log(`gen-sprites: ${map.size - failed} of ${map.size} sprites in public/sprites (${todo.length} fetched)${failed ? `; ${failed} could not be downloaded, the page will skip them` : ''}`);
}

if (require.main === module) main().catch(e => console.log('gen-sprites: skipped,', e.message));
module.exports = {speciesToDex, decodeIndexed, clearBackground, encodeRgba};
