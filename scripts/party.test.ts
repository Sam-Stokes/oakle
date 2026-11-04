// The ROM reads the party as 5 fixed 5-byte entries (species, move1..move4). A mon with fewer than 4 moves (Kakuna: Harden)
// must not shift the mons after it. Runs on the baked days, so a regenerated days file can never reintroduce it.
import {readdirSync, readFileSync} from 'node:fs';
import {expect, it} from 'vitest';
import {GAMES} from '../src/games';
import {dayId, patchRom, romId, type Day} from '../src/rom';

const DIR = new URL('../public/days/', import.meta.url);
const files = (dir: URL) => readdirSync(dir).filter(f => f.endsWith('.json'));

for (const g of [GAMES.yellow, GAMES.crystal]) it(`${g.id}: every day writes each mon at its own 5-byte slot in the ROM config`, () => {
  const dir = new URL(g.days.replace(/^\/days\//, ''), DIR);
  const rom = new Uint8Array(100);
  rom.set([...'OAKLE'].map(c => c.charCodeAt(0)));
  let short = 0;
  for (const f of files(dir)) for (const d of JSON.parse(readFileSync(new URL(f, dir), 'utf8')).days as Day[]) {
    expect(d.party.length, `day ${d.day}`).toBe(g.size);
    expect(d.rng.length, `day ${d.day}`).toBe(g.rngLen);
    const out = patchRom(rom, 0, d, 'TEST', g);
    d.party.forEach((mon, i) => {
      if (mon.length < 5) short++;
      expect([...out.subarray(g.cfg.party + i * 5, g.cfg.party + 5 + i * 5)], `day ${d.day} mon ${i + 1}`).toEqual([...mon, 0, 0, 0, 0].slice(0, 5));
    });
  }
  expect(short).toBeGreaterThan(0); // the data really does contain short entries, so this test means something
});

it('day fingerprints: unchanged for full parties, changed for the days that were played scrambled', async () => {
  const legacy = (d: Day) => romId(new TextEncoder().encode(JSON.stringify([d.trainer, d.rng, d.party])));
  for (const f of files(DIR).slice(0, 2)) for (const d of JSON.parse(readFileSync(new URL(f, DIR), 'utf8')).days as Day[])
    expect(await dayId(d) === await legacy(d), `day ${d.day}`).toBe(d.party.every(m => m.length === 5));
});
