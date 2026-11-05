import { TASKS_SCOPE, type OAuthSession } from './oauth.ts';

const API = 'https://tasks.googleapis.com/tasks/v1/lists/@default/tasks';

export interface Task {
  id: string;
  title: string;
  /** "YYYY-MM-DD". Google's API stores the day only, so a time of day goes in the title. */
  due?: string;
  notes?: string;
}

const fromWire = (t: any): Task => ({
  id: t.id,
  title: t.title ?? '',
  ...(t.due ? { due: t.due.slice(0, 10) } : {}),
  ...(t.notes ? { notes: t.notes } : {}),
});

const toWire = (t: Partial<Omit<Task, 'id'>>) => ({
  ...(t.title !== undefined ? { title: t.title } : {}),
  ...(t.due !== undefined ? { due: `${t.due}T00:00:00.000Z` } : {}),
  ...(t.notes !== undefined ? { notes: t.notes } : {}),
});

/** Google Tasks on the family account's default list ("My Tasks"); they show in its Google Calendar. */
export class TasksClient {
  private session: OAuthSession;

  constructor(session: OAuthSession) {
    this.session = session;
  }

  private async request<T = any>(method: string, path = '', opts: { query?: Record<string, string>; body?: unknown } = {}): Promise<T> {
    const url = new URL(`${API}${path}`);
    for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${await this.session.accessToken()}`,
        ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`Google Tasks ${method} -> HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  /** Open (not completed) tasks, soonest due first; undated ones last. */
  async open(): Promise<Task[]> {
    const res = await this.request<{ items?: any[] }>('GET', '', { query: { showCompleted: 'false', maxResults: '100' } });
    return (res.items ?? []).map(fromWire).sort((a, b) => (a.due ?? '9').localeCompare(b.due ?? '9'));
  }

  async add(t: Omit<Task, 'id'>): Promise<string> {
    return (await this.request<{ id: string }>('POST', '', { body: toWire(t) })).id;
  }

  async update(id: string, patch: Partial<Omit<Task, 'id'>>) {
    await this.request('PATCH', `/${encodeURIComponent(id)}`, { body: toWire(patch) });
  }

  async complete(id: string) {
    await this.request('PATCH', `/${encodeURIComponent(id)}`, { body: { status: 'completed' } });
  }

  async remove(id: string) {
    await this.request('DELETE', `/${encodeURIComponent(id)}`);
  }
}

/** Null until the sign-in includes task access. */
export const tasksFrom = (session: OAuthSession | null) => (session?.has(TASKS_SCOPE) ? new TasksClient(session) : null);
