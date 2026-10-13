// Replays a submitted input log on the real ROM (binjgb as WebAssembly) and returns what the game itself says happened.
// Costs seconds of CPU per win: needs Workers Paid (10 ms CPU on Free). Enabled by VERIFY = "1" in wrangler.toml.
import Binjgb from '../public/emu/binjgb.js';
import wasm from '../public/emu/binjgb.wasm';
import {decodeLog, patchRom, replay, romId, withinClock, type Day, type Result} from '../src/rom';

const DAYS_PER_FILE = 50;

let module: Promise<any> | undefined;
const load = () => (module ??= Binjgb({instantiateWasm(imports: any, done: (i: WebAssembly.Instance) => void) { WebAssembly.instantiate(wasm, imports).then(done); return {}; }}));
let rom: Promise<{bytes: Uint8Array; at: number; id: string}> | undefined;

/**
 * Null when the log is malformed, longer than the wall-clock time since the run started, or never reaches a result.
 * 'stale' when the player's ROM is not the one being served (a deploy happened mid-battle): not evidence either way.
 */
export async function verify(assets: {fetch: typeof fetch}, origin: string, day: number, name: string, log: unknown, sinceStartMs: number, clientRom: unknown): Promise<Result | null | 'stale'> {
  const events = decodeLog(log);
  if (!events || !withinClock(events, sinceStartMs)) return null;
  const get = (path: string) => assets.fetch(new Request(origin + path)).then(r => (r.ok ? r : Promise.reject(new Error(path + ' ' + r.status))));
  rom ??= Promise.all([get('/rom/oakle.gbc').then(r => r.arrayBuffer()), get('/rom/oakle.json').then(r => r.json() as Promise<{config: number}>)])
    .then(async ([buf, meta]) => { const bytes = new Uint8Array(buf); return {bytes, at: meta.config, id: await romId(bytes)}; })
    .catch((e) => { rom = undefined; throw e; });
  const [{bytes, at, id}, chunk] = await Promise.all([rom, get(`/days/${Math.floor((day - 1) / DAYS_PER_FILE)}.json`).then(r => r.json() as Promise<{days: Day[]}>)]);
  if (clientRom !== id) return 'stale';
  const d = chunk.days.find(x => x.day === day);
  return d ? replay(await load(), patchRom(bytes, at, d, name), events, day) : null;
}
