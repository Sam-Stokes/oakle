// Guards the text boxes: a row holds 18 columns and the game does not wrap. Reads the lines this project changed or
// added (the committed patch), so it runs without the ROM. <PLAYER> and <RIVAL> count as 7 columns (the longest name).
// The engine puts "PROF.OAK: " (10 columns) in front of the end-of-battle texts, so their first row has 8 left.
import {readFileSync} from 'node:fs';
import {describe, expect, it} from 'vitest';

const COLUMNS = 18, NAME = 7, PREFIX = 'PROF.OAK: '.length;
const END_OF_BATTLE = /^_\w+(DefeatedText|VictoryText)$/;
const width = (s: string) => s.replace(/<(PLAYER|RIVAL|USER|TARGET)>/g, 'N'.repeat(NAME)).replace(/#/g, 'POKé').replace(/<[A-Z]+>/g, '').length;

describe('text boxes', () => {
  const patch = readFileSync(new URL('../rom/patches/oakle.patch', import.meta.url), 'utf8').split('\n');
  const rows: {label: string; text: string; first: boolean}[] = [];
  let file = '', label = '', first = true;
  for (const l of patch) {
    const f = /^\+\+\+ (\S+)/.exec(l);
    if (f) { file = f[1]; continue; }
    if (!/\/text\/|oakle_party|ChampionsRoom/.test(file) || !l.startsWith('+')) continue;
    const lab = /^\+(\w+)::?\s*$/.exec(l);
    if (lab) { label = lab[1]; first = true; continue; }
    const m = /^\+\s+(text|line|cont|para|next)\s+"(.*)"\s*$/.exec(l);
    if (m) { rows.push({label, text: m[2], first: first && m[1] === 'text'}); first = first && m[1] !== 'text' ? first : false; }
  }

  it('finds the texts this project wrote', () => {
    expect(rows.length).toBeGreaterThan(5);
    expect(rows.some(r => r.label === '_OakDefeatedText')).toBe(true);
  });
  it('keeps every row within the box, with room for the trainer prefix where the engine adds one', () => {
    const tooWide = rows.filter(r => width(r.text) + (r.first && END_OF_BATTLE.test(r.label) ? PREFIX : 0) > COLUMNS);
    expect(tooWide.map(r => `${r.label}: "${r.text}"`)).toEqual([]);
  });
  it('does not repeat the trainer name the engine already prints', () => {
    const doubled = rows.filter(r => END_OF_BATTLE.test(r.label) && /^OAK:/.test(r.text));
    expect(doubled.map(r => r.label)).toEqual([]);
  });
});
