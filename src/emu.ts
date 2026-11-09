// Thin browser wrapper around the game's emulator: binjgb (MIT, public/emu/binjgb.{js,wasm}) for the Game Boy games and
// mGBA (MPL-2.0, public/emu/mgba.{js,wasm}, built by emu/mgba/build.sh) for Gen 3. Both export the same C API, so this
// is one class: video, audio, joypad, cart RAM, save states. What differs lives in the game's `emu` config (src/games.ts).
const AUDIO_LATENCY_SEC = 0.1;
const EVENT_NEW_FRAME = 1, EVENT_AUDIO_BUFFER_FULL = 2, EVENT_UNTIL_TICKS = 4;
const CGB_COLOR_CURVE = 2; // Gambatte-style colours (binjgb only)

import {GAMES, type EmuCfg, type Game} from './games';
import {InputLog, readParty, type Button} from './rom';
export type {Button};

const scripts = new Map<string, Promise<void>>();
/**
 * The emulator scripts are classic scripts that define a global factory (`Binjgb`, `Mgba`), so load each with a tag
 * (once). Every call returns a brand-new module: an emulator is only reproducible as the first one on its module, and
 * the server replays recorded games on fresh modules.
 */
export const loadEmulator = async (cfg: EmuCfg) => {
  if (!scripts.has(cfg.script)) scripts.set(cfg.script, new Promise<void>((res, rej) => {
    const s = document.createElement('script');
    s.src = cfg.script;
    s.onload = () => res();
    s.onerror = () => { scripts.delete(cfg.script); rej(new Error('could not load the emulator')); };
    document.head.append(s);
  }));
  await scripts.get(cfg.script);
  return (window as any)[cfg.global]();
};

export class Emu {
  private e: number;
  private romPtr: number;
  private raf = 0;
  private last = 0;
  /** Where the emulator's clock should be by now. Time is owed in whole frames on the GBA, so keep the target instead of asking for `dt` more each time: a 120 Hz screen would otherwise run a whole frame every 8 ms (twice too fast). */
  private target = 0;
  private audioStart = 0;
  private ctx: AudioContext;
  private gain: GainNode;
  private image: ImageData;
  /** Every button change with its exact emulator tick: the server replays this to verify a win. */
  readonly input = new InputLog();
  /** The player name written into this ROM's config (the replay needs the same one). */
  romName = '';
  /** Fingerprint of the ROM this game runs on, sent with the log so the server knows what to replay it against. */
  romId = '';
  private px: CanvasRenderingContext2D;

  constructor(private m: any, rom: Uint8Array, private canvas: HTMLCanvasElement, private game: Game = GAMES.yellow) {
    const {w, h, audio} = game.emu;
    this.image = new ImageData(w, h);
    this.ctx = new AudioContext();
    this.gain = this.ctx.createGain();
    this.gain.connect(this.ctx.destination);
    const size = (rom.length + 0x7fff) & ~0x7fff;
    this.romPtr = m._malloc(size);
    const heap = new Uint8Array(m.HEAP8.buffer, this.romPtr, size);
    heap.fill(0); heap.set(rom);
    this.e = m._emulator_new_simple(this.romPtr, size, this.ctx.sampleRate, audio.frames, CGB_COLOR_CURVE);
    if (!this.e) throw new Error('invalid ROM');
    m._emulator_set_default_joypad_callback(this.e, m._joypad_new()); // without this the joypad setters do nothing
    canvas.width = w; canvas.height = h;
    this.px = canvas.getContext('2d')!;
  }

  start() {
    this.last = 0;
    this.target = this.m._emulator_get_ticks_f64(this.e);
    this.ctx.resume();
    const tick = (ms: number) => {
      this.raf = requestAnimationFrame(tick);
      const dt = this.last ? Math.min(ms - this.last, 100) : 16;
      this.last = ms;
      this.target += dt * this.game.emu.ms;
      const until = this.target;
      for (;;) {
        const ev = this.m._emulator_run_until_f64(this.e, until);
        if (ev & EVENT_NEW_FRAME) this.draw();
        if (ev & EVENT_AUDIO_BUFFER_FULL) this.pushAudio();
        if (ev & EVENT_UNTIL_TICKS) break;
      }
    };
    this.raf = requestAnimationFrame(tick);
  }

  /**
   * Run the game's own boot (about 400 frames of black) ahead of time, silently, until the first real picture, so the
   * player never sits through it. Yields between chunks to keep the page responsive.
   */
  async warm(maxFrames = 900) {
    const m = this.m;
    const run = (frames: number) => {
      const until = m._emulator_get_ticks_f64(this.e) + this.game.emu.frame * frames;
      while (!(m._emulator_run_until_f64(this.e, until) & EVENT_UNTIL_TICKS)) { /* drop audio and frame events */ }
    };
    for (let frames = 0; frames < maxFrames; frames += 10) {
      run(10);
      const px = new Uint8Array(m.HEAP8.buffer, m._get_frame_buffer_ptr(this.e), m._get_frame_buffer_size(this.e));
      let dark = 0;
      for (let i = 0; i < px.length; i += 4) if (px[i] < 0x60) dark++;
      if (dark / (px.length / 4) > 0.1) { run(8); break; } // first picture is up; a few more frames so the sprites are drawn too
      await new Promise(r => setTimeout(r));
    }
    this.draw();
    this.audioStart = 0;
  }

  stop() { cancelAnimationFrame(this.raf); this.ctx.suspend(); }

  /** Call from a click handler: browsers only let audio start from a user gesture. */
  unlock() { this.ctx.resume(); }

  setMuted(muted: boolean) { this.gain.gain.value = muted ? 0 : 1; }

  private set = (setter: string, down: boolean) => this.m[setter](this.e, down);
  /** [hp, maxHp] for each Pokemon in the player's party right now. */
  party(g: Game = this.game) { return readParty(a => this.m._emulator_read_mem(this.e, a), g); }
  press(b: Button, down: boolean) { this.input.press(b, down, this.m._emulator_get_ticks_f64(this.e), this.set); }

  private draw() {
    const m = this.m;
    this.image.data.set(new Uint8Array(m.HEAP8.buffer, m._get_frame_buffer_ptr(this.e), m._get_frame_buffer_size(this.e)));
    this.px.putImageData(this.image, 0, 0);
  }

  private pushAudio() {
    const m = this.m, ctx = this.ctx, {frames, rate: fixed, s16} = this.game.emu.audio;
    const rate = fixed || ctx.sampleRate; // mGBA plays at its own 32768 Hz and the browser resamples
    const ptr = m._get_audio_buffer_ptr(this.e);
    const now = ctx.currentTime;
    this.audioStart ||= now + AUDIO_LATENCY_SEC;
    if (this.audioStart < now) { this.audioStart = now + AUDIO_LATENCY_SEC; return; } // fell behind: resync
    const buf = ctx.createBuffer(2, frames, rate);
    const l = buf.getChannelData(0), r = buf.getChannelData(1);
    if (s16) {
      const src = new Int16Array(m.HEAP8.buffer, ptr, frames * 2);
      for (let i = 0; i < frames; i++) { l[i] = src[2 * i] / 32768; r[i] = src[2 * i + 1] / 32768; }
    } else {
      const src = new Uint8Array(m.HEAP8.buffer, ptr, m._get_audio_buffer_capacity(this.e));
      for (let i = 0; i < frames; i++) { l[i] = src[2 * i] / 255; r[i] = src[2 * i + 1] / 255; }
    }
    const node = ctx.createBufferSource();
    node.buffer = buf;
    node.connect(this.gain);
    node.start(this.audioStart);
    this.audioStart += frames / rate;
  }

  private withFile<T>(file: number, cb: (buf: Uint8Array, file: number) => T): T {
    const m = this.m;
    try { return cb(new Uint8Array(m.HEAP8.buffer, m._get_file_data_ptr(file), m._get_file_data_size(file)), file); }
    finally { m._file_data_delete(file); }
  }

  // binjgb naming: read_* loads a buffer INTO the emulator, write_* dumps the emulator INTO a buffer.
  /** Cartridge RAM (32 KB). The ROM hack writes the battle result here. */
  extRam(): Uint8Array {
    return this.withFile(this.m._ext_ram_file_data_new(this.e), (buf, f) => { this.m._emulator_write_ext_ram(this.e, f); return buf.slice(); });
  }

  saveState(): Uint8Array {
    return this.withFile(this.m._state_file_data_new(this.e), (buf, f) => { this.m._emulator_write_state(this.e, f); return buf.slice(); });
  }

  /** Resumes a saved game together with the input log that was saved with it. */
  loadState(bytes: Uint8Array, log: number[]): boolean {
    const ok = this.withFile(this.m._state_file_data_new(this.e), (buf, f) => {
      if (buf.byteLength !== bytes.byteLength) return false;
      buf.set(bytes);
      this.m._emulator_read_state(this.e, f);
      return true;
    });
    if (ok) { this.input.resume(log, this.m._emulator_get_ticks_f64(this.e), this.set); this.target = this.m._emulator_get_ticks_f64(this.e); }
    return ok;
  }
}
