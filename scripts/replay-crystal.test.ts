// Crystal's version of the replay property (see replay.test.ts): a real battle played by a fuzzing bot the way the page plays
// one (real-time slices, button changes between them, a mid-battle resume from a save state), then replayed from power-on on a
// fresh module: the result must come out identical. Crystal's cartridge has a real-time clock, so this is also the check that
// the clock cannot leak into a game. Skipped until `sh rom/crystal/build.sh` and `npm run days` have run.
import {existsSync, readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {beforeAll, describe, expect, it} from 'vitest';
import {GAMES} from '../src/games';
import {decodeLog, encodeLog, InputLog, patchRom, readParty, readResult, replay, TICKS_PER_MS, type Button, type Day, type Result} from '../src/rom';

const G = GAMES.crystal;
const ROM = new URL('../public/rom/crystal.gbc', import.meta.url);
const META = new URL('../public/rom/crystal.json', import.meta.url);
const DAYS = new URL('../public/days/crystal/0.json', import.meta.url);
const {boot, load} = createRequire(import.meta.url)('./emu.cjs');

const ready = existsSync(ROM) && existsSync(META) && existsSync(DAYS);
describe.skipIf(!ready)('a real Crystal battle', () => {
  let rom: Uint8Array, day: Day, input: InputLog, live: Result | null, log: number[], party: Array<[number, number]>;

  beforeAll(async () => {
    day = JSON.parse(readFileSync(DAYS, 'utf8')).days[0];
    const config = JSON.parse(readFileSync(META, 'utf8')).config;
    rom = patchRom(new Uint8Array(readFileSync(ROM)), config, day, 'TEST', G);

    const a = await boot(Buffer.from(rom), 48000); // the page uses the browser's sample rate; replay uses 44100
    const {m, e} = a;
    input = new InputLog();
    const set = (s: string, d: boolean) => m[s](e, d);
    const ticks = () => m._emulator_get_ticks_f64(e);
    const step = (frames: number) => { const until = ticks() + 70224 * frames; while (!(m._emulator_run_until_f64(e, until) & 4)) { /* drop events */ } };
    const tap = (b: Button, hold = 4, wait = 14) => { input.press(b, true, ticks(), set); step(hold); input.press(b, false, ticks(), set); step(wait); };

    step(600);
    tap('up', 100, 20); // walk to Elm
    for (let i = 0; i < 12; i++) tap('a', 4, 60); // talk to him, through the battle intro
    let seed = 11; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    const pool: Button[] = ['a', 'a', 'a', 'a', 'a', 'a', 'b', 'up', 'down', 'left', 'right'];
    let saved: {state: Uint8Array; log: number[]} | null = null;
    live = null;
    for (let i = 0; i < 30000 && !live; i++) {
      tap(pool[Math.floor(rnd() * pool.length)]);
      if (i === 300) saved = {state: a.saveState(), log: input.log.slice()};
      if (i === 450) { // like a page reload: throw away the last 150 taps and resume from the save
        const f = m._state_file_data_new(e);
        new Uint8Array(m.HEAP8.buffer, m._get_file_data_ptr(f), m._get_file_data_size(f)).set(saved!.state);
        m._emulator_read_state(e, f); m._file_data_delete(f);
        input.resume(saved!.log, ticks(), set);
      }
      if (i % 50 === 0) live = readResult(a.extRam(), day.day, G);
    }
    live = readResult(a.extRam(), day.day, G);
    party = readParty(addr => m._emulator_read_mem(e, addr), G);
    log = decodeLog(encodeLog(input.log))!;
  }, 600_000);

  it('replays to the same result, resume included, and rejects a tampered log', async () => {
    expect(live, 'the bot should finish a battle (try another seed if the ROM changed)').not.toBeNull();
    // the party read from game memory agrees with the result block the ROM wrote
    expect(party).toHaveLength(G.size);
    expect(party.filter(([hp]) => hp > 0)).toHaveLength(live!.alive);
    expect(party.every(([, max]) => max > 0)).toBe(true);
    // a different module instance and sample rate than the original run
    expect(await replay(load, rom, log, day.day, G)).toEqual(live);
    // tampering: dropping a stretch of inputs must not reproduce the result
    expect(await replay(load, rom, log.slice(0, 400).concat(log.slice(800)), day.day, G)).not.toEqual(live);
    expect(log[log.length - 2] / TICKS_PER_MS).toBeGreaterThan(30_000);
  }, 600_000);
});
