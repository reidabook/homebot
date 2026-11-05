import type { CalendarClient } from '../google/calendar.ts';
import type { GmailClient } from '../google/gmail.ts';
import { readJson, writeJson } from '../state.ts';
import { buildDigest, fmtItem, type DigestItem } from './digest.ts';

const STATE_FILE = 'newsletter.json';
const DAY_MS = 24 * 60 * 60 * 1000;
const RETRY_MS = 10 * 60 * 1000;
/** How long a "want these on the calendar?" question stays open for a reply. */
const PENDING_MS = 7 * DAY_MS;

interface NewsletterState {
  /** Date of the Friday whose digest is finished (sent, or given up on). */
  doneWeek?: string;
  /** Date of the Friday whose 5pm check found no email yet. */
  triedWeek?: string;
  /** Gmail id of the last email digested, so it is never digested twice. */
  lastMessageId?: string;
  /** The items in the latest question, until answered or stale. */
  pending?: { askedAt: number; items: DigestItem[] };
  /** Every item ever asked about and still in the future, so it is not asked about again. */
  asked: { title: string; start: string; askedAt: number }[];
}

const load = () => readJson<NewsletterState | null>(STATE_FILE, null);
const save = (s: NewsletterState) => writeJson(STATE_FILE, s);

const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** The most recent Friday 5pm at or before `now`, and the Saturday noon after it. */
export function slotFor(now: Date) {
  const friday = new Date(now);
  friday.setHours(17, 0, 0, 0);
  friday.setDate(friday.getDate() - ((friday.getDay() + 2) % 7));
  if (friday > now) friday.setDate(friday.getDate() - 7);
  const lastTry = new Date(friday);
  lastTry.setDate(lastTry.getDate() + 1);
  lastTry.setHours(12, 0, 0, 0);
  return { week: ymd(friday), lastTry };
}

export interface NewsletterDeps {
  gmail: GmailClient;
  calendar: CalendarClient;
  sender: string;
  send: (text: string) => Promise<void>;
  log: (...args: unknown[]) => void;
  dryRun: boolean;
}

/** Digest the newest email from the sender now, whatever the day. In dry-run nothing is sent or saved. */
export async function runNewsletter(deps: NewsletterDeps, opts: { force?: boolean } = {}): Promise<boolean> {
  const now = new Date();
  const state = load() ?? { asked: [] };
  const email = await deps.gmail.latestFrom(deps.sender);
  const isNew = email && email.id !== state.lastMessageId && now.getTime() - email.receivedAt.getTime() < 7 * DAY_MS;
  if (!email || (!isNew && !opts.force)) return false;

  deps.log(`newsletter: digesting "${email.subject}" (${email.pdfs.length} pdf, ${email.links.length} links)`);
  const today = ymd(now);
  const asked = state.asked.filter((a) => a.start.slice(0, 10) >= today);
  const digest = await buildDigest({ email, calendar: deps.calendar, asked, now });
  deps.log(`newsletter message:\n${digest.message}`);
  if (deps.dryRun) {
    deps.log('[dry-run] newsletter not sent, state not saved');
    return true;
  }
  await deps.send(digest.message);
  save({
    ...state,
    lastMessageId: email.id,
    pending: digest.items.length ? { askedAt: now.getTime(), items: digest.items } : undefined,
    asked: [...asked, ...digest.items.map((i) => ({ title: i.title, start: i.start, askedAt: now.getTime() }))],
  });
  return true;
}

let retryAt = 0;

/**
 * Called on every poll. Friday 5pm: digest the week's newsletter. If it has not arrived,
 * look once more on Saturday at noon, then say so. A Mac that was asleep catches up on wake.
 */
export async function maybeRunNewsletter(deps: NewsletterDeps) {
  const now = new Date();
  if (now.getTime() < retryAt) return;
  const { week, lastTry } = slotFor(now);
  let state = load();
  if (!state) {
    // First run after setup: start with the coming Friday rather than digesting right away.
    if (!deps.dryRun) save({ doneWeek: week, asked: [] });
    return;
  }
  if (state.doneWeek === week) return;
  const finalTry = now >= lastTry;
  if (!finalTry && state.triedWeek === week) return;

  try {
    const sent = await runNewsletter(deps);
    if (deps.dryRun) {
      retryAt = Infinity;
      return;
    }
    state = load() ?? state;
    if (sent) save({ ...state, doneWeek: week });
    else if (finalTry) {
      deps.log('newsletter: none this week');
      await deps.send(`No school newsletter email from ${process.env.NEWSLETTER_FROM_NAME || 'the teacher'} this week.`);
      save({ ...state, doneWeek: week });
    } else {
      deps.log('newsletter: not here yet, will look again Saturday at noon');
      save({ ...state, triedWeek: week });
    }
  } catch (err) {
    deps.log(`newsletter error, retrying in ${RETRY_MS / 60_000} min:`, err);
    retryAt = Date.now() + RETRY_MS;
  }
}

/** Extra context for the chat agent while a newsletter question is waiting for an answer. */
export function pendingNote(): string {
  const pending = load()?.pending;
  if (!pending || Date.now() - pending.askedAt > PENDING_MS) return '';
  const lines = pending.items.map((i) => `- ${fmtItem(i)} | start ${i.start}${i.end ? ` | end ${i.end}` : ''}`);
  return `Newsletter dates you offered to add to the calendar on ${new Date(pending.askedAt).toLocaleDateString('en-US', { dateStyle: 'full' })} (still waiting for an answer):\n${lines.join('\n')}`;
}
