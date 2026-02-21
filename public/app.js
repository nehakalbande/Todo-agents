/**
 * Frontend — Todo AI Agent
 *
 * Handles:
 *  - Chat UI: sending messages, rendering bubbles, streaming SSE events
 *  - Tool call indicators: shows which MCP server is being used
 *  - Todo panel: fetches, filters, renders todo cards
 *  - Quick actions: complete/delete directly without Claude
 */

// ─── State ────────────────────────────────────────────────────────────────────

let history      = [];    // Full Claude conversation history (sent with each request)
let currentFilter = 'all'; // 'all' | 'pending' | 'completed'
let allTodos     = [];    // Latest fetched todos

// Tools that belong to todo-storage MCP (used to colour indicators)
const STORAGE_TOOLS = new Set([
  'create_todo', 'list_todos', 'update_todo', 'complete_todo', 'delete_todo',
]);

// ─── DOM refs ─────────────────────────────────────────────────────────────────

const messagesEl  = document.getElementById('messages');
const inputEl     = document.getElementById('chat-input');
const sendBtn     = document.getElementById('send-btn');
const todosListEl = document.getElementById('todos-list');
const filterTabs  = document.getElementById('filter-tabs');
const refreshBtn  = document.getElementById('refresh-btn');
const chatForm    = document.getElementById('chat-form');

// ─── Chat ─────────────────────────────────────────────────────────────────────

chatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  sendMessage();
});

refreshBtn.addEventListener('click', () => loadTodos());

filterTabs.addEventListener('click', (e) => {
  const btn = e.target.closest('.ftab');
  if (!btn) return;
  document.querySelectorAll('.ftab').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  currentFilter = btn.dataset.filter;
  renderTodos(allTodos);
});

async function sendMessage() {
  const text = inputEl.value.trim();
  if (!text || sendBtn.disabled) return;

  inputEl.value    = '';
  sendBtn.disabled = true;

  // Show user bubble
  appendBubble('user', escHtml(text));

  // Show typing indicator
  const typingEl = appendTyping();

  // Active tool indicators
  const indicators = [];

  try {
    const resp = await fetch('/api/chat', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ message: text, history }),
    });

    const reader  = resp.body.getReader();
    const decoder = new TextDecoder();
    let   buf     = '';
    let   typingRemoved = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop(); // keep incomplete line in buffer

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        let evt;
        try { evt = JSON.parse(line.slice(6)); } catch { continue; }

        // Remove typing bubble on first real event
        if (!typingRemoved) {
          typingEl.remove();
          typingRemoved = true;
        }

        if (evt.type === 'tool_call') {
          const isStorage = STORAGE_TOOLS.has(evt.name);
          const el = appendToolEvent(evt.name, isStorage ? 'storage' : 'ai', 'active');
          indicators.push({ el, name: evt.name });
        }

        if (evt.type === 'tool_result') {
          // Mark the matching indicator as done
          const ind = indicators.findLast(i => i.name === evt.name && !i.done);
          if (ind) {
            ind.done = true;
            ind.el.classList.remove('active', 'ai-active');
            ind.el.classList.add('done');
          }
          // Refresh todo panel if a storage tool ran
          if (STORAGE_TOOLS.has(evt.name)) loadTodos();
        }

        if (evt.type === 'response') {
          appendBubble('assistant', formatText(evt.text));
        }

        if (evt.type === 'done') {
          history = evt.messages;
        }

        if (evt.type === 'error') {
          appendBubble('assistant', `⚠️ ${escHtml(evt.message)}`);
        }
      }
    }

    // If typing was never removed (empty stream), remove it now
    if (!typingRemoved) typingEl.remove();

  } catch (err) {
    typingEl.remove();
    appendBubble('assistant', `⚠️ Connection error: ${escHtml(err.message)}`);
  }

  sendBtn.disabled = false;
  inputEl.focus();
}

// ─── Message Helpers ──────────────────────────────────────────────────────────

function appendBubble(role, html) {
  const wrap = document.createElement('div');
  wrap.className = `msg ${role}`;
  wrap.innerHTML = `<div class="bubble">${html}</div>`;
  messagesEl.appendChild(wrap);
  scrollChat();
  return wrap;
}

function appendTyping() {
  const wrap = document.createElement('div');
  wrap.className = 'msg assistant';
  wrap.innerHTML = `<div class="typing-bubble"><span></span><span></span><span></span></div>`;
  messagesEl.appendChild(wrap);
  scrollChat();
  return wrap;
}

function appendToolEvent(toolName, server, state) {
  const label = server === 'storage' ? '📦 todo-storage' : '🤖 todo-ai';
  const cls   = state === 'active' ? (server === 'storage' ? 'active' : 'ai-active') : 'done';

  const el = document.createElement('div');
  el.className = `tool-event ${cls}`;
  el.innerHTML = `
    <span class="tool-dot"></span>
    <span>${label} →</span>
    <span class="tool-name">${toolName}()</span>
  `;
  messagesEl.appendChild(el);
  scrollChat();
  return el;
}

function scrollChat() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

// ─── Todos Panel ──────────────────────────────────────────────────────────────

async function loadTodos() {
  try {
    const res = await fetch('/api/todos');
    allTodos = await res.json();
    renderTodos(allTodos);
  } catch { /* silently fail */ }
}

function renderTodos(todos) {
  const filtered = todos.filter(t => {
    if (currentFilter === 'pending')   return !t.completed;
    if (currentFilter === 'completed') return  t.completed;
    return true;
  });

  // Sort: pending first, then by priority weight, then by created_at
  const weight = { high: 0, medium: 1, low: 2 };
  filtered.sort((a, b) => {
    if (a.completed !== b.completed) return a.completed ? 1 : -1;
    return (weight[a.priority] ?? 1) - (weight[b.priority] ?? 1);
  });

  if (filtered.length === 0) {
    const labels = { all: 'No todos yet.\nStart by chatting with the AI!', pending: 'No pending todos.', completed: 'No completed todos yet.' };
    todosListEl.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">📋</div>
        <p>${labels[currentFilter] ?? ''}</p>
      </div>`;
    return;
  }

  todosListEl.innerHTML = filtered.map(todo => {
    const today   = new Date().toISOString().slice(0, 10);
    const overdue = todo.due_date && !todo.completed && todo.due_date < today;
    const doneClass = todo.completed ? 'done' : todo.priority;

    return `
      <div class="todo-card ${doneClass}" data-id="${todo.id}">
        <button class="check-btn" onclick="handleComplete('${todo.id}', ${todo.completed})" title="${todo.completed ? 'Completed' : 'Mark complete'}">
          ${todo.completed ? '✓' : ''}
        </button>

        <div class="card-body">
          <div class="card-title">${escHtml(todo.title)}</div>
          ${todo.description ? `<div class="card-desc">${escHtml(todo.description)}</div>` : ''}
          <div class="card-meta">
            <span class="pri-badge ${todo.priority}">${todo.priority}</span>
            ${todo.due_date ? `<span class="due-tag ${overdue ? 'overdue' : ''}">📅 ${todo.due_date}${overdue ? ' · overdue' : ''}</span>` : ''}
          </div>
        </div>

        <div class="card-actions">
          ${!todo.completed
            ? `<button class="act-btn comp" onclick="handleComplete('${todo.id}', false)" title="Mark complete">✓</button>`
            : ''}
          <button class="act-btn del" onclick="handleDelete('${todo.id}')" title="Delete">✕</button>
        </div>
      </div>`;
  }).join('');
}

async function handleComplete(id, isAlreadyDone) {
  if (isAlreadyDone) return;
  await fetch(`/api/todos/${id}/complete`, { method: 'POST' });
  await loadTodos();
}

async function handleDelete(id) {
  await fetch(`/api/todos/${id}`, { method: 'DELETE' });
  await loadTodos();
}

// ─── Text Utils ───────────────────────────────────────────────────────────────

function escHtml(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

function formatText(raw) {
  return escHtml(raw)
    .replace(/\*\*(.*?)\*\*/g,  '<strong>$1</strong>')
    .replace(/\*(.*?)\*/g,      '<em>$1</em>')
    .replace(/`([^`]+)`/g,      '<code>$1</code>')
    .replace(/\n/g,             '<br>');
}

// ─── Init ─────────────────────────────────────────────────────────────────────

loadTodos();
