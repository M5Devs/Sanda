'use strict';

const $ = (sel) => document.querySelector(sel);

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

// ---- ports ----------------------------------------------------------------

function setPortState(which, up) {
  const el = $(`#${which}-state`);
  el.className = `pill ${up ? 'pill-ok' : 'pill-idle'}`;
  el.textContent = up ? 'running' : 'stopped';
}

async function refresh() {
  try {
    const status = await api('/api/status');
    renderTools(status.tools);
    setPortState('desktop', status.running.desktop);
    setPortState('dsh', status.running.dsh);
    $('#desktop-link').href = portUrl(6080);

    const dshLink = $('#dsh-link');
    if (status.running.dsh) {
      dshLink.href = portUrl(3080);
      dshLink.hidden = false;
    } else {
      dshLink.hidden = true;
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

async function startDsh() {
  const btn = $('#start-dsh');
  btn.disabled = true;
  btn.textContent = 'Starting…';
  openLog('DeepSeek Harness web UI');
  appendLine({ s: 'meta', m: 'Starting dsh web on port 3080 (the first run downloads the package)…' });

  try {
    const result = await api('/api/start-dsh', {});
    if (result.running) {
      appendLine({ s: 'meta', m: 'Already running.' });
      refresh();
      return;
    }
    appendLine({ s: 'meta', m: `Started (pid ${result.pid}). Waiting for the port…` });

    let tries = 0;
    const timer = setInterval(async () => {
      tries += 1;
      try {
        const ports = await api('/api/ports');
        if (ports.dsh) {
          clearInterval(timer);
          appendLine({ s: 'meta', m: `Ready — ${portUrl(3080)}` });
          refresh();
        } else if (tries > 40) {
          clearInterval(timer);
          appendLine({ s: 'err', m: 'Port 3080 is still closed. Check /tmp/sanda-dsh-web.log.' });
        }
      } catch {
        /* keep polling */
      }
    }, 1500);
  } catch (err) {
    appendLine({ s: 'err', m: err.message });
  } finally {
    btn.disabled = false;
    btn.textContent = 'Start';
  }
}

// ---- wiring ---------------------------------------------------------------

$('#refresh').addEventListener('click', refresh);
$('#start-dsh').addEventListener('click', startDsh);
$('#log-clear').addEventListener('click', () => {
  logEl().textContent = '';
  $('#log-panel').hidden = true;
});

$('#exec-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const cmd = $('#cmd').value.trim();
  if (cmd) runCommand(cmd);
});

document.querySelectorAll('.chip').forEach((chip) => {
  chip.addEventListener('click', () => {
    $('#cmd').value = chip.dataset.cmd;
    runCommand(chip.dataset.cmd);
  });
});

refresh();
setInterval(() => {
  if (!document.hidden) refresh();
}, 15000);
