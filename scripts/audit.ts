// Free win audit. The Worker (VERIFY = "audit") accepts a win at once and keeps its input log on the row; this replays
// each such win on the real ROM and corrects the ones that do not reproduce. Run by .github/workflows/audit.yml every
// few minutes, or by hand: CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... D1_DATABASE_ID=... npx tsx scripts/audit.ts
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {decodeLog, patchRom, replay, romId, type Day, type Result} from '../src/rom';

export type Db = {all(sql: string, params?: string[]): Promise<any[]>};
type Deps = {site: string; fetch: typeof fetch; load: () => Promise<any>; replayFn?: typeof replay; batch?: number};

/** Replays pending wins; returns how many were confirmed, corrected, or left alone (ROM changed since they were played). */
export async function audit(db: Db, {site, fetch, load, replayFn = replay, batch = 10}: Deps, log: (s: string) => void = console.log) {
  const out = {confirmed: 0, corrected: 0, skipped: 0};
  const rows = await db.all(`SELECT player_id, day, log FROM runs WHERE won = 1 AND verified = 0 AND log IS NOT NULL ORDER BY finished_at LIMIT ${batch}`);
  if (!rows.length) return out;
  const get = async (path: string) => { const r = await fetch(site + path); if (!r.ok) throw new Error(`${path}: ${r.status}`); return r; };
  const rom = new Uint8Array(await (await get('/rom/oakle.gbc')).arrayBuffer());
  const {config} = (await (await get('/rom/oakle.json')).json()) as {config: number};
  const id = await romId(rom);
  const m = await load();
  const chunks = new Map<number, Promise<Day[]>>();
  const days = (n: number) => { const k = Math.floor((n - 1) / 50); if (!chunks.has(k)) chunks.set(k, get(`/days/${k}.json`).then(r => r.json()).then((j: any) => j.days)); return chunks.get(k)!; };

  for (const row of rows) {
    const day = Number(row.day), who = String(row.player_id).slice(0, 6);
    const where = `WHERE player_id = ? AND day = ${day} AND verified = 0`;
    let evidence: any = null;
    try { evidence = JSON.parse(row.log); } catch { /* corrected below */ }
    // verified = 2: cannot be audited (the evidence is for a different ROM). Marked so it never blocks the queue.
    const skip = async (why: string) => { await db.all(`UPDATE runs SET verified = 2 ${where}`, [row.player_id]); out.skipped++; log(`day ${day} ${who}: skipped, ${why}`); };
    if (evidence && evidence.rom !== id) { await skip('the ROM changed since it was played'); continue; }
    const events = evidence ? decodeLog(evidence.log) : null;
    const d = (await days(day)).find(x => x.day === day);
    if (events && !d) { await skip('no data for that day'); continue; }
    const res: Result | null = events && d ? replayFn(m, patchRom(rom, config, d, String(evidence.name ?? '')), events, day) : null;
    if (res?.won) { // the game itself says it was a win; its numbers replace the claimed ones
      await db.all(`UPDATE runs SET turns = ${res.turns | 0}, alive = ${res.alive | 0}, verified = 1, log = NULL ${where}`, [row.player_id]);
      out.confirmed++; log(`day ${day} ${who}: confirmed, ${res.turns} turns`);
    } else { // not reproduced: a loss, with whatever the game itself ended with. The evidence stays on the row.
      await db.all(`UPDATE runs SET won = 0, turns = ${(res?.turns ?? 0) | 0}, alive = ${(res?.alive ?? 0) | 0}, verified = 1 ${where}`, [row.player_id]);
      out.corrected++; log(`day ${day} ${who}: CORRECTED to a loss (${res ? 'the replay lost' : 'the replay never finished'})`);
    }
  }
  return out;
}

/** Cloudflare's D1 REST API: POST /accounts/{id}/d1/database/{id}/query, rows in result[0].results. */
const d1 = (account: string, database: string, token: string): Db => ({
  async all(sql, params = []) {
    const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/d1/database/${database}/query`, {
      method: 'POST', headers: {authorization: `Bearer ${token}`, 'content-type': 'application/json'}, body: JSON.stringify({sql, params}),
    });
    const j: any = await r.json();
    if (!j.success) throw new Error(`D1: ${JSON.stringify(j.errors)}`);
    return j.result[0]?.results ?? [];
  },
});

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const {CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: account, D1_DATABASE_ID: database, SITE_URL} = process.env;
  if (!token || !account || !database) { console.log('audit: not configured (needs CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, D1_DATABASE_ID), nothing to do'); process.exit(0); }
  const {load} = createRequire(import.meta.url)('./emu.cjs');
  audit(d1(account, database, token), {site: (SITE_URL || 'https://oakle.day').replace(/\/$/, ''), fetch, load})
    .then(r => console.log(`audit: ${r.confirmed} confirmed, ${r.corrected} corrected, ${r.skipped} skipped`))
    .catch(e => { console.error(e); process.exit(1); });
}
