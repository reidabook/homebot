import { login, refresh, AUTH_BASE, type Tokens } from './auth.ts';
import { readJson, writeJson } from '../state.ts';

const API = `${AUTH_BASE}/api`;
const API_VERSION = '2026-05-01';
const TOKEN_FILE = 'skylight-tokens.json';
const REFRESH_SKEW_MS = 60_000;

export interface SkylightList {
  id: string;
  label: string;
  kind: string;
}

export interface SkylightItem {
  id: string;
  label: string;
  status: 'pending' | 'completed';
  section: string | null;
}

type JsonApiResource = { id: string; type?: string; attributes?: Record<string, any> };

export class SkylightClient {
  private tokens: Tokens | null = readJson<Tokens | null>(TOKEN_FILE, null);
  private inflight: Promise<Tokens> | null = null;
  private frameId: string | undefined;
  private email: string;
  private password: string;

  constructor(opts: { email: string; password: string; frameId?: string }) {
    this.email = opts.email;
    this.password = opts.password;
    this.frameId = opts.frameId || undefined;
  }

  private save(t: Tokens) {
    this.tokens = t;
    writeJson(TOKEN_FILE, t, 0o600);
    return t;
  }

  /** Single-flight so concurrent calls never spend the same single-use refresh token twice. */
  private renew(): Promise<Tokens> {
    this.inflight ??= (async () => {
      try {
        if (this.tokens?.refreshToken) {
          try {
            return this.save(await refresh(this.tokens.refreshToken));
          } catch (err) {
            console.warn(`[skylight] refresh failed, logging in again: ${(err as Error).message}`);
          }
        }
        return this.save(await login(this.email, this.password));
      } finally {
        this.inflight = null;
      }
    })();
    return this.inflight;
  }

  private async accessToken(): Promise<string> {
    if (!this.tokens || Date.now() > this.tokens.expiresAt - REFRESH_SKEW_MS) await this.renew();
    return this.tokens!.accessToken;
  }

  async request<T = any>(method: string, path: string, body?: unknown, retried = false): Promise<T> {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${await this.accessToken()}`,
        'skylight-api-version': API_VERSION,
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status === 401 && !retried) {
      await this.renew();
      return this.request(method, path, body, true);
    }
    if (!res.ok) {
      const text = (await res.text()).slice(0, 300);
      throw new Error(`Skylight ${method} ${path} -> HTTP ${res.status}: ${text}`);
    }
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  async frames(): Promise<{ id: string; name: string }[]> {
    const res = await this.request<{ data: JsonApiResource[] }>('GET', '/frames');
    return (res.data ?? []).map((f) => ({ id: f.id, name: f.attributes?.name ?? '?' }));
  }

  async frame(): Promise<string> {
    if (this.frameId) return this.frameId;
    const frames = await this.frames();
    if (frames.length !== 1) {
      throw new Error(`Set SKYLIGHT_FRAME_ID; account has ${frames.length} frames: ${frames.map((f) => `${f.id} (${f.name})`).join(', ')}`);
    }
    return (this.frameId = frames[0].id);
  }

  async lists(): Promise<SkylightList[]> {
    const f = await this.frame();
    const res = await this.request<{ data: JsonApiResource[] }>('GET', `/frames/${f}/lists`);
    return (res.data ?? []).map((l) => ({ id: l.id, label: l.attributes?.label ?? '', kind: l.attributes?.kind ?? '' }));
  }

  async createList(label: string, kind: 'shopping' | 'to_do', color = '#42D792'): Promise<SkylightList> {
    const f = await this.frame();
    const res = await this.request<{ data: JsonApiResource }>('POST', `/frames/${f}/lists`, { label, color, kind });
    return { id: res.data.id, label: res.data.attributes?.label ?? label, kind: res.data.attributes?.kind ?? kind };
  }

  async items(listId: string): Promise<SkylightItem[]> {
    const f = await this.frame();
    const res = await this.request<{ data: JsonApiResource[] }>('GET', `/frames/${f}/lists/${listId}/list_items`);
    return (res.data ?? []).map((i) => ({
      id: i.id,
      label: i.attributes?.label ?? '',
      status: i.attributes?.status === 'completed' ? 'completed' : 'pending',
      section: i.attributes?.section ?? null,
    }));
  }

  async addItem(listId: string, label: string, section?: string): Promise<string> {
    const f = await this.frame();
    const res = await this.request<{ data: JsonApiResource }>('POST', `/frames/${f}/lists/${listId}/list_items`, {
      label,
      ...(section ? { section } : {}),
    });
    return res.data.id;
  }

  async updateItem(listId: string, itemId: string, patch: { label?: string; status?: 'pending' | 'completed' }) {
    const f = await this.frame();
    await this.request('PUT', `/frames/${f}/lists/${listId}/list_items/${itemId}`, patch);
  }

  async deleteItem(listId: string, itemId: string) {
    const f = await this.frame();
    await this.request('DELETE', `/frames/${f}/lists/${listId}/list_items/${itemId}`);
  }
}

export function clientFromEnv() {
  const { SKYLIGHT_EMAIL, SKYLIGHT_PASSWORD, SKYLIGHT_FRAME_ID } = process.env;
  if (!SKYLIGHT_EMAIL || !SKYLIGHT_PASSWORD) throw new Error('Set SKYLIGHT_EMAIL and SKYLIGHT_PASSWORD in .env');
  return new SkylightClient({ email: SKYLIGHT_EMAIL, password: SKYLIGHT_PASSWORD, frameId: SKYLIGHT_FRAME_ID });
}
