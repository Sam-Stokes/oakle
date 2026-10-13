// Headless binjgb harness for tests and ROM debugging (Node). CommonJS because binjgb.js is a browser build.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const dir = path.join(__dirname, '..', 'public', 'emu');
const TICKS_PER_FRAME = 70224;

async function load() {
  const mod = {exports: {}};
  new Function('module', 'exports', 'require', '__dirname', '__filename', fs.readFileSync(path.join(dir, 'binjgb.js'), 'utf8'))(mod, mod.exports, require, dir, path.join(dir, 'binjgb.js'));
  const wasm = fs.readFileSync(path.join(dir, 'binjgb.wasm'));
  return mod.exports({instantiateWasm(imports, done) { WebAssembly.instantiate(wasm, imports).then(r => done(r.instance, r.module)); return {}; }});
}

const BUTTONS = {up: '_set_joyp_up', down: '_set_joyp_down', left: '_set_joyp_left', right: '_set_joyp_right', a: '_set_joyp_A', b: '_set_joyp_B', start: '_set_joyp_start', select: '_set_joyp_select'};

async function boot(rom, sampleRate = 44100) {
  const m = await load();
  const size = (rom.length + 0x7fff) & ~0x7fff;
  const ptr = m._malloc(size);
  const heap = new Uint8Array(m.HEAP8.buffer, ptr, size); heap.fill(0); heap.set(rom);
  const e = m._emulator_new_simple(ptr, size, sampleRate, 4096, 2);
  if (!e) throw new Error('invalid ROM');
  m._emulator_set_default_joypad_callback(e, m._joypad_new()); // without this the set_joyp_* setters do nothing
  const api = {
    m, e, // raw module and emulator handles, for replay tests
    frame: 0,
    run(n) { const until = m._emulator_get_ticks_f64(e) + TICKS_PER_FRAME * n; for (;;) { if (m._emulator_run_until_f64(e, until) & 4) break; } api.frame += n; },
    // hold a button for `hold` frames, then wait `wait` frames
    press(btn, hold = 4, wait = 20) { m[BUTTONS[btn]](e, true); api.run(hold); m[BUTTONS[btn]](e, false); api.run(wait); },
    pixels() { const p = m._get_frame_buffer_ptr(e); return new Uint8Array(m.HEAP8.buffer.slice(p, p + m._get_frame_buffer_size(e))); },
    extRam() {
      const f = m._ext_ram_file_data_new(e);
      m._emulator_write_ext_ram(e, f); // write_* = emulator -> buffer
      const out = new Uint8Array(m.HEAP8.buffer.slice(m._get_file_data_ptr(f), m._get_file_data_ptr(f) + m._get_file_data_size(f)));
      m._file_data_delete(f);
      return out;
    },
    saveState() {
      const f = m._state_file_data_new(e);
      m._emulator_write_state(e, f);
      const out = new Uint8Array(m.HEAP8.buffer.slice(m._get_file_data_ptr(f), m._get_file_data_ptr(f) + m._get_file_data_size(f)));
      m._file_data_delete(f);
      return out;
    },
    // like the page: free-running slices of ~16.67 ms, handling events the way src/emu.ts does
    runRealtime(frames, hooks = {}) {
      const slice = 4194.304 * 16.667;
      for (let n = 0; n < frames * 70224 / slice; n++) {
        const until = m._emulator_get_ticks_f64(e) + slice;
        for (;;) { const ev = m._emulator_run_until_f64(e, until); if (ev & 1) hooks.frame && hooks.frame(); if (ev & 4) break; }
        api.frame += slice / 70224;
        hooks.slice && hooks.slice(n);
      }
    },
    colors() { return new Set(new Uint32Array(api.pixels().buffer)).size; },
    screenshot(file, scale = 3) {
      const W = 160, H = 144, px = api.pixels(), w = W * scale, h = H * scale;
      const raw = Buffer.alloc((w * 4 + 1) * h);
      for (let y = 0; y < h; y++) {
        raw[y * (w * 4 + 1)] = 0;
        for (let x = 0; x < w; x++) { const s = ((y / scale | 0) * W + (x / scale | 0)) * 4, d = y * (w * 4 + 1) + 1 + x * 4; raw[d] = px[s]; raw[d + 1] = px[s + 1]; raw[d + 2] = px[s + 2]; raw[d + 3] = 255; }
      }
      const crc = (b) => { let c = ~0; for (const v of b) { c ^= v; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c >>> 0; };
      const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
      const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
      fs.writeFileSync(file, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
    },
  };
  return api;
}

module.exports = {boot, load};
