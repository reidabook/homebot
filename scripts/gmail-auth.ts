// One-time Google sign-in for the family account (read Gmail, manage Tasks): `npm run gmail-auth <path to OAuth client JSON>`.
// Opens a browser consent page, then saves a refresh token to GMAIL_OAUTH_FILE.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { GMAIL_SCOPE, TASKS_SCOPE, type GoogleOAuth } from '../src/google/oauth.ts';

const clientFile = process.argv[2];
const out = process.env.GMAIL_OAUTH_FILE || 'state/gmail-oauth.json';
if (!clientFile) throw new Error('Usage: npm run gmail-auth <path to OAuth client JSON downloaded from Google Cloud>');

const raw = JSON.parse(readFileSync(clientFile, 'utf8'));
const { client_id, client_secret } = raw.installed ?? raw.web ?? raw;
if (!client_id || !client_secret) throw new Error('That file has no client_id/client_secret. Download the "Desktop app" OAuth client JSON.');

const state = randomBytes(16).toString('hex');

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const code = url.searchParams.get('code');
  if (!code || url.searchParams.get('state') !== state) {
    res.writeHead(400).end(url.searchParams.get('error') ?? 'Missing code');
    return;
  }
  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      body: new URLSearchParams({ code, client_id, client_secret, redirect_uri: redirectUri(), grant_type: 'authorization_code' }),
    });
    const json = (await tokenRes.json()) as { refresh_token?: string; scope?: string; error_description?: string };
    if (!json.refresh_token) throw new Error(json.error_description ?? 'Google returned no refresh token');

    const oauth: GoogleOAuth = { client_id, client_secret, refresh_token: json.refresh_token, scope: json.scope };
    for (const s of [GMAIL_SCOPE, TASKS_SCOPE]) if (!json.scope?.split(' ').includes(s)) console.warn(`Not granted: ${s} (tick every box on the consent page and run this again)`);
    writeFileSync(out, JSON.stringify(oauth, null, 2), { mode: 0o600 });
    chmodSync(out, 0o600);
    // The bot runs as homebot; let it read the file when someone else created it.
    try {
      execFileSync('chmod', ['+a', 'user:homebot allow read', out]);
    } catch {}
    res.end('Signed in. You can close this tab.');
    console.log(`Saved ${out}`);
  } catch (e) {
    res.writeHead(500).end(String(e));
    console.error(e);
    process.exitCode = 1;
  }
  server.close();
});

function redirectUri() {
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('Server not listening');
  return `http://127.0.0.1:${addr.port}`;
}

server.listen(0, '127.0.0.1', () => {
  const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  auth.search = new URLSearchParams({
    client_id,
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: `${GMAIL_SCOPE} ${TASKS_SCOPE}`,
    access_type: 'offline',
    prompt: 'consent',
    state,
  }).toString();
  console.log(`Sign in as the mailbox the newsletter arrives in:\n\n${auth}\n`);
  try {
    execFileSync('open', [auth.toString()]);
  } catch {}
});
