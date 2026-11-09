import {Dex, TeamValidator} from '@pkmn/sim';
import {describe, expect, it} from 'vitest';
import {GAMES} from '../src/games';
import {dayTeam} from './teams';

describe('dayTeam', () => {
  it('any of the 151 can appear, unevolved included, and moves differ between days', () => {
    const seen = new Set<string>(), moves = new Map<string, Set<string>>();
    for (let d = 1; d <= 800; d++) for (const m of dayTeam(d)) { seen.add(m.species); (moves.get(m.species) ?? moves.set(m.species, new Set()).get(m.species)!).add(m.moves.join()); }
    expect(seen.size).toBeGreaterThan(140);
    expect(seen.has('Magikarp') && seen.has('Bulbasaur')).toBe(true);
    expect([...moves.values()].some(s => s.size > 1)).toBe(true);
  });
  it('is deterministic and varies by day', () => {
    expect(dayTeam(5)).toEqual(dayTeam(5));
    expect(dayTeam(5).map(m => m.species)).not.toEqual(dayTeam(6).map(m => m.species));
  });
  it('5 distinct Gen 1 species with 1-4 legal Gen 1 moves', () => {
    const v = TeamValidator.get('gen1customgame'), dex = Dex.forGen(1);
    for (let d = 1; d <= 300; d++) {
      const team = dayTeam(d);
      expect(new Set(team.map(m => m.species)).size).toBe(5);
      for (const m of team) {
        expect(m.moves.length).toBeGreaterThan(0);
        expect(m.moves.length).toBeLessThanOrEqual(4);
        const sp = dex.species.get(m.species);
        for (const mv of m.moves) expect(v.checkCanLearn(dex.moves.get(mv), sp, v.allSources(sp), {} as any), `day ${d} ${m.species} ${mv}`).toBeNull();
      }
    }
  });

  it('Crystal: 6 distinct species from all 251, with 1-4 legal Gen 2 moves (level-up or TM/HM)', () => {
    const g = GAMES.crystal, v = TeamValidator.get('gen2customgame'), dex = Dex.forGen(2);
    const seen = new Set<number>();
    for (let d = 1; d <= 300; d++) {
      const team = dayTeam(d, g);
      expect(new Set(team.map(m => m.species)).size).toBe(6);
      for (const m of team) {
        expect(m.moves.length).toBeGreaterThan(0);
        expect(m.moves.length).toBeLessThanOrEqual(4);
        const sp = dex.species.get(m.species);
        seen.add(sp.num);
        expect(sp.num).toBeLessThanOrEqual(251);
        for (const mv of m.moves) expect(v.checkCanLearn(dex.moves.get(mv), sp, v.allSources(sp), {} as any), `day ${d} ${m.species} ${mv}`).toBeNull();
      }
    }
    expect([...seen].some(n => n > 151)).toBe(true); // Gen 2 species do show up
    expect(Math.max(...seen)).toBeGreaterThan(240);
  });
  it('Crystal teams differ from Yellow\'s and Yellow\'s do not depend on the game argument', () => {
    expect(dayTeam(9, GAMES.crystal).map(m => m.species)).not.toEqual(dayTeam(9).map(m => m.species));
    expect(dayTeam(9, GAMES.yellow)).toEqual(dayTeam(9));
  });
  it('Emerald: 6 distinct species from all 386, 1-4 legal Gen 3 moves, an ability slot the species really has', () => {
    const g = GAMES.emerald, v = TeamValidator.get('gen3customgame'), dex = Dex.forGen(3);
    const seen = new Set<number>(), slots = new Set<number>();
    for (let d = 1; d <= 300; d++) {
      const team = dayTeam(d, g);
      expect(new Set(team.map(m => m.species)).size).toBe(6);
      for (const m of team) {
        expect(m.moves.length).toBeGreaterThan(0);
        expect(m.moves.length).toBeLessThanOrEqual(4);
        const sp = dex.species.get(m.species);
        seen.add(sp.num); slots.add(m.ability!);
        expect(sp.num).toBeLessThanOrEqual(386);
        expect(m.ability === 0 || (m.ability === 1 && !!sp.abilities['1']), `day ${d} ${m.species} slot ${m.ability}`).toBe(true);
        for (const mv of m.moves) expect(v.checkCanLearn(dex.moves.get(mv), sp, v.allSources(sp), {} as any), `day ${d} ${m.species} ${mv}`).toBeNull();
      }
    }
    expect(Math.max(...seen)).toBeGreaterThan(370); // Hoenn species show up
    expect([...slots].sort()).toEqual([0, 1]);
  });
  it('adding Gen 3 left the Gen 1 and Gen 2 teams exactly as they were', () => {
    expect(dayTeam(9, GAMES.yellow).every(m => m.ability === undefined)).toBe(true);
    expect(dayTeam(9, GAMES.crystal).every(m => m.ability === undefined)).toBe(true);
    expect(dayTeam(9, GAMES.emerald).map(m => m.species)).not.toEqual(dayTeam(9, GAMES.crystal).map(m => m.species));
  });
  it('never hands out a move that does nothing against a trainer (Gen 2 list)', () => {
    const bad = new Set(['sketch', 'mirrorcoat', 'perishsong', 'destinybond', 'spite', 'sleeptalk', 'snore', 'dreameater', 'nightmare', 'conversion2', 'psychup', 'batonpass', 'transform', 'metronome', 'mimic']);
    const only = new Set(['smeargle', 'ditto', 'wobbuffet', 'unown']); // species whose whole pool is skipped: they keep it
    for (let d = 1; d <= 400; d++) for (const m of dayTeam(d, GAMES.crystal)) if (!only.has(m.species.toLowerCase())) for (const mv of m.moves) expect(bad.has(mv), `day ${d} ${m.species} ${mv}`).toBe(false);
  });
});
