// The page <-> ROM contract and replay verification. Shared by the page, the Worker and the tests: no DOM, no Node APIs.
export type Day = {day: number; trainer: number; rng: number[]; party: number[][]};
export type Result = {won: boolean; turns: number; alive: number};

// ---- cartridge RAM contract with the ROM hack (rom/src/engine/oakle/oakle_party.asm)
const CFG = {trainer: 6, day: 7, rng: 9, name: 18, party: 29};
// SRAM bank 1, $bf00: "OAKLE", 1 win/2 loss, turns, day lo, day hi, party Pokemon still standing
const RESULT_AT = 1 * 0x2000 + 0x1f00;

/** Game charset: A-Z $80.., 0-9 $F6.., space $7F, "-" $E3, terminator $50. */
const encodeName = (n: string) => {
  const out = new Uint8Array(11).fill(0x50);
  [...n.slice(0, 7)].forEach((c, i) => (out[i] = c >= 'A' && c <= 'Z' ? 0x80 + c.charCodeAt(0) - 65 : c >= '0' && c <= '9' ? 0xf6 + +c : c === '-' ? 0xe3 : 0x7f));
  return out;
};

/** A copy of the ROM with the day's trainer, dice, party and the player's name written into its config block. */
export function patchRom(rom: Uint8Array, at: number, d: Day, name: string) {
  const r = rom.slice();
  if (String.fromCharCode(...r.subarray(at, at + 5)) !== 'OAKLE') throw new Error('ROM config not found: rebuild with rom/build.sh');
  r[at + CFG.trainer] = d.trainer;
  r[at + CFG.day] = d.day & 255; r[at + CFG.day + 1] = d.day >> 8;
  r.set(d.rng, at + CFG.rng);
  r.set(encodeName(name), at + CFG.name);
  r.set(d.party.flat(), at + CFG.party);
  return r;
}

/** The battle result the ROM wrote to cartridge RAM for this day, or null while there is none. */
export function readResult(ram: Uint8Array, day: number): Result | null {
  const tag = String.fromCharCode(...ram.subarray(RESULT_AT, RESULT_AT + 5));
  if (tag !== 'OAKLE' || (ram[RESULT_AT + 7] | (ram[RESULT_AT + 8] << 8)) !== day) return null;
  return {won: ram[RESULT_AT + 5] === 1, turns: ram[RESULT_AT + 6], alive: ram[RESULT_AT + 9]};
}

// ---- input log: every button change with the emulator's exact tick, so a battle can be replayed bit for bit.
export const BUTTONS = ['up', 'down', 'left', 'right', 'a', 'b', 'start', 'select'] as const;
export type Button = (typeof BUTTONS)[number];
export const SETTER: Record<Button, string> = {up: '_set_joyp_up', down: '_set_joyp_down', left: '_set_joyp_left', right: '_set_joyp_right', a: '_set_joyp_A', b: '_set_joyp_B', start: '_set_joyp_start', select: '_set_joyp_select'};
export const TICKS_PER_MS = 4194.304;
const MAX_EVENTS = 30_000;

type Setter = (setter: string, down: boolean) => void;
/** Records button changes as they are applied to the emulator. Repeats (key auto-repeat) are dropped. */
export class InputLog {
  log: number[] = [];
  private held = new Set<number>();
  press(b: Button, down: boolean, tick: number, set: Setter) {
    const i = BUTTONS.indexOf(b);
    if (this.held.has(i) === down) return;
    if (down) this.held.add(i); else this.held.delete(i);
    this.log.push(tick, i * 2 + (down ? 1 : 0));
    set(SETTER[b], down);
  }
  /** After loading a save state: carry on from the log saved with it, letting go of anything it still holds. */
  resume(saved: number[], tick: number, set: Setter) {
    this.log = saved.slice();
    this.held.clear();
    for (let i = 0; i < saved.length; i += 2) {
      if (saved[i + 1] & 1) this.held.add(saved[i + 1] >> 1); else this.held.delete(saved[i + 1] >> 1);
    }
    for (const i of [...this.held]) this.press(BUTTONS[i], false, tick, set);
  }
}

/** log is flat [tick, code, tick, code, ...] with code = button index * 2 + (down ? 1 : 0). Ticks never decrease. */
export function encodeLog(log: number[]): string {
  const bytes: number[] = [];
  let prev = 0;
  for (let i = 0; i < log.length; i += 2) {
    let v = (log[i] - prev) * 16 + log[i + 1]; // LEB128 varint of delta * 16 + code (doubles: no bit ops)
    prev = log[i];
    while (v >= 128) { bytes.push((v % 128) | 128); v = Math.floor(v / 128); }
    bytes.push(v);
  }
  let s = '';
  for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode(...bytes.slice(i, i + 8192));
  return btoa(s);
}

/** Inverse of encodeLog; null for anything malformed or absurdly long. */
export function decodeLog(b64: unknown): number[] | null {
  if (typeof b64 !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) return null;
  let s: string;
  try { s = atob(b64); } catch { return null; }
  const log: number[] = [];
  let tick = 0, v = 0, mul = 1;
  for (let i = 0; i < s.length; i++) {
    const b = s.charCodeAt(i);
    v += (b & 127) * mul;
    if (b & 128) { mul *= 128; if (mul > 2 ** 49) return null; continue; }
    tick += Math.floor(v / 16);
    log.push(tick, v % 16);
    if (log.length > MAX_EVENTS * 2) return null;
    v = 0; mul = 1;
  }
  return mul === 1 ? log : null; // a dangling continuation byte means truncated
}

/** Short fingerprint of the served ROM: a log is only evidence against the exact ROM it was played on. */
export async function romId(rom: Uint8Array): Promise<string> {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', rom as BufferSource));
  return [...h.subarray(0, 8)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// ---- replay
const TAIL_FRAMES = 900;   // game time allowed after the last input for the result to appear (15 s)
const SLICE_FRAMES = 6;

/**
 * Plays the log back from power-on and returns what the game itself wrote as the result.
 * `newModule` makes a brand-new binjgb module: a second emulator on a module that has already run one does not behave
 * like the first (it drifts by a few ticks), and the player's game was the first on its module. `rom` must be patched
 * exactly as the player's was (same day, same name). Null when the game never produced a result for `day`.
 */
export async function replay(newModule: () => Promise<any>, rom: Uint8Array, log: number[], day: number): Promise<Result | null> {
  const m = await newModule();
  const size = (rom.length + 0x7fff) & ~0x7fff;
  const ptr = m._malloc(size);
  const heap = new Uint8Array(m.HEAP8.buffer, ptr, size);
  heap.fill(0); heap.set(rom);
  const e = m._emulator_new_simple(ptr, size, 44100, 4096, 2);
  if (!e) { m._free(ptr); return null; }
  const joy = m._joypad_new();
  m._emulator_set_default_joypad_callback(e, joy);
  const ticks = () => m._emulator_get_ticks_f64(e);
  const runTo = (until: number) => { while (!(m._emulator_run_until_f64(e, until) & 4)) { /* drop audio and frame events */ } };
  const ram = () => {
    const f = m._ext_ram_file_data_new(e);
    try {
      m._emulator_write_ext_ram(e, f);
      return new Uint8Array(m.HEAP8.buffer, m._get_file_data_ptr(f), m._get_file_data_size(f)).slice();
    } finally { m._file_data_delete(f); }
  };
  try {
    for (let i = 0; i < log.length; i += 2) {
      // The recorded tick is an instruction boundary the original run really stopped at; aiming half a tick short
      // lands on exactly that boundary whichever way binjgb treats "until".
      if (log[i] > ticks()) runTo(log[i] - 0.5);
      m[SETTER[BUTTONS[log[i + 1] >> 1]]](e, !!(log[i + 1] & 1));
    }
    for (let f = 0; f <= TAIL_FRAMES; f += SLICE_FRAMES) {
      const r = readResult(ram(), day);
      if (r) return r;
      runTo(ticks() + 70224 * SLICE_FRAMES);
    }
    return null;
  } finally {
    m._emulator_delete(e); m._joypad_delete(joy); m._free(ptr);
  }
}
