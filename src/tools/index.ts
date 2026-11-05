// Tool registry. To add a use case: create src/tools/<domain>.ts exporting
// { prompt, tools } and add it to DOMAINS below.
import { tool, type SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import type { z } from 'zod';
import type { CalendarClient } from '../google/calendar.ts';
import type { GiftsterClient } from '../giftster/client.ts';
import type { GmailClient } from '../google/gmail.ts';
import type { TasksClient } from '../google/tasks.ts';
import type { SkylightClient } from '../skylight/client.ts';
import calendar from './calendar.ts';
import giftster from './giftster.ts';
import lists from './lists.ts';
import mail from './mail.ts';
import memory from './memory.ts';
import reminders from './reminders.ts';
import skills from './skills.ts';
import tasks from './tasks.ts';
import wishlist from './wishlist.ts';

export interface ToolContext {
  skylight: SkylightClient;
  calendar: CalendarClient;
  /** Null when the family Gmail is not set up. */
  gmail: GmailClient | null;
  /** Null until the family Google sign-in includes task access. */
  tasks: TasksClient | null;
  /** Giftster logins by lowercase family-member name; empty when none are set up. */
  giftster: Record<string, GiftsterClient>;
  /** The chat the current messages came from; reminders set now are delivered there. */
  chatGuid: string;
  /** Names of the people whose messages are being handled now; empty for scheduled jobs. */
  senders: string[];
  /** Wrap every mutating call: runs it, or just logs it in dry-run mode. */
  write: (description: string, fn: () => Promise<unknown>) => Promise<void>;
}

export interface ToolDomain {
  /** System-prompt section describing conventions for this domain. */
  prompt: string;
  /** Leave the domain out (prompt and tools) when this returns false. */
  enabled?: (ctx: ToolContext) => boolean;
  tools: (ctx: ToolContext) => SdkMcpToolDefinition<any>[];
}

/** An in-process MCP tool whose handler returns text; thrown errors go back to Claude as tool errors. */
export function defineTool<S extends z.ZodRawShape>(
  name: string,
  description: string,
  shape: S,
  run: (args: z.infer<z.ZodObject<S>>) => Promise<string>,
) {
  return tool(name, description, shape, async (args) => {
    console.log(new Date().toISOString(), `[tool] ${name} ${JSON.stringify(args)}`);
    try {
      return { content: [{ type: 'text' as const, text: await run(args as z.infer<z.ZodObject<S>>) }] };
    } catch (e) {
      return { content: [{ type: 'text' as const, text: e instanceof Error ? e.message : String(e) }], isError: true };
    }
  });
}

const DOMAINS: ToolDomain[] = [lists, giftster, calendar, tasks, reminders, mail, memory, skills, wishlist];

const active = (ctx: ToolContext) => DOMAINS.filter((d) => d.enabled?.(ctx) ?? true);

export function buildTools(ctx: ToolContext) {
  return active(ctx).flatMap((d) => d.tools(ctx));
}

export function domainPrompts(ctx: ToolContext) {
  return active(ctx).map((d) => d.prompt.trim()).join('\n\n');
}
