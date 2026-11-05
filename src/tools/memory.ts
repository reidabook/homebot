import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { readJson, writeJson } from '../state.ts';
import { defineTool, type ToolContext, type ToolDomain } from './index.ts';

const FILE = 'memory.json';
/** Past this many entries the assistant is told to tidy up. */
const SOFT_CAP = 80;

export interface Memory {
  id: string;
  text: string;
  savedAt: string;
}

export const loadMemories = () => readJson<Memory[]>(FILE, []);
const save = (m: Memory[]) => writeJson(FILE, m);

/** Everything remembered, for the prompt. */
export function memoryText() {
  const all = loadMemories();
  if (!all.length) return '(nothing saved yet)';
  const lines = all.map((m) => `- [${m.id}] ${m.text}`).join('\n');
  return all.length > SOFT_CAP ? `${lines}\n(This is getting long: merge related entries and forget stale ones when you next save something.)` : lines;
}

export const prompt = `
## Memory
- What you have saved about this family is listed under "What you remember". Use it without being asked: it is how you know who people are and how they like things done.
- Save lasting things you learn as you go, with remember: who people are, the kids' schools, classes and teachers, allergies and food preferences, favourite stores and brands, regular routines, and how they want you to behave ("stop confirming every item"). Also save anything you are told to remember.
- Don't save one-off events (those belong on the calendar), list items, or things already saved. One fact per entry, written so it makes sense on its own ("Sam is allergic to peanuts").
- When something saved turns out wrong or changes, fix it with update_memory rather than adding a second entry. forget removes one.
- Save quietly. Mention it only when you were asked to remember, or asked what you know.
`;

export function tools(ctx: ToolContext) {
  return [
    defineTool('remember', 'Save one lasting fact or preference about the family for future conversations.', { text: z.string() }, async ({ text }) => {
      const entry: Memory = { id: randomBytes(2).toString('hex'), text: text.trim(), savedAt: new Date().toISOString() };
      await ctx.write(`remember "${entry.text}"`, async () => save([...loadMemories(), entry]));
      return JSON.stringify({ saved: entry.id });
    }),

    defineTool('update_memory', 'Replace the text of a saved memory, by the id shown in brackets.', { id: z.string(), text: z.string() }, async ({ id, text }) => {
      const all = loadMemories();
      if (!all.some((m) => m.id === id)) throw new Error(`No memory with id ${id}`);
      const next = all.map((m) => (m.id === id ? { ...m, text: text.trim(), savedAt: new Date().toISOString() } : m));
      await ctx.write(`update memory ${id} to "${text}"`, async () => save(next));
      return JSON.stringify({ updated: id });
    }),

    defineTool('forget', 'Delete a saved memory, by the id shown in brackets.', { id: z.string() }, async ({ id }) => {
      const all = loadMemories();
      if (!all.some((m) => m.id === id)) throw new Error(`No memory with id ${id}`);
      await ctx.write(`forget memory ${id}`, async () => save(all.filter((m) => m.id !== id)));
      return JSON.stringify({ forgotten: id });
    }),
  ];
}

export default { prompt, tools } satisfies ToolDomain;
