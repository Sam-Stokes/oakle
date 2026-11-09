// The ROM reads the party as fixed-size entries: Gen 1/2 5 bytes (species, move1..move4), Gen 3 11 bytes (16-bit species and moves,
// ability slot). A mon with fewer than 4 moves (Kakuna: Harden) must not shift the mons after it. Runs on the baked days, so a regenerated days file can never reintroduce it.
import {existsSync, readdirSync, readFileSync} from 'node:fs';
import {expect, it} from 'vitest';
import {GAMES} from '../src/games';
import {dayId, partyStride, patchRom, romId, type Day} from '../src/rom';

const DIR = new URL('../public/days/', import.meta.url);
const files = (dir: URL) => readdirSync(dir).filter(f => f.endsWith('.json'));

for (const g of [GAMES.yellow, GAMES.crystal, GAMES.emerald]) it(`${g.id}: every day writes each mon at its own ${partyStride(g)}-byte slot in the ROM config`, () => {
  const dir = new URL(g.days.replace(/^\/days\//, ''), DIR);
  const rom = new Uint8Array(200), n = partyStride(g);
  rom.set([...'OAKLE'].map(c => c.charCodeAt(0)));
  let short = 0;
  for (const f of files(dir)) for (const d of JSON.parse(readFileSync(new URL(f, dir), 'utf8')).days as Day[]) {
    expect(d.party.length, `day ${d.day}`).toBe(g.size);
    expect(d.rng.length, `day ${d.day}`).toBe(g.rngLen);
    const out = patchRom(rom, 0, d, 'TEST', g);
    d.party.forEach((mon, i) => {
      const at = g.cfg.party + i * n, got = [...out.subarray(at, at + n)];
      if (g.gen === 3) { // 5 little-endian 16-bit ids, then the ability slot
        if (mon.slice(1, 5).includes(0)) short++;
        expect(mon.length, `day ${d.day} mon ${i + 1}`).toBe(6);
        expect(got, `day ${d.day} mon ${i + 1}`).toEqual([...mon.slice(0, 5).flatMap(v => [v & 255, v >> 8]), mon[5]]);
      } else {
        if (mon.length < 5) short++;
        expect(got, `day ${d.day} mon ${i + 1}`).toEqual([...mon, 0, 0, 0, 0].slice(0, 5));
      }
    });
  }
  expect(short).toBeGreaterThan(0); // the data really does contain short entries, so this test means something
});

it('day fingerprints: unchanged for full parties, changed for the days that were played scrambled', async () => {
  const legacy = (d: Day) => romId(new TextEncoder().encode(JSON.stringify([d.trainer, d.rng, d.party])));
  for (const f of files(DIR).slice(0, 2)) for (const d of JSON.parse(readFileSync(new URL(f, DIR), 'utf8')).days as Day[])
    expect(await dayId(d) === await legacy(d), `day ${d.day}`).toBe(d.party.every(m => m.length === 5));
});

it('Gen 3 data: abilities are slot 0 or 1, ids are 16-bit, the name uses the Gen 3 charset', () => {
  const g = GAMES.emerald, dir = new URL('emerald/', DIR), days = JSON.parse(readFileSync(new URL('0.json', dir), 'utf8')).days as Day[];
  for (const d of days) for (const m of d.party) { expect([0, 1]).toContain(m[5]); expect(m[0]).toBeGreaterThan(0); expect(m[0]).toBeLessThanOrEqual(411); }
  const rom = new Uint8Array(200);
  rom.set([...'OAKLE'].map(c => c.charCodeAt(0)));
  const out = patchRom(rom, 0, days[0], 'ASH-9 x', g);
  // A S H - 9 space, and "x" (not allowed in names) becomes a space; then the terminator
  expect([...out.subarray(g.cfg.name, g.cfg.name + 8)]).toEqual([0xbb, 0xbb + 18, 0xbb + 7, 0xae, 0xa1 + 9, 0x00, 0x00, 0xff]);
});

// The ability the page lists beside a Pokemon's moves must be the one the game gives it: its own species table, slot picked by
// the day's data (the ROM turns slot 1 into an odd personality, and a species with one ability always has it).
it.skipIf(!existsSync(new URL('../rom/emerald/pokeemerald-pristine/src/data/pokemon/species_info.h', import.meta.url)))('Emerald: every listed ability is the one the game itself gives that Pokemon', () => {
  const norm = (n: string) => n.toLowerCase().replace(/[^a-z0-9]/g, '');
  const game = new Map<string, [string, string]>(); // species -> its two ability slots, as in gSpeciesInfo
  const text = readFileSync(new URL('../rom/emerald/pokeemerald-pristine/src/data/pokemon/species_info.h', import.meta.url), 'utf8');
  for (const block of text.split(/(?=\[SPECIES_\w+\]\s*=)/)) { // one block per species (some, like the Unown forms, have no abilities of their own)
    const name = /^\[SPECIES_(\w+)\]/.exec(block)?.[1], ab = /\.abilities\s*=\s*\{\s*ABILITY_(\w+)\s*,\s*ABILITY_(\w+)\s*\}/.exec(block);
    if (name && ab) game.set(norm(name), [norm(ab[1]), norm(ab[2])]);
  }
  expect(game.size).toBeGreaterThan(380);
  const dir2 = new URL('emerald/', DIR);
  let checked = 0, second = 0;
  for (const f of files(dir2)) for (const d of JSON.parse(readFileSync(new URL(f, dir2), 'utf8')).days as Array<Day & {team: Array<{species: string; ability?: string}>}>) d.team.forEach((mon, i) => {
    const slots = game.get(norm(mon.species));
    expect(slots, `${mon.species} in the game's table`).toBeDefined();
    const slot = d.party[i][5], want = slot === 1 && slots![1] !== 'none' ? slots![1] : slots![0];
    expect(norm(mon.ability ?? ''), `day ${d.day} ${mon.species} slot ${slot}`).toBe(want);
    checked++; if (want === slots![1] && slots![1] !== slots![0]) second++;
  });
  expect(checked).toBeGreaterThan(20000);
  expect(second).toBeGreaterThan(1000); // the second slot really is used
});

it('Yellow and Crystal list no abilities (they have none)', () => {
  for (const g of [GAMES.yellow, GAMES.crystal]) {
    const d = JSON.parse(readFileSync(new URL(`${g.days.replace(/^\/days\//, '')}0.json`, DIR), 'utf8')).days[0];
    expect(d.team.every((m: object) => !('ability' in m))).toBe(true);
  }
});
