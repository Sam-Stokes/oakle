// Shared by the Worker tests: an in-memory D1 (node:sqlite), a fresh Worker module per test, and a stubbed fetch so
// nothing touches the network. `route` answers calls that are not Discord webhook posts (for example OAuth).
import {createRequire} from 'node:module';
import {vi} from 'vitest';
import {dayStart} from '../src/day';

export const HOOK = 'https://discord.test/api/webhooks/1/secret-token';
export const RESULTS = 'https://discord.test/api/webhooks/2/results-token';
export const TODAY = 5, ROLLOVER = dayStart(TODAY);
export const id = (c: string) => c.repeat(16); // player ids are 16+ hex characters

const {DatabaseSync} = createRequire(import.meta.url)('node:sqlite');
export function d1() {
  const sql = new DatabaseSync(':memory:');
  const stmt = (q: string, args: unknown[] = []): any => ({
    bind: (...a: unknown[]) => stmt(q, a),
    run: async () => ({meta: {changes: Number(sql.prepare(q).run(...args).changes)}}),
    first: async () => sql.prepare(q).get(...args) ?? null,
    all: async () => ({results: sql.prepare(q).all(...args)}),
  });
  return {sql, prepare: (q: string) => stmt(q), batch: async (list: any[]) => { for (const s of list) await s.run(); }};
}

export async function setup(
  env: Record<string, unknown> = {DISCORD_WEBHOOK: HOOK, DISCORD_RESULTS_WEBHOOK: RESULTS},
  hook: (url: string, init: any) => Promise<any> = async () => ({ok: true, status: 204}),
  route?: (url: string, init: any) => any,
) {
  vi.resetModules(); // a fresh Worker module: its schema and board caches start empty
  const {default: worker} = await import('../worker/index');
  const db = d1(), sent: any[] = [];
  const fetchMock = vi.fn(async (url: string, init: any = {}) => {
    const routed = route?.(String(url), init);
    if (routed !== undefined) return routed;
    sent.push({...JSON.parse(init.body), url});
    return hook(url, init);
  });
  vi.stubGlobal('fetch', fetchMock);
  const pending: Promise<unknown>[] = [];
  const ctx = {waitUntil: (p: Promise<unknown>) => { pending.push(p); }};
  const e = {DB: db, ASSETS: {fetch: async () => new Response('')}, ...env} as any;
  const flush = () => Promise.all(pending.splice(0)); // rejects if a background post threw
  const call = async (path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const r = await worker.fetch(new Request('https://oakle.test' + path, body ? {method: 'POST', body: JSON.stringify(body), headers} : {headers}), e, ctx);
    await flush();
    return r;
  };
  const tick = async (at: number) => { vi.setSystemTime(at); await worker.scheduled(null, e, ctx); await flush(); };
  const play = async (c: string, name: string, won: boolean, turns: number, alive: number, day = TODAY, extra: object = {}) => {
    await call('/api/name', {id: id(c), name});
    await call('/api/start', {id: id(c), name, day});
    return call('/api/finish', {id: id(c), day, won, turns, alive, ...extra});
  };
  const text = (starts: string) => sent.filter(m => m.url === HOOK).map(m => m.content as string).filter(t => t.startsWith(starts)); // the feed
  const results = () => sent.filter(m => m.url === RESULTS).map(m => m.content as string); // the results channel
  return {db, sent, call, tick, play, text, results, fetchMock};
}
