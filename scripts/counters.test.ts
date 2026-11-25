// The trigger-kept counters and all-time board stay exact through everything that touches a finished run:
// a finish, the audit's void (finished_at = NULL), its turn correction, and a delete.
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {ROLLOVER, TODAY, id, setup} from './harness';

vi.mock('../worker/verify', () => ({verify: async () => null}));

const counts = (t: any) => Object.fromEntries(t.db.sql.prepare(`SELECT k, n FROM meta`).all().map((r: any) => [r.k, r.n]));
const board = async (t: any) => (await (await t.call('/api/leaderboard?day=' + TODAY)).json()).allTime.map((r: any) => [r.name, r.wins, r.played, r.avgTurns]);

describe('counters and all-time board', () => {
  beforeEach(() => { vi.useFakeTimers({toFake: ['Date']}); vi.setSystemTime(ROLLOVER + 12 * 3600e3); });

  it('follow finish, turn correction, void and delete', async () => {
    const t = await setup({});
    await t.play('a', 'ASH', true, 10, 3);
    await t.play('a', 'ASH', true, 20, 2, TODAY - 1);
    await t.play('b', 'MISTY', false, 7, 0);
    expect(counts(t)).toMatchObject({trainers: 2, yellow: 3});
    expect(await board(t)).toEqual([['ASH', 2, 2, 15], ['MISTY', 0, 1, null]]);

    t.db.sql.exec(`UPDATE runs SET turns = 12 WHERE player_id = '${id('a')}' AND day = ${TODAY}`); // audit corrects turns
    t.db.sql.exec(`UPDATE runs SET finished_at = NULL, won = NULL, turns = NULL, alive = NULL, verified = 3 WHERE player_id = '${id('a')}' AND day = ${TODAY - 1}`); // audit voids
    expect(counts(t)).toMatchObject({yellow: 2});
    t.db.sql.exec(`DELETE FROM runs WHERE player_id = '${id('b')}'`);
    expect(counts(t)).toMatchObject({yellow: 1});
    const ps = t.db.sql.prepare(`SELECT player_id, wins, played, win_turns FROM ps WHERE played > 0`).all();
    expect(ps).toEqual([{player_id: id('a'), wins: 1, played: 1, win_turns: 12}]);
  });

  it('backfills existing data once on a cold start', async () => {
    const t = await setup({});
    await t.play('a', 'ASH', true, 10, 3);
    t.db.sql.exec(`DELETE FROM meta; DELETE FROM ps`); // as if shipped onto a database that predates the counters
    vi.resetModules();
    const {default: worker} = await import('../worker/index'); // a cold isolate
    const r = await worker.fetch(new Request('https://oakle.test/api/stats'), {DB: t.db, ASSETS: {fetch: async () => new Response('')}}, {waitUntil() {}});
    expect(await r.json()).toMatchObject({trainers: 1, games: 1, yellow: 1});
    expect(t.db.sql.prepare(`SELECT wins, played, win_turns FROM ps`).all()).toEqual([{wins: 1, played: 1, win_turns: 10}]);
  });
});
