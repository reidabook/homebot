import { htmlToText, type Email } from '../google/gmail.ts';

const MAX_CHARS = 60_000;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';

export interface LinkedNewsletter {
  label: string;
  url: string;
  text?: string;
  pdf?: { filename: string; base64: string };
  /** Set instead of text/pdf when the link could not be read. */
  error?: string;
}

/** The school-wide newsletter link, as opposed to the photo album or sign-up sheet. */
export function newsletterLinks(email: Email) {
  return email.links.filter((l) => /smore\.com/i.test(l.url) || /newsletter/i.test(l.label));
}

/**
 * Smore pages render in the browser, but the newsletter body ships inside an inline
 * script as an escaped JSON tree of { "t": tag, "c": [children] }. Pull out the text leaves.
 */
export function smoreText(html: string): string {
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
  const data = scripts.sort((a, b) => b.length - a.length)[0] ?? '';
  const json = data.replace(/\\\\/g, '\u0000').replace(/\\"/g, '"').replace(/\u0000/g, '\\');
  const out: string[] = [];
  for (const m of json.matchAll(/"((?:[^"\\]|\\.)*)"(\s*:)?/g)) {
    if (m[2]) continue; // an object key
    const before = json.slice(Math.max(0, m.index - 6), m.index);
    if (/"t":\s*$/.test(before)) continue; // a tag name
    let s: string;
    try {
      s = JSON.parse(`"${m[1]}"`);
    } catch {
      continue;
    }
    s = s.trim();
    if (s.length < 2 || !/[a-z]/i.test(s) || /^(https?:|data:|#|[\w-]+\.(js|css|png|jpe?g|svg|webp))/i.test(s)) continue;
    if (!/\s/.test(s) && s.length > 30) continue; // ids, tokens, hashes
    out.push(s);
  }
  return out.join('\n');
}

export async function fetchLink(link: { label: string; url: string }): Promise<LinkedNewsletter> {
  try {
    const res = await fetch(link.url, { headers: { 'User-Agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if ((res.headers.get('content-type') ?? '').includes('pdf')) {
      const base64 = Buffer.from(await res.arrayBuffer()).toString('base64');
      return { ...link, pdf: { filename: `${link.label || 'linked'}.pdf`, base64 } };
    }
    const html = await res.text();
    let text = /smore\.com/i.test(link.url) ? smoreText(html) : '';
    if (text.length < 500) text = htmlToText(html);
    if (text.length < 200) throw new Error('page had no readable text');
    return { ...link, text: text.slice(0, MAX_CHARS) };
  } catch (e) {
    return { ...link, error: e instanceof Error ? e.message : String(e) };
  }
}
