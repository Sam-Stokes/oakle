// Bakes ten years of daily data into public/days/N.json (Yellow), public/days/crystal/N.json and public/days/emerald/N.json, 50 days per file
// (the page and the Worker fetch one file): team as the ROM's internal ids (+ display names), RNG seed, the boss's starter.
// Reads the internal species/move ids from the pret decomp constants so they can never drift from the ROM.
import {createHash} from 'node:crypto';
import {mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {GAMES, type Game} from '../src/games';
import {abilityName, dayTeam, moveName} from './teams';

const DECOMP = {yellow: '../rom/pokeyellow-pristine/constants/', crystal: '../rom/crystal/pokecrystal-pristine/constants/', emerald: '../rom/emerald/pokeemerald-pristine/include/constants/'};
const DAYS = 3650, PER_FILE = 50; // PER_FILE must match the page (src/main.ts) and the Worker (worker/verify.ts)
const SPECIAL: Record<string, string> = {Psychic: 'PSYCHIC_M', 'Vise Grip': 'VICEGRIP', 'High Jump Kick': 'HI_JUMP_KICK'};
const CRYSTAL_ONLY: Record<string, string> = {'Smelling Salts': 'SMELLINGSALT', 'Feint Attack': 'FAINT_ATTACK', 'Mr. Mime': 'MR__MIME'}; // names that differ in pokecrystal
const EMERALD_ONLY: Record<string, string> = {'Vise Grip': 'VICE_GRIP', 'High Jump Kick': 'HI_JUMP_KICK', 'Feint Attack': 'FAINT_ATTACK', 'Smelling Salts': 'SMELLING_SALT'}; // names that differ in pokeemerald
const OVERRIDE: Record<Game['id'], Record<string, string>> = {yellow: SPECIAL, crystal: {...SPECIAL, ...CRYSTAL_ONLY}, emerald: EMERALD_ONLY};

function bake(g: Game, out: URL) {
  const SRC = new URL(DECOMP[g.id], import.meta.url);
  const consts = (file: string, prefix: string) => {
    const m = new Map<string, number>();
    for (const l of readFileSync(new URL(file, SRC), 'utf8').split('\n')) {
      // Gen 3 is C: `#define SPECIES_TREECKO 277` (the game's own internal numbers: Hoenn species do not follow the Pokedex)
      const x = g.gen === 3 ? new RegExp(`^#define ${prefix}_(\\w+)\\s+(\\d+)\\s*$`).exec(l) : /^\s*const\s+(\w+)\s*;\s*\$?([0-9a-fA-F]{2})\b/.exec(l);
      if (x) m.set(x[1], g.gen === 3 ? +x[2] : parseInt(x[2], 16));
    }
    return m;
  };
  const SPECIES = g.gen === 3 ? consts('species.h', 'SPECIES') : consts('pokemon_constants.asm', ''), MOVES = g.gen === 3 ? consts('moves.h', 'MOVE') : consts('move_constants.asm', '');
  const missing = new Set<string>();
  const lookup = (table: Map<string, number>, name: string) => {
    const n = OVERRIDE[g.id][name] ?? name.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '');
    for (const c of [n, n.replace(/_/g, '')]) if (table.has(c)) return table.get(c)!;
    missing.add(`${name} (tried ${n})`);
    return 0;
  };
  const days = Array.from({length: DAYS}, (_, i) => {
    const day = i + 1, trainer = (day % 3) + 1;
    const team = dayTeam(day, g);
    return {
      day,
      trainer, // 1..3 selects the boss's starter in the ROM (Yellow: Blastoise, Venusaur, Charizard; Crystal: Meganium, Typhlosion, Feraligatr; Emerald: Sceptile, Blaziken, Swampert)
      rng: [...createHash('sha256').update(`${g.seed}-rng-${day}`).digest().subarray(0, g.rngLen)],
      // Gen 1/2: species then up to 4 moves. Gen 3: species, exactly 4 moves (0 = none), which of the species' abilities
      party: team.map(m => g.gen === 3
        ? [lookup(SPECIES, m.species), ...[...m.moves.map(id => lookup(MOVES, moveName(id, g))), 0, 0, 0, 0].slice(0, 4), m.ability!]
        : [lookup(SPECIES, m.species), ...m.moves.map(id => lookup(MOVES, moveName(id, g)))]),
      // the names the page shows; `ability` only where the generation has abilities (Gen 3+), so Yellow's and Crystal's files stay as they were
      team: team.map(m => ({species: m.species, moves: m.moves.map(id => moveName(id, g)), ...(m.ability === undefined ? {} : {ability: abilityName(m.species, m.ability, g)})})),
    };
  });
  if (missing.size) throw new Error(`${g.id}: no ROM constant for: ` + [...missing].join('; '));
  mkdirSync(out, {recursive: true});
  for (let i = 0; i < DAYS; i += PER_FILE) writeFileSync(new URL(`${i / PER_FILE}.json`, out), JSON.stringify({days: days.slice(i, i + PER_FILE)}));
  console.log(`wrote ${g.id} (${DAYS} days in ${DAYS / PER_FILE} files); day 1:`, days[0].team.map(m => m.species).join(', '));
}

const root = new URL('../public/days/', import.meta.url);
rmSync(root, {recursive: true, force: true}); // Yellow first: its folder is the parent of Crystal's
rmSync(new URL('../public/days.json', import.meta.url), {force: true}); // the old single-file layout
bake(GAMES.yellow, root);
bake(GAMES.crystal, new URL('crystal/', root));
bake(GAMES.emerald, new URL('emerald/', root));
