// Posts short notes to a Discord channel through an incoming webhook (Server settings > Integrations > Webhooks).
// Set the secret DISCORD_WEBHOOK to the webhook URL. Without it everything here does nothing.
export async function notify(env: {DISCORD_WEBHOOK?: string}, content: string, fetchImpl: typeof fetch = fetch) {
  if (!env.DISCORD_WEBHOOK) return false;
  const r = await fetchImpl(env.DISCORD_WEBHOOK, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({username: 'Oakle', content: content.slice(0, 1900), allowed_mentions: {parse: []}}), // names are player input: never ping anyone
  });
  if (!r.ok) console.error('discord post failed', r.status);
  return r.ok;
}
