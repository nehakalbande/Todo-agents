/**
 * MCP Server 1: todo-storage
 *
 * Responsibility: All CRUD operations on todos.json
 * This server knows nothing about AI — it just stores and retrieves data.
 *
 * Tools exposed:
 *   - create_todo   → add a new todo
 *   - list_todos    → read todos with optional filters
 *   - update_todo   → edit title/description/priority/due_date
 *   - complete_todo → mark a todo as done
 *   - delete_todo   → remove a todo permanently
 *
 * Transport: stdio (spawned as a child process by server.js)
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE = path.join(__dirname, '../data/todos.json');

// ─── Data helpers ─────────────────────────────────────────────────────────────

async function readTodos() {
  try {
    const raw = await fs.readFile(DATA_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

async function writeTodos(todos) {
  await fs.mkdir(path.dirname(DATA_FILE), { recursive: true });
  await fs.writeFile(DATA_FILE, JSON.stringify(todos, null, 2));
}

// ─── MCP Server ───────────────────────────────────────────────────────────────

const server = new Server(
  { name: 'todo-storage', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

// List all tools this server exposes
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'create_todo',
      description: 'Create a new todo item and save it to storage',
      inputSchema: {
        type: 'object',
        properties: {
          title:       { type: 'string', description: 'Short title for the todo' },
          description: { type: 'string', description: 'Optional longer description' },
          priority:    { type: 'string', enum: ['low', 'medium', 'high'], description: 'Priority level (default: medium)' },
          due_date:    { type: 'string', description: 'Optional due date in YYYY-MM-DD format' },
        },
        required: ['title'],
      },
    },
    {
      name: 'list_todos',
      description: 'List todos, optionally filtered by status or priority',
      inputSchema: {
        type: 'object',
        properties: {
          status:   { type: 'string', enum: ['all', 'pending', 'completed'], description: 'Filter by completion status (default: all)' },
          priority: { type: 'string', enum: ['low', 'medium', 'high'], description: 'Filter by priority level' },
        },
      },
    },
    {
      name: 'update_todo',
      description: 'Update fields on an existing todo by its ID',
      inputSchema: {
        type: 'object',
        properties: {
          id:          { type: 'string', description: 'The todo ID to update' },
          title:       { type: 'string' },
          description: { type: 'string' },
          priority:    { type: 'string', enum: ['low', 'medium', 'high'] },
          due_date:    { type: 'string' },
        },
        required: ['id'],
      },
    },
    {
      name: 'complete_todo',
      description: 'Mark a todo as completed',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The todo ID to mark complete' },
        },
        required: ['id'],
      },
    },
    {
      name: 'delete_todo',
      description: 'Permanently delete a todo by its ID',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The todo ID to delete' },
        },
        required: ['id'],
      },
    },
  ],
}));

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  // ── create_todo ──────────────────────────────────────────────────────────
  if (name === 'create_todo') {
    const todos = await readTodos();
    const todo = {
      id:          Date.now().toString(),
      title:       args.title,
      description: args.description || '',
      priority:    args.priority || 'medium',
      due_date:    args.due_date || null,
      completed:   false,
      created_at:  new Date().toISOString(),
    };
    todos.push(todo);
    await writeTodos(todos);
    return {
      content: [{ type: 'text', text: `Created todo "${todo.title}" with ID ${todo.id}` }],
    };
  }

  // ── list_todos ───────────────────────────────────────────────────────────
  if (name === 'list_todos') {
    let todos = await readTodos();
    if (args.status === 'pending')   todos = todos.filter(t => !t.completed);
    if (args.status === 'completed') todos = todos.filter(t =>  t.completed);
    if (args.priority)               todos = todos.filter(t => t.priority === args.priority);

    if (todos.length === 0) {
      return { content: [{ type: 'text', text: 'No todos match the filter.' }] };
    }

    const lines = todos.map(t =>
      `[${t.id}] ${t.completed ? '✓' : '○'} ${t.title} | ${t.priority} priority` +
      (t.due_date    ? ` | due ${t.due_date}` : '') +
      (t.description ? ` | ${t.description}`  : '')
    );
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }

  // ── update_todo ──────────────────────────────────────────────────────────
  if (name === 'update_todo') {
    const todos = await readTodos();
    const idx = todos.findIndex(t => t.id === args.id);
    if (idx === -1) {
      return { content: [{ type: 'text', text: `No todo found with ID ${args.id}` }] };
    }
    if (args.title       !== undefined) todos[idx].title       = args.title;
    if (args.description !== undefined) todos[idx].description = args.description;
    if (args.priority    !== undefined) todos[idx].priority    = args.priority;
    if (args.due_date    !== undefined) todos[idx].due_date    = args.due_date;
    todos[idx].updated_at = new Date().toISOString();
    await writeTodos(todos);
    return { content: [{ type: 'text', text: `Updated todo "${todos[idx].title}"` }] };
  }

  // ── complete_todo ────────────────────────────────────────────────────────
  if (name === 'complete_todo') {
    const todos = await readTodos();
    const idx = todos.findIndex(t => t.id === args.id);
    if (idx === -1) {
      return { content: [{ type: 'text', text: `No todo found with ID ${args.id}` }] };
    }
    todos[idx].completed    = true;
    todos[idx].completed_at = new Date().toISOString();
    await writeTodos(todos);
    return { content: [{ type: 'text', text: `Marked "${todos[idx].title}" as complete ✓` }] };
  }

  // ── delete_todo ──────────────────────────────────────────────────────────
  if (name === 'delete_todo') {
    const todos = await readTodos();
    const idx = todos.findIndex(t => t.id === args.id);
    if (idx === -1) {
      return { content: [{ type: 'text', text: `No todo found with ID ${args.id}` }] };
    }
    const [deleted] = todos.splice(idx, 1);
    await writeTodos(todos);
    return { content: [{ type: 'text', text: `Deleted "${deleted.title}"` }] };
  }

  throw new Error(`Unknown tool: ${name}`);
});

// Start the server over stdio
const transport = new StdioServerTransport();
await server.connect(transport);
