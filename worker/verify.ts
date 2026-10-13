// Replays a submitted input log on the real ROM (binjgb as WebAssembly) and returns what the game itself says happened.
// Costs seconds of CPU per win: needs Workers Paid (10 ms CPU on Free). Enabled by VERIFY = "1" in wrangler.toml.
import Binjgb from '../public/emu/binjgb.js';
import wasm from '../public/emu/binjgb.wasm';
import {decodeLog, patchRom, replay, romId, TICKS_PER_MS, type Day, type Result} from '../src/rom';

const DAYS_PER_FILE = 50;
const IN_WORKER_MAX_MS = 40 * 60_000; // longer games are left to the audit job instead of the Worker's CPU budget

// a new instance every time: an emulator is only reproducible as the first one on its module (see replay in src/rom.ts)
const load = () => Binjgb({instantiateWasm(imports: any, done: (i: WebAssembly.Instance) => void) { WebAssembly.instantiate(wasm, imports).then(done); return {}; }});
let rom: Promise<{bytes: Uint8Array; at: number; id: string}> | undefined;

/**
 * Null when the log is malformed or never reaches a result.
 * 'stale' when the player's ROM is not the one being served (a deploy happened mid-battle): not evidence either way.
 * 'defer' when the game is plausible but too long to replay here: the audit job takes it.
 */
export async function verify(assets: {fetch: typeof fetch}, origin: string, day: number, name: string, log: unknown, clientRom: unknown): Promise<Result | null | 'stale' | 'defer'> {
  const events = decodeLog(log);
  if (!events?.length) return null;
  if (events[events.length - 2] / TICKS_PER_MS > IN_WORKER_MAX_MS) return 'defer';
  const get = (path: string) => assets.fetch(new Request(origin + path)).then(r => (r.ok ? r : Promise.reject(new Error(path + ' ' + r.status))));
  rom ??= Promise.all([get('/rom/oakle.gbc').then(r => r.arrayBuffer()), get('/rom/oakle.json').then(r => r.json() as Promise<{config: number}>)])
    .then(async ([buf, meta]) => { const bytes = new Uint8Array(buf); return {bytes, at: meta.config, id: await romId(bytes)}; })
    .catch((e) => { rom = undefined; throw e; });
  const [{bytes, at, id}, chunk] = await Promise.all([rom, get(`/days/${Math.floor((day - 1) / DAYS_PER_FILE)}.json`).then(r => r.json() as Promise<{days: Day[]}>)]);
  if (clientRom !== id) return 'stale';
  const d = chunk.days.find(x => x.day === day);
  return d ? replay(load, patchRom(bytes, at, d, name), events, day) : null;
}
