import { z } from 'zod';
import { defineTool, type ToolContext, type ToolDomain } from './index.ts';
import type { SkylightList } from '../skylight/client.ts';

const norm = (s: string) => s.trim().toLowerCase();

async function findList(ctx: ToolContext, name: string): Promise<SkylightList> {
  const lists = await ctx.skylight.lists();
  const hit = lists.find((l) => norm(l.label) === norm(name));
  if (!hit) throw new Error(`No list named "${name}". Existing lists: ${lists.map((l) => l.label).join(', ')}`);
  return hit;
}

export const prompt = `
## Lists (Skylight)
- Groceries and household supplies go to the "Grocery List" list unless a message names another list.
- Other errands and chores go to the "Honey Do" list unless a message names another list.
- Only create a new list when someone explicitly asks for one.
- Keep item labels short and capitalized like a shopping list ("Milk", "Paper towels"). Put quantities in the label only if someone gave one ("Eggs (2 dozen)").
- "Got X", "bought X", or "X is done" means mark X completed. "Never mind X" or "remove X" means remove it.
- Before adding items, check the list; add_items skips items that are already pending anyway.
`;

export function tools(ctx: ToolContext) {
  return [
    defineTool('get_lists', 'List all Skylight lists (name and kind).', {}, async () => JSON.stringify((await ctx.skylight.lists()).map(({ label, kind }) => ({ name: label, kind })))),

    defineTool('get_list_items', 'Get the items in a Skylight list by list name.', {
        list: z.string().describe('List name, case-insensitive'),
        include_completed: z.boolean().optional(),
      }, async ({ list, include_completed }) => {
        const l = await findList(ctx, list);
        const items = await ctx.skylight.items(l.id);
        return JSON.stringify(
          items.filter((i) => include_completed || i.status === 'pending').map(({ label, status }) => ({ label, status })),
        );
      }),

    defineTool('add_items', 'Add one or more items to a Skylight list. Items already pending on the list are skipped.', {
        list: z.string(),
        items: z.array(z.string()).min(1),
      }, async ({ list, items }) => {
        const l = await findList(ctx, list);
        const pending = new Set((await ctx.skylight.items(l.id)).filter((i) => i.status === 'pending').map((i) => norm(i.label)));
        const added: string[] = [];
        const skipped: string[] = [];
        for (const label of items) {
          if (pending.has(norm(label))) {
            skipped.push(label);
            continue;
          }
          await ctx.write(`add "${label}" to ${l.label}`, () => ctx.skylight.addItem(l.id, label));
          pending.add(norm(label));
          added.push(label);
        }
        return JSON.stringify({ list: l.label, added, skipped_already_on_list: skipped });
      }),

    defineTool('complete_items', 'Mark items on a Skylight list as completed (e.g. bought or done). Match labels as they appear on the list.', { list: z.string(), items: z.array(z.string()).min(1) }, async ({ list, items }) => {
        const l = await findList(ctx, list);
        const current = await ctx.skylight.items(l.id);
        const done: string[] = [];
        const notFound: string[] = [];
        for (const label of items) {
          const hit = current.find((i) => i.status === 'pending' && norm(i.label) === norm(label));
          if (!hit) {
            notFound.push(label);
            continue;
          }
          await ctx.write(`complete "${hit.label}" on ${l.label}`, () =>
            ctx.skylight.updateItem(l.id, hit.id, { status: 'completed' }),
          );
          done.push(hit.label);
        }
        return JSON.stringify({ list: l.label, completed: done, not_found: notFound });
      }),

    defineTool('remove_items', 'Delete items from a Skylight list (use when someone says never mind / remove). Match labels as they appear on the list.', { list: z.string(), items: z.array(z.string()).min(1) }, async ({ list, items }) => {
        const l = await findList(ctx, list);
        const current = await ctx.skylight.items(l.id);
        const removed: string[] = [];
        const notFound: string[] = [];
        for (const label of items) {
          const hit = current.find((i) => norm(i.label) === norm(label));
          if (!hit) {
            notFound.push(label);
            continue;
          }
          await ctx.write(`remove "${hit.label}" from ${l.label}`, () => ctx.skylight.deleteItem(l.id, hit.id));
          removed.push(hit.label);
        }
        return JSON.stringify({ list: l.label, removed, not_found: notFound });
      }),

    defineTool('create_list', 'Create a new Skylight list. Only when explicitly asked.', { name: z.string(), kind: z.enum(['shopping', 'to_do']) }, async ({ name, kind }) => {
        await ctx.write(`create list "${name}" (${kind})`, () => ctx.skylight.createList(name, kind));
        return JSON.stringify({ created: name });
      }),
  ];
}

export default { prompt, tools } satisfies ToolDomain;
