// The text players copy to share a result, in the spirit of Wordle's: a title line, a row of squares, the link.
// No spoilers (no moves, no Pokemon), just how it went and how healthy the team ended.
//
//   Oakle #12 — I beat Oak in 18 turns
//   🟩🟩🟨🟥⬛
//   https://oakle.day
export type Party = Array<[number, number]>; // [hp, maxHp] per Pokemon, in party order

const SQUARES = ['⬛', '🟥', '🟨', '🟩']; // fainted, low, half, healthy

/** 0 fainted .. 3 healthy: the same colour thresholds as the game's own 48-pixel HP bar. */
const band = ([hp, max]: [number, number]) => {
  if (hp <= 0) return 0;
  const px = Math.max(1, Math.floor((hp * 48) / max));
  return px < 10 ? 1 : px < 27 ? 2 : 3;
};
const square = (m: [number, number]) => SQUARES[band(m)];

/** One digit per Pokemon (0 fainted .. 3 healthy): what the page sends so the server can post the same card. */
export const bands = (party?: Party) => (party?.length === 5 ? party.map(band).join('') : '');

/** The squares from the page's bands. Anything missing, malformed or not matching the survivor count falls back to the count. */
export const rowFrom = (b: unknown, alive: number) =>
  typeof b === 'string' && /^[0-3]{5}$/.test(b) && [...b].filter(c => c !== '0').length === alive
    ? [...b].map(c => SQUARES[+c]).join('')
    : '🟩'.repeat(alive) + '⬛'.repeat(Math.max(0, 5 - alive));

// who: someone else's card (the Discord post names the player); row: squares already worked out (from rowFrom)
export function shareText(o: {day: number; late: boolean; won: boolean; turns: number; alive: number; party?: Party; link: string; who?: string; row?: string}) {
  const squares = o.row ?? (o.party?.length ? o.party.map(square).join('') : '🟩'.repeat(o.alive) + '⬛'.repeat(Math.max(0, 5 - o.alive)));
  const who = o.who ?? 'I';
  const turns = `${o.turns} turn${o.turns === 1 ? '' : 's'}`;
  const title = `Oakle #${o.day}${o.late ? ' (archive)' : ''} — ${o.won ? `${who} beat Oak in ${turns}` : `${who} lost to Oak in ${turns}`}`;
  return `${title}\n${squares}\n${o.link}`;
}
