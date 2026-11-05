import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { CalendarClient } from '../google/calendar.ts';
import type { Email } from '../google/gmail.ts';
import { memoryText } from '../tools/memory.ts';
import { fetchLink, newsletterLinks } from './sources.ts';

const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-5';
const LOOKAHEAD_DAYS = 120;

export interface DigestItem {
  title: string;
  /** "YYYY-MM-DD" for all-day, or "YYYY-MM-DDTHH:MM". */
  start: string;
  end?: string;
  notes?: string;
}

export interface Digest {
  /** The text for the group chat. */
  message: string;
  /** Dated items the message asks about: not on the calendar and not asked about before. */
  items: DigestItem[];
}

/** Who the child is: name, class, school, teacher, and which programs they are (not) in. */
const CHILD = process.env.NEWSLETTER_CONTEXT || "The child is in one class at the school; the class newsletter comes from the child's teacher.";

const SYSTEM = `You read a school's weekly newsletters for one family and pick out what matters to them.

The child: ${CHILD}

What is relevant:
- Anything from the child's own class newsletter (the PDF from the teacher).
- School-wide items that affect the child's class or program, or the parents: closures, early releases, picture days, family events, things to bring or wear, forms, deadlines, payments, volunteer asks.
- Skip anything for other classes or programs, staff news, and general filler.
- If it is unclear whether a closure or event covers the child's program, include it and say so in its notes.

Output:
- summary: one or two short plain-text sentences, 40 words at most, on what the parents need to know or do that the item list does not already say (what to bring or wear, sign-ups, what the class is doing). Do not repeat the listed dates. No greeting, no markdown.
- items: the relevant dated items from today onward that a parent would want on the calendar: closures, early closes, events to attend, deadlines. Leave out week-long themes and background periods unless the parents must do something on a set day, and leave out open-ended volunteer asks (mention those in the summary if they matter). List each item once even if both newsletters mention it.
- Each item: a plain title of at most 6 words (no child name, no parentheses), start, optional end, and notes only when the parents need them to act (what to bring, or doubt about whether it covers the child's program), at most 8 words. Use "YYYY-MM-DD" for all-day items (end = last day, inclusive, only for multi-day) and "YYYY-MM-DDTHH:MM" (24h local) when a time is given. Work out the year from today's date.
- For each item set status: "on_calendar" if the family calendar already has an event for the same thing on that day (titles may be worded differently), "asked_before" if it matches an entry in the already-asked list, otherwise "new".
- unread: name any source you were given that was missing or unreadable, else an empty string.`;

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'items', 'unread'],
  properties: {
    summary: { type: 'string' },
    unread: { type: 'string' },
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'start', 'status'],
        properties: {
          title: { type: 'string' },
          start: { type: 'string' },
          end: { type: 'string' },
          notes: { type: 'string' },
          status: { type: 'string', enum: ['new', 'on_calendar', 'asked_before'] },
        },
      },
    },
  },
};

const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function clock(hhmm: string) {
  const [h, m] = hhmm.split(':').map(Number);
  return `${h % 12 || 12}${m ? `:${String(m).padStart(2, '0')}` : ''}${h < 12 ? 'am' : 'pm'}`;
}

function dayLabel(date: string) {
  const d = new Date(`${date}T12:00`);
  return `${d.toLocaleDateString('en-US', { weekday: 'short' })} ${d.getMonth() + 1}/${d.getDate()}`;
}

/** "Thu 10/15", "Mon 10/26 6pm-7pm", "Mon 10/26 - Fri 10/30" */
export function fmtWhen(start: string, end?: string) {
  const [d1, t1] = start.split('T');
  const [d2, t2] = (end ?? '').split('T');
  if (!t1) return d2 && d2 !== d1 ? `${dayLabel(d1)} - ${dayLabel(d2)}` : dayLabel(d1);
  if (d2 && d2 !== d1) return `${dayLabel(d1)} ${clock(t1)} - ${dayLabel(d2)}${t2 ? ` ${clock(t2)}` : ''}`;
  return `${dayLabel(d1)} ${clock(t1)}${t2 ? `-${clock(t2)}` : ''}`;
}

export const fmtItem = (i: DigestItem) => `${fmtWhen(i.start, i.end)}: ${i.title}${i.notes ? ` (${i.notes})` : ''}`;

export async function buildDigest(opts: {
  email: Email;
  calendar: CalendarClient;
  asked: { title: string; start: string }[];
  now?: Date;
}): Promise<Digest> {
  const { email, calendar, asked, now = new Date() } = opts;
  const linked = await Promise.all(newsletterLinks(email).map(fetchLink));
  const pdfs = [...email.pdfs, ...linked.flatMap((l) => (l.pdf ? [l.pdf] : []))];
  const horizon = new Date(now.getTime() + LOOKAHEAD_DAYS * 24 * 60 * 60 * 1000);
  const events = await calendar.events(ymd(now), ymd(horizon));

  const text = [
    `Today: ${now.toLocaleDateString('en-US', { dateStyle: 'full' })}`,
    `What the family has told their assistant (where this differs from the description of the child above, this is newer and wins):\n${memoryText()}`,
    `Teacher's email, received ${email.receivedAt.toLocaleDateString('en-US', { dateStyle: 'full' })}, subject "${email.subject}":\n${email.text}`,
    pdfs.length ? `Attached PDF(s): ${pdfs.map((p) => p.filename).join(', ')}` : 'No PDF was attached to the email.',
    ...linked.map((l) =>
      l.text
        ? `School-wide newsletter "${l.label}" (${l.url}), text extracted from the web page (layout words mixed in, ignore them):\n${l.text}`
        : l.error
          ? `School-wide newsletter "${l.label}" (${l.url}) could not be read: ${l.error}`
          : `School-wide newsletter "${l.label}" is one of the attached PDFs.`,
    ),
    linked.length ? '' : 'The email had no link to the school-wide newsletter.',
    `Family calendar, next ${LOOKAHEAD_DAYS} days:\n${events.map((e) => `${e.start}${e.end !== e.start ? ` to ${e.end}` : ''} ${e.title}`).join('\n') || '(empty)'}`,
    `Already asked about in earlier weeks:\n${asked.map((a) => `${a.start} ${a.title}`).join('\n') || '(nothing)'}`,
  ]
    .filter(Boolean)
    .join('\n\n');

  const prompt: SDKUserMessage = {
    type: 'user',
    parent_tool_use_id: null,
    message: {
      role: 'user',
      content: [
        ...pdfs.map((p) => ({
          type: 'document' as const,
          title: p.filename,
          source: { type: 'base64' as const, media_type: 'application/pdf' as const, data: p.base64 },
        })),
        { type: 'text' as const, text },
      ],
    },
  };

  let out: any;
  for await (const msg of query({
    prompt: (async function* () {
      yield prompt;
    })(),
    options: {
      model: MODEL,
      systemPrompt: SYSTEM,
      thinking: { type: 'adaptive' },
      effort: 'medium',
      tools: [],
      outputFormat: { type: 'json_schema', schema: SCHEMA },
      strictMcpConfig: true,
      permissionMode: 'dontAsk',
      settingSources: [],
      persistSession: false,
      maxTurns: 5,
    },
  })) {
    if (msg.type !== 'result') continue;
    if (msg.subtype !== 'success') throw new Error(`Newsletter digest failed: ${msg.subtype}`);
    if (msg.is_error) throw new Error(`Newsletter digest failed: ${msg.result}`);
    out = msg.structured_output ?? JSON.parse(msg.result);
    break;
  }
  if (!out?.summary) throw new Error('Newsletter digest returned nothing');

  const valid = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/;
  const items: DigestItem[] = (out.items as (DigestItem & { status: string })[])
    .filter((i) => i.status === 'new' && valid.test(i.start) && (!i.end || valid.test(i.end)))
    .map(({ title, start, end, notes }) => ({ title, start, ...(end ? { end } : {}), ...(notes ? { notes } : {}) }))
    .sort((a, b) => a.start.localeCompare(b.start));

  const message = [
    `School newsletter: ${out.summary.trim()}`,
    out.unread ? `(Couldn't read: ${out.unread})` : '',
    items.length ? `Not on the calendar yet:\n${items.map((i) => `• ${fmtItem(i)}`).join('\n')}\nAdd these to the calendar?` : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  return { message, items };
}
