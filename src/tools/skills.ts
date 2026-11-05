import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { STATE_DIR } from '../state.ts';
import { defineTool, type ToolContext, type ToolDomain } from './index.ts';

// A skill is a routine the family taught the assistant: state/skills/<name>.md,
// first line the description, the rest the steps.
const DIR = join(STATE_DIR, 'skills');
const name = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'Use lowercase words joined by hyphens, e.g. "meal-plan"');
const file = (n: string) => join(DIR, `${n}.md`);

function read(n: string) {
  const [description = '', ...rest] = readFileSync(file(n), 'utf8').split('\n');
  return { name: n, description, instructions: rest.join('\n').trim() };
}

/** Name and description of every skill, for the prompt. */
export function skillIndex() {
  if (!existsSync(DIR)) return '(none yet)';
  const names = readdirSync(DIR).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3)).sort();
  return names.map((n) => `- ${n}: ${read(n).description}`).join('\n') || '(none yet)';
}

export const prompt = `
## Skills
- A skill is a routine the family has taught you, listed under "Your skills". When a message calls for one, load its steps with use_skill and follow them using your other tools.
- When someone teaches you how they want a recurring job done ("when I say meal plan, do this...", "from now on, when we ask for a packing list..."), save it with save_skill: a short hyphenated name, a one-line description of when to use it, and the steps in your own clear words. Say you've learned it.
- When they correct how you did a skill, load it, then save the improved steps under the same name.
- Skills only describe how to use the tools you already have. If a routine needs something you can't do, say so instead of saving it.
`;

export function tools(ctx: ToolContext) {
  return [
    defineTool('use_skill', 'Load the steps of a saved skill.', { name }, async (a) => {
      if (!existsSync(file(a.name))) throw new Error(`No skill named ${a.name}`);
      return read(a.name).instructions;
    }),

    defineTool('save_skill', 'Create a skill, or replace one with the same name.', {
        name,
        description: z.string().describe('One line: when to use this skill'),
        instructions: z.string().describe('The steps to follow'),
      }, async (a) => {
        await ctx.write(`save skill ${a.name}`, async () => {
          mkdirSync(DIR, { recursive: true });
          writeFileSync(file(a.name), `${a.description.replace(/\s+/g, ' ').trim()}\n\n${a.instructions.trim()}\n`);
        });
        return JSON.stringify({ saved: a.name });
      }),

    defineTool('delete_skill', 'Delete a saved skill.', { name }, async (a) => {
      if (!existsSync(file(a.name))) throw new Error(`No skill named ${a.name}`);
      await ctx.write(`delete skill ${a.name}`, async () => rmSync(file(a.name)));
      return JSON.stringify({ deleted: a.name });
    }),
  ];
}

export default { prompt, tools } satisfies ToolDomain;
