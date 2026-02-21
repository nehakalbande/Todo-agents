# Todo-agents

A todo platform powered by **2 MCP agents + Claude AI**. Manage your todos by chatting in natural language — no buttons, no forms, just talk.

![Tech](https://img.shields.io/badge/Node.js-ES%20Modules-green) ![MCP](https://img.shields.io/badge/MCP-2%20Servers-blue) ![Claude](https://img.shields.io/badge/Claude-Sonnet%204.6-purple)

---

## How it works

```
You → "Add: Buy groceries, high priority"
         ↓
    Claude (orchestrator)
         ↓
    ┌────────────────┐     ┌─────────────────┐
    │ todo-storage   │     │   todo-ai        │
    │ MCP Server     │     │   MCP Server     │
    │                │     │                  │
    │ create_todo    │     │ prioritize_todos  │
    │ list_todos     │     │ summarize_todos   │
    │ update_todo    │     │ suggest_next_todo │
    │ complete_todo  │     │ categorize_todos  │
    │ delete_todo    │     │                  │
    └───────┬────────┘     └────────┬─────────┘
            │                       │
       todos.json            Claude Haiku
      (storage)              (AI analysis)
```

**MCP (Model Context Protocol)** is Anthropic's open standard for connecting AI to external tools. Each MCP server runs as a separate process and exposes tools Claude can call.

- **todo-storage MCP** — handles all data operations (CRUD) on a local JSON file
- **todo-ai MCP** — uses Claude Haiku internally to analyze and provide insights on your todos

---

## Features

- Chat naturally to add, update, complete, or delete todos
- AI-powered prioritization, summaries, and next-action suggestions
- Live tool-call indicators showing which MCP agent is working
- Todo panel with priority color bars and due date tracking
- Filter by All / Pending / Done
- Quick complete and delete buttons on each todo card

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | Vanilla HTML, CSS, JavaScript |
| Backend | Node.js + Express |
| AI Orchestrator | Claude Sonnet 4.6 |
| AI Analyst (internal) | Claude Haiku 4.5 |
| Agent Protocol | Model Context Protocol (MCP) |
| Storage | JSON file |

---

## Project Structure

```
todo-agents/
├── server.js                  # Express backend + MCP orchestrator + serves HTML
├── servers/
│   ├── todo-storage.js        # MCP Server 1 — CRUD operations
│   └── todo-ai.js             # MCP Server 2 — AI analysis
├── public/
│   ├── style.css              # Dark theme styles
│   └── app.js                 # Frontend logic + SSE streaming
├── data/
│   └── todos.json             # Local todo storage
├── .env.example               # Environment variable template
└── package.json
```

> No `.html` file — the page is served directly from `server.js` as a template string via `GET /`.

---

## Getting Started

### Prerequisites

- Node.js 18+
- An [Anthropic API key](https://console.anthropic.com)

### Installation

```bash
# Clone the repo
git clone https://github.com/nehakalbande/Todo-agents.git
cd todo-agents

# Install dependencies
npm install

# Set up environment
cp .env.example .env
# Edit .env and add your ANTHROPIC_API_KEY
```

### Run

```bash
npm start
```

Open [http://localhost:3000](http://localhost:3000)

---

## Usage Examples

| You say | Agent used |
|---|---|
| "Add: Review PR, high priority, due 2026-02-28" | 📦 todo-storage MCP |
| "Show all my pending todos" | 📦 todo-storage MCP |
| "Mark todo [ID] as done" | 📦 todo-storage MCP |
| "What should I work on next?" | 🤖 todo-ai MCP |
| "Prioritize my todos" | 🤖 todo-ai MCP |
| "Summarize my tasks" | 🤖 todo-ai MCP |
| "Group my todos into categories" | 🤖 todo-ai MCP |

---

## Environment Variables

| Variable | Description |
|---|---|
| `ANTHROPIC_API_KEY` | Your Anthropic API key |
| `PORT` | Server port (default: 3000) |

---

## License

MIT
