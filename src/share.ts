// The text players copy to share a result, in the spirit of Wordle's: a title line, a row of squares, the link.
// No spoilers (no moves, no Pokemon), just how it went and how healthy the team ended.
//
//   Oakle #12 — I beat Oak in 18 turns           (Yellow)
//   Oakle Crystal #3 — I beat Elm in 24 turns    (Crystal)
//   🟩🟩🟨🟥⬛
//   https://oakle.day
import {GAMES, type Game} from './games';

export type Party = Array<[number, number]>; // [hp, maxHp] per Pokemon, in party order

const SQUARES = ['⬛', '🟥', '🟨', '🟩']; // fainted, low, half, healthy

/** 0 fainted .. 3 healthy: the same colour thresholds as the game's own 48-pixel HP bar. */
const band = ([hp, max]: [number, number]) => {
  if (hp <= 0) return 0;
  const px = Math.max(1, Math.floor((hp * 48) / max));
  return px < 10 ? 1 : px < 27 ? 2 : 3;
};
const square = (m: [number, number]) => SQUARES[band(m)];

/** The game's name as it heads a share card and the feeds: Yellow stays plain "Oakle". */
export const gameLabel = (g: Game) => (g.id === 'yellow' ? 'Oakle' : `Oakle ${g.title.replace('Pokémon ', '')}`);

/** One digit per Pokemon (0 fainted .. 3 healthy): what the page sends so the server can post the same card. */
export const bands = (party?: Party, g: Game = GAMES.yellow) => (party?.length === g.size ? party.map(band).join('') : '');

/** The squares from the page's bands. Anything missing, malformed or not matching the survivor count falls back to the count. */
export const rowFrom = (b: unknown, alive: number, g: Game = GAMES.yellow) =>
  typeof b === 'string' && b.length === g.size && /^[0-3]+$/.test(b) && [...b].filter(c => c !== '0').length === alive
    ? [...b].map(c => SQUARES[+c]).join('')
    : '🟩'.repeat(alive) + '⬛'.repeat(Math.max(0, g.size - alive));

// who: someone else's card (the Discord post names the player); row: squares already worked out (from rowFrom)
export function shareText(o: {day: number; won: boolean; turns: number; alive: number; party?: Party; link: string; who?: string; row?: string; game?: Game}) {
  const g = o.game ?? GAMES.yellow;
  const squares = o.row ?? (o.party?.length ? o.party.map(square).join('') : '🟩'.repeat(o.alive) + '⬛'.repeat(Math.max(0, g.size - o.alive)));
  const who = o.who ?? 'I';
  const turns = `${o.turns} turn${o.turns === 1 ? '' : 's'}`;
  const title = `${gameLabel(g)} #${o.day} — ${o.won ? `${who} beat ${g.boss} in ${turns}` : `${who} lost to ${g.boss} in ${turns}`}`;
  return `${title}\n${squares}${o.link ? `\n${o.link}` : ''}`; // link: '' leaves the line out (the Discord card)
}
