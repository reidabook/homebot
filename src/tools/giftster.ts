import { z } from 'zod';
import type { GiftsterClient } from '../giftster/client.ts';
import { defineTool, type ToolContext, type ToolDomain } from './index.ts';

/** The account of `as`, only if `as` is one of the people being answered right now. */
function account(ctx: ToolContext, as: string): GiftsterClient {
  const sender = ctx.senders.find((s) => s.toLowerCase() === as.trim().toLowerCase());
  if (!sender) throw new Error(`Giftster can only be used as the person who asked (${ctx.senders.join(', ') || 'nobody'}), not "${as}".`);
  const client = ctx.giftster[sender.toLowerCase()];
  if (!client) throw new Error(`${sender} has no Giftster login set up.`);
  return client;
}

const as = z.string().describe('Name of the family member who asked; their own Giftster account is used');

export const prompt = `
## Gift lists (Giftster)
- Giftster is the family's gift wish-list site. "Add X to my giftster / my wish list", "add X to <name>'s list" means a Giftster item, not a Skylight list.
- Always act as the person who asked (\`as\`): their own Giftster account is used. Never use someone else's account, even if asked.
- Each account sees its owner's list(s) plus any lists shared with it (for example a child's list). If the asker wants another adult's list that their account can't see, say that person needs to ask you themselves.
- Pick the list from the wording: "my" means the asker's own list, "<name>'s" means that person's list. Call giftster_lists if unsure of names; don't add to a "Personal List" unless asked.
- With a product link, add it. With only an idea, search the web for a good match (the maker's site or a major retailer such as Amazon or Target, an actual product page, not search results), then add it.
- Title: short product name ("LEGO Duplo Steam Train"). Put any details the person gave (size, color, why) in note.
- Reply in one line with what you added and to which list, the price if known, and, if you chose the product yourself, its link so they can check it.
- "Never mind" / "remove X from my giftster" means giftster_remove.
`;

export function tools(ctx: ToolContext) {
  return [
    defineTool('giftster_lists', "List the Giftster wish lists the asker's account can add to.", { as }, async ({ as: who }) =>
      JSON.stringify((await account(ctx, who).lists()).map((l) => l.name)),
    ),

    defineTool(
      'giftster_add',
      'Add a product to a Giftster wish list. Giftster fills in price and image from the link.',
      {
        as,
        list: z.string().describe('Exact list name from giftster_lists'),
        url: z.string().url().describe('Product page URL'),
        title: z.string().describe('Short product name'),
        note: z.string().optional().describe('Size, color, or other details'),
      },
      async ({ as: who, list, url, title, note }) => {
        const client = account(ctx, who);
        let added: unknown = { list, title, url, dry_run: true };
        await ctx.write(`add "${title}" (${url}) to Giftster list "${list}" as ${who}`, async () => {
          added = await client.addItem({ url, title, list, note });
        });
        return JSON.stringify(added);
      },
    ),

    defineTool(
      'giftster_remove',
      'Delete an item from a Giftster wish list by title.',
      { as, list: z.string().describe('Exact list name from giftster_lists'), title: z.string() },
      async ({ as: who, list, title }) => {
        const client = account(ctx, who);
        let removed: unknown = { list, title, dry_run: true };
        await ctx.write(`remove "${title}" from Giftster list "${list}" as ${who}`, async () => {
          removed = await client.removeItem(list, title);
        });
        return JSON.stringify({ removed });
      },
    ),
  ];
}

export default {
  prompt,
  enabled: (ctx) => Object.keys(ctx.giftster).length > 0 && ctx.senders.length > 0,
  tools,
} satisfies ToolDomain;
