import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { readJson, writeJson } from '../state.ts';
import { defineTool, type ToolContext, type ToolDomain } from './index.ts';

// Things the family wanted that the assistant can't do yet. Read by whoever improves the bot.
const FILE = 'wishlist.json';

export interface Wish {
  id: string;
  /** What was wanted, in plain words. */
  want: string;
  /** What is missing: a tool, an access, a limit of some service. */
  why_not: string;
  askedBy: string;
  firstAsked: string;
  lastAsked: string;
  /** How often it has come up. */
  times: number;
  status: 'open' | 'done';
}

export const loadWishes = () => readJson<Wish[]>(FILE, []);
const save = (w: Wish[]) => writeJson(FILE, w);
const open = () => loadWishes().filter((w) => w.status === 'open').sort((a, b) => b.times - a.times);
const today = () => new Date().toISOString().slice(0, 10);

/** Open wishes, most-asked first, for the prompt. */
export function wishlistText() {
  return open().map((w) => `- [${w.id}] ${w.want} (asked ${w.times}x)`).join('\n') || '(empty)';
}

export const prompt = `
## Wishlist
- The wishlist records what the family wanted that you can't do yet, so it can be built later. The open entries are listed under "Wishlist".
- When you can't do what was asked because you have no tool or access for it, say so in one short line and log it with add_wish, e.g. "Can't order from Amazon yet; added it to the wishlist." If an open entry already covers it, pass its id as same_as so it is counted again instead of duplicated.
- Also log it when someone says "add to the wishlist ...", "it'd be nice if you could ...", or complains about a limit of yours.
- Don't log one-off failures (a service being down, a search with no results, a missing detail in a request). Only missing abilities.
- "What's on the wishlist?" means get_wishlist; answer with the open ones, most-asked first, a few words each.
`;

export function tools(ctx: ToolContext) {
  return [
    defineTool('add_wish', 'Log something the family wanted that you cannot do yet, or count another request for an existing entry.', {
        want: z.string().describe('What they wanted, in plain words'),
        why_not: z.string().describe('What you are missing: which tool, access, or limit'),
        asked_by: z.string().describe('Who asked'),
        same_as: z.string().optional().describe('Id of an open entry this repeats'),
      }, async (a) => {
        const all = loadWishes();
        const existing = all.find((w) => w.id === a.same_as && w.status === 'open');
        if (existing) {
          const next = all.map((w) => (w === existing ? { ...w, times: w.times + 1, lastAsked: today() } : w));
          await ctx.write(`count wish ${existing.id} again: ${existing.want}`, async () => save(next));
          return JSON.stringify({ counted: existing.id, times: existing.times + 1 });
        }
        const wish: Wish = {
          id: randomBytes(2).toString('hex'),
          want: a.want.trim(),
          why_not: a.why_not.trim(),
          askedBy: a.asked_by,
          firstAsked: today(),
          lastAsked: today(),
          times: 1,
          status: 'open',
        };
        await ctx.write(`add wish: ${wish.want}`, async () => save([...all, wish]));
        return JSON.stringify({ added: wish.id });
      }),

    defineTool('get_wishlist', 'The open wishlist entries with details, most-asked first.', {}, async () => JSON.stringify(open())),

    defineTool('close_wish', 'Mark a wishlist entry done (it was built) or no longer wanted, by id.', { id: z.string() }, async ({ id }) => {
      const all = loadWishes();
      if (!all.some((w) => w.id === id)) throw new Error(`No wishlist entry with id ${id}`);
      await ctx.write(`close wish ${id}`, async () => save(all.map((w) => (w.id === id ? { ...w, status: 'done' as const } : w))));
      return JSON.stringify({ closed: id });
    }),
  ];
}

export default { prompt, tools } satisfies ToolDomain;
