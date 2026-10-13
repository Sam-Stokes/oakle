// Pure helpers for the leaderboard, kept free of D1 so they can be unit-tested.
export type Win = {player_id: string; day: number};

/** Win streaks per player from same-day wins only. A streak is "current" if it reaches today or yesterday. */
export function streaks(wins: Win[], today: number) {
  const byPlayer = new Map<string, number[]>();
  for (const w of wins) {
    const list = byPlayer.get(w.player_id) ?? [];
    list.push(w.day);
    byPlayer.set(w.player_id, list);
  }
  const out = new Map<string, {current: number; best: number}>();
  for (const [id, days] of byPlayer) {
    days.sort((a, b) => a - b);
    let best = 0, run = 0, prev = -2;
    for (const d of days) {
      run = d === prev + 1 ? run + 1 : 1;
      prev = d;
      best = Math.max(best, run);
    }
    out.set(id, {best, current: prev >= today - 1 ? run : 0});
  }
  return out;
}

// Pairing codes: 6 characters, no look-alikes (no 0/O, 1/I/L). ponytail: a byte % 31 is very slightly biased, which is
// fine for a 10-minute, one-use code.
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const makeCode = (bytes: Uint8Array) => [...bytes].map(b => CODE_CHARS[b % CODE_CHARS.length]).join('');
export const cleanCode = (s: unknown) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/** Player names: 1-7 of A-Z, 0-9, space, dash (what the game's name table can show), uppercase. */
export const cleanName = (n: unknown) => String(n ?? '').toUpperCase().replace(/[^A-Z0-9 -]/g, '').replace(/\s+/g, ' ').trim().slice(0, 7);

// Moderation for the public leaderboard. Names are already limited to A-Z 0-9 space dash, so this normalises the usual
// disguises (digits for letters, spacing, repeated letters) and checks two lists. ponytail: a short list, not a
// dictionary; add words when one slips through. Words that live inside innocent names (ASS in CLASSIC, DICK in
// DICKENS) are only blocked when they ARE the name or a whole word of it.
const ANYWHERE = 'FUCK SHIT CUNT BITCH NIGGER NIGGA FAGGOT WHORE TWAT PUSSY BLOWJOB WANKER RETARD SPERM JIZZ PEDO CHINK COCKSUCK MOTHERFU DICKHEAD ASSHOLE BASTARD SLUT KYKE DYKE TRANNY BOLLOCK HITLER'.split(' ');
const WHOLE = new Set('ASS ARSE DICK COCK CUM TIT TITS ANAL RAPE RAPIST SEX NAZI KKK FAG HOE PORN DILDO PENIS VAGINA BOOB BOOBS CLIT ANUS PISS CRAP DAMN'.split(' '));
const LEET: Record<string, string> = {0: 'O', 1: 'I', 3: 'E', 4: 'A', 5: 'S', 7: 'T', 8: 'B'};
const squash = (s: string) => s.replace(/(.)\1+/g, '$1');
export function isBlocked(name: string) {
  const norm = (s: string) => s.toUpperCase().replace(/[0-9]/g, d => LEET[d] ?? d);
  const words = name.toUpperCase().split(/[ -]+/).filter(Boolean);
  for (const variant of [norm(name), norm(name).replace(/I/g, 'L')]) {
    const joined = variant.replace(/[^A-Z]/g, '');
    for (const j of [joined, squash(joined)]) if (ANYWHERE.some(w => j.includes(w))) return true;
  }
  const toks = [...words, words.join('')];
  return toks.some(t => [t, norm(t), squash(norm(t))].some(x => WHOLE.has(x)));
}
