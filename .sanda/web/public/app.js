'use strict';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

// Codespaces serves every forwarded port as <name>-<port>.<domain>, on both the
// current app.github.dev domain and the older githubpreview.dev one.
const CODESPACE_HOST = /^(.*)-(\d+)\.(app\.github\.dev|githubpreview\.dev)$/;

function portUrl(port) {
  const { protocol, hostname } = window.location;
  const match = hostname.match(CODESPACE_HOST);
  if (match) return `https://${match[1]}-${port}.${match[3]}`;
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
  // Jobs and service actions that are still running. The 15s status poll must
  // not reset a button that belongs to an action the user just started.
  installs: new Set(),
  busy: new Set(),
  sessions: {},
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
      // A poll in the middle of an install rebuilds this card; keep the job
      // visible instead of offering a second Install.
      const running = state.installs.has(tool.id);
      btn.textContent = running ? 'Installing…' : 'Install';
      btn.disabled = running;
      btn.addEventListener('click', () => installTool(tool, btn));
      card.append(btn);
    }

    wrap.append(card);
  }

  const done = tools.filter((t) => t.installed).length;
  $('#tool-summary').textContent = `${done}/${tools.length} installed`;
}

async function installTool(tool, btn) {
  state.installs.add(tool.id);
  btn.disabled = true;
  btn.textContent = 'Installing…';
  openLog(`Installing ${tool.label}`);
  appendLine({ s: 'meta', m: `$ sanda install ${tool.install}` });

  const finish = () => {
    state.installs.delete(tool.id);
    btn.disabled = false;
    btn.textContent = 'Install';
    refresh();
  };

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
      finish();
    });

    source.onerror = () => {
      source.close();
      appendLine({ s: 'err', m: 'log stream closed' });
      finish();
    };
  } catch (err) {
    appendLine({ s: 'err', m: err.message });
    finish();
  }
}

// ---- launch cards ---------------------------------------------------------

const SERVICES = {
  dsh: { port: 3080, label: 'DeepSeek Harness', log: '/tmp/sanda-dsh-web.log' },
  opencode: { port: 4096, label: 'OpenCode Web', log: '/tmp/sanda-opencode.log' },
};

function setPortState(which, up) {
  const el = $(`#${which}-state`);
  if (!el) return;
  el.className = `pill ${up ? 'pill-ok' : 'pill-idle'}`;
  el.textContent = up ? 'running' : 'stopped';
}

function setNote(id, text) {
  const el = $(`#${id}`);
  if (!el) return;
  el.textContent = text;
  el.hidden = !text;
}

// A 43-char secret would otherwise force the card wider than the phone.
// <wbr> adds wrap points but contributes no text, so copy still yields the
// exact value.
function setSecret(el, value) {
  el.textContent = '';
  for (let i = 0; i < value.length; i += 8) {
    if (i) el.append(document.createElement('wbr'));
    el.append(value.slice(i, i + 8));
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

// Start when stopped; Stop + Restart when running. Hidden buttons keep their
// tap target out of the way on a phone.
function setServiceButtons(id, running) {
  const start = $(`#start-${id}`);
  const stop = $(`#${id}-stop`);
  const restart = $(`#${id}-restart`);
  const busy = state.busy.has(id);
  if (start) {
    start.hidden = running;
    start.disabled = busy;
    if (!busy) start.textContent = id === 'antigravity' ? 'Launch' : 'Start';
  }
  for (const btn of [stop, restart]) {
    if (!btn) continue;
    btn.hidden = !running;
    btn.disabled = busy;
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

async function waitForPortDown(id, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const ports = await api('/api/ports');
      if (!ports[id]) return true;
    } catch {
      /* keep polling */
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

async function startService(id) {
  const svc = SERVICES[id];
  const noteId = `${id}-note`;
  const btn = $(`#start-${id}`);

  state.busy.add(id);
  setNote(noteId, '');
  setServiceButtons(id, false);
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Starting…';
  }
  openLog(`Starting ${svc.label}`);
  appendLine({ s: 'meta', m: `Starting ${svc.label} on port ${svc.port}…` });

  try {
    const result = await api(`/api/start-${id}`, {});
    if (result.running) {
      appendLine({ s: 'meta', m: result.starting ? 'Already starting…' : 'Already running.' });
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
  } catch (err) {
    setNote(noteId, err.message);
    appendLine({ s: 'err', m: err.message });
  } finally {
    state.busy.delete(id);
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Start';
    }
    refresh();
  }
}

async function stopService(id) {
  const svc = SERVICES[id] || { label: 'Antigravity Desktop' };
  const btn = $(`#${id}-stop`);

  state.busy.add(id);
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Stopping…';
  }
  openLog(`Stopping ${svc.label}`);

  try {
    const result = await api(`/api/stop-${id}`, {});
    if (result.error) {
      setNote(`${id}-note`, result.error);
      appendLine({ s: 'err', m: result.error });
    } else if (result.wasRunning === false) {
      appendLine({ s: 'meta', m: `${svc.label} was not running.` });
    } else {
      appendLine({ s: 'meta', m: `Stopped (pid ${result.pid}).` });
    }
    if (id === 'opencode') $('#opencode-password-row').hidden = true;
  } catch (err) {
    setNote(`${id}-note`, err.message);
    appendLine({ s: 'err', m: err.message });
  } finally {
    state.busy.delete(id);
    if (btn) btn.textContent = 'Stop';
    refresh();
  }
}

async function restartService(id) {
  if (state.busy.has(id)) return;
  await stopService(id);
  if (SERVICES[id]) {
    await waitForPortDown(id, 15000);
    await startService(id);
  } else {
    await startAntigravity();
  }
}

async function startAntigravity() {
  const btn = $('#start-antigravity');
  state.busy.add('antigravity');
  setNote('antigravity-note', '');
  setServiceButtons('antigravity', false);
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Launching…';
  }

  try {
    const result = await api('/api/start-antigravity', {});
    if (result.install) {
      setNote('antigravity-note', 'Antigravity Desktop is not installed yet — install it above.');
      return;
    }
    if (!result.started && !result.running) {
      const detail = result.log ? ` ${result.log.split('\n').slice(-2).join(' ')}` : '';
      setNote('antigravity-note', `${result.error || 'Launch failed'}.${detail}`);
      return;
    }
    setNote(
      'antigravity-note',
      `Running on DISPLAY ${result.display}. Open the Linux Desktop to use it.`
    );
  } catch (err) {
    setNote('antigravity-note', err.message);
  } finally {
    state.busy.delete('antigravity');
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Launch';
    }
    refresh();
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
    refresh();
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

// "continuing chat" tells the user the next message carries the conversation;
// New chat forgets the stored session.
function updateChatSession() {
  const el = $('#chat-session');
  if (!el) return;
  el.textContent = state.sessions[state.chat.agent] ? 'continuing chat' : 'new chat';
}

function clearChatLog() {
  const log = $('#chat-log');
  log.textContent = '';
  const empty = document.createElement('p');
  empty.className = 'chat-empty';
  empty.textContent = 'Pick an agent, type a prompt, tap Send.';
  log.append(empty);
}

async function newChat() {
  const agent = state.chat.agent;
  try {
    await api('/api/chat/reset', { agent });
    state.sessions[agent] = null;
  } catch (err) {
    setNote('chat-hint', err.message);
  }
  clearChatLog();
  updateChatSession();
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
  updateChatSession();
}

// ---- status ---------------------------------------------------------------

async function refresh() {
  try {
    const status = await api('/api/status');
    state.tools = status.tools;
    renderTools(status.tools);
    updateChatHint();

    for (const agent of status.chat || []) state.sessions[agent.id] = agent.session;
    updateChatSession();

    // While an action owns a card, leave its buttons alone: a poll landing in
    // the middle of "Starting…" must not re-enable Start.
    for (const id of ['dsh', 'opencode']) {
      const up = Boolean(status.running[id]);
      if (!state.busy.has(id)) setPortState(id, up);
      setServiceButtons(id, up);
    }

    setPortState('desktop', status.running.desktop);
    $('#desktop-link').href = portUrl(6080);
    // The 3080 proxy signs the browser in itself; no token in the link.
    toggleLink('dsh', status.running.dsh, 3080);
    toggleLink('opencode', status.running.opencode, 4096);

    const antigravity = status.tools.find((t) => t.id === 'antigravity-desktop');
    const agy = status.tools.find((t) => t.id === 'agy');
    const agPill = $('#antigravity-state');
    const agRunning = Boolean(status.running.antigravity);
    // One Google sign-in covers both the CLI and the desktop app.
    $('#agy-signin').hidden = !(agy && agy.installed);
    if (!antigravity || !antigravity.installed) {
      agPill.className = 'pill pill-idle';
      agPill.textContent = 'not installed';
      setServiceButtons('antigravity', false);
    } else {
      if (!state.busy.has('antigravity')) setPortState('antigravity', agRunning);
      setServiceButtons('antigravity', agRunning);
    }

    const password = status.opencode && status.opencode.password;
    if (status.running.opencode && password) {
      setSecret($('#opencode-password'), password);
      $('#opencode-password-row').hidden = false;
    } else {
      $('#opencode-password-row').hidden = true;
    }

    // dsh answers 401 to any request without its per-process token, and the
    // Codespaces first-visit redirect can drop the ?token= query. Keep the
    // token on the card so it can be copied, or Open re-tapped.
    const dshToken = status.dsh && status.dsh.token;
    if (status.running.dsh && dshToken) {
      setSecret($('#dsh-token'), dshToken);
      $('#dsh-token-row').hidden = false;
      setNote('dsh-note', '');
    } else {
      $('#dsh-token-row').hidden = true;
      if (status.running.dsh) {
        setNote(
          'dsh-note',
          'dsh is running but has not printed its token yet, so the auto sign-in on port 3080 cannot work. Restart it here.'
        );
      }
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

for (const id of ['dsh', 'opencode']) {
  $(`#start-${id}`).addEventListener('click', () => startService(id));
  $(`#${id}-stop`).addEventListener('click', () => stopService(id));
  $(`#${id}-restart`).addEventListener('click', () => restartService(id));
}
$('#agy-signin').addEventListener('click', async () => {
  const panel = $('#agy-auth');
  const button = $('#agy-signin');
  button.disabled = true;
  button.textContent = 'Starting…';
  setNote('agy-auth-status', 'Asking agy for a Google sign-in link…');
  try {
    const result = await api('/api/antigravity/auth-start', {});
    if (!result.ok) {
      setNote('agy-auth-status', result.error);
      panel.hidden = true;
      return;
    }
    $('#agy-auth-url').href = result.url;
    $('#agy-auth-host').textContent = 'accounts.google.com · code is valid for a few minutes';
    panel.hidden = false;
    setNote('agy-auth-status', 'Open the link, sign in, then paste the code below.');
  } catch (err) {
    setNote('agy-auth-status', err.message);
  } finally {
    button.disabled = false;
    button.textContent = 'Sign in with Google';
  }
});

$('#agy-auth-submit').addEventListener('click', async () => {
  const input = $('#agy-auth-code');
  const code = input.value.trim();
  if (!code) {
    setNote('agy-auth-status', 'Paste the code Google showed you first.');
    return;
  }
  const button = $('#agy-auth-submit');
  button.disabled = true;
  setNote('agy-auth-status', 'Checking the code with Google…');
  try {
    const result = await api('/api/antigravity/auth-code', { code });
    if (result.ok) {
      input.value = '';
      $('#agy-auth').hidden = true;
      setNote('agy-auth-status', '');
      setNote('antigravity-note', result.message);
    } else {
      setNote('agy-auth-status', `${result.error} — tap Sign in with Google to get a fresh link.`);
    }
  } catch (err) {
    setNote('agy-auth-status', err.message);
  } finally {
    button.disabled = false;
  }
});

$('#start-antigravity').addEventListener('click', startAntigravity);
$('#antigravity-stop').addEventListener('click', () => stopService('antigravity'));
$('#antigravity-restart').addEventListener('click', () => restartService('antigravity'));

async function copySecret(valueEl, btn) {
  try {
    await navigator.clipboard.writeText(valueEl.textContent);
    btn.textContent = '✓';
    setTimeout(() => { btn.textContent = '⧉'; }, 1200);
  } catch {
    // Clipboard needs https or localhost; fall back to selecting the text.
    const range = document.createRange();
    range.selectNodeContents(valueEl);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }
}

$('#opencode-copy').addEventListener('click', () =>
  copySecret($('#opencode-password'), $('#opencode-copy'))
);
$('#dsh-copy').addEventListener('click', () => copySecret($('#dsh-token'), $('#dsh-copy')));

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

$('#chat-reset').addEventListener('click', newChat);

refresh();
setInterval(() => {
  if (!document.hidden) refresh();
}, 15000);
