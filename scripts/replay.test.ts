// A real battle is played by a fuzzing bot the way the page plays one (real-time slices, button changes between them,
// a mid-battle resume from a save state), then replayed from power-on: the result must come out identical. This is the
// property the Worker's win verification rests on. Skipped until `npm run rom` and `npm run days` have run.
import {existsSync, readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {beforeAll, describe, expect, it} from 'vitest';
import {decodeLog, encodeLog, InputLog, patchRom, readResult, replay, romId, TICKS_PER_MS, type Button, type Day, type Result} from '../src/rom';
import {audit, type Db} from './audit';

const ROM = new URL('../public/rom/oakle.gbc', import.meta.url);
const DAYS = new URL('../public/days/0.json', import.meta.url);
const {boot} = createRequire(import.meta.url)('./emu.cjs');

describe('input log codec', () => {
  it('round-trips and rejects garbage', () => {
    const log = [0, 3, 0, 8, 70224, 9, 1e9, 0, 2 ** 40, 15];
    expect(decodeLog(encodeLog(log))).toEqual(log);
    expect(decodeLog('')).toEqual([]);
    expect(decodeLog('not base64!')).toBeNull();
    expect(decodeLog(btoa('\x80'))).toBeNull(); // dangling continuation byte
    expect(decodeLog(42)).toBeNull();
  });
  it('drops repeated presses and lets go of held buttons on resume', () => {
    const calls: string[] = [];
    const set = (s: string, d: boolean) => calls.push(`${s}:${d}`);
    const l = new InputLog();
    l.press('a', true, 10, set); l.press('a', true, 11, set); l.press('up', true, 12, set); l.press('up', false, 13, set);
    expect(l.log).toEqual([10, 9, 12, 1, 13, 0]);
    const r = new InputLog();
    r.resume(l.log, 100, set);
    expect(r.log).toEqual([10, 9, 12, 1, 13, 0, 100, 8]); // A was still held at save time
  });
});

const ready = existsSync(ROM) && existsSync(DAYS);
describe.skipIf(!ready)('a real battle', () => {
  let rom: Uint8Array, day: Day, config: number, input: InputLog, live: Result | null, log: number[];
  const {load} = createRequire(import.meta.url)('./emu.cjs');

  beforeAll(async () => {
    day = JSON.parse(readFileSync(DAYS, 'utf8')).days[0];
    config = JSON.parse(readFileSync(new URL('../public/rom/oakle.json', import.meta.url), 'utf8')).config;
    rom = patchRom(new Uint8Array(readFileSync(ROM)), config, day, 'TEST');

    const a = await boot(Buffer.from(rom), 48000); // the page uses the browser's sample rate; replay uses 44100
    const {m, e} = a;
    input = new InputLog();
    const set = (s: string, d: boolean) => m[s](e, d);
    const ticks = () => m._emulator_get_ticks_f64(e);
    const step = (frames: number) => { const until = ticks() + 70224 * frames; while (!(m._emulator_run_until_f64(e, until) & 4)) { /* drop events */ } };
    const tap = (b: Button, hold = 4, wait = 14) => { input.press(b, true, ticks(), set); step(hold); input.press(b, false, ticks(), set); step(wait); };

    step(600);
    for (let i = 0; i < 40; i++) tap('a', 4, 30);       // intro text
    tap('left', 14, 30); tap('up', 3, 20); tap('a', 4, 120); // walk to Oak and talk to him
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
      if (i % 50 === 0) live = readResult(a.extRam(), day.day);
    }
    live = readResult(a.extRam(), day.day);
    log = decodeLog(encodeLog(input.log))!;
  }, 300_000);

  it('replays to the same result, resume included, and rejects a tampered log', async () => {
    expect(live, 'the bot should finish a battle (try another seed if the ROM changed)').not.toBeNull();
    // a different module instance and sample rate than the original run
    expect(await replay(load, rom, log, day.day)).toEqual(live);
    // tampering: dropping a stretch of inputs must not reproduce the result
    expect(await replay(load, rom, log.slice(0, 400).concat(log.slice(800)), day.day)).not.toEqual(live);
    expect(log[log.length - 2] / TICKS_PER_MS).toBeGreaterThan(60_000);
  }, 300_000);

  it('audit corrects wins that do not reproduce and leaves the rest', async () => {
    const {DatabaseSync} = createRequire(import.meta.url)('node:sqlite');
    const sql = new DatabaseSync(':memory:');
    sql.exec(`CREATE TABLE runs (player_id TEXT, day INTEGER, finished_at INTEGER, won INTEGER, turns INTEGER, alive INTEGER, log TEXT, verified INTEGER, PRIMARY KEY (player_id, day))`);
    const db: Db = {async all(q, params = []) { const st = sql.prepare(q); return /^\s*select/i.test(q) ? st.all(...params) : (st.run(...params), []); }};
    const site = 'https://example.test';
    const files: Record<string, BodyInit> = {
      '/rom/oakle.gbc': readFileSync(ROM), '/rom/oakle.json': JSON.stringify({config}), '/days/0.json': readFileSync(DAYS),
    };
    const fakeFetch = (async (u: string) => (files[new URL(u).pathname] ? new Response(files[new URL(u).pathname]) : new Response('no', {status: 404}))) as unknown as typeof fetch;
    const id = await romId(new Uint8Array(readFileSync(ROM)));
    const add = (player: string, evidence: object | string) => sql.prepare(`INSERT INTO runs VALUES (?, ?, ?, 1, 12, 3, ?, 0)`).run(player, day.day, 1, typeof evidence === 'string' ? evidence : JSON.stringify(evidence));
    const proof = {name: 'TEST', rom: id, log: encodeLog(log)};
    add('liar', proof);                              // claims a win; the game says it was not one
    add('liar2', {...proof, name: 'OTHER'});         // a second row on a different ROM patch: every replay needs its own module
    add('garbage', {...proof, log: 'not base64!'});  // malformed evidence
    add('oldrom', {...proof, rom: 'deadbeefdeadbeef'}); // played on another build: cannot be judged
    const row = (p: string) => sql.prepare(`SELECT won, turns, alive, verified, log IS NULL AS nolog FROM runs WHERE player_id = ?`).get(p);

    const out = await audit(db, {site, fetch: fakeFetch, load}, () => {});
    expect(out).toEqual({confirmed: 0, corrected: 3, skipped: 1});
    expect(row('liar')).toMatchObject({won: 0, turns: live!.turns, alive: live!.alive, verified: 1, nolog: 0});
    expect(row('liar2')).toMatchObject({won: 0, turns: live!.turns, alive: live!.alive, verified: 1}); // a reused module would give turns 0
    expect(row('garbage')).toMatchObject({won: 0, turns: 0, alive: 0, verified: 1});
    expect(row('oldrom')).toMatchObject({won: 1, verified: 2});

    // a win the replay reproduces is confirmed with the game's own numbers and its evidence dropped
    add('honest', proof);
    const out2 = await audit(db, {site, fetch: fakeFetch, load, replayFn: async () => ({won: true, turns: 9, alive: 2})}, () => {});
    expect(out2.confirmed).toBe(1);
    expect(row('honest')).toMatchObject({won: 1, turns: 9, alive: 2, verified: 1, nolog: 1});
    expect(await audit(db, {site, fetch: fakeFetch, load}, () => {})).toEqual({confirmed: 0, corrected: 0, skipped: 0}); // nothing pending
  }, 300_000);
});

describe('audit before the first deploy of this version', () => {
  it('does nothing while the database has no verified column', async () => {
    const {DatabaseSync} = createRequire(import.meta.url)('node:sqlite');
    const sql = new DatabaseSync(':memory:');
    sql.exec(`CREATE TABLE runs (player_id TEXT, day INTEGER, finished_at INTEGER, won INTEGER, turns INTEGER, alive INTEGER, log TEXT)`);
    const db: Db = {async all(q) { return sql.prepare(q).all(); }};
    const lines: string[] = [];
    const out = await audit(db, {site: 'https://example.test', fetch, load: async () => null}, s => lines.push(s));
    expect(out).toEqual({confirmed: 0, corrected: 0, skipped: 0});
    expect(lines[0]).toMatch(/no verified column/);
  });
});
