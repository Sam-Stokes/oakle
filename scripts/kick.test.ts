import {beforeEach, describe, expect, it} from 'vitest';
import {kickAudit, resetKick} from '../worker/kick';

describe('audit kick', () => {
  beforeEach(resetKick);
  const calls: {url: string; init: any}[] = [];
  const fake = (async (url: string, init: any) => { calls.push({url, init}); return {ok: true, status: 204}; }) as unknown as typeof fetch;
  beforeEach(() => { calls.length = 0; });

  it('does nothing without a token or repo', async () => {
    expect(await kickAudit({}, 1_000_000, fake)).toBe(false);
    expect(await kickAudit({GITHUB_TOKEN: 't'}, 1_000_000, fake)).toBe(false);
    expect(calls).toHaveLength(0);
  });
  it('dispatches the audit workflow on main with the token', async () => {
    expect(await kickAudit({GITHUB_TOKEN: 'tok', GITHUB_REPO: 'me/oakle'}, 1_000_000, fake)).toBe(true);
    expect(calls[0].url).toBe('https://api.github.com/repos/me/oakle/actions/workflows/audit.yml/dispatches');
    expect(calls[0].init.headers.authorization).toBe('Bearer tok');
    expect(JSON.parse(calls[0].init.body)).toEqual({ref: 'main'});
  });
  it('starts at most one run a minute per instance', async () => {
    const env = {GITHUB_TOKEN: 'tok', GITHUB_REPO: 'me/oakle'};
    await kickAudit(env, 1_000_000, fake);
    expect(await kickAudit(env, 1_030_000, fake)).toBe(false);
    expect(await kickAudit(env, 1_061_000, fake)).toBe(true);
    expect(calls).toHaveLength(2);
  });
});
