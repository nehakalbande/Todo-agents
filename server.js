/**
 * Express backend — the orchestrator
 *
 * On startup:
 *   1. Spawns MCP Server 1 (todo-storage) as a child process via stdio
 *   2. Spawns MCP Server 2 (todo-ai) as a child process via stdio
 *   3. Collects all tools from both servers
 *   4. Serves the static frontend from /public
 *
 * API routes:
 *   POST /api/chat          → runs the agentic loop with Claude + both MCP servers
 *                             streams progress events via SSE
 *   GET  /api/todos         → returns todos.json directly (for the UI panel)
 *   POST /api/todos/:id/complete  → quick-complete from the UI
 *   DELETE /api/todos/:id         → quick-delete from the UI
 */

import express         from 'express';
import Anthropic       from '@anthropic-ai/sdk';
import { Client }      from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'url';
import path            from 'path';
import fs              from 'fs/promises';
import dotenv          from 'dotenv';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE  = path.join(__dirname, 'data/todos.json');

// ─── MCP Setup ────────────────────────────────────────────────────────────────

let storageClient, aiClient;

// allTools is what we send to Claude's API — each entry also carries
// a hidden _server field so we know which MCP to route the call to.
let allTools = [];

// Maps tool name → which server owns it
const toolServerMap = new Map();

async function spawnMCPClient(serverFile) {
  const client    = new Client({ name: 'todo-web', version: '1.0.0' }, { capabilities: {} });
  const transport = new StdioClientTransport({
    command: 'node',
    args:    [path.join(__dirname, 'servers', serverFile)],
    env:     { ...process.env },
  });
  await client.connect(transport);
  return client;
}

async function initMCP() {
  storageClient = await spawnMCPClient('todo-storage.js');
  aiClient      = await spawnMCPClient('todo-ai.js');

  const [storageMeta, aiMeta] = await Promise.all([
    storageClient.listTools(),
    aiClient.listTools(),
  ]);

  // Register tools from MCP Server 1
  for (const t of storageMeta.tools) {
    toolServerMap.set(t.name, 'storage');
    allTools.push({ name: t.name, description: t.description, input_schema: t.inputSchema });
  }

  // Register tools from MCP Server 2
  for (const t of aiMeta.tools) {
    toolServerMap.set(t.name, 'ai');
    allTools.push({ name: t.name, description: t.description, input_schema: t.inputSchema });
  }

  console.log(`✅ todo-storage MCP: ${storageMeta.tools.length} tools → ${storageMeta.tools.map(t => t.name).join(', ')}`);
  console.log(`✅ todo-ai MCP:      ${aiMeta.tools.length} tools → ${aiMeta.tools.map(t => t.name).join(', ')}`);
}

async function callMCPTool(name, args) {
  const server = toolServerMap.get(name);
  if (!server) throw new Error(`No MCP server registered for tool: ${name}`);
  const client = server === 'storage' ? storageClient : aiClient;
  const result = await client.callTool({ name, arguments: args });
  return result.content[0]?.text ?? '';
}

// ─── Claude Setup ─────────────────────────────────────────────────────────────

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `You are a helpful todo assistant connected to two specialized MCP agents:

1. **todo-storage MCP** (tools: create_todo, list_todos, update_todo, complete_todo, delete_todo)
   → Use for any create, read, update, or delete operation on todos.

2. **todo-ai MCP** (tools: prioritize_todos, summarize_todos, suggest_next_todo, categorize_todos)
   → Use for AI-powered analysis: prioritization, summaries, recommendations, categorization.

Guidelines:
- When a user wants to add/create a todo → call create_todo immediately
- When they want to see their list → call list_todos
- When they ask what to work on / what's important → use suggest_next_todo or prioritize_todos
- For overviews or stats → use summarize_todos
- Be concise in your final reply — the UI already shows the todo list`;

// ─── Express App ──────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Serve the app shell — no index.html file needed
app.get('/', (_req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Todo AI Agent</title>
  <link rel="stylesheet" href="style.css" />
</head>
<body>
  <div class="app">
    <header class="header">
      <div class="logo">
        <div class="logo-icon">✓</div>
        <span class="logo-text">Todo AI Agent</span>
      </div>
      <div class="agent-pills">
        <div class="pill storage"><span class="pill-dot"></span><span>todo-storage MCP</span></div>
        <div class="pill ai"><span class="pill-dot"></span><span>todo-ai MCP</span></div>
      </div>
    </header>
    <main class="main">
      <section class="chat-panel">
        <div class="panel-title">
          <span>AI Assistant</span>
          <span class="panel-hint">Type naturally — e.g. "add buy groceries, high priority"</span>
        </div>
        <div class="messages" id="messages">
          <div class="msg assistant">
            <div class="bubble">
              👋 Hi! I'm your Todo AI Agent powered by two MCP servers.<br><br>
              <strong>Try:</strong><br>
              &bull; "Add a todo: Review PR, high priority, due 2026-02-28"<br>
              &bull; "What should I work on next?"<br>
              &bull; "Prioritize my todos"<br>
              &bull; "Summarize my tasks"
            </div>
          </div>
        </div>
        <form class="input-row" id="chat-form" autocomplete="off">
          <input id="chat-input" type="text" placeholder="Ask me anything about your todos…" />
          <button type="submit" id="send-btn">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="22" y1="2" x2="11" y2="13"/>
              <polygon points="22 2 15 22 11 13 2 9 22 2"/>
            </svg>
          </button>
        </form>
      </section>
      <section class="todos-panel">
        <div class="panel-title">
          <span>My Todos</span>
          <div class="todos-controls">
            <div class="filter-tabs" id="filter-tabs">
              <button class="ftab active" data-filter="all">All</button>
              <button class="ftab" data-filter="pending">Pending</button>
              <button class="ftab" data-filter="completed">Done</button>
            </div>
            <button class="icon-btn" id="refresh-btn" title="Refresh">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M23 4v6h-6"/><path d="M1 20v-6h6"/>
                <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
              </svg>
            </button>
          </div>
        </div>
        <div class="todos-list" id="todos-list">
          <div class="empty-state">
            <div class="empty-icon">📋</div>
            <p>No todos yet.<br>Start by chatting with the AI!</p>
          </div>
        </div>
      </section>
    </main>
  </div>
  <script src="app.js"></script>
</body>
</html>`);
});

/**
 * POST /api/chat
 *
 * Body: { message: string, history: Message[] }
 *
 * Streams SSE events:
 *   { type: 'tool_call',   name, input }        — Claude is calling a tool
 *   { type: 'tool_result', name, result }        — tool returned a result
 *   { type: 'response',    text }                — Claude's final text
 *   { type: 'done',        messages }            — full updated history
 *   { type: 'error',       message }             — something went wrong
 */
app.post('/api/chat', async (req, res) => {
  const { message, history = [] } = req.body;

  // Set up Server-Sent Events
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  try {
    const messages = [...history, { role: 'user', content: message }];

    // Agentic loop: keep going until Claude stops calling tools
    while (true) {
      const response = await anthropic.messages.create({
        model:      'claude-sonnet-4-6',
        max_tokens: 4096,
        system:     SYSTEM_PROMPT,
        messages,
        tools:      allTools,
      });

      if (response.stop_reason === 'tool_use') {
        // Claude wants to call one or more tools
        messages.push({ role: 'assistant', content: response.content });

        const toolResults = [];

        for (const block of response.content) {
          if (block.type !== 'tool_use') continue;

          send({ type: 'tool_call', name: block.name, input: block.input });

          const result = await callMCPTool(block.name, block.input);

          send({ type: 'tool_result', name: block.name, result });

          toolResults.push({
            type:        'tool_result',
            tool_use_id: block.id,
            content:     result,
          });
        }

        messages.push({ role: 'user', content: toolResults });

      } else {
        // Claude is done — send the final text response
        const text = response.content.find(b => b.type === 'text')?.text ?? '';
        messages.push({ role: 'assistant', content: response.content });

        send({ type: 'response', text });
        send({ type: 'done',     messages });
        break;
      }
    }
  } catch (err) {
    send({ type: 'error', message: err.message });
  }

  res.end();
});

/**
 * GET /api/todos
 * Returns the raw todos.json array — used by the UI to refresh the panel.
 */
app.get('/api/todos', async (_req, res) => {
  try {
    const raw = await fs.readFile(DATA_FILE, 'utf-8');
    res.json(JSON.parse(raw));
  } catch {
    res.json([]);
  }
});

/**
 * POST /api/todos/:id/complete
 * Quick-complete from the UI button (bypasses Claude for speed).
 */
app.post('/api/todos/:id/complete', async (req, res) => {
  try {
    const raw   = await fs.readFile(DATA_FILE, 'utf-8');
    const todos = JSON.parse(raw);
    const idx   = todos.findIndex(t => t.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Not found' });
    todos[idx].completed    = true;
    todos[idx].completed_at = new Date().toISOString();
    await fs.writeFile(DATA_FILE, JSON.stringify(todos, null, 2));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/todos/:id
 * Quick-delete from the UI button (bypasses Claude for speed).
 */
app.delete('/api/todos/:id', async (req, res) => {
  try {
    const raw   = await fs.readFile(DATA_FILE, 'utf-8');
    const todos = JSON.parse(raw);
    const idx   = todos.findIndex(t => t.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Not found' });
    todos.splice(idx, 1);
    await fs.writeFile(DATA_FILE, JSON.stringify(todos, null, 2));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;

initMCP().then(() => {
  app.listen(PORT, () => {
    console.log(`\n🚀  Todo Agents → http://localhost:${PORT}`);
    console.log(`     📦  MCP 1: todo-storage  (CRUD operations)`);
    console.log(`     🤖  MCP 2: todo-ai        (AI analysis)\n`);
  });
}).catch(err => {
  console.error('Failed to init MCP servers:', err);
  process.exit(1);
});
