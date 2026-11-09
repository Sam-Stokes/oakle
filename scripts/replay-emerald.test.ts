// Emerald's version of the replay property (see replay.test.ts): a real battle played by a fuzzing bot the way the page plays
// one (real-time slices, button changes between them, a mid-battle resume from a save state), then replayed from power-on on a
// fresh module: the result must come out identical. Plus the things only this game can get wrong: that thinking time cannot
// change the dice, that the room plays out as it should, and that the party addresses the page reads match the ROM that was built.
// Skipped until `sh rom/emerald/build.sh`, `npm run days` and `sh emu/mgba/build.sh` have run.
import {existsSync, readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {beforeAll, describe, expect, it} from 'vitest';
import {GAMES} from '../src/games';
import {decodeLog, encodeLog, InputLog, patchRom, readParty, readResult, replay, SETTER, type Button, type Day, type Result} from '../src/rom';

const G = GAMES.emerald;
const ROM = new URL('../public/rom/emerald.gba', import.meta.url);
const META = new URL('../public/rom/emerald.json', import.meta.url);
const MAP = new URL('../rom/emerald/work/pokeemerald.map', import.meta.url);
const DAYS = new URL('../public/days/emerald/0.json', import.meta.url);
const WASM = new URL('../public/emu/mgba.wasm', import.meta.url);
const {boot, load} = createRequire(import.meta.url)('./emu.cjs');
const newModule = () => load(G.emu.global);

const patched = (day: Day) => patchRom(new Uint8Array(readFileSync(ROM)), JSON.parse(readFileSync(META, 'utf8')).config, day, 'TEST', G);
const frames = (m: any, e: number, n: number) => { const until = m._emulator_get_ticks_f64(e) + G.emu.frame * n; while (!(m._emulator_run_until_f64(e, until) & 4)) { /* drop events */ } };

/**
 * What a player does to get into the fight: wait for Birch's greeting, read it, walk up to him, talk. `press(button, hold, wait)`
 * and `frames(n)` are the caller's, so the same steps can be recorded into an input log. `think` frames are spent before walking.
 */
const toTheFight = (press: (b: Button, hold: number, wait: number) => void, wait: (n: number) => void, think = 0) => {
  wait(500); // the room fades in and Birch greets the player
  for (let i = 0; i < 5; i++) press('a', 4, 90); // his greeting, line by line (a press with nothing to talk to does nothing)
  wait(think); // the player takes their time (and may open the team screen with START)
  press('up', 40, 20); // walk up to Birch
  press('a', 4, 120); // talk: "Show me what you've got"
  press('a', 4, 0); // and the battle transition
};

const ready = [ROM, META, DAYS, WASM].every(f => existsSync(f));
describe.skipIf(!ready)('a real Emerald battle', () => {
  let rom: Uint8Array, day: Day, input: InputLog, live: Result | null, log: number[], party: Array<[number, number]>;

  beforeAll(async () => {
    day = JSON.parse(readFileSync(DAYS, 'utf8')).days[0];
    rom = patched(day);

    const a = await boot(Buffer.from(rom), 32768, G.emu.global);
    const {m, e} = a;
    input = new InputLog();
    const set = (s: string, d: boolean) => m[s](e, d);
    const ticks = () => m._emulator_get_ticks_f64(e);
    const tap = (b: Button, hold = 4, wait = 14) => { input.press(b, true, ticks(), set); frames(m, e, hold); input.press(b, false, ticks(), set); frames(m, e, wait); };

    toTheFight(tap, n => frames(m, e, n));
    frames(m, e, 600);
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
  }, 900_000);

  it('replays to the same result, resume included, and rejects a tampered log', async () => {
    expect(live, 'the bot should finish a battle (try another seed if the ROM changed)').not.toBeNull();
    expect(party).toHaveLength(G.size);
    expect(party.filter(([hp]) => hp > 0)).toHaveLength(live!.alive); // game memory agrees with the result block the ROM wrote
    expect(party.every(([, max]) => max > 0)).toBe(true);
    expect(await replay(newModule, rom, log, day.day, G)).toEqual(live); // a different module instance and sample rate
    // a log that stops early is no evidence of a win: Birch is still talking, or the fight has only begun
    expect(await replay(newModule, rom, log.slice(0, 12), day.day, G)).toBeNull();
    expect(log[log.length - 2] / G.emu.ms).toBeGreaterThan(30_000);
  }, 900_000);

  it('thinking time cannot change the dice: the game\'s RNG is the same however long the player waits, in the room or in the fight', async () => {
    // gRngValue straight from game memory at the first battle menu. Any per-frame Random() still live in the battle (there were
    // two) or a seed set too early (in the room) makes these differ.
    const map = readFileSync(MAP, 'utf8');
    const at = parseInt(/0x(0[0-9a-f]{7})\s+gRngValue\b/.exec(map)![1], 16);
    const rngAfter = async (roomIdle: number, menuIdle: number) => {
      const {m, e} = await boot(Buffer.from(patched(day)), 32768, G.emu.global);
      const press = (b: Button, hold: number, wait: number) => { m[SETTER[b]](e, true); frames(m, e, hold); m[SETTER[b]](e, false); frames(m, e, wait); };
      toTheFight(press, n => frames(m, e, n), roomIdle);
      frames(m, e, 2400); // the transition, the intro, up to the first command menu
      frames(m, e, menuIdle); // the player thinks
      return [0, 1, 2, 3].map(i => m._emulator_read_mem(e, at + i));
    };
    const first = await rngAfter(0, 0);
    expect(first.some(b => b !== 0)).toBe(true);
    for (const [room, menu] of [[0, 1], [0, 937], [937, 0], [3001, 3001]]) expect(await rngAfter(room, menu), `room ${room}, menu ${menu} idle frames`).toEqual(first);
  }, 600_000);

  it('Birch is in the room: he greets the player, START shows only the team, and talking to him starts the fight', async () => {
    const {m, e} = await boot(Buffer.from(patched(day)), 32768, G.emu.global);
    const shot = () => new Uint32Array(m.HEAP8.buffer.slice(m._get_frame_buffer_ptr(e), m._get_frame_buffer_ptr(e) + m._get_frame_buffer_size(e)));
    const press = (b: Button, hold: number, wait: number) => { m[SETTER[b]](e, true); frames(m, e, hold); m[SETTER[b]](e, false); frames(m, e, wait); };
    const differs = (a: Uint32Array, b: Uint32Array) => a.some((v, i) => v !== b[i]);
    frames(m, e, 500);
    const greeting = shot();
    for (let i = 0; i < 5; i++) press('a', 4, 90);
    const room = shot();
    expect(differs(greeting, room)).toBe(true); // the text box is gone
    press('start', 4, 60);
    const menu = shot();
    expect(differs(room, menu)).toBe(true); // the START menu (POKéMON and EXIT: the bag, saving and options are not offered)
    press('a', 4, 150);
    const team = shot();
    expect(differs(menu, team)).toBe(true); // the team screen
    press('b', 4, 60); press('b', 4, 60); press('b', 4, 60); frames(m, e, 30);
    expect(readParty(addr => m._emulator_read_mem(e, addr), G)).toHaveLength(G.size);
    press('up', 40, 20); press('a', 4, 120);
    expect(differs(room, shot())).toBe(true); // Birch's "Show me what you've got"
  }, 300_000);
});

// The page shows its result screen within half a second of the result appearing in cartridge memory, so the ROM must write it only
// after the professor has had the last word (as Yellow and Crystal do), in the battle screen, with no trip back to the map.
// The last text the battle printed is in gDisplayedStringBattle: it must be Birch's own line, "BIRCH: ...".
it.skipIf(!ready || !existsSync(MAP))('the result is written after Birch\'s closing line, in the battle, with no whiteout and no map', async () => {
  const day: Day = JSON.parse(readFileSync(DAYS, 'utf8')).days[0];
  const {m, e, extRam} = await boot(Buffer.from(patched(day)), 32768, G.emu.global);
  const press = (b: Button, hold: number, wait: number) => { m[SETTER[b]](e, true); frames(m, e, hold); m[SETTER[b]](e, false); frames(m, e, wait); };
  const map = readFileSync(MAP, 'utf8');
  const sym = (n: string) => parseInt(new RegExp(`0x(0[0-9a-f]{7})\\s+${n}\\b`).exec(map)![1], 16);
  toTheFight(press, n => frames(m, e, n));
  frames(m, e, 600);
  let seed = 5; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const pool: Button[] = ['a', 'a', 'a', 'a', 'a', 'a', 'b', 'up', 'down', 'left', 'right'];
  let res: Result | null = null;
  for (let i = 0; i < 30000 && !res; i++) { press(pool[Math.floor(rnd() * pool.length)], 4, 14); res = readResult(extRam(), day.day, G); }
  expect(res, 'the bot should finish a battle').not.toBeNull();
  const last = Array.from({length: 6}, (_, i) => m._emulator_read_mem(e, sym('gDisplayedStringBattle') + i));
  expect(last, 'the last text printed is Birch speaking').toEqual([0xbc, 0xc3, 0xcc, 0xbd, 0xc2, 0xf0]); // "BIRCH:" in the game's character set
  frames(m, e, 600); // and nothing else happens: the game does not go back to the map or whiteout
  expect(readResult(extRam(), day.day, G)).toEqual(res);
}, 300_000);

// The game counts a Pokemon as "traded" (and, at Lv 100 without badges, makes it loaf around instead of obeying) unless its OT ID
// is the player's trainer ID and its OT name is the player's name. Read both straight from memory, for the whole team.
it.skipIf(!ready || !existsSync(MAP))('the player\'s own Pokemon obey: their OT matches the player\'s trainer ID and name', async () => {
  const day: Day = JSON.parse(readFileSync(DAYS, 'utf8')).days[0];
  const {m, e} = await boot(Buffer.from(patched(day)), 32768, G.emu.global);
  frames(m, e, 600);
  const map = readFileSync(MAP, 'utf8');
  const sym = (n: string) => parseInt(new RegExp(`0x(0[0-9a-f]{7})\\s+${n}\\b`).exec(map)![1], 16);
  const rd = (a: number, n: number) => Array.from({length: n}, (_, i) => m._emulator_read_mem(e, a + i));
  const word = (a: number) => rd(a, 4);
  const sb2 = word(sym('gSaveBlock2Ptr')).reduce((p, b, i) => p + b * 2 ** (8 * i), 0); // the pointer to the save block
  const trainerId = rd(sb2 + 0x0a, 4), name = rd(sb2, 8); // playerTrainerId, playerName
  for (let i = 0; i < G.size; i++) {
    const mon = G.ram.party + i * G.ram.monLen; // struct Pokemon: personality, otId, nickname (10), language, flags, otName (7)
    expect(word(mon + 4), `Pokemon ${i + 1}: OT ID`).toEqual(trainerId);
    expect(rd(mon + 20, 7), `Pokemon ${i + 1}: OT name`).toEqual(name.slice(0, 7));
  }
});

// needs only the ROM build's map, not the emulator: adding the Oakle code must not have moved the party in RAM
it.skipIf(!existsSync(MAP))('the party addresses in src/games.ts are the ones the built ROM has', () => {
  const map = readFileSync(MAP, 'utf8');
  const at = (sym: string) => parseInt(new RegExp(`0x([0-9a-f]+)\\s+${sym}\\s*$`, 'm').exec(map)![1], 16);
  expect(at('gPlayerPartyCount')).toBe(G.ram.partyCount);
  expect(at('gPlayerParty')).toBe(G.ram.party);
});
