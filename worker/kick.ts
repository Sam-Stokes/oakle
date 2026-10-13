// Starts the audit job on GitHub right after a win is accepted, so it does not depend on GitHub's timer (which can be
// late or skip runs). Needs a fine-grained token with "Actions: read and write" on this one repository, set as the
// Worker secret GITHUB_TOKEN, and GITHUB_REPO ("owner/name") as a variable. Without them it does nothing and the
// scheduled run in .github/workflows/audit.yml is the only trigger.
const MIN_GAP_MS = 60_000; // one start a minute per Worker instance is plenty: the job drains everything pending
let last = 0;

export async function kickAudit(env: {GITHUB_TOKEN?: string; GITHUB_REPO?: string}, now = Date.now(), fetchImpl: typeof fetch = fetch) {
  if (!env.GITHUB_TOKEN || !env.GITHUB_REPO || now - last < MIN_GAP_MS) return false;
  last = now;
  const r = await fetchImpl(`https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/audit.yml/dispatches`, {
    method: 'POST',
    headers: {authorization: `Bearer ${env.GITHUB_TOKEN}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'oakle-worker'},
    body: JSON.stringify({ref: 'main'}),
  });
  if (!r.ok) console.error('audit dispatch failed', r.status);
  return r.ok;
}

/** For tests: forget the last start. */
export const resetKick = () => { last = 0; };
