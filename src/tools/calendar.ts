import { z } from 'zod';
import { defineTool, type ToolContext, type ToolDomain } from './index.ts';

const norm = (s: string) => s.trim().toLowerCase();

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const when = z.string().regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/, 'Use YYYY-MM-DD or YYYY-MM-DDTHH:MM');
const START = 'Local time. "YYYY-MM-DDTHH:MM" (24h), or "YYYY-MM-DD" for an all-day event.';
const END = 'Same format as start. Defaults to one hour after start; for all-day events, the last day (defaults to the start day).';

export const prompt = `
## Calendar (Google)
- Add an event when someone asks for it ("put dinner with the Smiths on the calendar for Friday at 7") or states a settled plan with a date ("dentist is Tuesday at 3"). Skip maybes and questions ("should we do Friday?").
- Work out dates from the current time given with the messages. A bare weekday or a date without a year ("Jan 12") means the next one coming up, which may be next year. If no time of day was given, make it an all-day event. If there is no date at all, don't guess; say what's missing.
- Keep titles short ("Dentist", "Dinner with the Smiths"). Name a person in the title only if the message did.
- To change or cancel an event, find it with get_events first, searching a wide enough range of days and using a one-word query ("cleaners", not "recurring cleaners"). "Moved to 4" means update_event; "cancelled" or "never mind" means remove_event.
- Occurrences of a repeating event carry a seriesId. To cancel one date ("no soccer this week"), remove that occurrence by its id. To delete the repeating event altogether, call remove_event once with the seriesId; never delete occurrences one by one.
- add_event skips an event that is already on the calendar with the same title and start, so re-adding is safe.
- Confirm with the day and time, e.g. "Added Dentist Tue 10/6 3pm to calendar".
`;

export function tools(ctx: ToolContext) {
  return [
    defineTool('get_events', 'List events on the shared Google calendar between two days (inclusive). Returns ids needed by update_event and remove_event; occurrences of a repeating event also have a seriesId.', {
        from: day,
        to: day,
        query: z.string().optional().describe('Free-text filter on title, location, and notes'),
      }, async ({ from, to, query }) => JSON.stringify(await ctx.calendar.events(from, to, query))),

    defineTool('add_event', 'Add an event to the shared Google calendar. Skipped if an event with the same title and start already exists.', {
        title: z.string(),
        start: when.describe(START),
        end: when.optional().describe(END),
        location: z.string().optional(),
        notes: z.string().optional(),
        rrule: z.string().optional().describe('Only for repeating events: an RFC 5545 rule such as "FREQ=WEEKLY;BYDAY=TU"'),
      }, async (event) => {
        const date = event.start.slice(0, 10);
        const existing = (await ctx.calendar.events(date, date)).find(
          (e) => norm(e.title) === norm(event.title) && e.start === event.start,
        );
        if (existing) return JSON.stringify({ skipped_already_on_calendar: existing });
        await ctx.write(`add "${event.title}" to calendar at ${event.start}`, () => ctx.calendar.addEvent(event));
        return JSON.stringify({ added: event });
      }),

    defineTool('update_event', 'Change an existing calendar event by id (from get_events). Only the given fields change. When moving an event, give both start and end. On a repeating event this changes only that one occurrence.', {
        id: z.string(),
        title: z.string().optional(),
        start: when.optional().describe(START),
        end: when.optional().describe(END),
        location: z.string().optional(),
        notes: z.string().optional(),
      }, async ({ id, ...patch }) => {
        if (patch.end && !patch.start) throw new Error('Give start along with end');
        await ctx.write(`update calendar event ${id}: ${JSON.stringify(patch)}`, () => ctx.calendar.updateEvent(id, patch));
        return JSON.stringify({ updated: id, ...patch });
      }),

    defineTool('remove_event', 'Delete a calendar event by id (from get_events). For a repeating event, an occurrence id removes only that date; its seriesId removes the whole series, past and future.', { id: z.string() }, async ({ id }) => {
        await ctx.write(`remove calendar event ${id}`, () => ctx.calendar.deleteEvent(id));
        return JSON.stringify({ removed: id });
      }),
  ];
}

export default { prompt, tools } satisfies ToolDomain;
