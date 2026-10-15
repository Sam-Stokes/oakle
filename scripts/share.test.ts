import {describe, expect, it} from 'vitest';
import {bands, rowFrom, shareText} from '../src/share';
import {readParty} from '../src/rom';

const base = {day: 1, late: false, link: 'https://oakle.day'};
describe('share text', () => {
  it('a win: title, one square per Pokemon (fainted, red, yellow, green), link', () => {
    const party: [number, number][] = [[0, 300], [20, 300], [100, 300], [250, 300], [300, 300]];
    expect(shareText({...base, won: true, turns: 39, alive: 4, party})).toBe('Oakle #1 — I beat Oak in 39 turns\n⬛🟥🟨🟩🟩\nhttps://oakle.day');
  });
  it('a loss says so, uses the singular, and marks archive days', () => {
    const party: [number, number][] = [[0, 100], [0, 100], [0, 100], [0, 100], [0, 100]];
    expect(shareText({...base, day: 7, late: true, won: false, turns: 1, alive: 0, party}))
      .toBe('Oakle #7 (archive) — I lost to Oak in 1 turn\n⬛⬛⬛⬛⬛\nhttps://oakle.day');
  });
  it('falls back to the count of survivors when the party was not recorded', () => {
    expect(shareText({...base, won: true, turns: 12, alive: 2})).toBe('Oakle #1 — I beat Oak in 12 turns\n🟩🟩⬛⬛⬛\nhttps://oakle.day');
  });
});

describe('result card for the Discord post', () => {
  const party: [number, number][] = [[0, 300], [20, 300], [100, 300], [250, 300], [300, 300]];
  it('bands: one digit per Pokemon (0 fainted .. 3 healthy), only for a full party of five', () => {
    expect(bands(party)).toBe('01233');
    expect(bands(undefined)).toBe('');
    expect(bands([[1, 2]])).toBe('');
  });
  it('rowFrom: uses the squares when they match the survivor count, else the count', () => {
    expect(rowFrom('01233', 4)).toBe('⬛🟥🟨🟩🟩');
    expect(rowFrom('01233', 3)).toBe('🟩🟩🟩⬛⬛'); // does not add up
    expect(rowFrom('0123', 3)).toBe('🟩🟩🟩⬛⬛'); // wrong length
    expect(rowFrom('abcde', 0)).toBe('⬛⬛⬛⬛⬛');
    expect(rowFrom(undefined, 2)).toBe('🟩🟩⬛⬛⬛');
  });
  it('names the player when it is not their own card', () => {
    expect(shareText({...base, won: true, turns: 1, alive: 5, who: '**ASH**', row: '🟩🟩🟩🟩🟩', link: '<https://oakle.day>'}))
      .toBe('Oakle #1 — **ASH** beat Oak in 1 turn\n🟩🟩🟩🟩🟩\n<https://oakle.day>');
  });
});

describe('party memory', () => {
  it('reads hp and max hp for each Pokemon', () => {
    const ram = new Map<number, number>([[0xd162, 2], [0xd16a + 1, 0x01], [0xd16a + 2, 0x2c], [0xd16a + 34, 0x01], [0xd16a + 35, 0x90], [0xd16a + 44 + 1, 0], [0xd16a + 44 + 2, 0], [0xd16a + 44 + 34, 0x00], [0xd16a + 44 + 35, 0x64]]);
    expect(readParty(a => ram.get(a) ?? 0)).toEqual([[0x012c, 0x0190], [0, 100]]);
  });
});
