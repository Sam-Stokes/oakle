// The Discord feed: notify() itself, text escaping, and the three Worker hooks (new trainer, win/#1, recap).
// No network: fetch is stubbed and D1 is a small shim over node:sqlite.
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {md, notify} from '../worker/discord';
import {dayStart} from '../src/day';
import {HOOK, RESULTS, ROLLOVER, TODAY, id, setup} from './harness';

vi.mock('../worker/verify', () => ({verify: async () => null})); // the real one imports the emulator's wasm

const box = (s: string) => '```\n' + s + '\n```'; // a result card is one code block

describe('notify', () => {
  const calls: {url: string; init: any}[] = [];
  const ok = (async (url: string, init: any) => { calls.push({url, init}); return {ok: true, status: 204}; }) as unknown as typeof fetch;
  beforeEach(() => { calls.length = 0; });

  it('does nothing without a webhook', async () => {
    expect(await notify({}, 'hi', ok)).toBe(false);
    expect(calls).toHaveLength(0);
  });
  it('posts the text as Oakle and never pings anyone', async () => {
    expect(await notify({DISCORD_WEBHOOK: HOOK}, '**ASH** beat Oak', ok)).toBe(true);
    expect(calls[0].url).toBe(HOOK);
    expect(JSON.parse(calls[0].init.body)).toEqual({username: 'Oakle', content: '**ASH** beat Oak', allowed_mentions: {parse: []}});
  });
  it('never throws on a 429, a 500 or a network error, and never logs the URL', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const bad = (r: unknown) => (async () => { if (r instanceof Error) throw r; return r; }) as unknown as typeof fetch;
    expect(await notify({DISCORD_WEBHOOK: HOOK}, 'x', bad({ok: false, status: 429}))).toBe(false);
    expect(await notify({DISCORD_WEBHOOK: HOOK}, 'x', bad({ok: false, status: 500}))).toBe(false);
    expect(await notify({DISCORD_WEBHOOK: HOOK}, 'x', bad(new Error(`fetch failed ${HOOK}`)))).toBe(false);
    expect(JSON.stringify(log.mock.calls)).not.toContain('secret-token');
    log.mockRestore();
  });
});

describe('md (player text made inert)', () => {
  it('leaves ordinary names alone', () => {
    expect(md('ASH-7')).toBe('ASH-7');
    expect(md('MISTY K')).toBe('MISTY K');
  });
  it('escapes markdown, and breaks mentions, emoji codes and links', () => {
    const out = md('**@everyone** http://evil.example [x](y) <@123> `c` _a_ ~b~ ||s|| > q');
    expect(out).not.toMatch(/https?:\/\//);
    expect(out).not.toContain('@everyone');
    expect(out).not.toMatch(/(^|[^\\])[*_~|`>\[\]()<]/); // every markdown character is preceded by a backslash
    expect(out.length).toBeLessThan(80);
  });
  it('drops newlines, control and zero-width characters and caps the length', () => {
    expect(md('A\n' + 'B' + String.fromCharCode(0x200b) + 'C' + String.fromCharCode(0x202e) + 'D')).toBe('A B C D');
    expect(md('x'.repeat(100))).toHaveLength(32);
  });
});

describe('Worker hooks', () => {
  beforeEach(() => { vi.useFakeTimers({toFake: ['Date']}); vi.setSystemTime(ROLLOVER + 12 * 3600e3); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('a win says where it ranks: #1 gets the medal, later ones their place', async () => {
    const t = await setup();
    await t.play('a', 'ASH', true, 10, 3);
    await t.play('b', 'MISTY', true, 20, 2);
    expect(t.sent.every(m => m.allowed_mentions.parse.length === 0)).toBe(true);
    expect(t.text('🥇')).toEqual(['🥇 **ASH** takes #1 today: 10 turns, 3 left']);
    expect(t.text('**MISTY**')).toEqual(['**MISTY** beat Oak in 20 turns, 2 left. #2 today']);
  });
  it('an archive win names the day, and a loss says nothing', async () => {
    const t = await setup();
    await t.play('a', 'ASH', true, 9, 1, TODAY - 1);
    await t.play('b', 'BROCK', false, 7, 0);
    expect(t.text('🥇')).toEqual([`🥇 **ASH** takes #1 on Oakle #${TODAY - 1}: 9 turns, 1 left`]);
    expect(t.text('')).toHaveLength(3); // the feed: 2 new trainers + 1 win
  });
  it('a finished battle is posted to the results channel as the share card, win or loss', async () => {
    const t = await setup();
    await t.play('a', 'ASH', true, 10, 3, TODAY, {sq: '32100'});
    await t.play('b', 'MISTY', false, 7, 0, TODAY, {sq: '00000'});
    expect(t.results()).toEqual([
      box('Oakle #5 — ASH beat Oak in 10 turns\n🟩🟨🟥⬛⬛'),
      box('Oakle #5 — MISTY lost to Oak in 7 turns\n⬛⬛⬛⬛⬛'),
    ]);
  });
  it('a past day just names its number, and squares that are missing, junk or do not add up fall back to the survivor count', async () => {
    const t = await setup();
    await t.play('a', 'ASH', true, 9, 2, TODAY - 1, {sq: '33333'}); // claims 5 survivors, the result says 2
    await t.play('b', 'MISTY', true, 11, 1, TODAY - 1); // no squares sent
    await t.play('c', 'BROCK', true, 12, 4, TODAY - 1, {sq: {not: 'a string'}});
    expect(t.results()).toEqual([
      box(`Oakle #${TODAY - 1} — ASH beat Oak in 9 turns\n🟩🟩⬛⬛⬛`),
      box(`Oakle #${TODAY - 1} — MISTY beat Oak in 11 turns\n🟩⬛⬛⬛⬛`),
      box(`Oakle #${TODAY - 1} — BROCK beat Oak in 12 turns\n🟩🟩🟩🟩⬛`),
    ]);
  });
  it('no results post without DISCORD_RESULTS_WEBHOOK, and the feed is unaffected', async () => {
    const t = await setup({DISCORD_WEBHOOK: HOOK});
    await t.play('a', 'ASH', true, 10, 3, TODAY, {sq: '32100'});
    expect(t.results()).toEqual([]);
    expect(t.text('🥇')).toHaveLength(1);
  });
  it('a new trainer posts once, and a name cannot be changed afterwards', async () => {
    const t = await setup();
    await t.call('/api/name', {id: id('a'), name: 'ASH'});
    await t.call('/api/name', {id: id('a'), name: 'ASH'});
    expect((await t.call('/api/name', {id: id('a'), name: 'ASH2'})).status).toBe(409); // names are final
    await t.call('/api/start', {id: id('a'), name: 'ASH2', day: TODAY});
    await t.call(`/api/me?id=${id('a')}`);
    expect(t.text('New trainer')).toEqual(['New trainer: **ASH**']);
  });
  it('the recap posts at the rollover tick only, not on the other 23 hourly ticks', async () => {
    const t = await setup();
    vi.setSystemTime(dayStart(TODAY - 1) + 3600e3); // the finished day, as it was being played
    await t.play('a', 'ASH', true, 10, 3, TODAY - 1);
    await t.play('b', 'MISTY', true, 12, 2, TODAY - 1);
    await t.play('c', 'BROCK', true, 15, 1, TODAY - 1);
    await t.play('d', 'GARY', true, 18, 1, TODAY - 1);
    await t.play('e', 'JAMES', false, 7, 0, TODAY - 1);
    const before = t.sent.length;
    for (let k = -23; k <= 0; k++) await t.tick(ROLLOVER + 60_000 + k * 3600e3); // 24 consecutive ":01" ticks, the last one just after midnight
    const recap = t.sent.slice(before).map(m => m.content as string);
    expect(recap).toEqual([`**Oakle #${TODAY - 1} recap:** 4 of 5 beat Oak.\n1. ASH, 10 turns\n2. MISTY, 12 turns\n3. BROCK, 15 turns`]);
  });
  it('sends nothing, and throws nothing, when DISCORD_WEBHOOK is unset', async () => {
    const t = await setup({});
    vi.setSystemTime(dayStart(TODAY - 1) + 3600e3);
    expect((await t.play('a', 'ASH', true, 10, 3, TODAY - 1)).status).toBe(200);
    await t.tick(ROLLOVER + 60_000);
    expect(t.fetchMock).not.toHaveBeenCalled();
  });
  it.each([
    ['a 429', async () => ({ok: false, status: 429})],
    ['a 500', async () => ({ok: false, status: 500})],
    ['a network error', async () => { throw new Error('boom'); }],
  ])('a failing webhook (%s) never reaches the request path', async (_n, hook) => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const t = await setup({DISCORD_WEBHOOK: HOOK}, hook as any);
    expect((await t.call('/api/name', {id: id('a'), name: 'ASH'})).status).toBe(200);
    const r = await t.play('a', 'ASH', true, 10, 3);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({won: true, turns: 10});
    await t.tick(ROLLOVER + 60_000); // the recap path too
    log.mockRestore();
  });
  it('a stored name that predates the filter is escaped in every message', async () => {
    const t = await setup();
    await t.call(`/api/me?id=${id('a')}`); // creates the schema
    const nasty = '**@everyone** ``` http://evil.example/x\n[y](z)';
    t.db.sql.prepare('INSERT INTO players (id, name, created_at) VALUES (?, ?, 0)').run(id('a'), nasty); // bypasses the 7-character A-Z filter
    await t.call('/api/start', {id: id('a'), name: 'X', day: TODAY});
    await t.call('/api/finish', {id: id('a'), day: TODAY, won: true, turns: 10, alive: 3});
    const [msg] = t.text('🥇');
    expect(msg).toContain('\\*\\*@\u200beveryone\\*\\*');
    expect(msg).not.toContain('@everyone');
    expect(msg).not.toMatch(/https?:\/\//);
    expect(t.sent[0].allowed_mentions).toEqual({parse: []});
    const [card] = t.results();
    expect(card.split('\n')).toHaveLength(4); // fence, title, squares, fence: the name cannot add lines
    expect(card.split('```')).toHaveLength(3); // and cannot close the block early
    expect(card).toContain("Oakle #5 — **@everyone** ''' http://evil.ex beat Oak in 10 turns"); // backticks swapped for quotes, 32 characters at most
  });
});
