import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';

const API = 'https://www.googleapis.com/calendar/v3';
const SCOPE = 'https://www.googleapis.com/auth/calendar.events';
const REFRESH_SKEW_MS = 60_000;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Events are read and written as wall-clock times in the Mac's timezone. */
export const TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

/**
 * Times are wall-clock strings: "YYYY-MM-DD" for all-day events, "YYYY-MM-DDTHH:MM" otherwise.
 * An all-day `end` is the last day of the event (inclusive), unlike Google's exclusive end date.
 */
export interface CalendarEvent {
  id: string;
  title: string;
  start: string;
  end: string;
  location?: string;
  notes?: string;
  /** Set on one occurrence of a repeating event: the id of the whole series. */
  seriesId?: string;
}

export interface EventInput {
  title: string;
  start: string;
  /** Defaults to one hour after start, or the same day for all-day events. */
  end?: string;
  location?: string;
  notes?: string;
  /** e.g. "FREQ=WEEKLY;BYDAY=TU" */
  rrule?: string;
}

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  token_uri: string;
}

const isDate = (s: string) => s.length === 10;

/** Shift a wall-clock string by `ms`, keeping its shape. */
function shift(s: string, ms: number) {
  const t = new Date(`${isDate(s) ? `${s}T00:00` : s}Z`).getTime();
  return new Date(t + ms).toISOString().slice(0, s.length);
}

/** `clear` nulls the unused fields, so a PATCH can switch an event between all-day and timed. */
function toWireTimes(start: string, end?: string, clear = false) {
  const allDay = isDate(start);
  if (end && isDate(end) !== allDay) throw new Error('start and end must both be dates or both be date-times');
  if (allDay) {
    const blank = clear ? { dateTime: null, timeZone: null } : {};
    return { start: { date: start, ...blank }, end: { date: shift(end ?? start, DAY_MS), ...blank } };
  }
  const blank = clear ? { date: null } : {};
  return {
    start: { dateTime: `${start}:00`, timeZone: TIME_ZONE, ...blank },
    end: { dateTime: `${end ?? shift(start, HOUR_MS)}:00`, timeZone: TIME_ZONE, ...blank },
  };
}

function fromWire(e: any): CalendarEvent {
  const allDay = !!e.start?.date;
  return {
    id: e.id,
    title: e.summary ?? '',
    start: allDay ? e.start.date : e.start.dateTime.slice(0, 16),
    end: allDay ? shift(e.end.date, -DAY_MS) : e.end.dateTime.slice(0, 16),
    ...(e.location ? { location: e.location } : {}),
    ...(e.description ? { notes: e.description } : {}),
    ...(e.recurringEventId ? { seriesId: e.recurringEventId } : {}),
  };
}

export class CalendarClient {
  private token: { value: string; expiresAt: number } | null = null;
  private key: ServiceAccountKey;
  private calendarId: string;

  constructor(opts: { key: ServiceAccountKey; calendarId: string }) {
    this.key = opts.key;
    this.calendarId = opts.calendarId;
  }

  get serviceAccountEmail() {
    return this.key.client_email;
  }

  /** Service-account flow: sign a JWT with the key and trade it for a one-hour access token. */
  private async accessToken(): Promise<string> {
    if (this.token && Date.now() < this.token.expiresAt - REFRESH_SKEW_MS) return this.token.value;
    const now = Math.floor(Date.now() / 1000);
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({
      iss: this.key.client_email,
      scope: SCOPE,
      aud: this.key.token_uri,
      iat: now,
      exp: now + 3600,
    })}`;
    const signature = createSign('RSA-SHA256').update(unsigned).sign(this.key.private_key, 'base64url');
    const res = await fetch(this.key.token_uri, {
      method: 'POST',
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: `${unsigned}.${signature}`,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`Google token -> HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const json = (await res.json()) as { access_token: string; expires_in: number };
    this.token = { value: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 };
    return this.token.value;
  }

  private async request<T = any>(method: string, path: string, opts: { query?: Record<string, string>; body?: unknown } = {}): Promise<T> {
    const url = new URL(`${API}/calendars/${encodeURIComponent(this.calendarId)}${path}`);
    for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${await this.accessToken()}`,
        ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      const text = (await res.text()).slice(0, 300);
      throw new Error(`Google Calendar ${method} ${path} -> HTTP ${res.status}: ${text}`);
    }
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  /** Events overlapping the days `from`..`to` ("YYYY-MM-DD", both inclusive), soonest first. */
  async events(from: string, to: string, query?: string): Promise<CalendarEvent[]> {
    const res = await this.request<{ items?: any[] }>('GET', '/events', {
      query: {
        timeMin: new Date(`${from}T00:00`).toISOString(),
        timeMax: new Date(`${shift(to, DAY_MS)}T00:00`).toISOString(),
        timeZone: TIME_ZONE,
        singleEvents: 'true',
        orderBy: 'startTime',
        maxResults: '250',
        ...(query ? { q: query } : {}),
      },
    });
    return (res.items ?? []).map(fromWire);
  }

  async addEvent(e: EventInput): Promise<string> {
    const res = await this.request<{ id: string }>('POST', '/events', {
      body: {
        summary: e.title,
        ...toWireTimes(e.start, e.end),
        ...(e.location ? { location: e.location } : {}),
        ...(e.notes ? { description: e.notes } : {}),
        ...(e.rrule ? { recurrence: [`RRULE:${e.rrule.replace(/^RRULE:/i, '')}`] } : {}),
      },
    });
    return res.id;
  }

  async updateEvent(id: string, patch: Partial<Omit<EventInput, 'rrule'>>) {
    await this.request('PATCH', `/events/${encodeURIComponent(id)}`, {
      body: {
        ...(patch.title !== undefined ? { summary: patch.title } : {}),
        ...(patch.start !== undefined ? toWireTimes(patch.start, patch.end, true) : {}),
        ...(patch.location !== undefined ? { location: patch.location } : {}),
        ...(patch.notes !== undefined ? { description: patch.notes } : {}),
      },
    });
  }

  async deleteEvent(id: string) {
    await this.request('DELETE', `/events/${encodeURIComponent(id)}`);
  }
}

export function calendarFromEnv() {
  const { GOOGLE_KEY_FILE, GOOGLE_CALENDAR_ID } = process.env;
  if (!GOOGLE_KEY_FILE || !GOOGLE_CALENDAR_ID) throw new Error('Set GOOGLE_KEY_FILE and GOOGLE_CALENDAR_ID in .env');
  const key = JSON.parse(readFileSync(GOOGLE_KEY_FILE, 'utf8')) as ServiceAccountKey;
  return new CalendarClient({ key, calendarId: GOOGLE_CALENDAR_ID });
}
