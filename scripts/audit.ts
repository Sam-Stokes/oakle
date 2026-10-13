// Free win audit. The Worker (VERIFY = "audit") accepts a win at once and keeps its input log on the row; this replays
// each such win on the real ROM and corrects the ones that do not reproduce. Run by .github/workflows/audit.yml every
// few minutes, or by hand: CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... D1_DATABASE_ID=... npx tsx scripts/audit.ts
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {dayId, decodeLog, patchRom, replay, romId, type Day, type Result} from '../src/rom';

export type Db = {all(sql: string, params?: string[]): Promise<any[]>};
type Deps = {site: string; fetch: typeof fetch; load: () => Promise<any>; replayFn?: typeof replay; batch?: number};

/** Replays pending wins; returns how many were confirmed, voided (`corrected`), or left alone (ROM changed since they were played). */
export async function audit(db: Db, {site, fetch, load, replayFn = replay, batch = 10}: Deps, log: (s: string) => void = console.log) {
  const out = {confirmed: 0, corrected: 0, skipped: 0};
  let rows: any[];
  try {
    rows = await db.all(`SELECT player_id, day, log FROM runs WHERE won = 1 AND verified = 0 AND log IS NOT NULL ORDER BY finished_at LIMIT ${batch}`);
  } catch (e) {
    // The Worker adds this column on its first request after a deploy; until then there is nothing to audit.
    if (/no such column: verified/.test(String(e))) { log('audit: no verified column yet (the Worker creates it on its first request after a deploy), nothing to do'); return out; }
    throw e;
  }
  if (!rows.length) return out;
  const get = async (path: string) => { const r = await fetch(site + path); if (!r.ok) throw new Error(`${path}: ${r.status}`); return r; };
  const rom = new Uint8Array(await (await get('/rom/oakle.gbc')).arrayBuffer());
  const {config} = (await (await get('/rom/oakle.json')).json()) as {config: number};
  const id = await romId(rom);
  const chunks = new Map<number, Promise<Day[]>>();
  const days = (n: number) => { const k = Math.floor((n - 1) / 50); if (!chunks.has(k)) chunks.set(k, get(`/days/${k}.json`).then(r => r.json()).then((j: any) => j.days)); return chunks.get(k)!; };

  type Decision = {kind: 'confirm' | 'void' | 'skip'; day: number; who: string; player: string; res: Result | null; why: string};
  const decisions: Decision[] = [];
  for (const row of rows) {
    const day = Number(row.day), who = String(row.player_id).slice(0, 6);
    let evidence: any = null;
    try { evidence = JSON.parse(row.log); } catch { /* voided below */ }
    const decide = (kind: Decision['kind'], res: Result | null = null, why = '') => decisions.push({kind, day, who, player: row.player_id, res, why});
    // skipped (verified = 2): the evidence is for different data than what is served now, so it cannot be judged. It is
    // left as it was claimed, never voided, and marked so it does not block the queue.
    if (evidence && evidence.rom !== id) { decide('skip', null, 'the ROM changed since it was played'); continue; }
    const events = evidence ? decodeLog(evidence.log) : null;
    const d = (await days(day)).find(x => x.day === day);
    if (events && !d) { decide('skip', null, 'no data for that day'); continue; }
    if (events && d && evidence.cfg && evidence.cfg !== (await dayId(d))) { decide('skip', null, 'the data for that day changed since it was played'); continue; }
    const res: Result | null = events && d ? await replayFn(load, patchRom(rom, config, d, String(evidence.name ?? '')), events, day) : null;
    if (res?.won) decide('confirm', res);
    else decide('void', res, res ? 'the replay was not a win' : 'the replay never finished');
  }

  // Circuit breaker: several wins failing while none confirms looks like a fault in the audit, not several cheaters.
  // Nothing is voided then, the wins stay counted as claimed, and the run fails loudly so it gets looked at.
  const voids = decisions.filter(x => x.kind === 'void'), confirms = decisions.filter(x => x.kind === 'confirm');
  const suspicious = voids.length >= 3 && confirms.length === 0;
  if (suspicious) log(`SUSPICIOUS: ${voids.length} of ${decisions.length} wins did not reproduce and none did. Not voiding any of them (this looks like a fault, not cheating).`);

  for (const x of decisions) {
    const where = `WHERE player_id = ? AND day = ${x.day} AND verified = 0`;
    if (x.kind === 'confirm') { // the game itself says it was a win; its numbers replace the claimed ones
      await db.all(`UPDATE runs SET turns = ${x.res!.turns | 0}, alive = ${x.res!.alive | 0}, verified = 1, log = NULL ${where}`, [x.player]);
      out.confirmed++; log(`day ${x.day} ${x.who}: confirmed, ${x.res!.turns} turns`);
    } else if (x.kind === 'skip') {
      await db.all(`UPDATE runs SET verified = 2 ${where}`, [x.player]);
      out.skipped++; log(`day ${x.day} ${x.who}: skipped, ${x.why}`);
    } else if (!suspicious) {
      // Not a win on replay: it stops counting. It is never turned into a loss (void: counted as neither). The evidence
      // stays on the row, and verified = 3 is what the page and the Worker read as "void".
      await db.all(`UPDATE runs SET finished_at = NULL, won = NULL, turns = NULL, alive = NULL, verified = 3 ${where}`, [x.player]);
      out.corrected++; log(`day ${x.day} ${x.who}: VOIDED (${x.why})`);
    }
  }
  if (suspicious) throw new Error('audit: suspicious batch, nothing voided');
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
  const db = d1(account, database, token), site = (SITE_URL || 'https://oakle.day').replace(/\/$/, '');
  (async () => {
    const total = {confirmed: 0, corrected: 0, skipped: 0};
    for (let round = 0; round < 30; round++) { // batches of 10 until nothing is pending (or 300 wins, then the next run continues)
      const r = await audit(db, {site, fetch, load});
      total.confirmed += r.confirmed; total.corrected += r.corrected; total.skipped += r.skipped;
      if (r.confirmed + r.corrected + r.skipped === 0) break;
    }
    console.log(`audit: ${total.confirmed} confirmed, ${total.corrected} corrected, ${total.skipped} skipped`);
  })().catch(e => { console.error(e); process.exit(1); });
}
