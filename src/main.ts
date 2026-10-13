import './style.css';
import {dayNumber, dayStart, TZ} from './day';
import {Emu, loadBinjgb, type Button} from './emu';
import {encodeLog, patchRom, readResult, romId, type Day as RomDay} from './rom';

type Mon = {species: string; moves: string[]};
type Day = RomDay & {team: Mon[]};
// log/romName: the replay evidence for a finished battle, kept until the server has accepted it. rejected: the server's
// replay did not reproduce the win, so it was recorded as a loss.
type Run = {started?: boolean; done?: boolean; won?: boolean; turns?: number; alive?: number; late?: boolean; synced?: boolean; forfeit?: boolean; log?: string; romName?: string; romId?: string; rejected?: boolean};
type Save = {id: string; name: string; runs: Record<number, Run>};

// ?test (optionally &day=N), localhost only: own save slot, no server, no one-try lock, for checking the ROM.
const Q = new URLSearchParams(location.search);
const LOCAL = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname); // never honoured on the deployed site
const TEST = LOCAL && Q.has('test');
const KEY = TEST ? 'oakle-test' : 'oakle';
const hex = () => [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, '0')).join('');
let save: Save;
try { save = JSON.parse(localStorage.getItem(KEY) || ''); save.runs ||= {}; } catch { save = {id: hex(), name: '', runs: {}}; }
const persist = () => { try { localStorage.setItem(KEY, JSON.stringify(save)); } catch { /* private mode: play without saving */ } };
let muted = false;
try { muted = localStorage.getItem('oakle-muted') === '1'; } catch { /* default: sound on */ }

const app = document.getElementById('app')!;
const $ = <T extends HTMLElement>(s: string) => document.querySelector<T>(s)!;
const esc = (s: unknown) => String(s).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const api = async (path: string, body?: unknown) => {
  if (TEST) return {status: 200, data: {today: [], allTime: [], streaks: [], bestStreaks: [], played: 0, won: 0, runs: []}};
  const r = await fetch('/api/' + path, {redirect: 'manual', ...(body ? {method: 'POST', body: JSON.stringify(body)} : {})});
  if (r.type === 'opaqueredirect') throw new Error('signin'); // Cloudflare Access wants a login first
  return {status: r.status, data: await r.json().catch(() => ({} as any))};
};

// ---- names: 1-7 of A-Z 0-9 space dash, unique on the leaderboard (checked by the server)
const cleanName = (s: string) => s.toUpperCase().replace(/[^A-Z0-9 -]/g, '').replace(/\s+/g, ' ').trim().slice(0, 7);
async function claimName(name: string): Promise<'ok' | 'taken' | 'invalid' | 'blocked' | 'busy'> {
  if (TEST) return 'ok';
  try {
    const r = await api('name', {id: save.id, name});
    if (r.status === 409) return 'taken';
    if (r.status === 400) return r.data.error === 'blocked' ? 'blocked' : 'invalid';
    if (r.status === 429) return 'busy';
    return 'ok';
  } catch { return 'ok'; } // offline: keep it locally, the server learns it when the battle starts
}
const NAME_ERR = {taken: 'THAT NAME IS TAKEN. TRY ANOTHER', invalid: 'USE LETTERS OR NUMBERS', blocked: 'PICK A DIFFERENT NAME', busy: 'TOO MANY TRIES. WAIT A MINUTE'};

// ---- save states (reload resumes the same battle instead of rerolling it)
const stateKey = (d: number) => `state-${TEST ? 't' : ''}${d}`;
const idb = () => new Promise<IDBDatabase>((res, rej) => { const r = indexedDB.open('oakle', 1); r.onupgradeneeded = () => r.result.createObjectStore('s'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
type Saved = {state: Uint8Array; log: number[]; name: string; rom: string}; // a save state with the input log and name that produced it
const idbGet = async (k: string) => { const db = await idb(); return new Promise<Saved | undefined>(res => { const q = db.transaction('s').objectStore('s').get(k); q.onsuccess = () => res(q.result); q.onerror = () => res(undefined); }); };
const idbDel = async (k: string) => { const db = await idb(); db.transaction('s', 'readwrite').objectStore('s').delete(k); };
const idbSet = async (k: string, v: Saved) => { const db = await idb(); db.transaction('s', 'readwrite').objectStore('s').put(v, k); };

// ---- preload: fetch the emulator, ROM and config at page load, and build the (paused) emulator as soon as the name
// is known, so pressing BATTLE only has to start it. The AudioContext is resumed by that click.
let assets: Promise<[ArrayBuffer, {config: number}]> | null = null;
const loadAssets = () => (assets ??= Promise.all([fetch('/rom/oakle.gbc').then(r => r.arrayBuffer()), fetch('/rom/oakle.json').then(r => r.json())]));
let prepared: Promise<Emu> | null = null;
// every emulator gets its own fresh module (loadBinjgb), never one that already ran a game
const prepare = (warm = true) => (prepared ??= Promise.all([loadBinjgb(), loadAssets()]).then(async ([mod, [rom, meta]]) => {
  const e = new Emu(mod, patchRom(new Uint8Array(rom), meta.config, today, save.name), $<HTMLCanvasElement>('#screen'));
  e.romName = save.name;
  e.romId = await romId(new Uint8Array(rom)).catch(() => ''); // needs a secure context; '' just means "not auditable"
  if (warm) await e.warm(); // a resumed game loads a save state instead, so it skips this
  return e;
}));
let timers: number[] = [];
const haltGame = () => { timers.forEach(clearInterval); timers = []; emu?.stop(); emu = null; };

// ---- state
const KEYS: Record<string, Button> = {ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', KeyX: 'a', KeyZ: 'b', Enter: 'start', ShiftRight: 'select', ShiftLeft: 'select', Backspace: 'select'};
let day = 0, current = 0, archive = false, today: Day, emu: Emu | null = null;

const dateOf = (n: number) => new Date(dayStart(n) + 12 * 3600e3).toLocaleDateString(undefined, {weekday: 'long', day: 'numeric', month: 'long', timeZone: TZ});

function buildShell() {
  const kbd = (k: string, what: string) => `<span><kbd>${k}</kbd>${what}</span>`;
  app.innerHTML = `
    <header class="top">
      <div class="title">
        <h1>OAKLE <span>#${day}</span>${archive ? '<em class="badge">ARCHIVE</em>' : ''}</h1>
        <p>${esc(dateOf(day))}. ${archive ? `<a href="${TEST ? '?test' : './'}">Back to today (#${current})</a>` : 'Beat Professor Oak. One try a day.'}</p>
      </div>
      <div class="tools">
        <button class="chip" id="mute" aria-pressed="${muted}" aria-label="Sound">${muted ? 'SOUND OFF' : 'SOUND ON'}</button>
        <button class="chip" id="fs" aria-label="Fullscreen" hidden>FULLSCREEN</button>
      </div>
    </header>
    <div class="grid">
      <main class="stage" id="console" data-on="false">
        <div class="screen-frame" id="frame">
          <canvas id="screen" width="160" height="144" aria-label="Game screen"></canvas>
          <div class="overlay" id="overlay"></div>
        </div>
        <div class="pad" aria-label="On-screen controls">
          <div class="dpad">
            <button class="key up" data-b="up" aria-label="Up">&#9650;</button><button class="key left" data-b="left" aria-label="Left">&#9664;</button>
            <span class="key mid" aria-hidden="true"></span>
            <button class="key right" data-b="right" aria-label="Right">&#9654;</button><button class="key down" data-b="down" aria-label="Down">&#9660;</button>
          </div>
          <div class="sys">
            <button class="key wide" data-b="select" aria-label="Select">SELECT</button>
            <button class="key wide" data-b="start" aria-label="Start">START</button>
          </div>
          <div class="ab"><button class="key b" data-b="b" aria-label="B">B</button><button class="key a" data-b="a" aria-label="A">A</button></div>
        </div>
        <div class="keys" aria-label="Keyboard controls">${kbd('ARROWS', 'move')}${kbd('X', 'A')}${kbd('Z', 'B')}${kbd('ENTER', 'start')}${kbd('SHIFT', 'select')}${kbd('M', 'mute')}</div>
      </main>
      <aside class="side left">
        <section class="card record" id="record"></section>
        <section class="card board" id="board"></section>
      </aside>
      <aside class="side right">
        <details class="card team" id="team"></details>
        <details class="card archive" id="archive"></details>
        <details class="card link" id="link"></details>
        <details class="card how" id="how"></details>
      </aside>
    </div>`;

  // buttons: pointer events so thumbs can hold several at once (touch-action: none in CSS)
  app.querySelectorAll<HTMLButtonElement>('[data-b]').forEach(btn => {
    const b = btn.dataset.b as Button;
    const set = (down: boolean) => { btn.classList.toggle('on', down); emu?.press(b, down); };
    btn.addEventListener('pointerdown', e => { e.preventDefault(); btn.setPointerCapture(e.pointerId); set(true); });
    for (const t of ['pointerup', 'pointercancel', 'lostpointercapture']) btn.addEventListener(t, () => set(false));
    btn.addEventListener('contextmenu', e => e.preventDefault());
  });
  const key = (down: boolean) => (e: KeyboardEvent) => {
    if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
    if (e.code === 'KeyM' && down && !e.repeat) { $('#mute').click(); return; }
    const b = KEYS[e.code];
    if (!b) return;
    const ov = document.querySelector<HTMLButtonElement>('#overlay .ov-btn');
    if (down && ov && !ov.disabled && e.code === 'Enter') { e.preventDefault(); ov.click(); return; }
    e.preventDefault();
    emu?.press(b, down);
    app.querySelector(`[data-b="${b}"]`)?.classList.toggle('on', down);
  };
  addEventListener('keydown', key(true)); addEventListener('keyup', key(false));

  const fs = $<HTMLButtonElement>('#fs');
  if (document.fullscreenEnabled) {
    fs.hidden = false;
    fs.addEventListener('click', () => { document.fullscreenElement ? document.exitFullscreen() : $('#frame').requestFullscreen?.(); });
  }
  $('#mute').addEventListener('click', () => {
    muted = !muted;
    try { localStorage.setItem('oakle-muted', muted ? '1' : '0'); } catch { /* not persisted */ }
    $('#mute').setAttribute('aria-pressed', String(muted));
    $('#mute').textContent = muted ? 'SOUND OFF' : 'SOUND ON';
    emu?.setMuted(muted);
  });
}

const overlay = (html: string | null) => { const o = $('#overlay'); o.hidden = html === null; o.innerHTML = html ?? ''; };

// ---- side cards
const renderTeam = () => {
  const el = $<HTMLDetailsElement>('#team');
  el.innerHTML = `<summary><span>${archive ? `Team for #${day}` : 'Your team today'}</span></summary>
    <div class="team-list">${today.team.map((m, i) => `<div class="mon"><b><i>${i + 1}</i>${esc(m.species)}</b><ul>${m.moves.map(x => `<li>${esc(x)}</li>`).join('')}</ul></div>`).join('')}</div>`;
};

function renderHow() {
  const d = $<HTMLDetailsElement>('#how');
  d.open = !save.name;
  d.innerHTML = `<summary>How it works</summary>
    <ul class="how-list">
      <li>Talk to Prof. Oak when you are ready. Before that you can reorder your team with START, then POKEMON.</li>
      <li>Everyone gets the same team and the same dice each day. One try per day, no rematches.</li>
      <li>Fewest turns wins the day. Missed a day? Play it from the archive: it still counts towards your wins.</li>
      <li>Some days are brutal on purpose.</li>
    </ul>`;
}

function stats() {
  const done = Object.values(save.runs).filter(r => r.done);
  const wins = done.filter(r => r.won);
  let streak = 0;
  for (let d = save.runs[current]?.done ? current : current - 1; save.runs[d]?.won && !save.runs[d].late; d--) streak++;
  return {played: done.length, wins: wins.length, pct: done.length ? Math.round(100 * wins.length / done.length) : 0, streak};
}

function renderRecord() {
  const run = save.runs[day], s = stats(), done = !!run?.done;
  const alive = run?.alive ?? 0;
  const share = `Oakle #${day}${run?.late ? ' (archive)' : ''} ${run?.won ? '✅' : '❌'} ${run?.turns} turns\n${'🟩'.repeat(alive)}${'🟥'.repeat(5 - alive)}`;
  $('#record').innerHTML = `<h2>Your record</h2>
    <p class="who" id="who">Playing as <b>${esc(save.name || '...')}</b> <button class="linkbtn" id="rename">Change name</button></p>
    <div class="stats"><div><b>${s.played}</b><span>played</span></div><div><b>${s.wins}</b><span>won</span></div><div><b>${s.pct}%</b><span>win rate</span></div><div><b>${s.streak}</b><span>streak</span></div></div>
    ${done && !run.forfeit ? `<p class="today">${run.won ? 'You beat Prof. Oak' : 'Prof. Oak won'} in ${run.turns} turns${run.alive != null ? `, ${run.alive} of 5 left` : ''}</p><button class="btn" id="share">Share result</button>` : ''}
    <p class="muted" id="next"></p>
    ${TEST && done ? '<button class="btn ghost" id="reset">Test mode: play again</button>' : ''}`;
  document.getElementById('reset')?.addEventListener('click', () => { delete save.runs[day]; persist(); idbDel(stateKey(day)).finally(() => location.reload()); });
  document.getElementById('share')?.addEventListener('click', async e => {
    const btn = e.target as HTMLButtonElement;
    try { if (navigator.share) await navigator.share({text: share}); else { await navigator.clipboard.writeText(share); btn.textContent = 'Copied'; } } catch { /* cancelled */ }
  });
  document.getElementById('rename')?.addEventListener('click', () => {
    $('#who').innerHTML = `<span class="nameform"><input id="newname" maxlength="7" value="${esc(save.name)}" autocomplete="off" autocapitalize="characters" spellcheck="false" aria-label="New name"><button class="btn" id="savename">Save</button></span><span class="muted" id="whoerr">1 to 7 letters or numbers. Must be unique.</span>`;
    const input = $<HTMLInputElement>('#newname'); input.focus(); input.select();
    const save_ = async () => {
      const name = cleanName(input.value);
      if (!name) { $('#whoerr').textContent = 'Use letters or numbers.'; return; }
      if (name === save.name) return renderRecord();
      const r = await claimName(name);
      if (r !== 'ok') { $('#whoerr').textContent = NAME_ERR[r].toLowerCase().replace(/^./, c => c.toUpperCase()); return; }
      save.name = name; persist();
      renderRecord(); loadBoard();
      if (document.getElementById('go') && !emu) { prepared = null; ready(readyResume); } // the game must be rebuilt with the new name
    };
    $('#savename').onclick = save_;
    input.addEventListener('keydown', e => { if (e.key === 'Enter') save_(); if (e.key === 'Escape') renderRecord(); });
  });
  updateCountdown();
}

const updateCountdown = () => {
  const t = Math.max(0, Math.floor((dayStart(current + 1) - Date.now()) / 1000)), p = (n: number) => String(n).padStart(2, '0');
  const el = document.getElementById('next');
  if (el) el.textContent = `New battle at midnight, ${TZ.split('/')[1].replace('_', ' ')} time. In ${p(Math.floor(t / 3600))}:${p(Math.floor(t / 60) % 60)}:${p(t % 60)}`;
  if (!t && !TEST) location.reload();
};

function renderArchive() {
  const cells = Array.from({length: current}, (_, i) => {
    const n = current - i, r = save.runs[n];
    const state = r?.done ? (r.won ? 'won' : 'lost') : 'open';
    const label = `#${n}: ${state === 'open' ? 'not played' : state}`;
    return `<a class="cell ${state} ${n === day ? 'now' : ''}" href="?${TEST ? 'test&' : ''}day=${n}" aria-label="${label}" title="${label}">${n}</a>`;
  }).join('');
  const el = $<HTMLDetailsElement>('#archive');
  if (!el.dataset.init) { el.open = matchMedia('(min-width: 1020px)').matches; el.dataset.init = '1'; }
  const played = Object.values(save.runs).filter(r => r.done).length;
  el.innerHTML = `<summary><span>Archive <small>${played} of ${current} played</small></span></summary>
    <div class="cells">${cells}</div>
    <p class="muted">One try per day, even for past days. Archive wins count towards your total.</p>`;
}

let boardTab: 'day' | 'all' | 'streak' = 'day';
let boardData: any = null;
async function loadBoard() {
  $('#board').innerHTML = `<h2>Leaderboard</h2><p class="muted">Loading...</p>`;
  try {
    const {data} = await api(`leaderboard?day=${day}&id=${save.id}`);
    boardData = data;
  } catch { boardData = null; }
  renderBoard();
}
function renderBoard() {
  const el = $('#board');
  if (!boardData) { el.innerHTML = `<h2>Leaderboard</h2><p class="muted">Leaderboard is offline.</p>`; return; }
  const d = boardData;
  const rows = (list: any[], cols: (r: any) => string[]) => list?.length
    ? `<table>${list.map((r, i) => `<tr class="${r.me ? 'me' : ''}"><td>${i + 1}</td><td>${esc(r.name)}</td>${cols(r).map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</table>`
    : '<p class="muted">Nobody yet.</p>';
  const tab = (id: typeof boardTab, label: string) => `<button class="tab" data-tab="${id}" aria-pressed="${boardTab === id}">${label}</button>`;
  let body = '', you = '';
  if (boardTab === 'day') {
    body = `<p class="muted">${d.won ?? 0} of ${d.played ?? 0} beat Oak. Fewest turns wins.</p>` +
      rows(d.today, r => [`${r.turns} turns`, r.late ? '<span class="late">late</span>' : '']);
    you = d.todayRank ? `You are #${d.todayRank} on this day` : '';
  } else if (boardTab === 'all') {
    body = `<p class="muted">Most wins, then fewest turns on average.</p>` + rows(d.allTime, r => [`${r.wins} / ${r.played}`, `${r.avgTurns ?? '-'} avg`]);
    you = d.allTimeRank ? `You are #${d.allTimeRank} all time` : '';
  } else {
    body = `<p class="muted">Same-day wins in a row. Archive plays do not count.</p>` + rows(d.streaks, r => [`${r.current} now`, `${r.best} best`]);
    you = d.you ? `Your streak: ${d.you.current} now, ${d.you.best} best` : '';
  }
  el.innerHTML = `<h2>Leaderboard</h2>
    <div class="tabs">${tab('day', archive ? 'This day' : 'Today')}${tab('all', 'All time')}${tab('streak', 'Streaks')}</div>
    ${body}${you ? `<p class="you">${you}</p>` : ''}`;
  el.querySelectorAll<HTMLButtonElement>('.tab').forEach(b => b.onclick = () => { boardTab = b.dataset.tab as typeof boardTab; renderBoard(); });
}

// ---- flow
async function main() {
  current = dayNumber();
  const asked = Number(Q.get('day'));
  day = Number.isInteger(asked) && asked >= 1 && (TEST || asked <= current) ? asked : current;
  archive = day < current;
  if (!TEST) document.addEventListener('visibilitychange', () => dayNumber() !== current && location.reload());
  if (!save.id) save.id = hex();
  if (!save.runs[day]?.done) loadAssets().catch(() => { assets = null; }); // fire and forget; ready() reports failures
  const chunk = await fetch(`/days/${Math.floor((day - 1) / 50)}.json`); // 50 days per file
  const data: {days: Day[]} = chunk.ok ? await chunk.json() : {days: []};
  buildShell();
  setInterval(updateCountdown, 1000);
  const d = data.days.find(x => x.day === day);
  if (!d) { overlay(`<p class="big">NO BATTLE</p><p class="dim">NOTHING IS SCHEDULED FOR THIS DAY</p>`); return; }
  today = d;
  renderHow(); renderTeam(); renderArchive();

  // merge the server's history (other devices, other browsers) into the local record
  try {
    const {data: me} = await api(`me?id=${save.id}`);
    for (const r of me.runs ?? []) save.runs[r.day] = {...save.runs[r.day], done: true, won: !!r.won, turns: r.turns, alive: r.alive ?? undefined, late: !!r.late, started: true, synced: true};
    persist();
  } catch (e) {
    if ((e as Error)?.message === 'signin') { overlay(`<p class="big">SIGN IN TO PLAY</p><p>THIS GAME IS PRIVATE</p><a class="ov-btn" href="/signin">SIGN IN</a>`); return; }
    /* offline: local record only */
  }
  renderRecord(); renderArchive(); renderLink(); loadBoard();

  if (!save.name) await askName();
  const run = save.runs[day];
  if (run?.done) { if (!run.synced) submit(run); return result(); }
  ready(!!run?.started);
}

// Adopt the identity from another device: the code is one-time and expires after ten minutes.
async function claim(raw: string) {
  try {
    const r = await api('claim', {code: raw});
    if (r.status !== 200 || !r.data.id) return false;
    save = {id: r.data.id, name: r.data.name, runs: {}};
    persist();
    location.href = location.pathname + (TEST ? '?test' : '');
    return true;
  } catch { return false; }
}

function askName() {
  return new Promise<void>(res => {
    const nameForm = () => {
      overlay(`<p class="big">OAKLE #${day}</p><p>PICK A NAME</p><input id="n" maxlength="7" autocomplete="off" autocapitalize="characters" spellcheck="false" aria-label="Your name"><p class="dim" id="nerr">1 TO 7 LETTERS OR NUMBERS.<br>SHOWN ON THE LEADERBOARD.</p><button class="ov-btn" id="ok">OK</button><button class="ov-link" id="have">I ALREADY PLAY ON ANOTHER DEVICE</button>`);
      $('#n').addEventListener('keydown', e => { if ((e as KeyboardEvent).key === 'Enter') $('#ok').click(); });
      $('#ok').onclick = async () => {
        const name = cleanName(($<HTMLInputElement>('#n')).value);
        const btn = $<HTMLButtonElement>('#ok');
        if (!name) { $('#nerr').textContent = NAME_ERR.invalid; return; }
        btn.disabled = true;
        const r = await claimName(name);
        btn.disabled = false;
        if (r !== 'ok') { $('#nerr').textContent = NAME_ERR[r]; return; }
        save.name = name; persist(); renderHow(); renderRecord(); loadBoard(); res();
      };
      $('#have').onclick = codeForm;
    };
    const codeForm = () => {
      overlay(`<p class="big">LINK DEVICE</p><p>ENTER THE CODE SHOWN ON YOUR OTHER DEVICE</p><input id="c" maxlength="7" autocomplete="off" autocapitalize="characters" spellcheck="false" aria-label="Code"><p class="dim" id="cerr">&nbsp;</p><button class="ov-btn" id="cok">LINK</button><button class="ov-link" id="back">BACK</button>`);
      const go = async () => { if (!(await claim(($<HTMLInputElement>('#c')).value))) $('#cerr').textContent = TEST ? 'NOT AVAILABLE IN TEST MODE' : 'INVALID OR EXPIRED CODE'; };
      $('#c').addEventListener('keydown', e => { if ((e as KeyboardEvent).key === 'Enter') go(); });
      $('#cok').onclick = go;
      $('#back').onclick = nameForm;
    };
    nameForm();
  });
}

// ---- "play on another device": get a code here, type it there. No account, no email.
let pairCode: {code: string; expiresAt: number} | null = null;
function renderLink(msg = '') {
  const el = $<HTMLDetailsElement>('#link');
  const live = pairCode && pairCode.expiresAt > Date.now();
  const wasOpen = el.open || !!live || !!msg;
  el.innerHTML = `<summary>Play on another device</summary>
    <p class="muted">Take your record to your phone or laptop. No sign-up.</p>
    ${live ? `<div class="code" aria-live="polite">${pairCode!.code}</div><p class="muted">Enter this on the other device within 10 minutes. It works once.</p>` : ''}
    ${msg ? `<p class="muted">${esc(msg)}</p>` : ''}
    <button class="btn" id="getcode">${live ? 'New code' : 'Get a code'}</button>
    <div class="codein"><input id="cardcode" maxlength="7" autocomplete="off" autocapitalize="characters" spellcheck="false" aria-label="Code from another device"><button class="btn ghost" id="usecode">Use</button></div>`;
  el.open = wasOpen;
  $('#getcode').onclick = async () => {
    try {
      const r = await api('pair', {id: save.id, name: save.name || 'RED'});
      if (r.status === 200 && r.data.code) pairCode = {code: r.data.code, expiresAt: r.data.expiresAt}; else return renderLink(TEST ? 'Not available in test mode.' : 'Could not get a code. Try again.');
    } catch { return renderLink('Offline. Try again.'); }
    renderLink();
  };
  $('#usecode').onclick = async () => {
    const ok = await claim(($<HTMLInputElement>('#cardcode')).value);
    if (!ok) renderLink(TEST ? 'Not available in test mode.' : 'That code is invalid or has expired.');
  };
}

let readyResume = false;
function ready(resume: boolean) {
  readyResume = resume;
  overlay(`<p class="big">OAKLE #${day}</p><p>${esc(save.name)}, PROF. OAK IS WAITING</p><button class="ov-btn" id="go" disabled>LOADING</button><p class="dim">${archive ? 'ARCHIVE: ONE TRY PER DAY' : 'ONE TRY A DAY'}</p>`);
  const label = resume ? 'RESUME' : 'BATTLE';
  prepare(!resume).then(() => { const b = document.getElementById('go') as HTMLButtonElement | null; if (b) { b.disabled = false; b.textContent = label; } },
    () => { prepared = null; assets = null; const b = document.getElementById('go') as HTMLButtonElement | null; if (b) { b.disabled = false; b.textContent = 'TRY AGAIN'; } });
  $('#go').onclick = () => {
    prepared?.then(e => e.unlock(), () => {}); // inside the click: lets the sound start
    ($<HTMLButtonElement>('#go')).disabled = true;
    if (resume) return void play(true);
    const run: Run = {late: archive};
    save.runs[day] = run; persist();
    play(false); // go immediately; the server is told in the background
    api('start', {id: save.id, name: save.name, day}).then(r => {
      if (r.status === 409) { // this day was already played from another device: stop and show that result
        haltGame();
        Object.assign(run, {done: true, won: !!r.data.won, turns: r.data.turns ?? 0, alive: r.data.alive ?? undefined, forfeit: true, synced: true, started: true});
        persist(); result();
      } else { run.started = r.status === 200; persist(); }
    }).catch(() => { /* offline: the start is retried when the result is sent */ });
  };
}

async function submit(run: Run) {
  try {
    if (!run.started) { const s = await api('start', {id: save.id, name: save.name, day}); run.started = s.status === 200 || s.status === 409; }
    const r = await api('finish', {id: save.id, day, won: !!run.won, turns: run.turns ?? 0, alive: run.alive ?? 0, name: run.romName, rom: run.romId, log: run.log});
    if (r.status === 200) { // the server's replayed result is the one that counts
      if (typeof r.data.won === 'boolean') Object.assign(run, {won: r.data.won, turns: r.data.turns, alive: r.data.alive});
      if (r.data.rejected) Object.assign(run, {rejected: true, forfeit: true});
    }
    if (r.status === 200 || r.status === 409) { run.synced = true; delete run.log; delete run.romName; delete run.romId; persist(); }
  } catch { /* retried next load */ }
}

async function play(resume: boolean) {
  emu = await prepare(!resume);
  emu.setMuted(muted);
  if (resume) {
    const saved = await idbGet(stateKey(day));
    if (saved?.rom && saved.rom !== emu.romId) {
      // The game was updated since this battle began, and a save state only works on the ROM it came from. Not the
      // player's fault, so the battle simply starts again on the new ROM.
      await emu.warm();
    } else {
      if (!saved?.log || !emu.loadState(saved.state, saved.log)) { // the saved game is gone: that counts as a loss, no rerolls
        const run = save.runs[day];
        Object.assign(run, {done: true, won: false, turns: 0, alive: 0, forfeit: true});
        persist(); haltGame(); await submit(run); return result();
      }
      emu.romName = saved.name; // the replay must use the name and ROM this game was started with
      emu.romId = saved.rom;
    }
  }
  emu.start();
  overlay(null);
  $('#console').dataset.on = 'true';

  const saveNow = () => emu && idbSet(stateKey(day), {state: emu.saveState(), log: emu.input.log.slice(), name: emu.romName, rom: emu.romId});
  const saver = window.setInterval(saveNow, 5000);
  setTimeout(saveNow, 1500);
  const poll = window.setInterval(async () => {
    if (!emu) return;
    const res = readResult(emu.extRam(), day);
    if (res) {
      const run = save.runs[day];
      Object.assign(run, {done: true, ...res, log: encodeLog(emu.input.log), romName: emu.romName, romId: emu.romId});
      haltGame();
      persist(); await submit(run);
      result();
    }
  }, 500);
  timers = [saver, poll];
}

function result() {
  const run = save.runs[day];
  $('#console').dataset.on = 'false';
  const lost = run.forfeit && run.alive === undefined; // someone else (another device) already played this day
  overlay(run.rejected
    ? `<p class="big">NOT<br>VERIFIED</p><p class="dim">THE REPLAY DID NOT MATCH.<br>RECORDED AS A LOSS</p>`
    : lost
    ? `<p class="big">ALREADY<br>BATTLED</p><p class="dim">ONE TRY PER DAY</p>`
    : `<p class="big">${run.won ? 'YOU WON!' : 'OAK WINS'}</p><p>${run.turns} TURN${run.turns === 1 ? '' : 'S'} TAKEN</p>${run.alive != null ? `<p>${run.alive} POKEMON LEFT</p>` : ''}<p class="dim">${archive ? 'PICK ANOTHER DAY IN THE ARCHIVE' : 'COME BACK TOMORROW'}</p>`);
  renderRecord(); renderArchive(); loadBoard();
}

main().catch(err => { app.innerHTML = `<p class="card">Could not start: ${esc(err.message)}</p>`; });
