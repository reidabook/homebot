// Skylight OAuth2 login (auth code + PKCE) and refresh.
// Ported from chrischall/skylight-mcp src/auth-session-login.ts (MIT).
import { createHash, randomBytes, randomUUID } from 'node:crypto';

export const AUTH_BASE = 'https://app.ourskylight.com';

const CLIENT_ID = 'skylight-mobile';
const SCOPE = 'everything';
const REDIRECT_URI = 'https://ourskylight.com/welcome';
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';
const DEVICE_PARAMS = {
  skylight_api_client_device_platform: 'web',
  skylight_api_client_device_name: 'unknown',
  skylight_api_client_device_os_version: '10.15.7',
  skylight_api_client_device_app_version: 'unknown',
  skylight_api_client_device_hardware: 'Macintosh',
  source: 'js-mobile',
};

export interface Tokens {
  accessToken: string;
  refreshToken: string;
  /** Absolute epoch ms. */
  expiresAt: number;
}

class CookieJar {
  private cookies = new Map<string, string>();
  absorb(headers: Headers) {
    for (const raw of headers.getSetCookie()) {
      const [pair] = raw.split(';');
      const eq = pair.indexOf('=');
      if (eq < 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (value === '' || /max-age=0/i.test(raw)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }
  header() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }
}

function extractAuthenticityToken(html: string, status: number): string {
  const form =
    html.match(/<[^>]*\bname\s*=\s*["']authenticity_token["'][^>]*\bvalue\s*=\s*["']([^"']+)["']/i) ??
    html.match(/<[^>]*\bvalue\s*=\s*["']([^"']+)["'][^>]*\bname\s*=\s*["']authenticity_token["']/i);
  if (form) return form[1];
  const meta =
    html.match(/<meta[^>]*\bname\s*=\s*["']csrf-token["'][^>]*\bcontent\s*=\s*["']([^"']+)["']/i) ??
    html.match(/<meta[^>]*\bcontent\s*=\s*["']([^"']+)["'][^>]*\bname\s*=\s*["']csrf-token["']/i);
  if (meta) return meta[1];
  throw new Error(`Skylight login: no authenticity_token on /auth/session/new (HTTP ${status}); login page may have changed`);
}

function toTokens(status: number, json: any): Tokens {
  if (status < 200 || status >= 300 || !json?.access_token) {
    throw new Error(`Skylight token request failed (HTTP ${status}): ${String(json?.error ?? 'no access_token')}`);
  }
  const expiresIn = typeof json.expires_in === 'number' ? json.expires_in : 86400;
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? '',
    expiresAt: Date.now() + expiresIn * 1000,
  };
}

export async function login(email: string, password: string): Promise<Tokens> {
  const jar = new CookieJar();
  const headers = (extra: Record<string, string> = {}) => {
    const h: Record<string, string> = { 'User-Agent': USER_AGENT, ...extra };
    const c = jar.header();
    if (c) h.Cookie = c;
    return h;
  };

  // 1. CSRF token + session cookie
  const s1 = await fetch(`${AUTH_BASE}/auth/session/new`, { redirect: 'manual', headers: headers() });
  jar.absorb(s1.headers);
  const authenticityToken = extractAuthenticityToken(await s1.text(), s1.status);

  // 2. Submit credentials
  const s2 = await fetch(`${AUTH_BASE}/auth/session`, {
    method: 'POST',
    redirect: 'manual',
    headers: headers({
      'Content-Type': 'application/x-www-form-urlencoded',
      Origin: AUTH_BASE,
      Referer: `${AUTH_BASE}/auth/session/new`,
    }),
    body: new URLSearchParams({ authenticity_token: authenticityToken, email, password }).toString(),
  });
  jar.absorb(s2.headers);
  if ((s2.headers.get('location') ?? '').includes('/auth/session/new')) {
    throw new Error('Skylight login failed: bad SKYLIGHT_EMAIL/SKYLIGHT_PASSWORD, or rate-limited');
  }

  // 3. Authorize (PKCE required) -> code in redirect to REDIRECT_URI
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  let next: string | null =
    `${AUTH_BASE}/oauth/authorize?client_id=${CLIENT_ID}&response_type=code&scope=${SCOPE}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&code_challenge=${challenge}&code_challenge_method=S256`;
  let code: string | null = null;
  let lastStatus = 0;
  for (let hops = 0; next && hops < 4; hops++) {
    const s3: Response = await fetch(next, { redirect: 'manual', headers: headers() });
    jar.absorb(s3.headers);
    lastStatus = s3.status;
    const loc = s3.headers.get('location');
    if (s3.status < 300 || s3.status >= 400 || !loc) break;
    const dest = new URL(loc, next);
    const cb = new URL(REDIRECT_URI);
    if (dest.origin === cb.origin && dest.pathname === cb.pathname) {
      code = dest.searchParams.get('code');
      break;
    }
    if (dest.origin !== AUTH_BASE) throw new Error('Skylight login: unexpected authorize redirect');
    next = dest.href;
  }
  if (!code) throw new Error(`Skylight login: no authorization code (HTTP ${lastStatus}); OAuth flow may have changed`);

  // 4. Exchange code for tokens
  const s4 = await fetch(`${AUTH_BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      scope: SCOPE,
      skylight_api_client_device_fingerprint: randomUUID(),
      ...DEVICE_PARAMS,
      redirect_uri: REDIRECT_URI,
      code,
      code_verifier: verifier,
    }).toString(),
  });
  return toTokens(s4.status, await s4.json().catch(() => null));
}

/** Refresh tokens are single-use: always persist the returned pair. */
export async function refresh(refreshToken: string): Promise<Tokens> {
  const res = await fetch(`${AUTH_BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ grant_type: 'refresh_token', client_id: CLIENT_ID, refresh_token: refreshToken }).toString(),
  });
  const tokens = toTokens(res.status, await res.json().catch(() => null));
  if (!tokens.refreshToken) tokens.refreshToken = refreshToken;
  return tokens;
}
