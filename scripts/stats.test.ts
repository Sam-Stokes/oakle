import {describe, expect, it} from 'vitest';
import {streaks} from '../worker/stats';

describe('streaks', () => {
  const w = (player_id: string, ...days: number[]) => days.map(day => ({player_id, day}));
  it('counts consecutive days and keeps the best run', () => {
    const s = streaks([...w('a', 1, 2, 3, 5, 6), ...w('b', 4)], 6);
    expect(s.get('a')).toEqual({best: 3, current: 2});
    expect(s.get('b')).toEqual({best: 1, current: 0});
  });
  it('a streak is still alive if the last win was yesterday, dead after a missed day', () => {
    expect(streaks(w('a', 3, 4), 5).get('a')!.current).toBe(2);
    expect(streaks(w('a', 3, 4), 6).get('a')!.current).toBe(0);
  });
});

import {cleanCode, makeCode} from '../worker/stats';
describe('pairing codes', () => {
  it('uses only unambiguous characters and the requested length', () => {
    const code = makeCode(crypto.getRandomValues(new Uint8Array(6)));
    expect(code).toMatch(/^[A-HJKMNP-Z2-9]{6}$/);
  });
  it('cleans what people type', () => {
    expect(cleanCode(' k7q-f93 ')).toBe('K7QF93');
  });
});

import {cleanName} from '../worker/stats';
describe('player names', () => {
  it('uppercases, strips and caps at 7', () => {
    expect(cleanName(' ash ketchum ')).toBe('ASH KET');
    expect(cleanName('r3d<script>')).toBe('R3DSCRI');
    expect(cleanName('')).toBe('');
    expect(cleanName('---')).toBe('---');
  });
});

import {isBlocked} from '../worker/stats';
describe('name moderation', () => {
  it('blocks profanity and the usual disguises', () => {
    for (const n of ['FUCK', 'F U C K', 'FUUUCK', 'SH1T', 'B-ITCH', 'N1GGER', 'a55hole', 'F4G', 'RAPE', 'S E X'])
      expect(isBlocked(n.toUpperCase()), n).toBe(true);
  });
  it('lets innocent names through, including ones that contain short bad words', () => {
    for (const n of ['RED', 'BLUE', 'SAM', 'ASH KET', 'CLASSIC', 'GRASS', 'DICKENS', 'PEACOCK', 'ANALYST', 'GRAPES', 'ASSASSN', 'TITAN', 'SEXTON'])
      expect(isBlocked(n), n).toBe(false);
  });
});
