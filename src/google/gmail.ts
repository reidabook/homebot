import { GMAIL_SCOPE, type OAuthSession } from './oauth.ts';

const API = 'https://gmail.googleapis.com/gmail/v1/users/me';

export interface Email {
  id: string;
  from: string;
  subject: string;
  receivedAt: Date;
  /** Plain-text body (HTML stripped to text when there is no text part). */
  text: string;
  links: { label: string; url: string }[];
  /** File names of everything attached. */
  attachments: string[];
  /** PDF contents; only filled when asked for. */
  pdfs: { filename: string; base64: string }[];
}

export interface EmailSummary {
  id: string;
  from: string;
  subject: string;
  receivedAt: Date;
  snippet: string;
}

const decode = (data: string) => Buffer.from(data, 'base64url').toString('utf8');

const unescapeHtml = (s: string) =>
  s
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&');

export function htmlToText(html: string) {
  return unescapeHtml(
    html
      .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, '')
      .replace(/<(br|\/p|\/div|\/li|\/h\d|\/tr)[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

function linksFrom(html: string, text: string) {
  const links: Email['links'] = [];
  for (const m of html.matchAll(/<a\b[^>]*\bhref="(https?:[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    links.push({ label: htmlToText(m[2]), url: unescapeHtml(m[1]) });
  }
  if (!links.length) for (const m of text.matchAll(/https?:\/\/[^\s<>"]+/g)) links.push({ label: '', url: m[0] });
  return links;
}

const header = (msg: any, name: string) =>
  ((msg.payload?.headers ?? []) as { name: string; value: string }[]).find((h) => h.name.toLowerCase() === name)?.value ?? '';

export class GmailClient {
  private session: OAuthSession;

  constructor(session: OAuthSession) {
    this.session = session;
  }

  private async get<T = any>(path: string, query: Record<string, string> = {}): Promise<T> {
    const url = new URL(`${API}${path}`);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${await this.session.accessToken()}` },
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(`Gmail GET ${path} -> HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return (await res.json()) as T;
  }

  /** Newest first. `query` uses Gmail search syntax ("from:x newer_than:7d picture day"). */
  async search(query: string, max = 10): Promise<EmailSummary[]> {
    const list = await this.get<{ messages?: { id: string }[] }>('/messages', { q: query, maxResults: String(max) });
    return Promise.all(
      (list.messages ?? []).map(async ({ id }) => {
        const url = `/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`;
        const msg = await this.get(url);
        return { id, from: header(msg, 'from'), subject: header(msg, 'subject'), receivedAt: new Date(Number(msg.internalDate)), snippet: unescapeHtml(msg.snippet ?? '') };
      }),
    );
  }

  /** One message in full. PDF attachments are downloaded only with `pdfs: true`. */
  async message(id: string, opts: { pdfs?: boolean } = {}): Promise<Email> {
    const msg = await this.get(`/messages/${id}`, { format: 'full' });
    let plain = '';
    let html = '';
    const attachments: string[] = [];
    const pdfs: Email['pdfs'] = [];
    const walk = async (part: any) => {
      for (const p of part.parts ?? []) await walk(p);
      if (part.filename) attachments.push(part.filename);
      const isPdf = part.mimeType === 'application/pdf' || /\.pdf$/i.test(part.filename ?? '');
      if (isPdf && part.body?.attachmentId) {
        if (!opts.pdfs) return;
        const att = await this.get<{ data: string }>(`/messages/${id}/attachments/${part.body.attachmentId}`);
        pdfs.push({ filename: part.filename || 'attachment.pdf', base64: Buffer.from(att.data, 'base64url').toString('base64') });
      } else if (part.body?.data && !part.filename) {
        if (part.mimeType === 'text/plain') plain += decode(part.body.data);
        if (part.mimeType === 'text/html') html += decode(part.body.data);
      }
    };
    await walk(msg.payload);

    const text = plain.trim() || htmlToText(html);
    return {
      id,
      from: header(msg, 'from'),
      subject: header(msg, 'subject'),
      receivedAt: new Date(Number(msg.internalDate)),
      text,
      links: linksFrom(html, text),
      attachments,
      pdfs,
    };
  }

  /** Download one attachment of a message, by file name. */
  async attachment(id: string, filename: string): Promise<{ filename: string; mimeType: string; base64: string }> {
    const msg = await this.get(`/messages/${id}`, { format: 'full' });
    const parts: any[] = [];
    const walk = (part: any) => {
      if (part.filename && part.body?.attachmentId) parts.push(part);
      for (const p of part.parts ?? []) walk(p);
    };
    walk(msg.payload);
    const want = filename.trim().toLowerCase();
    const part = parts.find((p) => p.filename.toLowerCase() === want) ?? (parts.length === 1 ? parts[0] : undefined);
    if (!part) throw new Error(`No attachment named "${filename}". This email has: ${parts.map((p) => p.filename).join(', ') || 'none'}`);
    const att = await this.get<{ data: string }>(`/messages/${id}/attachments/${part.body.attachmentId}`);
    return { filename: part.filename, mimeType: part.mimeType, base64: Buffer.from(att.data, 'base64url').toString('base64') };
  }

  /** The newest message from `sender` with its PDFs, or null if there is none. */
  async latestFrom(sender: string): Promise<Email | null> {
    const [newest] = await this.search(`from:${sender}`, 1);
    return newest ? this.message(newest.id, { pdfs: true }) : null;
  }
}

export const gmailFrom = (session: OAuthSession | null) => (session?.has(GMAIL_SCOPE) ? new GmailClient(session) : null);
