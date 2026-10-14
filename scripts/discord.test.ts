import {describe, expect, it} from 'vitest';
import {notify} from '../worker/discord';

describe('discord notify', () => {
  const calls: {url: string; init: any}[] = [];
  const fake = (async (url: string, init: any) => { calls.push({url, init}); return {ok: true, status: 204}; }) as unknown as typeof fetch;

  it('does nothing without a webhook', async () => {
    expect(await notify({}, 'hi', fake)).toBe(false);
    expect(calls).toHaveLength(0);
  });
  it('posts the text as Oakle and never pings anyone', async () => {
    expect(await notify({DISCORD_WEBHOOK: 'https://discord.test/hook'}, '**ASH** beat Oak', fake)).toBe(true);
    expect(calls[0].url).toBe('https://discord.test/hook');
    expect(JSON.parse(calls[0].init.body)).toEqual({username: 'Oakle', content: '**ASH** beat Oak', allowed_mentions: {parse: []}});
  });
});
