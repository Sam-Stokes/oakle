// Posts short notes to a Discord channel through an incoming webhook (Server settings > Integrations > Webhooks).
// Set the secret DISCORD_WEBHOOK to the webhook URL. Without it everything here does nothing.
// Never throws and never logs the URL: a Discord problem must not touch the request that triggered the post.
export async function notify(env: {DISCORD_WEBHOOK?: string}, content: string, fetchImpl: typeof fetch = fetch) {
  if (!env.DISCORD_WEBHOOK) return false;
  try {
    const r = await fetchImpl(env.DISCORD_WEBHOOK, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({username: 'Oakle', content: content.slice(0, 1900), allowed_mentions: {parse: []}}), // names are player input: never ping anyone
    });
    if (!r.ok) console.error('discord post failed', r.status); // 429 included: the note is dropped, not retried
    return r.ok;
  } catch {
    console.error('discord post failed (network)'); // the error text can carry the URL, so it is not logged
    return false;
  }
}

/** How a linked player who is in the server appears next to their name: a mention chip (it renders, and never pings). */
export const mention = (id: unknown, member: unknown) => (member && /^[0-9]{15,25}$/.test(String(id)) ? `<@${id}>` : '');
export const chip = (id: unknown, member: unknown) => { const m = mention(id, member); return m ? ` (${m})` : ''; };

/** A player's name for use INSIDE a code block: nothing in there renders, so no escaping, just no way to close the block or add lines. */
export const plain = (s: unknown) => String(s ?? '').replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ').replace(/`/g, "'").replace(/\s+/g, ' ').trim().slice(0, 32);

/** Player-controlled text made inert inside a message: no markdown, links, mentions or emoji codes. Stored names are untouched. */
const ZWSP = String.fromCharCode(0x200b);
export const md = (s: unknown) => String(s ?? '')
  .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ') // controls, zero-width and bidi marks, line separators
  .replace(/\s+/g, ' ').trim().slice(0, 32)
  .replace(/[\\*_~|>`\[\]()<>#]/g, '\\$&')
  .replace(/[@:./]/g, m => m + ZWSP); // a zero-width space breaks @mentions, :emoji:, and http://, www. and bare-domain links
