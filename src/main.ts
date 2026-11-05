import { handleMessages, NO_REPLY, runScheduledTask } from './agent.ts';
import { giftsterFromEnv } from './giftster/client.ts';
import { calendarFromEnv } from './google/calendar.ts';
import { gmailFrom } from './google/gmail.ts';
import { oauthFromEnv } from './google/oauth.ts';
import { tasksFrom } from './google/tasks.ts';
import { maxRowId, messagesSince, openDb, recentMessages, type ChatMessage } from './imessage/reader.ts';
import { sendToChat } from './imessage/sender.ts';
import { maybeRunNewsletter, pendingNote, runNewsletter, type NewsletterDeps } from './newsletter/schedule.ts';
import { tickReminders, type ReminderDeps } from './reminders.ts';
import { clientFromEnv } from './skylight/client.ts';
import { loadCheckpoint, saveCheckpoint } from './state.ts';
import type { ToolContext } from './tools/index.ts';

const POLL_MS = 5_000;
// Wait until the chat has been quiet this long, so a burst of texts is handled as one batch.
const QUIET_MS = 8_000;
const CONTEXT_MESSAGES = 40;
const RETRY_MS = 60_000;

const DRY_RUN = process.env.DRY_RUN === '1';
// Dry-run only: replay the last N messages of the thread, then exit.
const REPLAY_LAST = Number(process.env.REPLAY_LAST || 0);
// Digest the newest newsletter email once, right now, then exit.
const NEWSLETTER_NOW = process.env.NEWSLETTER_NOW === '1';

const CHAT_GUID = required('CHAT_GUID');
// Optional one-to-one chats with the bot. Replies go back to the chat a message came from.
const DM_CHAT_GUIDS = (process.env.DM_CHAT_GUIDS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
// "Alex=+15551234567,Sam=+15557654321" (name= optional)
const people = required('ALLOWED_HANDLES')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => (s.includes('=') ? s.split('=') : [s, s]) as [string, string]);
const names = Object.fromEntries(people.map(([name, handle]) => [handle, name]));
const allowed = new Set(people.map(([, handle]) => handle));

function required(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name} in .env`);
  return v;
}

const log = (...args: unknown[]) => console.log(new Date().toISOString(), ...args);

// The family Google account's sign-in (Gmail reading, Tasks); null until `npm run gmail-auth`.
const google = oauthFromEnv();
const gmail = gmailFrom(google);

const ctx: ToolContext = {
  skylight: clientFromEnv(),
  calendar: calendarFromEnv(),
  gmail,
  tasks: tasksFrom(google),
  giftster: giftsterFromEnv(),
  chatGuid: CHAT_GUID,
  senders: [],
  write: async (description, fn) => {
    if (DRY_RUN) {
      log(`[dry-run] would ${description}`);
      return;
    }
    log(`[write] ${description}`);
    await fn();
  },
};

// Weekly school-newsletter digest; off unless both settings are present.
const newsletter: NewsletterDeps | null =
  gmail && process.env.NEWSLETTER_SENDER
    ? {
        gmail,
        calendar: ctx.calendar,
        sender: process.env.NEWSLETTER_SENDER,
        send: (text) => sendToChat(CHAT_GUID, text),
        log,
        dryRun: DRY_RUN,
      }
    : null;

const reminders: ReminderDeps = {
  send: sendToChat,
  runTask: async (r) => {
    const reply = await runScheduledTask({ instruction: r.text, dm: r.chatGuid !== CHAT_GUID, ctx: { ...ctx, chatGuid: r.chatGuid } });
    return reply === NO_REPLY ? null : reply;
  },
  log,
  dryRun: DRY_RUN,
};

async function process_(chatGuid: string, fresh: ChatMessage[], context: ChatMessage[]) {
  log(`handling ${fresh.length} message(s):`, fresh.map((m) => `${names[m.sender] ?? m.sender}: ${m.text}`));
  const reply = await handleMessages({ context, fresh, names, ctx: { ...ctx, chatGuid, senders: [...new Set(fresh.map((m) => names[m.sender] ?? m.sender))] }, dm: chatGuid !== CHAT_GUID, note: newsletter ? pendingNote() : '' });
  log(`reply: ${reply}`);
  if (reply === NO_REPLY) return;
  if (DRY_RUN) log('[dry-run] reply not sent');
  else await sendToChat(chatGuid, reply);
}

async function replay() {
  const db = openDb();
  const top = maxRowId(db, CHAT_GUID);
  const all = recentMessages(db, CHAT_GUID, top, REPLAY_LAST + CONTEXT_MESSAGES);
  const split = Math.max(0, all.length - REPLAY_LAST);
  const fresh = all.slice(split).filter((m) => !m.isFromMe && allowed.has(m.sender));
  await process_(CHAT_GUID, fresh, all.slice(0, split));
  db.close();
}

async function loop() {
  const db = openDb();
  const checkpoint = loadCheckpoint();
  // Last handled ROWID per watched chat. A chat with no checkpoint starts from now
  // instead of replaying its whole history.
  const seen: Record<string, number> = {
    [CHAT_GUID]: checkpoint?.lastRowId ?? maxRowId(db, CHAT_GUID),
  };
  for (const guid of DM_CHAT_GUIDS) seen[guid] = checkpoint?.dms?.[guid] ?? maxRowId(db, guid);
  const save = () => {
    const { [CHAT_GUID]: lastRowId, ...dms } = seen;
    if (!DRY_RUN) saveCheckpoint({ lastRowId, dms });
  };
  save();
  for (const [guid, rowId] of Object.entries(seen)) log(`watching ${guid} from ROWID ${rowId}`);

  let retryAt = 0;
  while (true) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    // Runs on its own schedule and handles its own errors, so it never holds up messages.
    if (newsletter) await maybeRunNewsletter(newsletter);
    await tickReminders(reminders);
    if (Date.now() < retryAt) continue;
    try {
      for (const guid of Object.keys(seen)) {
        const top = maxRowId(db, guid);
        if (top <= seen[guid]) continue;

        const pending = messagesSince(db, guid, seen[guid]).filter((m) => m.rowId <= top);
        const fresh = pending.filter((m) => !m.isFromMe && allowed.has(m.sender));

        if (fresh.length) {
          const newest = fresh[fresh.length - 1].sentAt.getTime();
          // Messages synced in after downtime are old, so they are handled right away.
          if (Date.now() - newest < QUIET_MS) continue;
          const context = recentMessages(db, guid, seen[guid], CONTEXT_MESSAGES);
          await process_(guid, fresh, context);
        }

        // Only advance after success: a crash or error means the batch is retried.
        // Retries are safe because add_items and add_event skip what is already there.
        seen[guid] = top;
        save();
      }
    } catch (err) {
      log(`error, retrying in ${RETRY_MS / 1000}s:`, err);
      retryAt = Date.now() + RETRY_MS;
    }
  }
}

if (NEWSLETTER_NOW) {
  if (!newsletter) throw new Error('Set GMAIL_OAUTH_FILE and NEWSLETTER_SENDER in .env');
  await runNewsletter(newsletter, { force: true });
} else if (REPLAY_LAST > 0) {
  if (!DRY_RUN) throw new Error('REPLAY_LAST is only allowed with DRY_RUN=1');
  await replay();
} else {
  await loop();
}
