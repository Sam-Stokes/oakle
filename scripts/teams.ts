// Daily player team: 5 random Gen 1 species (any of the 151), 4 random legal Gen 1 moves each, re-rolled every day.
// Dev-time only (uses @pkmn/dex); the result is baked into public/days.json by gen-days.ts.
import {Dex} from '@pkmn/sim';

const dex = Dex.forGen(1);
const SPECIES = dex.species.all().filter(s => s.num > 0 && s.num <= 151 && !s.forme);
// ponytail: skips moves that are no-ops or degenerate in Gen 1 trainer battles; add more if a day feels cheap
const SKIP = new Set(['transform', 'metronome', 'mimic', 'bide', 'counter', 'mirrormove', 'teleport', 'whirlwind', 'roar', 'splash', 'struggle']);

// xmur3 string hash -> mulberry32 PRNG
export function hash(s: string) {
  let h = 1779033703 ^ s.length;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 3432918353), h = (h << 13) | (h >>> 19);
  return () => ((h = Math.imul(h ^ (h >>> 16), 2246822507) ^ Math.imul(h ^ (h >>> 13), 3266489909)), (h ^= h >>> 16) >>> 0);
}
const rng = (seed: () => number) => { let a = seed(); return () => ((a = (a + 0x6d2b79f5) | 0), (Math.imul(a ^ (a >>> 15), 1 | a) ^ ((a ^ (a >>> 7)) + Math.imul(a ^ (a >>> 7), 61 | a))) >>> 0) / 4294967296; };

/** Moves this species can learn in Gen 1 (level-up or TM/HM). Own data only, so always legal. */
export const learnset = (id: string) =>
  Object.entries(dex.species.getLearnsetData(id as any).learnset ?? {}).filter(([, src]) => src.some(s => /^1[LM]/.test(s))).map(([m]) => m);
const damaging = (m: string) => dex.moves.get(m).category !== 'Status';

export type Mon = {species: string; moves: string[]}; // species display name, move ids
export function dayTeam(day: number): Mon[] {
  const r = rng(hash(`oakle-${day}`));
  const pick = <T,>(a: T[]) => a.splice(Math.floor(r() * a.length), 1)[0];
  const species = SPECIES.map(s => s.id);
  return Array.from({length: 5}, () => {
    const id = pick(species);
    let pool = learnset(id);
    const ok = pool.filter(m => !SKIP.has(m));
    if (ok.length) pool = ok;
    const atk = pool.filter(damaging);
    const first = pick(atk.length ? atk : [...pool]); // always one attack
    const rest = pool.filter(m => m !== first);
    return {species: dex.species.get(id).name, moves: [first, ...Array.from({length: Math.min(3, rest.length)}, () => pick(rest))]};
  });
}
export const moveName = (id: string) => dex.moves.get(id).name;
