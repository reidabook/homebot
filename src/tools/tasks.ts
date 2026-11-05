import { z } from 'zod';
import { defineTool, type ToolContext, type ToolDomain } from './index.ts';

const norm = (s: string) => s.trim().toLowerCase();
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

export const prompt = `
## Tasks (Google Tasks, shown in Google Calendar)
- "Remind us/me to ...", "don't let us forget ...", and to-dos with a day all mean add_task. Do NOT use add_reminder for these: a task stays in their calendar whether or not you are running. Use add_reminder only when they explicitly ask you to text or ping them at a time, and for scheduled jobs.
- A task has a due day but no time of day, so put any time in the title ("Flu clinic 3-5pm", "Bring costume, drop-off 8am"). Keep titles short; details go in notes. If no day was given, add it without one.
- Something that happens at a set time and that they attend (an appointment, a party) is a calendar event, not a task. A thing to do or bring by a day is a task.
- "Done with X" / "did X" means complete_task; "never mind" means remove_task. Find the id with get_tasks first.
- add_task skips a task already open with the same title and day.
- Confirm with the day, e.g. "Added task: Flu clinic 3-5pm, Thu 10/15".
`;

export function tools(ctx: ToolContext) {
  const tasks = ctx.tasks;
  if (!tasks) return [];
  return [
    defineTool('get_tasks', 'List open tasks, soonest due first. Returns ids needed by the other task tools.', {}, async () => JSON.stringify(await tasks.open())),

    defineTool('add_task', 'Add a task to Google Tasks. Skipped if the same task is already open.', {
        title: z.string(),
        due: day.optional().describe('The day it is due'),
        notes: z.string().optional(),
      }, async (t) => {
        const existing = (await tasks.open()).find((e) => norm(e.title) === norm(t.title) && e.due === t.due);
        if (existing) return JSON.stringify({ skipped_already_a_task: existing });
        await ctx.write(`add task "${t.title}"${t.due ? ` due ${t.due}` : ''}`, () => tasks.add(t));
        return JSON.stringify({ added: t });
      }),

    defineTool('update_task', 'Change a task by id. Only the given fields change.', {
        id: z.string(),
        title: z.string().optional(),
        due: day.optional(),
        notes: z.string().optional(),
      }, async ({ id, ...patch }) => {
        await ctx.write(`update task ${id}: ${JSON.stringify(patch)}`, () => tasks.update(id, patch));
        return JSON.stringify({ updated: id, ...patch });
      }),

    defineTool('complete_task', 'Mark a task done, by id.', { id: z.string() }, async ({ id }) => {
      await ctx.write(`complete task ${id}`, () => tasks.complete(id));
      return JSON.stringify({ completed: id });
    }),

    defineTool('remove_task', 'Delete a task by id.', { id: z.string() }, async ({ id }) => {
      await ctx.write(`remove task ${id}`, () => tasks.remove(id));
      return JSON.stringify({ removed: id });
    }),
  ];
}

export default { prompt, tools, enabled: (ctx) => !!ctx.tasks } satisfies ToolDomain;
