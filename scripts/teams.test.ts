import {Dex, TeamValidator} from '@pkmn/sim';
import {describe, expect, it} from 'vitest';
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
});
