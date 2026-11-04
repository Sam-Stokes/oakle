// Crystal beside Yellow: one shared trainer (name, Discord, pairing), but a day counter, results, boards, rules and feed of its own.
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {dayStart} from '../src/day';
import {GAMES} from '../src/games';
import {id, setup, TODAY} from './harness';

vi.mock('../worker/verify', () => ({verify: async () => null})); // the real one imports the emulator's wasm

const C = GAMES.crystal, CDAY = 3;
const crystal = (extra: object = {}) => ({game: 'crystal', ...extra});

describe('Crystal', () => {
  beforeEach(() => { vi.useFakeTimers({toFake: ['Date']}); vi.setSystemTime(dayStart(CDAY, C.launch) + 12 * 3600e3); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('counts its own days from its own launch date', async () => {
    const t = await setup({});
    expect((await (await t.call('/api/leaderboard?game=crystal')).json() as any).current).toBe(CDAY);
    expect((await (await t.call('/api/leaderboard')).json() as any).current).toBeGreaterThan(CDAY); // Yellow is older
    expect((await t.call('/api/start', {id: id('a'), name: 'ASH', day: CDAY + 1, game: 'crystal'})).status).toBe(400); // tomorrow
  });

  it('keeps the trainer: a name picked on Yellow is already there on Crystal, and the boards are separate', async () => {
    const t = await setup({});
    await t.call('/api/name', {id: id('a'), name: 'ASH'}); // as a Yellow player
    await t.call('/api/start', {id: id('a'), day: CDAY, game: 'crystal'}); // never names themselves again
    expect((await t.call('/api/finish', {id: id('a'), day: CDAY, won: true, turns: 14, alive: 4, game: 'crystal'})).status).toBe(200);
    await t.play('b', 'MISTY', true, 9, 3, TODAY); // Yellow, on a different day number
    const c: any = await (await t.call(`/api/leaderboard?game=crystal&id=${id('a')}`)).json();
    expect(c.today.map((r: any) => [r.name, r.turns, r.me])).toEqual([['ASH', 14, true]]);
    expect(c.allTime.map((r: any) => r.name)).toEqual(['ASH']);
    const y: any = await (await t.call(`/api/leaderboard?day=${TODAY}`)).json();
    expect(y.today.map((r: any) => r.name)).toEqual(['MISTY']); // ASH's Crystal win is not on Yellow's board
    expect(y.allTime.map((r: any) => r.name)).toEqual(['MISTY']);
  });

  it('plays the same trainer on both games without clashing on the day number', async () => {
    const t = await setup({});
    // Yellow's day 3 (long past) and Crystal's day 3 (today) are different runs of the same trainer
    expect((await t.play('a', 'ASH', true, 20, 2, CDAY)).status).toBe(200); // Yellow archive day 3
    expect((await t.play('a', 'ASH', true, 15, 3, CDAY, crystal())).status).toBe(200);
    const me = (g: string) => t.call(`/api/me?id=${id('a')}${g}`).then(r => r.json() as any);
    expect((await me('')).runs).toEqual([{day: CDAY, won: 1, turns: 20, alive: 2, late: 1}]);
    expect((await me('&game=crystal')).runs).toEqual([{day: CDAY, won: 1, turns: 15, alive: 3, late: 0}]);
  });

  it('one try per game and day', async () => {
    const t = await setup({});
    await t.play('a', 'ASH', true, 15, 3, CDAY, crystal());
    const again = await t.call('/api/start', {id: id('a'), day: CDAY, game: 'crystal'});
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({finished: true, won: 1, turns: 15, alive: 3});
  });

  it('uses the party size of the game: 6 survivors are fine on Crystal and impossible on Yellow', async () => {
    const t = await setup({});
    expect((await t.play('a', 'ASH', true, 12, 6, CDAY, crystal())).status).toBe(200);
    expect((await t.play('b', 'MISTY', true, 12, 7, CDAY, crystal())).status).toBe(400);
    expect((await t.play('c', 'BROCK', true, 12, 6, TODAY)).status).toBe(400);
    // a win needs one knockout per Pokemon: 5 turns cannot beat Elm's six
    expect(await (await t.play('d', 'GARY', true, 5, 1, CDAY, crystal())).json()).toEqual({void: true});
    expect((await t.play('e', 'LANCE', true, 5, 1, TODAY)).status).toBe(200); // but it can beat Oak's five
  });

  it('an old client that sends no game is Yellow', async () => {
    const t = await setup({});
    await t.play('a', 'ASH', true, 11, 3, TODAY);
    expect(((await (await t.call(`/api/leaderboard?day=${TODAY}`)).json()) as any).today).toHaveLength(1);
    expect(((await (await t.call(`/api/leaderboard?day=${CDAY}&game=nonsense`)).json()) as any).current).toBeGreaterThan(CDAY);
  });

  it('counts finished games per game on /api/stats', async () => {
    const t = await setup({});
    await t.play('a', 'ASH', true, 15, 3, CDAY, crystal());
    await t.play('a', 'ASH', true, 20, 2, CDAY); // Yellow archive
    expect(await (await t.call('/api/stats')).json()).toEqual({trainers: 1, games: 2, yellow: 1, crystal: 1});
  });

  it('names Elm, and the game, in the feed and on the results card', async () => {
    const t = await setup();
    await t.play('b', 'MISTY', true, 9, 6, CDAY, crystal()); // #1, so ASH's win is announced as a plain "beat Elm" with a rank
    await t.play('a', 'ASH', true, 15, 3, CDAY, crystal({sq: '321000'}));
    expect(t.text('')).toEqual(expect.arrayContaining([expect.stringContaining('ASH** beat Elm in 15 turns, 3 left. #2 today')]));
    expect(t.results().join('\n')).toContain('Oakle Crystal #3 — ASH beat Elm in 15 turns\n🟩🟨🟥⬛⬛⬛');
  });

  it('sends old links (/?day=5, /?code=...) to Yellow, which used to live at /', async () => {
    const t = await setup({});
    const r = await t.call('/?day=5');
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toBe('https://oakle.test/yellow?day=5');
    expect((await t.call('/index.html')).headers.get('location')).toBe('https://oakle.test/yellow');
  });
});
