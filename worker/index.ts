// API only; static files (page, ROM, emulator) are served by the assets binding in wrangler.toml.
// ponytail: results are trusted from the client (private site, no server-side emulator replay).
import {dayNumber} from '../src/day';
import {decodeLog} from '../src/rom';
import {cleanCode, cleanName, isBlocked, makeCode, streaks} from './stats';
import {verify} from './verify';
import {kickAudit} from './kick';
import {notify} from './discord';

const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), {status, headers: {
  'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'strict-transport-security': 'max-age=31536000',
}});
const ID = /^[0-9a-f-]{16,64}$/;
const TOP = 20;
const PAIR_TTL_MS = 10 * 60_000;
const MAX_BODY = 2048;
const MAX_FINISH_BODY = 192 * 1024; // /api/finish carries the input log of a whole battle
const safeName = (n: unknown) => { const c = cleanName(n); return isBlocked(c) ? '' : c; };
const BOARD_TTL_MS = 10_000;

// Schema is applied by the Worker itself on first use (idempotent), so deploys never depend on a separate migration step.
const TABLES = [
  `CREATE TABLE IF NOT EXISTS players (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS runs (player_id TEXT NOT NULL, day INTEGER NOT NULL, started_at INTEGER NOT NULL, finished_at INTEGER,
     won INTEGER, turns INTEGER, lead INTEGER, log TEXT, late INTEGER NOT NULL DEFAULT 0, alive INTEGER, PRIMARY KEY (player_id, day))`,
  `CREATE INDEX IF NOT EXISTS runs_day ON runs (day, won, turns, finished_at)`,
  `CREATE TABLE IF NOT EXISTS pairs (code TEXT PRIMARY KEY, player_id TEXT NOT NULL, expires_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS throttle (k TEXT PRIMARY KEY, w INTEGER NOT NULL, n INTEGER NOT NULL)`,
];
const COLUMNS: [string, string][] = [['late', 'late INTEGER NOT NULL DEFAULT 0'], ['alive', 'alive INTEGER'], ['log', 'log TEXT'], ['verified', 'verified INTEGER']]; // added after launch
let schema: Promise<void> | null = null;
const ensureSchema = (db: any) => (schema ??= (async () => {
  await db.batch(TABLES.map(s => db.prepare(s)));
  const have = new Set((await db.prepare(`PRAGMA table_info(runs)`).all()).results.map((c: any) => c.name));
  for (const [name, ddl] of COLUMNS) if (!have.has(name)) await db.prepare(`ALTER TABLE runs ADD COLUMN ${ddl}`).run();
})().catch((e) => { schema = null; throw e; }));

// Fixed-window counter per key (per IP and action): true when the caller is over the limit for this minute.
async function limited(db: any, key: string, max: number) {
  const w = Math.floor(Date.now() / 60_000);
  const r = await db.prepare(`INSERT INTO throttle (k, w, n) VALUES (?, ?, 1)
    ON CONFLICT(k) DO UPDATE SET n = CASE WHEN w = excluded.w THEN n + 1 ELSE 1 END, w = excluded.w RETURNING n`).bind(key, w).first();
  return r.n > max;
}
const NAV_DEST = new Set(['document', 'iframe', 'frame', 'embed', 'object']);

// The leaderboard scans whole tables, so requests within a few seconds share one result per day (per Worker isolate).
const boards = new Map<number, {at: number; rows: any[]}>();
const boardRows = async (db: any, day: number) => {
  const hit = boards.get(day);
  if (hit && Date.now() - hit.at < BOARD_TTL_MS) return hit.rows;
  const rows = await Promise.all([
    db.prepare(`SELECT p.id, p.name, r.turns, r.alive, r.late FROM runs r JOIN players p ON p.id = r.player_id
                WHERE r.day = ? AND r.won = 1 ORDER BY r.turns, r.alive DESC, r.finished_at`).bind(day).all(),
    db.prepare(`SELECT COUNT(*) AS played, COALESCE(SUM(won), 0) AS won FROM runs WHERE day = ? AND finished_at IS NOT NULL`).bind(day).first(),
    db.prepare(`SELECT p.id, p.name, SUM(r.won) AS wins, COUNT(*) AS played,
                       ROUND(AVG(CASE WHEN r.won = 1 THEN r.turns END), 1) AS avgTurns
                FROM runs r JOIN players p ON p.id = r.player_id WHERE r.finished_at IS NOT NULL
                GROUP BY p.id ORDER BY wins DESC, avgTurns, played`).all(),
    db.prepare(`SELECT player_id, day FROM runs WHERE won = 1 AND late = 0`).all(),
    db.prepare(`SELECT id, name FROM players`).all(),
  ]);
  if (boards.size > 8) boards.clear(); // days are client-chosen: keep the map small
  boards.set(day, {at: Date.now(), rows});
  return rows;
};
declare const HTMLRewriter: any; // Workers runtime global (no @cloudflare/workers-types in this project)

type Env = {DB: any; ASSETS: {fetch: typeof fetch}; FLOOD?: {limit(o: {key: string}): Promise<{success: boolean}>}; VERIFY?: string; GITHUB_TOKEN?: string; GITHUB_REPO?: string; DISCORD_WEBHOOK?: string};
type Ctx = {waitUntil(p: Promise<unknown>): void};
const WHEN = (day: number, current: number) => day === current ? 'today' : `on Oakle #${day}`;

/** Discord note for a win: where it lands on that day's board. Called after the run is saved. */
async function announceWin(db: any, env: Env, id: string, day: number, v: {turns: number; alive: number}, current: number) {
  const r = await db.prepare(`SELECT (SELECT name FROM players WHERE id = ?) AS name, 1 + COUNT(*) AS rank FROM runs
    WHERE day = ? AND won = 1 AND player_id != ? AND (turns < ? OR (turns = ? AND alive >= ?))`).bind(id, day, id, v.turns, v.turns, v.alive).first();
  if (!r?.name) return;
  const name = isBlocked(r.name) ? '???' : r.name;
  await notify(env, r.rank === 1
    ? `🥇 **${name}** takes #1 ${WHEN(day, current)}: ${v.turns} turns, ${v.alive} left`
    : `**${name}** beat Oak in ${v.turns} turns, ${v.alive} left. #${r.rank} ${WHEN(day, current)}`);
}

export default {
  /** Hourly cron: the moment the day rolls over (Auckland), post the finished day's recap. */
  async scheduled(_event: unknown, env: Env, ctx: Ctx) {
    const now = Date.now(), n = dayNumber(new Date(now));
    if (!env.DISCORD_WEBHOOK || n < 2 || dayNumber(new Date(now - 3_600_000)) === n) return;
    ctx.waitUntil((async () => {
      await ensureSchema(env.DB);
      const [board, count] = await boardRows(env.DB, n - 1);
      const top = board.results.slice(0, 3).map((r: any, i: number) => `${i + 1}. ${isBlocked(r.name) ? '???' : r.name}, ${r.turns} turns`);
      await notify(env, `**Oakle #${n - 1} recap:** ${count.won} of ${count.played} beat Oak.${top.length ? '\n' + top.join('\n') : ''}`);
    })().catch((e) => console.error('recap error', e)));
  },

  async fetch(req: Request, env: Env, ctx: Ctx) {
    const url = new URL(req.url), db = env.DB;
    const ip = req.headers.get('CF-Connecting-IP') ?? 'local';

    // Landing page: social-card tags must carry absolute URLs, so make them absolute for whichever host served it.
    if (url.pathname === '/' || url.pathname === '/index.html') {
      const page = await env.ASSETS.fetch(req);
      return new HTMLRewriter().on('meta[property^="og:"], meta[name^="twitter:"]', {
        element(el: any) {
          const c = el.getAttribute('content');
          if (c && c.startsWith('/')) el.setAttribute('content', url.origin + c);
        },
      }).transform(page);
    }
    // A path that Cloudflare Access can protect on its own: visiting it forces the login, then lands on the game.
    if (url.pathname === '/signin') return Response.redirect(url.origin + '/', 302);

    // Edge-side flood guard (Workers Rate Limiting binding, no database write) for everything that can cost a query.
    const guarded = url.pathname.startsWith('/api/') || url.pathname.startsWith('/rom/');
    if (guarded && env.FLOOD && !(await env.FLOOD.limit({key: ip})).success) return json({error: 'slow down'}, 429);
    // Browsers always send Origin on cross-site POSTs: refuse them (localhost stays open for the vite dev proxy).
    const origin = req.headers.get('Origin');
    if (req.method === 'POST' && origin && origin !== url.origin && url.hostname !== 'localhost') return json({error: 'forbidden'}, 403);

    // The ROM is only fetched by the page itself. Typing the URL, a link or an <iframe> is refused.
    // ponytail: a speed bump, not access control (curl can set any header). Cloudflare Access is the real gate.
    if (url.pathname.startsWith('/rom/')) {
      if (NAV_DEST.has(req.headers.get('Sec-Fetch-Dest') ?? '')) return new Response('Not found', {status: 404});
      return env.ASSETS.fetch(req);
    }
    const current = dayNumber();
    try {
      await ensureSchema(db);
      // ---- one player's history (source of truth for the archive grid across devices)
      if (url.pathname === '/api/me') {
        const id = url.searchParams.get('id') ?? '';
        if (!ID.test(id)) return json({runs: []});
        const r = await db.prepare(`SELECT day, won, turns, alive, late FROM runs WHERE player_id = ? AND finished_at IS NOT NULL ORDER BY day`).bind(id).all();
        return json({runs: r.results});
      }

      // ---- leaderboards: the chosen day, all time, streaks, plus where the asking player stands
      if (url.pathname === '/api/leaderboard') {
        const day = Math.min(Math.max(Math.trunc(Number(url.searchParams.get('day'))) || current, 1), current);
        const id = url.searchParams.get('id') ?? '';
        const [board, count, all, wins, names] = await boardRows(db, day);
        const rank = (rows: any[]) => { const i = rows.findIndex(r => r.id === id); return i < 0 ? null : i + 1; };
        const names_ = new Map<string, string>(names.results.map((p: any) => [p.id, p.name]));
        const st = streaks(wins.results, current);
        const streakRows = [...st].map(([pid, s]) => ({id: pid, name: names_.get(pid) ?? '?', ...s}))
          .sort((a, b) => b.current - a.current || b.best - a.best);
        const bestRows = [...streakRows].sort((a, b) => b.best - a.best || b.current - a.current);
        // never expose player ids; names that predate (or slipped past) the filter are masked
        const pub = ({id: pid, ...rest}: any) => ({...rest, name: isBlocked(rest.name ?? '') ? '???' : rest.name, me: !!id && pid === id});
        return json({
          day, current,
          played: count.played, won: count.won,
          today: board.results.slice(0, TOP).map(pub), todayRank: rank(board.results),
          allTime: all.results.slice(0, TOP).map(pub), allTimeRank: rank(all.results), allTimeTotal: all.results.length,
          streaks: streakRows.slice(0, TOP).map(pub), streakRank: rank(streakRows), you: id ? st.get(id) ?? {current: 0, best: 0} : null,
          bestStreaks: bestRows.slice(0, TOP).map(pub),
        });
      }

      if (req.method !== 'POST') return json({error: 'not found'}, 404);
      const maxBody = url.pathname === '/api/finish' ? MAX_FINISH_BODY : MAX_BODY;
      if (Number(req.headers.get('content-length')) > maxBody) return json({error: 'too large'}, 413);
      const raw = await req.text();
      let body: any = null;
      try { if (raw.length <= maxBody) body = JSON.parse(raw); } catch { /* falls through to 400 */ }
      if (!body || typeof body !== 'object') return json({error: 'bad request'}, 400);
      const now = Date.now();

      // ---- no-sign-up device linking: a one-time code that hands this player's id to another device
      if (url.pathname === '/api/claim') {
        if (await limited(db, `claim:${ip}`, 10)) return json({error: 'slow down'}, 429);
        const code = cleanCode(body.code);
        await db.prepare(`DELETE FROM pairs WHERE expires_at < ?`).bind(now).run();
        await db.prepare(`DELETE FROM throttle WHERE w < ?`).bind(Math.floor(now / 60_000) - 10).run();
        const row = code.length === 6 ? await db.prepare(`SELECT p.id, p.name FROM pairs c JOIN players p ON p.id = c.player_id WHERE c.code = ?`).bind(code).first() : null;
        if (!row) return json({error: 'invalid or expired code'}, 404);
        await db.prepare(`DELETE FROM pairs WHERE code = ?`).bind(code).run(); // single use
        return json({id: row.id, name: row.name});
      }
      if (!ID.test(body.id)) return json({error: 'bad id'}, 400);

      // ---- names are unique (case-insensitive); the player picks one and may change it later
      if (url.pathname === '/api/name') {
        if (await limited(db, `name:${ip}`, 20)) return json({error: 'slow down'}, 429);
        const name = cleanName(body.name);
        if (!name) return json({error: 'invalid'}, 400);
        if (isBlocked(name)) return json({error: 'blocked'}, 400);
        const taken = await db.prepare(`SELECT 1 AS t FROM players WHERE name = ? COLLATE NOCASE AND id != ?`).bind(name, body.id).first();
        if (taken) return json({error: 'taken'}, 409);
        const known = await db.prepare(`SELECT 1 AS k FROM players WHERE id = ?`).bind(body.id).first();
        await db.prepare(`INSERT INTO players (id, name, created_at) VALUES (?, ?, ?)
                          ON CONFLICT(id) DO UPDATE SET name = excluded.name`).bind(body.id, name, now).run();
        boards.clear();
        if (!known) ctx.waitUntil(notify(env, `New trainer: **${name}**`).catch((e) => console.error('discord error', e)));
        return json({name});
      }

      if (url.pathname === '/api/pair') {
        if (await limited(db, `pair:${ip}`, 10)) return json({error: 'slow down'}, 429);
        await db.prepare(`INSERT OR IGNORE INTO players (id, name, created_at) VALUES (?, ?, ?)`).bind(body.id, safeName(body.name) || 'RED', now).run();
        await db.prepare(`DELETE FROM pairs WHERE player_id = ? OR expires_at < ?`).bind(body.id, now).run();
        for (let i = 0; i < 5; i++) { // retry on the (very unlikely) collision of an active code
          const code = makeCode(crypto.getRandomValues(new Uint8Array(6)));
          const ins = await db.prepare(`INSERT OR IGNORE INTO pairs (code, player_id, expires_at) VALUES (?, ?, ?)`).bind(code, body.id, now + PAIR_TTL_MS).run();
          if (ins.meta.changes) return json({code, expiresAt: now + PAIR_TTL_MS});
        }
        return json({error: 'try again'}, 503);
      }
      const day = body.day;
      if (!Number.isInteger(day) || day < 1 || day > current) return json({error: 'bad day', current}, 400);

      if (url.pathname === '/api/start') {
        await db.prepare(`INSERT OR IGNORE INTO players (id, name, created_at) VALUES (?, ?, ?)`).bind(body.id, safeName(body.name) || 'RED', now).run();
        const ins = await db.prepare(`INSERT OR IGNORE INTO runs (player_id, day, started_at, late) VALUES (?, ?, ?, ?)`)
          .bind(body.id, day, now, day < current ? 1 : 0).run();
        if (ins.meta.changes) return json({ok: true});
        const r = await db.prepare(`SELECT won, turns, alive, finished_at, verified FROM runs WHERE player_id = ? AND day = ?`).bind(body.id, day).first();
        return json({ok: false, finished: r.finished_at != null, void: r.verified === 3, won: r.won, turns: r.turns, alive: r.alive}, 409);
      }

      if (url.pathname === '/api/finish') {
        const r = await db.prepare(`SELECT started_at, finished_at, verified FROM runs WHERE player_id = ? AND day = ?`).bind(body.id, day).first();
        if (!r || r.finished_at != null) return json({error: 'no open run'}, 409);
        if (r.verified === 3) return json({void: true});
        const turns = Number(body.turns), alive = Number(body.alive ?? 0);
        if (typeof body.won !== 'boolean' || !Number.isInteger(turns) || turns < 0 || turns > 255 || !Number.isInteger(alive) || alive < 0 || alive > 5)
          return json({error: 'bad result'}, 400);

        // Only real results count. A run is a win, a loss, or VOID (still "unfinished", so it counts nowhere), and a win
        // is never turned into a loss. runs.verified: 0 win awaiting audit, 1 replayed, 2 could not be audited,
        // 3 void, null nothing to check. runs.log holds the evidence {name, rom, log} for 0 and 3.
        const voidRun = async (evidence: string | null = null) => {
          await db.prepare(`UPDATE runs SET verified = 3, log = ? WHERE player_id = ? AND day = ?`).bind(evidence, body.id, day).run();
          boards.clear();
          return json({void: true});
        };
        // one try, one day: a battle that was not finished before the day it was started on ended does not count
        if (dayNumber(new Date(r.started_at)) !== current) return voidRun();
        // not something the game can produce: no turns is no battle. Where no replay backs the result up, a win also needs
        // 5 knockouts and a survivor and a loss leaves none; with a replay the replay decides, so a genuine result is never
        // voided on a guess.
        const replayed = env.VERIFY === '1' || env.VERIFY === 'audit';
        if (turns === 0 || (!replayed && (body.won ? turns < 5 || alive < 1 : alive !== 0))) return voidRun();

        let verdict = {won: body.won as boolean, turns, alive}, evidence: string | null = null, verified: number | null = null;
        const mode = env.VERIFY;
        if (body.won && (mode === '1' || mode === 'audit')) {
          // A claimed win needs its input log, and what the replay says is what the game itself did.
          // VERIFY = "1" replays it here (needs Workers Paid); "audit" accepts it now and scripts/audit.ts replays it.
          const proof = JSON.stringify({name: cleanName(body.name), rom: String(body.rom ?? '').slice(0, 32), cfg: String(body.cfg ?? '').slice(0, 32), log: body.log});
          if (mode === '1') {
            if (await limited(db, `finish:${ip}`, 6)) return json({error: 'slow down'}, 429);
            const v = await verify(env.ASSETS, url.origin, day, cleanName(body.name), body.log, body.rom)
              .catch((e) => { console.error('replay error', e); return undefined; });
            if (v === undefined) return json({error: 'verification unavailable'}, 503); // our fault: leave the run open, the page retries
            if (v === null || (v !== 'stale' && v !== 'defer' && !v.won)) return voidRun(proof);
            if (v === 'defer') { verified = 0; evidence = proof; } // too long for the Worker: the audit job takes it
            else if (v !== 'stale') { verdict = v; verified = 1; }
          } else {
            if (!decodeLog(body.log)?.length) return voidRun(proof);
            verified = 0; evidence = proof;
          }
        }
        await db.prepare(`UPDATE runs SET finished_at = ?, won = ?, turns = ?, alive = ?, log = ?, verified = ? WHERE player_id = ? AND day = ?`)
          .bind(now, verdict.won ? 1 : 0, verdict.turns, verdict.alive, evidence, verified, body.id, day).run();
        boards.clear();
        if (verdict.won && env.DISCORD_WEBHOOK) ctx.waitUntil(announceWin(db, env, body.id, day, verdict, current).catch((e) => console.error('discord error', e)));
        if (verified === 0) ctx.waitUntil(kickAudit(env).catch((e) => console.error('audit dispatch error', e))); // audit this win now
        return json(verdict);
      }
      return json({error: 'not found'}, 404);
    } catch (e) {
      console.error('api error', req.method, url.pathname, e);
      return json({error: 'server error'}, 500);
    }
  },
};
