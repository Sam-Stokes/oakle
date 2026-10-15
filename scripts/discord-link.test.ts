// Linking a Discord account to a trainer: the OAuth round trip, restoring a trainer on a new device, and mentions.
// No network: fetch is stubbed (Discord's side is `discord()`), D1 is the node:sqlite shim from harness.ts.
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {HOOK, RESULTS, ROLLOVER, TODAY, id, setup} from './harness';
import {dayStart} from '../src/day';

vi.mock('../worker/verify', () => ({verify: async () => null})); // the real one imports the emulator's wasm

const GUILD = '999999999999999999', DID = '123456789012345678';
const ENV = {DISCORD_WEBHOOK: HOOK, DISCORD_RESULTS_WEBHOOK: RESULTS, DISCORD_CLIENT_ID: 'client-1', DISCORD_CLIENT_SECRET: 'client-secret-xyz', DISCORD_GUILD_ID: GUILD};
const box = (s: string) => '```\n' + s + '\n```';
const ok = (data: unknown) => ({ok: true, status: 200, json: async () => data});
/** Discord's side as the Worker sees it: token exchange, who you are, which servers you are in. */
const discord = (who: object = {id: DID, global_name: 'Sam', username: 'sam_x'}, guilds: object[] = [{id: GUILD}]) => (url: string) => {
  if (url.endsWith('/oauth2/token')) return ok({access_token: 'ACCESS-TOKEN-1'});
  if (url.endsWith('/users/@me/guilds')) return ok(guilds);
  if (url.endsWith('/users/@me')) return ok(who);
};

type T = Awaited<ReturnType<typeof setup>>;
const begin = async (t: T, mode: 'link' | 'signin', c?: string) => {
  const r = await t.call('/api/discord/start', {mode, ...(c ? {id: id(c)} : {})});
  const body: any = await r.json();
  return {r, body, state: body.url ? new URL(body.url).searchParams.get('state')! : '', cookie: (r.headers.get('set-cookie') ?? '').split(';')[0]};
};
const finish = (t: T, state: string, cookie: string) => t.call(`/api/discord/callback?code=the-code&state=${state}`, undefined, cookie ? {cookie} : {});
const where = (r: Response) => new URL(r.headers.get('location')!).search;
const link = async (t: T, c: string, name: string) => { await t.call('/api/name', {id: id(c), name}); const s = await begin(t, 'link', c); return where(await finish(t, s.state, s.cookie)); };

describe('Discord link', () => {
  beforeEach(() => { vi.useFakeTimers({toFake: ['Date']}); vi.setSystemTime(ROLLOVER + 12 * 3600e3); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('is off, and harmless, until the client id and secret are set', async () => {
    const t = await setup({}, undefined, discord());
    expect((await t.call('/api/discord/start', {mode: 'signin'})).status).toBe(503);
    const r = await t.call(`/api/discord/callback?code=x&state=${'a'.repeat(48)}`);
    expect(r.status).toBe(302);
    expect(where(r)).toBe('?discord=error');
  });

  it('links an account to a named trainer, and keeps no token', async () => {
    const t = await setup(ENV, undefined, discord());
    expect((await t.call('/api/discord/start', {mode: 'link', id: id('a')})).status).toBe(400); // no trainer yet
    await t.call('/api/name', {id: id('a'), name: 'ASH'});
    const s = await begin(t, 'link', 'a');
    const u = new URL(s.body.url);
    expect(u.origin + u.pathname).toBe('https://discord.com/oauth2/authorize');
    expect(u.searchParams.get('scope')).toBe('identify guilds');
    expect(u.searchParams.get('redirect_uri')).toBe('https://oakle.test/api/discord/callback');
    expect(s.cookie).toBe(`oakle_oauth=${s.state}`);
    expect(where(await finish(t, s.state, s.cookie))).toBe('?discord=linked');
    expect(await (await t.call(`/api/me?id=${id('a')}`)).json()).toMatchObject({discord: {name: 'Sam', member: true}});
    const tables = t.db.sql.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((x: any) => x.name);
    const dump = JSON.stringify(tables.flatMap((n: string) => t.db.sql.prepare(`SELECT * FROM ${n}`).all()));
    expect(dump).not.toContain('ACCESS-TOKEN-1');
    expect(dump).not.toContain('client-secret-xyz');
  });

  it('a state is single use, tied to the browser that started it, and expires', async () => {
    const t = await setup(ENV, undefined, discord());
    await t.call('/api/name', {id: id('a'), name: 'ASH'});
    const s = await begin(t, 'link', 'a');
    expect(where(await finish(t, s.state, 'oakle_oauth=' + 'b'.repeat(48)))).toBe('?discord=error'); // another browser
    expect(where(await finish(t, s.state, ''))).toBe('?discord=error'); // no cookie
    expect(where(await finish(t, s.state, s.cookie))).toBe('?discord=linked');
    expect(where(await finish(t, s.state, s.cookie))).toBe('?discord=error'); // already used
    const s2 = await begin(t, 'link', 'a');
    vi.setSystemTime(Date.now() + 11 * 60_000);
    expect(where(await finish(t, s2.state, s2.cookie))).toBe('?discord=error'); // expired
  });

  it('one Discord account belongs to one trainer', async () => {
    const t = await setup(ENV, undefined, discord());
    expect(await link(t, 'a', 'ASH')).toBe('?discord=linked');
    expect(await link(t, 'b', 'MISTY')).toBe('?discord=taken');
  });

  it('signing in on a new device hands the trainer over through the one-time code', async () => {
    const t = await setup(ENV, undefined, discord());
    await link(t, 'a', 'ASH');
    const s = await begin(t, 'signin'); // a fresh browser: no trainer yet
    const code = new URLSearchParams(where(await finish(t, s.state, s.cookie))).get('code')!;
    expect(code).toMatch(/^[A-Z0-9]{6}$/);
    expect(await (await t.call('/api/claim', {code})).json()).toEqual({id: id('a'), name: 'ASH'});
    expect((await t.call('/api/claim', {code})).status).toBe(404); // single use
  });

  it('signing in with an account that is not linked finds nothing', async () => {
    const t = await setup(ENV, undefined, discord());
    const s = await begin(t, 'signin');
    expect(where(await finish(t, s.state, s.cookie))).toBe('?discord=none');
  });

  it('unlink clears it, and the account can be linked elsewhere afterwards', async () => {
    const t = await setup(ENV, undefined, discord());
    await link(t, 'a', 'ASH');
    await t.call('/api/discord/unlink', {id: id('a')});
    expect(await (await t.call(`/api/me?id=${id('a')}`)).json()).toMatchObject({discord: null});
    expect(await link(t, 'b', 'MISTY')).toBe('?discord=linked');
  });

  it('a linked member gets a chip in the feed and above the card, and never a ping', async () => {
    const t = await setup(ENV, undefined, discord());
    await link(t, 'a', 'ASH');
    await t.play('a', 'ASH', true, 10, 3, TODAY, {sq: '32100'});
    expect(t.text('🥇')).toEqual([`🥇 **ASH** (<@${DID}>) takes #1 today: 10 turns, 3 left`]);
    expect(t.results()).toEqual([`<@${DID}>\n` + box('Oakle #5 — ASH beat Oak in 10 turns\n🟩🟨🟥⬛⬛')]);
    expect(t.sent.every(m => m.allowed_mentions.parse.length === 0)).toBe(true);
  });

  it('an account that is not in the server is never mentioned', async () => {
    const t = await setup(ENV, undefined, discord(undefined, [{id: '111111111111111111'}]));
    await link(t, 'a', 'ASH');
    expect(await (await t.call(`/api/me?id=${id('a')}`)).json()).toMatchObject({discord: {member: false}});
    await t.play('a', 'ASH', true, 10, 3, TODAY, {sq: '32100'});
    expect(t.text('🥇')).toEqual(['🥇 **ASH** takes #1 today: 10 turns, 3 left']);
    expect(t.results()).toEqual([box('Oakle #5 — ASH beat Oak in 10 turns\n🟩🟨🟥⬛⬛')]);
  });

  it('the recap names linked winners with a chip', async () => {
    const t = await setup(ENV, undefined, discord());
    vi.setSystemTime(dayStart(TODAY - 1) + 3600e3);
    await link(t, 'a', 'ASH');
    await t.play('a', 'ASH', true, 10, 3, TODAY - 1);
    await t.play('b', 'MISTY', true, 12, 2, TODAY - 1);
    const before = t.sent.length;
    await t.tick(ROLLOVER + 60_000);
    expect(t.sent.slice(before).map(m => m.content)).toEqual([`**Oakle #${TODAY - 1} recap:** 2 of 2 beat Oak.\n1. ASH (<@${DID}>), 10 turns\n2. MISTY, 12 turns`]);
  });

  it('the public leaderboard never exposes a Discord id', async () => {
    const t = await setup(ENV, undefined, discord());
    await link(t, 'a', 'ASH');
    await t.play('a', 'ASH', true, 10, 3);
    const body = await (await t.call(`/api/leaderboard?day=${TODAY}&id=${id('a')}`)).text();
    expect(body).not.toContain(DID);
    expect(body.toLowerCase()).not.toContain('discord');
  });
});
