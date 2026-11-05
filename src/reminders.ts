import { readJson, writeJson } from './state.ts';

const FILE = 'reminders.json';
const RETRY_MS = 5 * 60 * 1000;
const LATE_MS = 60 * 60 * 1000;

export type Repeat = 'none' | 'daily' | 'weekly' | 'monthly';

export interface Reminder {
  id: string;
  /** Local wall-clock time it is next due, "YYYY-MM-DDTHH:MM". */
  at: string;
  repeat: Repeat;
  /** message: text the chat. task: run the assistant with `text` as its instruction and post what it says. */
  kind: 'message' | 'task';
  text: string;
  chatGuid: string;
}

export const loadReminders = () => readJson<Reminder[]>(FILE, []);
export const saveReminders = (r: Reminder[]) => writeJson(FILE, r);

const pad = (n: number) => String(n).padStart(2, '0');
const stamp = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;

/** The first occurrence of a repeating reminder after `now`. */
export function nextAt(at: string, repeat: Exclude<Repeat, 'none'>, now: Date): string {
  const first = new Date(at);
  const d = new Date(first);
  for (let n = 1; d <= now; n++) {
    if (repeat === 'monthly') {
      // Count from the original date so the 31st doesn't drift after a short month.
      d.setTime(first.getTime());
      d.setDate(1);
      d.setMonth(first.getMonth() + n);
      const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
      d.setDate(Math.min(first.getDate(), lastDay));
    } else d.setDate(d.getDate() + (repeat === 'weekly' ? 7 : 1));
  }
  return stamp(d);
}

export const fmtDue = (at: string) =>
  new Date(at).toLocaleString('en-US', { weekday: 'short', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' });

export interface ReminderDeps {
  send: (chatGuid: string, text: string) => Promise<void>;
  /** Run a `task` reminder through the assistant; returns the text to post, or null for nothing. */
  runTask: (r: Reminder) => Promise<string | null>;
  log: (...args: unknown[]) => void;
  dryRun: boolean;
}

let retryAt = 0;

/** Called on every poll: deliver whatever is due. After downtime, overdue ones go out on wake. */
export async function tickReminders(deps: ReminderDeps, now = new Date()) {
  if (deps.dryRun || now.getTime() < retryAt) return;
  const due = loadReminders().filter((r) => new Date(r.at) <= now);
  for (const r of due) {
    try {
      const late = now.getTime() - new Date(r.at).getTime() > LATE_MS ? ` (late, was due ${fmtDue(r.at)})` : '';
      deps.log(`reminder ${r.id} due (${r.kind}): ${r.text}`);
      const text = r.kind === 'message' ? `Reminder: ${r.text}${late}` : await deps.runTask(r);
      if (text) await deps.send(r.chatGuid, text);
      // Reload: the task itself may have added or removed reminders.
      const rest = loadReminders().filter((x) => x.id !== r.id);
      saveReminders(r.repeat === 'none' ? rest : [...rest, { ...r, at: nextAt(r.at, r.repeat, now) }]);
    } catch (err) {
      deps.log(`reminder ${r.id} failed, retrying in ${RETRY_MS / 60_000} min:`, err);
      retryAt = Date.now() + RETRY_MS;
      return;
    }
  }
}
