import { existsSync, readFileSync } from 'node:fs';

const TOKEN_URI = 'https://oauth2.googleapis.com/token';
const REFRESH_SKEW_MS = 60_000;

export const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
export const TASKS_SCOPE = 'https://www.googleapis.com/auth/tasks';

/** Written by `npm run gmail-auth`: the family Google account's sign-in. */
export interface GoogleOAuth {
  client_id: string;
  client_secret: string;
  refresh_token: string;
  /** Space-separated scopes that were granted. Missing in files from before tasks were added (Gmail only). */
  scope?: string;
}

export class OAuthSession {
  private token: { value: string; expiresAt: number } | null = null;
  private oauth: GoogleOAuth;

  constructor(oauth: GoogleOAuth) {
    this.oauth = oauth;
  }

  has(scope: string) {
    return (this.oauth.scope ?? GMAIL_SCOPE).split(' ').includes(scope);
  }

  /** Trade the long-lived refresh token for a one-hour access token. */
  async accessToken(): Promise<string> {
    if (this.token && Date.now() < this.token.expiresAt - REFRESH_SKEW_MS) return this.token.value;
    const { client_id, client_secret, refresh_token } = this.oauth;
    const res = await fetch(TOKEN_URI, {
      method: 'POST',
      body: new URLSearchParams({ client_id, client_secret, refresh_token, grant_type: 'refresh_token' }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`Google token -> HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const json = (await res.json()) as { access_token: string; expires_in: number };
    this.token = { value: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 };
    return this.token.value;
  }
}

/** Null until `npm run gmail-auth` has created the file. */
export function oauthFromEnv() {
  const { GMAIL_OAUTH_FILE } = process.env;
  if (!GMAIL_OAUTH_FILE || !existsSync(GMAIL_OAUTH_FILE)) return null;
  return new OAuthSession(JSON.parse(readFileSync(GMAIL_OAUTH_FILE, 'utf8')) as GoogleOAuth);
}
