/**
 * MCP Server 2: todo-ai
 *
 * Responsibility: AI-powered analysis of todos using Claude Haiku internally.
 * This server reads todos.json and calls Claude to generate insights.
 * It knows nothing about storage writes — read-only on the data.
 *
 * Tools exposed:
 *   - prioritize_todos   → rank todos by urgency/importance with reasoning
 *   - summarize_todos    → productivity overview and key stats
 *   - suggest_next_todo  → recommend the single best todo to do right now
 *   - categorize_todos   → group todos into logical themes
 *
 * Transport: stdio (spawned as a child process by server.js)
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE  = path.join(__dirname, '../data/todos.json');

async function readTodos() {
  try {
    const raw = await fs.readFile(DATA_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

// Claude client — used internally by this MCP server for AI analysis
// Uses claude-haiku-4-5 because these are fast, focused analytical prompts
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function askClaude(prompt) {
  const res = await anthropic.messages.create({
    model:      'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    messages:   [{ role: 'user', content: prompt }],
  });
  return res.content[0].text;
}

// ─── MCP Server ───────────────────────────────────────────────────────────────

const server = new Server(
  { name: 'todo-ai', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'prioritize_todos',
      description: 'AI-powered: analyze and rank all pending todos by urgency and importance, with reasoning for each rank',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'summarize_todos',
      description: 'AI-powered: generate a concise productivity summary — completion rate, deadlines, workload, key insights',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'suggest_next_todo',
      description: 'AI-powered: recommend the single best todo to work on right now, with reasoning',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'categorize_todos',
      description: 'AI-powered: group todos into 2–4 logical themes or categories',
      inputSchema: { type: 'object', properties: {} },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name } = request.params;
  const todos   = await readTodos();
  const pending = todos.filter(t => !t.completed);

  // Guard: no todos at all
  if (todos.length === 0) {
    return { content: [{ type: 'text', text: 'No todos found. Add some first!' }] };
  }

  // Guard: no pending todos for tools that only work on pending
  if (['prioritize_todos', 'suggest_next_todo'].includes(name) && pending.length === 0) {
    return { content: [{ type: 'text', text: 'All todos are completed — nothing left to analyze!' }] };
  }

  let prompt;

  if (name === 'prioritize_todos') {
    prompt = `You are a productivity coach. Here are the user's pending todos:

${JSON.stringify(pending, null, 2)}

Rank them from most to least urgent/important. For each, give:
1. Rank number
2. Title
3. One sentence explaining why it has this rank

Be concise. Consider due dates, priority labels, and implied urgency from the title.`;

  } else if (name === 'summarize_todos') {
    const completed = todos.filter(t => t.completed);
    const rate = todos.length > 0 ? Math.round((completed.length / todos.length) * 100) : 0;
    prompt = `You are a productivity assistant. Here is the user's todo list:

${JSON.stringify(todos, null, 2)}

Stats: ${todos.length} total, ${completed.length} completed (${rate}%), ${pending.length} pending.

Give a short productivity summary covering:
- Overall completion status
- Any overdue or urgent items
- One actionable insight or encouragement

Keep it under 5 sentences.`;

  } else if (name === 'suggest_next_todo') {
    prompt = `You are a productivity coach. Here are the user's pending todos:

${JSON.stringify(pending, null, 2)}

Which SINGLE todo should the user work on RIGHT NOW?
Reply with:
- The todo title (bold)
- 2 sentences explaining why this is the best next action

Consider: due dates, high priority labels, and what's most impactful.`;

  } else if (name === 'categorize_todos') {
    prompt = `You are an organizer. Here are all the user's todos:

${JSON.stringify(todos, null, 2)}

Group them into 2–4 logical categories. For each category:
- Category name (e.g. "Work", "Personal", "Health")
- List the todo titles under it

Use the actual content to determine categories, not the priority field.`;

  } else {
    throw new Error(`Unknown tool: ${name}`);
  }

  const result = await askClaude(prompt);
  return { content: [{ type: 'text', text: result }] };
});

// Start the server over stdio
const transport = new StdioServerTransport();
await server.connect(transport);
