// The live counters: every trainer, every finished game (archive included, abandoned starts not), cached briefly.
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {ROLLOVER, TODAY, id, setup} from './harness';

vi.mock('../worker/verify', () => ({verify: async () => null})); // the real one imports the emulator's wasm

describe('/api/stats', () => {
  beforeEach(() => { vi.useFakeTimers({toFake: ['Date']}); vi.setSystemTime(ROLLOVER + 12 * 3600e3); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('counts every trainer and every finished game, archive included, but not abandoned starts', async () => {
    const t = await setup({});
    await t.call('/api/name', {id: id('c'), name: 'LURKER'}); // a name and nothing else
    await t.call('/api/start', {id: id('d'), name: 'QUITTER', day: TODAY}); // started, never finished
    await t.play('a', 'ASH', true, 10, 3);
    await t.play('b', 'MISTY', false, 7, 0);
    await t.play('a', 'ASH', true, 12, 2, TODAY - 1);
    const r = await t.call('/api/stats');
    expect(r.headers.get('cache-control')).toBe('public, max-age=10');
    expect(await r.json()).toEqual({trainers: 4, games: 3});
  });

  it('is shared for a few seconds, then picks up new battles', async () => {
    const t = await setup({});
    await t.play('a', 'ASH', true, 10, 3);
    expect(await (await t.call('/api/stats')).json()).toMatchObject({games: 1});
    await t.play('b', 'MISTY', true, 20, 2);
    expect(await (await t.call('/api/stats')).json()).toMatchObject({games: 1}); // still the cached answer
    vi.setSystemTime(Date.now() + 11_000);
    expect(await (await t.call('/api/stats')).json()).toMatchObject({games: 2, trainers: 2});
  });
});
