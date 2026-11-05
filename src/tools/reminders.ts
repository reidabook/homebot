import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { fmtDue, loadReminders, saveReminders, type Reminder } from '../reminders.ts';
import { defineTool, type ToolContext, type ToolDomain } from './index.ts';

const at = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, 'Use YYYY-MM-DDTHH:MM (24h, local time)');

export const prompt = `
## Texted reminders and scheduled jobs
- These only go out while you are running on the family's laptop, so they can be late. add_reminder texts this same chat at a set time. Work the time out from the current time given with the messages. If no time of day was given, use 8:00 for a morning-of reminder, or ask if it matters. If there is no day at all, ask.
- kind "message" sends the text as written, so word it as the reminder itself ("Bring the costume for the school play"). kind "task" is for things you have to work out at that moment: the text is an instruction to yourself ("Send the week ahead from the calendar"), and whatever you answer then is posted.
- Use repeat for standing ones ("every Sunday at 6pm"). To change one, remove it and add it again.
- An event with a date belongs on the calendar; add a reminder as well only if they asked to be reminded.
- Confirm with the day and time, e.g. "Will remind you Thu 10/15 at 7am".
`;

export function tools(ctx: ToolContext) {
  return [
    defineTool('add_reminder', 'Schedule a text to this chat, once or repeating.', {
        at: at.describe('When it is first due, local time'),
        text: z.string().describe('The reminder wording (message), or the instruction to yourself (task)'),
        kind: z.enum(['message', 'task']).optional().describe('Defaults to message'),
        repeat: z.enum(['none', 'daily', 'weekly', 'monthly']).optional().describe('Defaults to none'),
      }, async (a) => {
        if (new Date(a.at) <= new Date()) throw new Error(`${a.at} is in the past`);
        const r: Reminder = {
          id: randomBytes(2).toString('hex'),
          at: a.at,
          repeat: a.repeat ?? 'none',
          kind: a.kind ?? 'message',
          text: a.text.trim(),
          chatGuid: ctx.chatGuid,
        };
        await ctx.write(`add ${r.kind} reminder at ${r.at} (repeat ${r.repeat}): ${r.text}`, async () => saveReminders([...loadReminders(), r]));
        return JSON.stringify({ added: r.id, due: fmtDue(r.at) });
      }),

    defineTool('list_reminders', 'List the reminders and scheduled jobs waiting to go out, soonest first.', {}, async () =>
      JSON.stringify(
        loadReminders()
          .sort((a, b) => a.at.localeCompare(b.at))
          .map(({ chatGuid, ...r }) => ({ ...r, due: fmtDue(r.at), thisChat: chatGuid === ctx.chatGuid })),
      )),

    defineTool('remove_reminder', 'Cancel a reminder by id (from list_reminders).', { id: z.string() }, async ({ id }) => {
      const all = loadReminders();
      if (!all.some((r) => r.id === id)) throw new Error(`No reminder with id ${id}`);
      await ctx.write(`remove reminder ${id}`, async () => saveReminders(all.filter((r) => r.id !== id)));
      return JSON.stringify({ removed: id });
    }),
  ];
}

export default { prompt, tools } satisfies ToolDomain;
