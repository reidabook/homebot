import { z } from 'zod';
import { readFile } from '../readFile.ts';
import { defineTool, type ToolContext, type ToolDomain } from './index.ts';

const MAX_BODY = 12_000;
const when = (d: Date) => d.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });

export const prompt = `
## Family email (Gmail, read-only)
- You can search and read the family's shared mailbox to answer questions ("what did the school send about picture day?", "when does the package arrive?"). You cannot send, reply to, or delete mail.
- search_mail takes Gmail search syntax: plain keywords, from:, subject:, newer_than:7d, has:attachment. Start narrow and recent, and widen if nothing comes back. Then read_mail the most likely message before answering.
- read_mail lists attachments by name. When the answer is probably inside a PDF or image attachment (a flyer, a class newsletter, a form), open it with read_attachment and pass the question you are trying to answer. Other file types can't be opened; say so.
- Answer the question in a line or two. Don't paste whole emails into the chat.
`;

export function tools(ctx: ToolContext) {
  const gmail = ctx.gmail;
  if (!gmail) return [];
  return [
    defineTool('search_mail', 'Search the family mailbox, newest first. Returns ids for read_mail.', {
        query: z.string().describe('Gmail search syntax'),
        max: z.number().int().min(1).max(20).optional(),
      }, async ({ query, max }) => {
        const found = await gmail.search(query, max ?? 8);
        return JSON.stringify(found.map((m) => ({ ...m, receivedAt: when(m.receivedAt) })));
      }),

    defineTool('read_mail', 'Read one email by id (from search_mail): body text, links, and attachment names.', { id: z.string() }, async ({ id }) => {
      const m = await gmail.message(id);
      return JSON.stringify({
        from: m.from,
        subject: m.subject,
        receivedAt: when(m.receivedAt),
        text: m.text.slice(0, MAX_BODY),
        links: m.links.slice(0, 30),
        attachments: m.attachments,
      });
    }),

    defineTool('read_attachment', 'Read a PDF or image attached to an email (id and file name from read_mail). Returns what the file says, or the answer to `question` if given.', {
        id: z.string(),
        filename: z.string(),
        question: z.string().optional().describe('What you need from the file; omit to get its full contents'),
      }, async ({ id, filename, question }) => readFile(await gmail.attachment(id, filename), question)),
  ];
}

export default { prompt, tools, enabled: (ctx) => !!ctx.gmail } satisfies ToolDomain;
