// Daily player team: Yellow 5 random Gen 1 species (any of the 151), Crystal 6 (any of the 251), Emerald 6 (any of the 386),
// 4 random legal moves each (that game's level-up and TM/HM moves), re-rolled every day. Emerald mons also get an ability slot.
// Dev-time only (uses @pkmn/dex); the result is baked into public/days/ by gen-days.ts.
import {Dex} from '@pkmn/sim';
import {GAMES, type Game} from '../src/games';

const dexes = {1: Dex.forGen(1), 2: Dex.forGen(2), 3: Dex.forGen(3)};
const LAST_SPECIES = {1: 151, 2: 251, 3: 386};
const speciesOf = (g: Game) => dexes[g.gen].species.all().filter(s => s.num > 0 && s.num <= LAST_SPECIES[g.gen] && !s.forme);
// ponytail: skips moves that are no-ops or degenerate in trainer battles; add more if a day feels cheap
const SKIP1 = ['transform', 'metronome', 'mimic', 'bide', 'counter', 'mirrormove', 'teleport', 'whirlwind', 'roar', 'splash', 'struggle'];
// Gen 2 additions: nothing to copy or counter, or they fail without a sleeping / confused / targeted foe (Dream Eater is a Gen 1 move too, so Yellow keeps it)
const SKIP2 = [...SKIP1, 'sketch', 'mirrorcoat', 'perishsong', 'destinybond', 'spite', 'sleeptalk', 'snore', 'dreameater', 'nightmare', 'conversion2', 'psychup', 'batonpass'];
// Gen 3 additions: moves with no partner, no target or nothing to copy in a one-on-one trainer fight (Sketch, Mimic, Destiny Bond etc. are already above)
const SKIP3 = [...SKIP2, 'helpinghand', 'followme', 'snatch', 'grudge', 'imprison', 'skillswap', 'lockon', 'mindreader'];
const SKIP = {1: new Set(SKIP1), 2: new Set(SKIP2), 3: new Set(SKIP3)};
const SOURCE = {1: /^1[LM]/, 2: /^2[LM]/, 3: /^3[LM]/}; // level-up or TM/HM in that generation (no egg moves, tutors or events)

// xmur3 string hash -> mulberry32 PRNG
export function hash(s: string) {
  let h = 1779033703 ^ s.length;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 3432918353), h = (h << 13) | (h >>> 19);
  return () => ((h = Math.imul(h ^ (h >>> 16), 2246822507) ^ Math.imul(h ^ (h >>> 13), 3266489909)), (h ^= h >>> 16) >>> 0);
}
const rng = (seed: () => number) => { let a = seed(); return () => ((a = (a + 0x6d2b79f5) | 0), (Math.imul(a ^ (a >>> 15), 1 | a) ^ ((a ^ (a >>> 7)) + Math.imul(a ^ (a >>> 7), 61 | a))) >>> 0) / 4294967296; };

/** Moves this species can learn in that game's generation (level-up or TM/HM). Own data only, so always legal. */
export const learnset = (id: string, g: Game = GAMES.yellow) =>
  Object.entries(dexes[g.gen].species.getLearnsetData(id as any).learnset ?? {}).filter(([, src]) => src.some(s => SOURCE[g.gen].test(s))).map(([m]) => m);

export type Mon = {species: string; moves: string[]; ability?: 0 | 1}; // species display name, move ids, Gen 3 only: which of its (up to two) abilities
export function dayTeam(day: number, g: Game = GAMES.yellow): Mon[] {
  const dex = dexes[g.gen];
  const damaging = (m: string) => dex.moves.get(m).category !== 'Status';
  const r = rng(hash(`${g.seed}-${day}`));
  const pick = <T,>(a: T[]) => a.splice(Math.floor(r() * a.length), 1)[0];
  const species = speciesOf(g).map(s => s.id);
  return Array.from({length: g.size}, () => {
    const id = pick(species);
    let pool = learnset(id, g);
    const ok = pool.filter(m => !SKIP[g.gen].has(m));
    if (ok.length) pool = ok;
    const atk = pool.filter(damaging);
    const first = pick(atk.length ? atk : [...pool]); // always one attack
    const rest = pool.filter(m => m !== first);
    const moves = [first, ...Array.from({length: Math.min(3, rest.length)}, () => pick(rest))];
    const sp = dex.species.get(id);
    if (g.gen < 3) return {species: sp.name, moves};
    return {species: sp.name, moves, ability: (sp.abilities['1'] ? Math.floor(r() * 2) : 0) as 0 | 1}; // drawn last: Gen 1 and 2 teams never see it
  });
}
/** The name of the ability a Gen 3+ mon has in the given slot (0 or 1): what the page lists beside its moves. */
export const abilityName = (species: string, slot: number, g: Game) => {
  const a = dexes[g.gen].species.get(species).abilities;
  return (slot === 1 && a['1'] ? a['1'] : a['0']) as string;
};
export const moveName = (id: string, g: Game = GAMES.yellow) => dexes[g.gen].moves.get(id).name;
