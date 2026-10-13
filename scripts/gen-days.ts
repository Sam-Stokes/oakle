// Bakes ten years of daily data into public/days/N.json, 50 days per file (the page and the Worker fetch one file): team as the ROM's internal ids (+ display names), RNG seed, Oak's starter.
// Reads the internal species/move ids from the pret/pokeyellow constants so they can never drift from the ROM.
import {createHash} from 'node:crypto';
import {mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {dayTeam, moveName} from './teams';

const SRC = new URL('../rom/pokeyellow-pristine/constants/', import.meta.url);
const consts = (file: string) => {
  const m = new Map<string, number>();
  for (const l of readFileSync(new URL(file, SRC), 'utf8').split('\n')) {
    const x = /^\s*const\s+(\w+)\s*;\s*\$?([0-9a-fA-F]{2})\b/.exec(l);
    if (x) m.set(x[1], parseInt(x[2], 16));
  }
  return m;
};
const SPECIES = consts('pokemon_constants.asm'), MOVES = consts('move_constants.asm');
const missing = new Set<string>();
const SPECIAL: Record<string, string> = {Psychic: 'PSYCHIC_M', 'Vise Grip': 'VICEGRIP', 'High Jump Kick': 'HI_JUMP_KICK'};
const lookup = (table: Map<string, number>, name: string) => {
  const n = SPECIAL[name] ?? name.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '');
  for (const c of [n, n.replace(/_/g, '')]) if (table.has(c)) return table.get(c)!;
  missing.add(`${name} (tried ${n})`);
  return 0;
};

const DAYS = 3650, PER_FILE = 50; // PER_FILE must match the page (src/main.ts) and the Worker (worker/verify.ts)
const days = Array.from({length: DAYS}, (_, i) => {
  const day = i + 1, trainer = (day % 3) + 1;
  const team = dayTeam(day);
  return {
    day,
    trainer, // 1..3 selects Oak's starter in the ROM (ProfOakData order: Blastoise, Venusaur, Charizard)
    rng: [...createHash('sha256').update(`oakle-rng-${day}`).digest().subarray(0, 9)],
    party: team.map(m => [lookup(SPECIES, m.species), ...m.moves.map(id => lookup(MOVES, moveName(id)))]),
    team: team.map(m => ({species: m.species, moves: m.moves.map(moveName)})),
  };
});
if (missing.size) throw new Error('no ROM constant for: ' + [...missing].join('; '));
const out = new URL('../public/days/', import.meta.url);
rmSync(out, {recursive: true, force: true});
mkdirSync(out, {recursive: true});
for (let i = 0; i < DAYS; i += PER_FILE) writeFileSync(new URL(`${i / PER_FILE}.json`, out), JSON.stringify({days: days.slice(i, i + PER_FILE)}));
rmSync(new URL('../public/days.json', import.meta.url), {force: true}); // the old single-file layout
console.log(`wrote public/days/ (${DAYS} days in ${DAYS / PER_FILE} files); day 1:`, days[0].team.map(m => m.species).join(', '));
