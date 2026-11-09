// One place that knows how the two games differ. Shared by the page, the Worker and the scripts: no DOM, no Node APIs.
// Names, Discord links and pairing codes are shared by all games; everything below is per game.
export type GameId = 'yellow' | 'crystal' | 'emerald';

export type Game = {
  id: GameId;
  title: string; // "Pokémon Yellow"
  gen: 1 | 2 | 3;
  boss: string; // "Oak": what the Discord feed, the share card and the page call the opponent
  bossFull: string; // "Prof. Oak"
  size: number; // Pokémon per side
  launch: string; // calendar date (Pacific/Auckland) of day #1
  runs: string; // D1 table holding this game's results (a closed set: never built from user text)
  path: string; // where the game lives on the site
  rom: string; // served ROM and its config-offset file
  romMeta: string;
  days: string; // per-day data, 50 days per file: `${days}${n}.json`
  sprites: string; // `${sprites}${species id}.png`
  seed: string; // day-team and dice seeds: `${seed}-${day}`, `${seed}-rng-${day}`
  rngLen: number; // seed bytes the ROM's shared battle RNG takes
  cfg: {trainer: number; day: number; rng: number; name: number; party: number}; // byte offsets in the ROM's OakleConfig
  result: number; // offset in cartridge RAM of the result block the ROM writes
  ram: {partyCount: number; party: number; monLen: number; hp: number; maxHp: number; le?: boolean}; // party layout in the game's RAM (Gen 3 is little-endian)
  emu: EmuCfg; // the emulator this game runs on
};

/** How a game talks to its emulator (public/emu/*): binjgb for the Game Boy games, mGBA for Gen 3. Both export the same C API. */
export type EmuCfg = {
  script: string; // served script that defines `global`
  global: string; // the factory it defines (window.Binjgb / window.Mgba)
  frame: number; // emulator ticks per video frame
  ms: number; // emulator ticks per millisecond
  w: number; h: number; // screen
  audio: {rate: number; frames: number; s16: boolean}; // sample rate (0 = the browser's), stereo frames per buffer, 16-bit signed (else 8-bit unsigned)
};
const GB: EmuCfg = {script: '/emu/binjgb.js', global: 'Binjgb', frame: 70224, ms: 4194.304, w: 160, h: 144, audio: {rate: 0, frames: 4096, s16: false}};
const GBA: EmuCfg = {script: '/emu/mgba.js', global: 'Mgba', frame: 280896, ms: 16777.216, w: 240, h: 160, audio: {rate: 32768, frames: 1024, s16: true}};

export const GAMES: Record<GameId, Game> = {
  yellow: {
    id: 'yellow', title: 'Pokémon Yellow', gen: 1, boss: 'Oak', bossFull: 'Prof. Oak', size: 5, launch: '2026-10-13',
    runs: 'runs', path: '/yellow', rom: '/rom/oakle.gbc', romMeta: '/rom/oakle.json', days: '/days/', sprites: '/sprites/',
    seed: 'oakle', rngLen: 9,
    cfg: {trainer: 6, day: 7, rng: 9, name: 18, party: 29},
    result: 1 * 0x2000 + 0x1f00, // SRAM bank 1, $bf00
    ram: {partyCount: 0xd162, party: 0xd16a, monLen: 44, hp: 1, maxHp: 34}, // wPartyCount, wPartyMons in the Yellow RAM map
    emu: GB,
  },
  crystal: {
    id: 'crystal', title: 'Pokémon Crystal', gen: 2, boss: 'Elm', bossFull: 'Prof. Elm', size: 6, launch: '2026-11-05',
    runs: 'runs_crystal', path: '/crystal', rom: '/rom/crystal.gbc', romMeta: '/rom/crystal.json', days: '/days/crystal/', sprites: '/sprites/crystal/',
    seed: 'oakle-crystal', rngLen: 10,
    cfg: {trainer: 6, day: 7, rng: 9, name: 19, party: 30},
    result: 0x1000, // SRAM bank 0, $b000
    ram: {partyCount: 0xdcd7, party: 0xdcdf, monLen: 48, hp: 34, maxHp: 36}, // wPartyCount, wPartyMon1Species in the Crystal RAM map
    emu: GB,
  },
  emerald: {
    id: 'emerald', title: 'Pokémon Emerald', gen: 3, boss: 'Birch', bossFull: 'Prof. Birch', size: 6, launch: '2026-11-12', // launch date = PLACEHOLDER, confirm before deploy
    runs: 'runs_emerald', path: '/emerald', rom: '/rom/emerald.gba', romMeta: '/rom/emerald.json', days: '/days/emerald/', sprites: '/sprites/emerald/',
    seed: 'oakle-emerald', rngLen: 4,
    cfg: {trainer: 6, day: 7, rng: 9, name: 13, party: 21},
    result: 31 * 0x1000, // flash sector 31 (the recorded-battle sector: a game that never saves a battle leaves it alone)
    ram: {partyCount: 0x020244e9, party: 0x020244ec, monLen: 100, hp: 86, maxHp: 88, le: true}, // gPlayerPartyCount, gPlayerParty; hp/maxHP inside struct Pokemon (checked against the build's map by the Emerald ROM test)
    emu: GBA,
  },
};

export const GAME_IDS = Object.keys(GAMES) as GameId[];
/** The game a request or a stored value names; anything else is Yellow (what every client before Crystal sent). */
export const gameOf = (v: unknown): Game => (typeof v === 'string' && v in GAMES ? GAMES[v as GameId] : GAMES.yellow);
