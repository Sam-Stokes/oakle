// The text players copy to share a result, in the spirit of Wordle's: a title line, a row of squares, the link.
// No spoilers (no moves, no Pokemon), just how it went and how healthy the team ended.
//
//   Oakle #12 — I beat Oak in 18 turns
//   🟩🟩🟨🟥⬛
//   https://oakle.day
export type Party = Array<[number, number]>; // [hp, maxHp] per Pokemon, in party order

/** ⬛ fainted, 🟥 low, 🟨 half, 🟩 healthy: the same colour thresholds as the game's own 48-pixel HP bar. */
const square = ([hp, max]: [number, number]) => {
  if (hp <= 0) return '⬛';
  const px = Math.max(1, Math.floor((hp * 48) / max));
  return px < 10 ? '🟥' : px < 27 ? '🟨' : '🟩';
};

export function shareText(o: {day: number; late: boolean; won: boolean; turns: number; alive: number; party?: Party; link: string}) {
  const squares = o.party?.length ? o.party.map(square).join('') : '🟩'.repeat(o.alive) + '⬛'.repeat(Math.max(0, 5 - o.alive));
  const turns = `${o.turns} turn${o.turns === 1 ? '' : 's'}`;
  const title = `Oakle #${o.day}${o.late ? ' (archive)' : ''} — ${o.won ? `I beat Oak in ${turns}` : `I lost to Oak in ${turns}`}`;
  return `${title}\n${squares}\n${o.link}`;
}
