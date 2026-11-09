// Emerald beside Yellow and Crystal: the shared trainer, but a day counter, results table and boards of its own.
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {dayStart} from '../src/day';
import {GAMES} from '../src/games';
import {id, setup} from './harness';

vi.mock('../worker/verify', () => ({verify: async () => null})); // the real one imports the emulator's wasm

const E = GAMES.emerald, EDAY = 2;

describe('Emerald', () => {
  beforeEach(() => { vi.useFakeTimers({toFake: ['Date']}); vi.setSystemTime(dayStart(EDAY, E.launch) + 12 * 3600e3); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('counts its own days from its own launch date', async () => {
    const t = await setup({});
    expect((await (await t.call('/api/leaderboard?game=emerald')).json() as any).current).toBe(EDAY);
    expect((await t.call('/api/start', {id: id('a'), name: 'ASH', day: EDAY + 1, game: 'emerald'})).status).toBe(400); // tomorrow
  });

  it('keeps the trainer and a board of its own, and takes six survivors', async () => {
    const t = await setup({});
    await t.call('/api/name', {id: id('a'), name: 'ASH'}); // named on another game
    await t.call('/api/start', {id: id('a'), day: EDAY, game: 'emerald'});
    expect((await t.call('/api/finish', {id: id('a'), day: EDAY, won: true, turns: 22, alive: 6, game: 'emerald'})).status).toBe(200);
    const e: any = await (await t.call(`/api/leaderboard?game=emerald&id=${id('a')}`)).json();
    expect(e.today.map((r: any) => [r.name, r.turns, r.me])).toEqual([['ASH', 22, true]]);
    const y: any = await (await t.call('/api/leaderboard')).json();
    expect(y.today.map((r: any) => r.name)).toEqual([]); // not on Yellow's board
    expect((await t.call('/api/stats')).status).toBe(200);
  });
});
