'use strict';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

// Codespaces serves every forwarded port as <name>-<port>.app.github.dev.
function portUrl(port) {
  const { protocol, hostname } = window.location;
  const match = hostname.match(/^(.*)-(\d+)\.app\.github\.dev$/);
  if (match) return `https://${match[1]}-${port}.app.github.dev`;
  return `${protocol}//${hostname}:${port}`;
}

async function api(path, body) {
  const options = body === undefined
    ? { headers: { Accept: 'application/json' } }
    : {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
      };
  const res = await fetch(path, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

const state = {
  tools: [],
  chat: { agent: 'pi', busy: false },
};

// ---- log viewer -----------------------------------------------------------

function logEl() { return $('#log'); }

function openLog(title) {
  $('#log-panel').hidden = false;
  $('#log-title').textContent = title;
  $('#log-status').textContent = '';
  logEl().textContent = '';
  $('#log-panel').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function appendText(text, cls) {
  if (!text) return;
  const span = document.createElement('span');
  if (cls) span.className = cls;
  span.textContent = text;
  const el = logEl();
  el.appendChild(span);
  el.scrollTop = el.scrollHeight;
}

function appendLine(entry) {
  const cls = entry.s === 'err' ? 'err' : entry.s === 'meta' ? 'meta' : '';
  appendText(`${entry.m}\n`, cls);
}

// ---- tools ----------------------------------------------------------------

function renderTools(tools) {
  const wrap = $('#tools');
  wrap.textContent = '';

  for (const tool of tools) {
    const card = document.createElement('div');
    card.className = 'tool';

    const body = document.createElement('div');
    body.className = 'tool-body';
    const name = document.createElement('strong');
    name.textContent = tool.label;
    const hint = document.createElement('small');
    hint.textContent = tool.installed ? (tool.path || 'installed') : (tool.hint || 'not installed');
    body.append(name, hint);

    const pill = document.createElement('span');
    pill.className = `pill ${tool.installed ? 'pill-ok' : 'pill-idle'}`;
    pill.textContent = tool.installed ? 'Installed' : 'Not installed';

    card.append(body, pill);

    if (!tool.installed) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn-small';
      btn.textContent = 'Install';
      btn.addEventListener('click', () => installTool(tool, btn));
      card.append(btn);
    }

    wrap.append(card);
  }

  const done = tools.filter((t) => t.installed).length;
  $('#tool-summary').textContent = `${done}/${tools.length} installed`;
}

async function installTool(tool, btn) {
  btn.disabled = true;
  btn.textContent = 'Installing…';
  openLog(`Installing ${tool.label}`);
  appendLine({ s: 'meta', m: `$ sanda install ${tool.install}` });

  try {
    const { id } = await api('/api/install', { tool: tool.id });
    const source = new EventSource(`/api/jobs/${id}/events`);

    source.onmessage = (event) => {
      try { appendLine(JSON.parse(event.data)); } catch { /* ignore */ }
    };

    source.addEventListener('done', (event) => {
      source.close();
      let code = 0;
      try { code = JSON.parse(event.data).code; } catch { /* ignore */ }
      appendLine({ s: code === 0 ? 'meta' : 'err', m: `— finished (exit ${code}) —` });
      btn.disabled = false;
      btn.textContent = 'Install';
      refresh();
    });

    source.onerror = () => {
      source.close();
      appendLine({ s: 'err', m: 'log stream closed' });
      btn.disabled = false;
      btn.textContent = 'Install';
      refresh();
    };
  } catch (err) {
    appendLine({ s: 'err', m: err.message });
    btn.disabled = false;
    btn.textContent = 'Install';
  }
}

// ---- launch cards ---------------------------------------------------------

const SERVICES = {
  dsh: { port: 3080, label: 'DeepSeek Harness', log: '/tmp/sanda-dsh-web.log' },
  opencode: { port: 4096, label: 'OpenCode Web', log: '/tmp/sanda-opencode.log' },
};

function setPortState(which, up) {
  const el = $(`#${which}-state`);
  el.className = `pill ${up ? 'pill-ok' : 'pill-idle'}`;
  el.textContent = up ? 'running' : 'stopped';
}

function setNote(id, text) {
  const el = $(`#${id}`);
  if (!el) return;
  el.textContent = text;
  el.hidden = !text;
}

// A 43-char password would otherwise force the card wider than the phone.
// <wbr> adds wrap points but contributes no text, so copy still yields the
// exact password.
function setPassword(password) {
  const el = $('#opencode-password');
  el.textContent = '';
  for (let i = 0; i < password.length; i += 8) {
    if (i) el.append(document.createElement('wbr'));
    el.append(password.slice(i, i + 8));
  }
}

function toggleLink(which, up, port, query) {
  const link = $(`#${which}-link`);
  if (!link) return;
  if (up) {
    link.href = portUrl(port) + (query ? `/?token=${encodeURIComponent(query)}` : '');
    link.hidden = false;
  } else {
    link.hidden = true;
  }
}

async function waitForPort(id, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const ports = await api('/api/ports');
      if (ports[id]) return true;
    } catch {
      /* keep polling */
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  return false;
}

async function startService(id, btn) {
  const svc = SERVICES[id];
  const noteId = `${id}-note`;
  const original = btn.textContent;

  setNote(noteId, '');
  btn.disabled = true;
  btn.textContent = 'Starting…';
  openLog(`Starting ${svc.label}`);
  appendLine({ s: 'meta', m: `Starting ${svc.label} on port ${svc.port}…` });

  try {
    const result = await api(`/api/start-${id}`, {});
    if (result.running) {
      appendLine({ s: 'meta', m: 'Already running.' });
      refresh();
      return;
    }
    if (result.install) {
      const msg = `${svc.label} is not installed yet — install it in AI coding tools above.`;
      setNote(noteId, msg);
      appendLine({ s: 'err', m: msg });
      return;
    }
    if (result.error) {
      setNote(noteId, result.error);
      appendLine({ s: 'err', m: result.error });
      return;
    }

    appendLine({ s: 'meta', m: `Started (pid ${result.pid}). Waiting for the port…` });
    const up = await waitForPort(id, 40000);
    if (up) {
      appendLine({ s: 'meta', m: `Ready — ${portUrl(svc.port)}` });
      if (id === 'opencode') {
        appendLine({ s: 'meta', m: 'OpenCode v2 prints a login password; it is shown on the card.' });
      }
    } else {
      setNote(noteId, `Port ${svc.port} is still closed. Check ${svc.log}.`);
      appendLine({ s: 'err', m: `Port ${svc.port} is still closed.` });
    }
    refresh();
  } catch (err) {
    setNote(noteId, err.message);
    appendLine({ s: 'err', m: err.message });
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

async function startAntigravity(btn) {
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Launching…';
  setNote('antigravity-note', '');

  try {
    const result = await api('/api/start-antigravity', {});
    if (result.install) {
      setNote('antigravity-note', 'Antigravity Desktop is not installed yet — install it above.');
      return;
    }
    if (!result.started) {
      const detail = result.log ? ` ${result.log.split('\n').slice(-2).join(' ')}` : '';
      setNote('antigravity-note', `${result.error || 'Launch failed'}.${detail}`);
      return;
    }
    setNote(
      'antigravity-note',
      `Running on DISPLAY ${result.display}. Open the Linux Desktop to use it.`
    );
    const pill = $('#antigravity-state');
    pill.className = 'pill pill-ok';
    pill.textContent = 'launched';
  } catch (err) {
    setNote('antigravity-note', err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

// ---- chat -----------------------------------------------------------------

function scrollChat() {
  const log = $('#chat-log');
  log.scrollTop = log.scrollHeight;
}

function addBubble(role, text) {
  const empty = $('#chat-log .chat-empty');
  if (empty) empty.remove();

  const bubble = document.createElement('div');
  bubble.className = `msg ${role}`;
  const pre = document.createElement('pre');
  pre.textContent = text;
  bubble.append(pre);
  $('#chat-log').append(bubble);
  scrollChat();
  return pre;
}

function appendBubble(pre, text) {
  pre.textContent += text;
  scrollChat();
}

function streamJob(id, onLine) {
  return new Promise((resolve) => {
    const source = new EventSource(`/api/jobs/${id}/events`);
    source.onmessage = (event) => {
      try { onLine(JSON.parse(event.data)); } catch { /* ignore */ }
    };
    source.addEventListener('done', () => {
      source.close();
      resolve();
    });
    source.onerror = () => {
      source.close();
      resolve();
    };
  });
}

async function sendChat(prompt) {
  const agent = state.chat.agent;
  state.chat.busy = true;
  const send = $('#chat-send');
  send.disabled = true;
  send.textContent = '…';

  addBubble('user', prompt);
  const pre = addBubble('agent', '');
  const bubble = pre.parentElement;
  bubble.classList.add('streaming');

  try {
    const { id } = await api('/api/chat', { agent, prompt });
    await streamJob(id, (line) => appendBubble(pre, `${line.m}\n`));
    if (!pre.textContent.trim()) appendBubble(pre, '(no output)');
  } catch (err) {
    appendBubble(pre, err.message);
    bubble.classList.add('failed');
  } finally {
    bubble.classList.remove('streaming');
    state.chat.busy = false;
    send.disabled = false;
    send.textContent = 'Send';
  }
}

function updateChatHint() {
  const info = state.tools.find((t) => t.id === state.chat.agent);
  if (info && !info.installed) {
    setNote('chat-hint', `${info.label} is not installed yet — install it above, then send.`);
  } else {
    setNote('chat-hint', '');
  }
}

function selectAgent(btn) {
  state.chat.agent = btn.dataset.agent;
  for (const other of $$('#chat-agents .seg')) {
    const active = other === btn;
    other.classList.toggle('is-active', active);
    other.setAttribute('aria-selected', String(active));
  }
  $('#chat-input').placeholder = `Ask ${btn.textContent} to explain this repo…`;
  updateChatHint();
}

// ---- status ---------------------------------------------------------------

async function refresh() {
  try {
    const status = await api('/api/status');
    state.tools = status.tools;
    renderTools(status.tools);
    updateChatHint();

    setPortState('desktop', status.running.desktop);
    setPortState('dsh', status.running.dsh);
    setPortState('opencode', status.running.opencode);
    $('#desktop-link').href = portUrl(6080);
    toggleLink('dsh', status.running.dsh, 3080, status.dsh && status.dsh.token);
    toggleLink('opencode', status.running.opencode, 4096);

    const antigravity = status.tools.find((t) => t.id === 'antigravity-desktop');
    const agPill = $('#antigravity-state');
    if (!antigravity || !antigravity.installed) {
      agPill.className = 'pill pill-idle';
      agPill.textContent = 'not installed';
    } else if (agPill.textContent !== 'launched') {
      agPill.className = 'pill pill-ok';
      agPill.textContent = 'ready';
    }

    const password = status.opencode && status.opencode.password;
    if (status.running.opencode && password) {
      setPassword(password);
      $('#opencode-password-row').hidden = false;
    } else {
      $('#opencode-password-row').hidden = true;
    }
  } catch {
    $('#tool-summary').textContent = 'dashboard offline';
  }
}

// ---- commands -------------------------------------------------------------

async function runCommand(cmd) {
  openLog(`$ ${cmd}`);
  appendLine({ s: 'meta', m: `$ ${cmd}` });

  try {
    const result = await api('/api/exec', { cmd });
    if (result.stdout) appendText(result.stdout.endsWith('\n') ? result.stdout : `${result.stdout}\n`);
    if (result.stderr) appendText(result.stderr.endsWith('\n') ? result.stderr : `${result.stderr}\n`, 'err');
    if (result.timedOut) appendLine({ s: 'err', m: '— timed out after 30s —' });
    else appendLine({ s: 'meta', m: `— exit ${result.code} —` });
  } catch (err) {
    appendLine({ s: 'err', m: err.message });
  }
}

// ---- wiring ---------------------------------------------------------------

$('#refresh').addEventListener('click', refresh);
$('#start-dsh').addEventListener('click', (event) => startService('dsh', event.currentTarget));
$('#start-opencode').addEventListener('click', (event) => startService('opencode', event.currentTarget));
$('#start-antigravity').addEventListener('click', (event) => startAntigravity(event.currentTarget));

$('#opencode-copy').addEventListener('click', async () => {
  const text = $('#opencode-password').textContent;
  const btn = $('#opencode-copy');
  try {
    await navigator.clipboard.writeText(text);
    btn.textContent = '✓';
    setTimeout(() => { btn.textContent = '⧉'; }, 1200);
  } catch {
    // Clipboard needs https or localhost; fall back to selecting the text.
    const range = document.createRange();
    range.selectNodeContents($('#opencode-password'));
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }
});

$('#log-clear').addEventListener('click', () => {
  logEl().textContent = '';
  $('#log-panel').hidden = true;
});

$('#exec-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const cmd = $('#cmd').value.trim();
  if (cmd) runCommand(cmd);
});

for (const chip of $$('.chip')) {
  chip.addEventListener('click', () => {
    $('#cmd').value = chip.dataset.cmd;
    runCommand(chip.dataset.cmd);
  });
}

for (const seg of $$('#chat-agents .seg')) {
  seg.addEventListener('click', () => selectAgent(seg));
}

$('#chat-form').addEventListener('submit', (event) => {
  event.preventDefault();
  if (state.chat.busy) return;
  const input = $('#chat-input');
  const prompt = input.value.trim();
  if (!prompt) return;
  input.value = '';
  sendChat(prompt);
});

// Enter inserts a newline on phones; Ctrl/Cmd+Enter sends from a keyboard.
$('#chat-input').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    $('#chat-form').requestSubmit();
  }
});

$('#chat-reset').addEventListener('click', () => {
  const log = $('#chat-log');
  log.textContent = '';
  const empty = document.createElement('p');
  empty.className = 'chat-empty';
  empty.textContent = 'Pick an agent, type a prompt, tap Send.';
  log.append(empty);
});

refresh();
setInterval(() => {
  if (!document.hidden) refresh();
}, 15000);
