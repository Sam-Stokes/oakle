// Posts one note to Bluesky from a dedicated bot account. Secrets: BSKY_HANDLE (for example oakle.bsky.social) and
// BSKY_APP_PASSWORD (Settings > Privacy and security > App passwords, never the account password).
// Without them everything here does nothing. Never throws and never logs the credentials: a Bluesky problem must not
// touch the cron that triggered the post.
const XRPC = 'https://bsky.social/xrpc/';
const post_ = (body: unknown, jwt?: string) => ({method: 'POST', headers: {'content-type': 'application/json', ...(jwt && {authorization: `Bearer ${jwt}`})}, body: JSON.stringify(body)});

/** `link` is a host that ends up inside `text` (for example "oakle.day"): it becomes a clickable link. */
export async function post(env: {BSKY_HANDLE?: string; BSKY_APP_PASSWORD?: string}, text: string, link: string, fetchImpl: typeof fetch = fetch) {
  if (!env.BSKY_HANDLE || !env.BSKY_APP_PASSWORD) return false;
  try {
    const s = await fetchImpl(XRPC + 'com.atproto.server.createSession', post_({identifier: env.BSKY_HANDLE, password: env.BSKY_APP_PASSWORD}));
    if (!s.ok) { console.error('bluesky login failed', s.status); return false; }
    const {accessJwt, did} = (await s.json()) as {accessJwt: string; did: string};
    const at = text.lastIndexOf(link), bytes = (s: string) => new TextEncoder().encode(s).length; // facets count UTF-8 bytes
    const facets = at < 0 ? undefined : [{index: {byteStart: bytes(text.slice(0, at)), byteEnd: bytes(text.slice(0, at + link.length))}, features: [{$type: 'app.bsky.richtext.facet#link', uri: 'https://' + link}]}];
    const r = await fetchImpl(XRPC + 'com.atproto.repo.createRecord', post_({repo: did, collection: 'app.bsky.feed.post', record: {$type: 'app.bsky.feed.post', text, facets, langs: ['en'], createdAt: new Date().toISOString()}}, accessJwt));
    if (!r.ok) console.error('bluesky post failed', r.status); // not retried: a missed daily post is not worth a double post
    return r.ok;
  } catch {
    console.error('bluesky post failed (network)'); // the error text could carry the credentials, so it is not logged
    return false;
  }
}
