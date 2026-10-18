// The Bluesky daily post: post() itself, and the cron hook that sends the new day when it rolls over.
// No network: fetch is stubbed and D1 is the harness's node:sqlite shim.
import {readFileSync} from 'node:fs';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {post} from '../worker/bluesky';
import {ROLLOVER, setup} from './harness';

vi.mock('../worker/verify', () => ({verify: async () => null})); // the real one imports the emulator's wasm

const ENV = {BSKY_HANDLE: 'oakle.bsky.social', BSKY_APP_PASSWORD: 'app-pass-word'};
const res = (ok: boolean, body: unknown = {}) => ({ok, status: ok ? 200 : 401, json: async () => body}) as unknown as Response;

describe('post', () => {
  const calls: {url: string; body: any; auth?: string}[] = [];
  const stub = (loginOk = true, postOk = true) => (async (url: string, init: any) => {
    calls.push({url, body: JSON.parse(init.body), auth: init.headers.authorization});
    return url.endsWith('createSession') ? res(loginOk, {accessJwt: 'jwt', did: 'did:plc:x'}) : res(postOk);
  }) as unknown as typeof fetch;
  beforeEach(() => { calls.length = 0; });

  it('does nothing without credentials', async () => {
    expect(await post({}, 'hi', 'oakle.day', stub())).toBe(false);
    expect(calls).toHaveLength(0);
  });
  it('logs in, then posts with the link as a facet measured in UTF-8 bytes', async () => {
    const text = 'Pokémon ✅ today\noakle.day';
    expect(await post(ENV, text, 'oakle.day', stub())).toBe(true);
    expect(calls[0].body).toEqual({identifier: ENV.BSKY_HANDLE, password: ENV.BSKY_APP_PASSWORD});
    expect(calls[1].auth).toBe('Bearer jwt');
    const {repo, record} = calls[1].body;
    expect(repo).toBe('did:plc:x');
    const {byteStart, byteEnd} = record.facets[0].index;
    expect(Buffer.from(text).subarray(byteStart, byteEnd).toString()).toBe('oakle.day'); // é and ✅ are more than one byte
    expect(record.facets[0].features[0].uri).toBe('https://oakle.day');
  });
  it('returns false, never throws, and never logs the password', async () => {
    const logged: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => { logged.push(a.join(' ')); };
    try {
      expect(await post(ENV, 'x', 'oakle.day', stub(false))).toBe(false);
      expect(await post(ENV, 'x', 'oakle.day', stub(true, false))).toBe(false);
      expect(await post(ENV, 'x', 'oakle.day', (async () => { throw new Error(`boom ${ENV.BSKY_APP_PASSWORD}`); }) as unknown as typeof fetch)).toBe(false);
    } finally { console.error = orig; }
    expect(logged.join('\n')).not.toContain(ENV.BSKY_APP_PASSWORD);
  });
});

describe('cron', () => {
  const days = JSON.parse(readFileSync(new URL('../public/days/0.json', import.meta.url), 'utf8'));
  const assets = {fetch: async () => new Response(JSON.stringify(days))};
  const run = async (env: Record<string, unknown>, at = ROLLOVER) => {
    const posts: any[] = [];
    const route = (url: string, init: any) => {
      if (!url.startsWith('https://bsky.social/')) return undefined;
      const body = JSON.parse(init.body);
      if (url.endsWith('createRecord')) posts.push(body.record);
      return url.endsWith('createSession') ? res(true, {accessJwt: 'jwt', did: 'did:plc:x'}) : res(true);
    };
    const w = await setup({ASSETS: assets, ...env}, undefined, route);
    await w.tick(at);
    return posts;
  };

  it('posts the new day with the real team the moment the day rolls over', async () => {
    const posts = await run(ENV);
    expect(posts).toHaveLength(1);
    const team = days.days.find((d: any) => d.day === 5).team.map((m: any) => m.species).join(', ');
    expect(posts[0].text).toContain(`Oakle #5 is live. Today's team: ${team}.`);
    expect(posts[0].text.endsWith('\noakle.day')).toBe(true);
  });
  it('stays quiet mid-day and without credentials', async () => {
    expect(await run(ENV, ROLLOVER + 2 * 3_600_000)).toHaveLength(0);
    expect(await run({})).toHaveLength(0);
  });
});
