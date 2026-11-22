#!/usr/bin/env node
'use strict';

// Sanda dashboard — zero-dependency HTTP server for port 4040.
//
//   GET  /api/health                     liveness probe (used by start.sh)
//   GET  /api/status                     tools, ports, chat agents, display
//   GET  /api/ports                      which local ports are listening
//   POST /api/install   {tool}           run `sanda install <tool>` as a job
//   POST /api/chat      {agent, prompt}  run pi/codex, resuming the agent session
//   POST /api/chat/reset {agent}         forget the stored session (New chat)
//   POST /api/exec      {cmd}            run one shell command
//   POST /api/start-dsh                  DeepSeek Harness web UI (3080)
//   POST /api/start-opencode             OpenCode v2 `serve` / v1 `web` (4096)
//   POST /api/start-antigravity          Antigravity Desktop inside XFCE (6080)
//   POST /api/stop-<service>             stop a service the hub started
//   GET  /api/jobs/:id/events            SSE stream of a job's output
//
// Binds 0.0.0.0 so Codespaces port forwarding always reaches it. Mutating
// requests must be JSON and come from the hub's own origin.

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const { spawn } = require('child_process');

const PORT = Number(process.env.SANDA_WEB_PORT || 4040);
const HOST = process.env.SANDA_WEB_HOST || '0.0.0.0';
const WEB_DIR = __dirname;
const PUBLIC_DIR = path.join(WEB_DIR, 'public');
const REPO_DIR = path.resolve(WEB_DIR, '..', '..');

// `sanda` is symlinked into /usr/local/bin by setup.sh; fall back to the repo
// copy so installs still work when that link is missing.
function sandaCommand() {
  if (process.env.SANDA_BIN) return { bin: process.env.SANDA_BIN, args: [] };
  const local = path.join(REPO_DIR, '.sanda', 'menu.sh');
  if (fs.existsSync(local)) return { bin: 'bash', args: [local] };
  return { bin: 'sanda', args: [] };
}

const DSH_PORT = 3080;
const DESKTOP_PORT = 6080;
const OPENCODE_PORT = 4096;

const DSH_LOG = '/tmp/sanda-dsh-web.log';
const OPENCODE_LOG = '/tmp/sanda-opencode.log';
const ANTIGRAVITY_LOG = '/tmp/sanda-antigravity.log';

// One pidfile per service the hub can spawn. A second tap (or a second tab)
// then finds the process instead of starting a duplicate.
const SERVICES = {
  dsh: {
    label: 'DeepSeek Harness',
    port: DSH_PORT,
    pidFile: '/tmp/sanda-dsh.pid',
  },
  opencode: {
    label: 'OpenCode Web',
    port: OPENCODE_PORT,
    pidFile: '/tmp/sanda-opencode.pid',
  },
  antigravity: {
    label: 'Antigravity Desktop',
    port: null,
    pidFile: '/tmp/sanda-antigravity.pid',
  },
};

// Chat sessions are stored by the agents themselves; the hub only remembers
// which session id to resume.
const CHAT_SESSION_DIR = '/tmp/sanda-chat';

const EXEC_TIMEOUT_MS = 30000;
const CHAT_TIMEOUT_MS = 240000;
const MAX_OUTPUT = 65536;
const MAX_LINES = 2000;

// OpenCode v2 installs into ~/.opencode/bin; v1 lives in the npm prefix.
const OPENCODE_PATHS = [
  path.join(os.homedir(), '.opencode/bin/opencode'),
  path.join(os.homedir(), '.local/bin/opencode'),
];

const TOOLS = [
  { id: 'dsh', label: 'DeepSeek Harness', hint: 'web UI on :3080', bin: 'dsh' },
  {
    id: 'opencode',
    label: 'OpenCode',
    hint: 'web UI on :4096',
    bin: 'opencode',
    extraPaths: OPENCODE_PATHS,
  },
  { id: 'pi', label: 'Pi coding agent', hint: 'chat below', bin: 'pi' },
  { id: 'codex', label: 'OpenAI Codex CLI', hint: 'chat below', bin: 'codex' },
  { id: 'agy', label: 'Antigravity CLI', hint: 'command: agy', bin: 'agy' },
  {
    id: 'antigravity-desktop',
    install: 'agy-desktop',
    label: 'Antigravity Desktop',
    hint: 'runs in the desktop',
    bin: 'antigravity',
    extraPaths: [
      path.join(os.homedir(), '.local/bin/antigravity'),
      path.join(os.homedir(), '.local/opt/antigravity/antigravity'),
      path.join(os.homedir(), '.local/opt/antigravity/Antigravity-x64/antigravity'),
    ],
  },
];

const CHAT_AGENTS = {
  pi: { label: 'Pi', bin: 'pi' },
  codex: { label: 'Codex', bin: 'codex' },
};

// nvm and ~/.opencode/bin are not on PATH in a non-login shell.
function buildSearchPath() {
  const dirs = [];
  const add = (d) => {
    if (d && !dirs.includes(d)) dirs.push(d);
  };
  add(path.join(os.homedir(), '.local/bin'));
  add(path.join(os.homedir(), '.opencode/bin'));
  add('/usr/local/share/nvm/current/bin');
  try {
    const nvmRoot = '/usr/local/share/nvm/versions/node';
    for (const v of fs.readdirSync(nvmRoot)) add(path.join(nvmRoot, v, 'bin'));
  } catch {
    /* nvm not installed */
  }
  for (const d of (process.env.PATH || '').split(':')) add(d);
  return dirs;
}

const SEARCH_PATH = buildSearchPath();
process.env.PATH = SEARCH_PATH.join(':');

function which(cmd, extraPaths) {
  const candidates = cmd.includes('/')
    ? [cmd]
    : SEARCH_PATH.map((d) => path.join(d, cmd)).concat(extraPaths || []);
  for (const p of candidates) {
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

function portOpen(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    const done = (result) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(400);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

function toolStatus() {
  return TOOLS.map((t) => {
    const p = which(t.bin, t.extraPaths);
    return {
      id: t.id,
      install: t.install || t.id,
      label: t.label,
      hint: t.hint || '',
      installed: Boolean(p),
      path: p || null,
    };
  });
}

function chatAgents() {
  return Object.entries(CHAT_AGENTS).map(([id, a]) => ({
    id,
    label: a.label,
    installed: Boolean(which(a.bin)),
  }));
}

// ---- Codespaces helpers ---------------------------------------------------

function forwardOrigin(port) {
  const cs = process.env.CODESPACE_NAME;
  const domain = process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN || 'app.github.dev';
  return cs ? `https://${cs}-${port}.${domain}` : null;
}

function detectDisplay() {
  const fromEnv = process.env.DISPLAY;
  if (fromEnv && /^:\d+/.test(fromEnv)) return fromEnv;

  const sockets = [];
  try {
    for (const entry of fs.readdirSync('/tmp/.X11-unix')) {
      const match = entry.match(/^X(\d+)$/);
      if (match) sockets.push(`:${match[1]}`);
    }
  } catch {
    /* no X sockets yet */
  }
  sockets.sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
  // desktop-lite starts its session on :1.
  return sockets.includes(':1') ? ':1' : sockets[0] || ':1';
}

function tailLog(file, lines) {
  try {
    return fs
      .readFileSync(file, 'utf8')
      .trimEnd()
      .split(/\r?\n/)
      .slice(-lines)
      .join('\n');
  } catch {
    return '';
  }
}

function opencodePassword() {
  const text = tailLog(OPENCODE_LOG, 200);
  const matches = [...text.matchAll(/server password\s+(\S+)/g)];
  return matches.length ? matches[matches.length - 1][1] : null;
}

// dsh prints "dsh web: http://127.0.0.1:3080/?token=..." and rejects requests
// without it, so the Open link has to carry the token.
function dshToken() {
  const text = tailLog(DSH_LOG, 200);
  const matches = [...text.matchAll(/[?&]token=([A-Za-z0-9_-]+)/g)];
  return matches.length ? matches[matches.length - 1][1] : null;
}

// ---- process helpers ------------------------------------------------------

const ANSI = /\u001b\[[0-9;?]*[A-Za-z]|\u001b\][^\u0007]*\u0007/g;

function stripAnsi(text) {
  return text.replace(ANSI, '');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Every service is spawned detached, so it leads its own process group; signal
// the group to take Electron/VNC helpers down with it.
function killGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    try {
      process.kill(pid, signal);
      return true;
    } catch {
      return false;
    }
  }
}

function truncateLog(file) {
  try {
    fs.writeFileSync(file, '');
  } catch {
    /* log directory is not writable; appending still works */
  }
}

function readPid(name) {
  const svc = SERVICES[name];
  if (!svc) return null;
  try {
    const pid = Number(fs.readFileSync(svc.pidFile, 'utf8').trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function writePid(name, pid) {
  try {
    fs.writeFileSync(SERVICES[name].pidFile, `${pid}\n`);
  } catch {
    /* pidfiles are a convenience; the port check still works without them */
  }
}

function clearPid(name) {
  try {
    fs.unlinkSync(SERVICES[name].pidFile);
  } catch {
    /* already gone */
  }
}

// The pidfile is only trusted while the process is alive.
function servicePid(name) {
  const pid = readPid(name);
  if (pid && alive(pid)) return pid;
  if (pid) clearPid(name);
  return null;
}

async function stopService(name) {
  const svc = SERVICES[name];
  if (!svc) return { stopped: false, error: 'unknown service' };

  const pid = servicePid(name);
  if (!pid) {
    const stillUp = svc.port ? await portOpen(svc.port) : false;
    if (stillUp) {
      return {
        stopped: false,
        running: true,
        error: `${svc.label} was started outside the hub; stop it from a terminal.`,
      };
    }
    return { stopped: false, running: false, wasRunning: false };
  }

  killGroup(pid, 'SIGTERM');
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline && alive(pid)) await sleep(150);
  if (alive(pid)) killGroup(pid, 'SIGKILL');
  clearPid(name);

  const closed = svc.port ? !(await portOpen(svc.port)) : !alive(pid);
  return { stopped: closed, wasRunning: true, pid };
}

// Starting is idempotent: concurrent requests share one spawn, and a service
// whose port is not up yet is reported as starting instead of spawned twice.
const starting = new Map();

function startOnce(name, fn) {
  if (starting.has(name)) return starting.get(name);
  const pending = (async () => {
    try {
      return await fn();
    } finally {
      starting.delete(name);
    }
  })();
  starting.set(name, pending);
  return pending;
}

function startingNow(name) {
  return starting.has(name);
}

// detached: true calls setsid(), so the child survives the parent (and the
// postStartCommand shell) exiting.
function spawnDetached(cmd, args, logFile, env) {
  // A fresh start gets a fresh log: these files are append-only for the life of
  // the process, and nothing rotates them.
  truncateLog(logFile);
  const log = fs.openSync(logFile, 'a');
  try {
    const child = spawn(cmd, args, {
      cwd: REPO_DIR,
      env: env || process.env,
      detached: true,
      stdio: ['ignore', log, log],
    });
    child.unref();
    return child.pid;
  } finally {
    fs.closeSync(log);
  }
}

function execCapture(cmd, args, timeoutMs, env) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer = null;

    const done = (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr });
    };

    let child;
    try {
      // Detached so a timeout can kill the whole group: `bash -lc` children
      // (npm, curl, a watcher) would otherwise outlive the request.
      child = spawn(cmd, args, { cwd: REPO_DIR, env: env || process.env, detached: true });
    } catch (err) {
      resolve({ code: 127, stdout, stderr: err.message });
      return;
    }

    timer = setTimeout(() => {
      killGroup(child.pid, 'SIGKILL');
      done(124);
    }, timeoutMs);

    child.stdout.on('data', (c) => {
      stdout = (stdout + c.toString('utf8')).slice(-MAX_OUTPUT);
    });
    child.stderr.on('data', (c) => {
      stderr = (stderr + c.toString('utf8')).slice(-MAX_OUTPUT);
    });
    child.on('error', (err) => {
      stderr += err.message;
      done(127);
    });
    child.on('close', (code) => done(code));
  });
}

// ---- jobs: streamed over SSE ---------------------------------------------

const jobs = new Map();
let jobSeq = 0;

function pruneJobs() {
  if (jobs.size <= 40) return;
  for (const [id, job] of jobs) {
    if (jobs.size <= 30) break;
    if (job.done) jobs.delete(id);
  }
}

function pushLine(job, stream, message) {
  const entry = { t: Date.now(), s: stream, m: stripAnsi(message) };
  job.lines.push(entry);
  if (job.lines.length > MAX_LINES) job.lines.shift();
  for (const res of job.subs) res.write(`data: ${JSON.stringify(entry)}\n\n`);
}

function finishJob(job, code) {
  if (job.done) return;
  job.done = true;
  job.code = code;
  const payload = JSON.stringify({ code });
  for (const res of job.subs) {
    res.write(`event: done\ndata: ${payload}\n\n`);
    res.end();
  }
  job.subs.clear();
  job.resolve(job);
}

function startJob(cmd, args, options = {}) {
  const id = `job${++jobSeq}`;
  const job = {
    id,
    label: options.label || `${path.basename(cmd)} ${args.join(' ')}`.slice(0, 120),
    lines: [],
    done: false,
    code: null,
    subs: new Set(),
  };
  job.finished = new Promise((resolve) => {
    job.resolve = resolve;
  });

  jobs.set(id, job);
  pruneJobs();

  let child;
  try {
    child = spawn(cmd, args, {
      cwd: options.cwd || REPO_DIR,
      env: options.env || process.env,
    });
  } catch (err) {
    pushLine(job, 'err', `failed to start: ${err.message}`);
    finishJob(job, 127);
    return job;
  }

  let timer = null;
  if (options.timeoutMs) {
    timer = setTimeout(() => {
      pushLine(job, 'err', `timed out after ${Math.round(options.timeoutMs / 1000)}s`);
      child.kill('SIGKILL');
    }, options.timeoutMs);
  }

  const push = (stream, chunk) => {
    for (const line of chunk.toString('utf8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      // options.transform can rewrite a line (Codex --json) or drop it.
      const events = options.transform ? options.transform(stream, line) : [{ s: stream, m: line }];
      for (const event of events || []) {
        if (event && event.m) pushLine(job, event.s || stream, event.m);
      }
    }
  };

  child.stdout.on('data', (c) => push('out', c));
  child.stderr.on('data', (c) => push('err', c));
  child.on('error', (err) => pushLine(job, 'err', `failed to start: ${err.message}`));
  child.on('close', (code) => {
    if (timer) clearTimeout(timer);
    finishJob(job, code);
  });

  return job;
}

function serveEvents(req, res, job) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');
  for (const line of job.lines) res.write(`data: ${JSON.stringify(line)}\n\n`);
  if (job.done) {
    res.write(`event: done\ndata: ${JSON.stringify({ code: job.code })}\n\n`);
    res.end();
    return;
  }
  job.subs.add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 15000);
  req.on('close', () => {
    clearInterval(ping);
    job.subs.delete(res);
  });
}

// ---- chat -----------------------------------------------------------------

const helpCache = new Map();

async function helpText(bin, preArgs) {
  const key = [bin, ...preArgs].join(' ');
  if (helpCache.has(key)) return helpCache.get(key);
  const result = await execCapture(bin, [...preArgs, '--help'], 8000);
  const text = `${result.stdout}\n${result.stderr}`;
  helpCache.set(key, text);
  return text;
}

// pi uses -p/--print, codex uses `exec`; both flags are probed from --help so
// older or newer releases degrade to a clear error instead of a broken command.
//
// Sessions: pi takes a stable --session-id, codex needs the thread id it prints
// on the first turn and `exec resume <id>` afterwards. The id is kept in
// /tmp/sanda-chat so the next message continues the same conversation.
function chatSessionFile(agentId) {
  return path.join(CHAT_SESSION_DIR, `${agentId}.session`);
}

function readChatSession(agentId) {
  try {
    return fs.readFileSync(chatSessionFile(agentId), 'utf8').trim() || null;
  } catch {
    return null;
  }
}

function writeChatSession(agentId, id) {
  try {
    fs.mkdirSync(CHAT_SESSION_DIR, { recursive: true });
    fs.writeFileSync(chatSessionFile(agentId), `${id}\n`);
  } catch {
    /* without a session file each message starts a new chat */
  }
}

function resetChatSession(agentId) {
  try {
    fs.rmSync(chatSessionFile(agentId), { force: true });
  } catch {
    /* nothing stored */
  }
}

// Codex --json streams one event per line; show the agent text, keep the rest
// out of the chat. The thread id is what a later `exec resume` needs.
function codexJsonFilter(agentId) {
  return (stream, line) => {
    const text = line.trim();
    if (!text.startsWith('{')) return [{ s: stream, m: line }];
    let event;
    try {
      event = JSON.parse(text);
    } catch {
      return [{ s: stream, m: line }];
    }
    if (event.type === 'thread.started' && event.thread_id) {
      writeChatSession(agentId, event.thread_id);
      return [];
    }
    if (event.type === 'item.completed') {
      const item = event.item || {};
      if (item.type === 'agent_message' && item.text) return [{ s: 'out', m: item.text }];
      if (item.type === 'command_execution' && item.command) return [{ s: 'meta', m: `$ ${item.command}` }];
      if (item.type === 'error' && item.message) return [{ s: 'err', m: item.message }];
      return [];
    }
    if (event.type === 'error' && event.message) return [{ s: 'err', m: event.message }];
    if (event.type === 'turn.failed') {
      return [{ s: 'err', m: (event.error && event.error.message) || 'turn failed' }];
    }
    return [];
  };
}

async function prepareChat(agentId, prompt) {
  const agent = CHAT_AGENTS[agentId];
  if (!agent) return { error: 'unknown agent' };

  const bin = which(agent.bin);
  if (!bin) {
    return { error: `${agent.label} is not installed yet`, install: agentId };
  }

  if (agentId === 'pi') {
    const help = await helpText(bin, []);
    if (!/--print/.test(help)) {
      return { error: 'This Pi build has no --print mode. Update Pi and try again.' };
    }
    const args = ['-p'];
    let session = readChatSession('pi');
    if (/--session-id/.test(help)) {
      if (!session) {
        session = `sanda-pi-${Date.now()}`;
        writeChatSession('pi', session);
      }
      args.push('--session-id', session);
    } else if (/--no-session/.test(help)) {
      args.push('--no-session');
      session = null;
    }
    args.push(prompt);
    return { bin, args, session, transform: null };
  }

  const help = await helpText(bin, ['exec']);
  if (!/codex exec/.test(help)) {
    return { error: 'This Codex build has no `exec` mode. Update Codex and try again.' };
  }

  const stored = readChatSession('codex');
  let resuming = false;
  if (stored) {
    const resumeHelp = await helpText(bin, ['exec', 'resume']);
    resuming = /codex exec resume/.test(resumeHelp);
  }

  const json = /--json/.test(help);
  const args = ['exec'];
  if (resuming) args.push('resume', stored);
  if (!resuming && /--color/.test(help)) args.push('--color', 'never');
  // --ephemeral would throw the session away, which is the opposite of what a
  // follow-up message needs.
  if (/--skip-git-repo-check/.test(help)) args.push('--skip-git-repo-check');
  if (!resuming && /-s, --sandbox/.test(help)) args.push('-s', 'workspace-write');
  if (json) args.push('--json');
  args.push(prompt);

  return {
    bin,
    args,
    session: resuming ? stored : null,
    resumed: resuming,
    transform: json ? codexJsonFilter('codex') : null,
  };
}

function chatEnv() {
  return { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0', TERM: 'dumb' };
}

// ---- service launchers ----------------------------------------------------

async function waitForPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await portOpen(port)) return true;
    await sleep(250);
  }
  return false;
}

// The spawn lock has to live until the port answers: releasing it right after
// spawn() lets a double-tap start a second instance before the first binds.
async function startDshWeb() {
  const args = ['web', '--port', String(DSH_PORT), '--no-open'];
  const trusted = forwardOrigin(DSH_PORT);
  if (trusted) args.push('--trusted-host', trusted.replace('https://', ''));

  // Prefer an installed `dsh`; npx would download it again into its cache.
  const dsh = which('dsh');
  const cmd = dsh || which('npx');
  if (!cmd) return { started: false, error: 'dsh is not installed and npx is missing' };

  const argv = dsh ? args : ['-y', '@deepseek-ai/dsh', ...args];
  const pid = spawnDetached(cmd, argv, DSH_LOG);
  writePid('dsh', pid);
  const ready = await waitForPort(DSH_PORT, 25000);
  return { started: true, ready, pid, port: DSH_PORT };
}

// OpenCode v2 is `opencode serve` (v2 API + web server); v1 used
// `opencode web`. Probe --help so either release works.
async function startOpencode() {
  const bin = which('opencode', OPENCODE_PATHS);
  if (!bin) {
    return { started: false, error: 'OpenCode is not installed yet', install: 'opencode' };
  }

  const help = await helpText(bin, []);
  let subcommand;
  if (/^\s+serve\s/m.test(help) || /\bserve\b.*web server/i.test(help)) subcommand = 'serve';
  else if (/^\s+web\s/m.test(help)) subcommand = 'web';
  else return { started: false, error: 'This OpenCode build has no web/serve command' };

  const args = [subcommand, '--port', String(OPENCODE_PORT), '--hostname', '0.0.0.0'];
  const origin = forwardOrigin(OPENCODE_PORT);
  if (origin) args.push('--cors', origin);

  const pid = spawnDetached(bin, args, OPENCODE_LOG);
  writePid('opencode', pid);
  const ready = await waitForPort(OPENCODE_PORT, 25000);
  return { started: true, ready, pid, port: OPENCODE_PORT, mode: subcommand };
}

async function startAntigravity() {
  const tool = TOOLS.find((t) => t.id === 'antigravity-desktop');
  const bin = which(tool.bin, tool.extraPaths);
  if (!bin) {
    return {
      started: false,
      error: 'Antigravity Desktop is not installed yet',
      install: 'antigravity-desktop',
    };
  }

  const display = detectDisplay();
  const pid = spawnDetached(bin, ['--no-sandbox'], ANTIGRAVITY_LOG, {
    ...process.env,
    DISPLAY: display,
  });
  writePid('antigravity', pid);

  // Electron exits fast when it cannot reach the X server; report that here
  // instead of leaving the user with a button that silently does nothing.
  await sleep(1500);
  if (!alive(pid)) {
    clearPid('antigravity');
    return {
      started: false,
      display,
      error: 'Antigravity exited right away',
      log: tailLog(ANTIGRAVITY_LOG, 12),
    };
  }

  return { started: true, pid, display, desktop: forwardOrigin(DESKTOP_PORT) };
}

// ---- helpers --------------------------------------------------------------

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store',
  });
  res.end(data);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1e6) {
        reject(new Error('request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error('invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

// Same origin, or the same Codespace's hub on its own port. Other ports of the
// same Codespace are separate apps (the desktop, an agent UI) and get no say.
const HUB_HOST = new RegExp(
  `^(?<prefix>.+)-${PORT}\\.(?:app\\.github\\.dev|githubpreview\\.dev)$`
);
function isAllowedOrigin(origin, host) {
  if (!origin) return true;
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.host === host) return true;
  const originMatch = parsed.hostname.match(HUB_HOST);
  const hostMatch = String(host || '').split(':')[0].match(HUB_HOST);
  return Boolean(
    originMatch && hostMatch && originMatch.groups.prefix === hostMatch.groups.prefix
  );
}

function isSafePost(req) {
  const type = String(req.headers['content-type'] || '');
  if (!type.includes('application/json')) return false;
  return isAllowedOrigin(req.headers.origin, req.headers.host);
}

function runCommand(cmd) {
  return execCapture('/bin/bash', ['-lc', cmd], EXEC_TIMEOUT_MS).then((result) => ({
    ...result,
    timedOut: result.code === 124,
  }));
}

// ---- static files ---------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const file = path.join(PUBLIC_DIR, rel);
  const inside = file === PUBLIC_DIR || file.startsWith(PUBLIC_DIR + path.sep);
  if (!inside) return json(res, 403, { error: 'forbidden' });

  fs.readFile(file, (err, data) => {
    if (err) {
      if (urlPath !== '/' && !path.extname(urlPath)) {
        return fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (err2, html) => {
          if (err2) return json(res, 404, { error: 'not found' });
          res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' });
          res.end(html);
        });
      }
      return json(res, 404, { error: 'not found' });
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      // Small local assets: always revalidate so edits show up on reload.
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(data);
  });
}

// ---- routes ---------------------------------------------------------------

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const route = url.pathname;

  if (req.method === 'GET' && route === '/api/health') {
    return json(res, 200, {
      ok: true,
      pid: process.pid,
      port: PORT,
      uptime: Math.round(process.uptime()),
    });
  }

  if (req.method === 'GET' && route === '/api/status') {
    // The payload carries the OpenCode password and the dsh token, so it gets
    // the same origin check as the mutating routes.
    if (!isAllowedOrigin(req.headers.origin, req.headers.host)) {
      return json(res, 403, { error: 'cross-origin request refused' });
    }
    const [dshUp, desktopUp, opencodeUp] = await Promise.all([
      portOpen(DSH_PORT),
      portOpen(DESKTOP_PORT),
      portOpen(OPENCODE_PORT),
    ]);
    const antigravityPid = servicePid('antigravity');
    return json(res, 200, {
      tools: toolStatus(),
      ports: { dashboard: PORT, dsh: DSH_PORT, desktop: DESKTOP_PORT, opencode: OPENCODE_PORT },
      running: {
        dsh: dshUp,
        desktop: desktopUp,
        opencode: opencodeUp,
        antigravity: Boolean(antigravityPid),
      },
      starting: {
        dsh: startingNow('dsh'),
        opencode: startingNow('opencode'),
        antigravity: startingNow('antigravity'),
      },
      pids: {
        dsh: servicePid('dsh'),
        opencode: servicePid('opencode'),
        antigravity: antigravityPid,
      },
      dsh: { port: DSH_PORT, token: dshUp ? dshToken() : null },
      opencode: { port: OPENCODE_PORT, password: opencodeUp ? opencodePassword() : null },
      chat: chatAgents().map((a) => ({ ...a, session: readChatSession(a.id) })),
      display: detectDisplay(),
      codespace: process.env.CODESPACE_NAME || null,
    });
  }

  if (req.method === 'GET' && route === '/api/ports') {
    const [dshUp, desktopUp, opencodeUp] = await Promise.all([
      portOpen(DSH_PORT),
      portOpen(DESKTOP_PORT),
      portOpen(OPENCODE_PORT),
    ]);
    return json(res, 200, {
      dsh: dshUp,
      desktop: desktopUp,
      opencode: opencodeUp,
      dashboard: true,
    });
  }

  const jobMatch = route.match(/^\/api\/jobs\/([^/]+)\/events$/);
  if (req.method === 'GET' && jobMatch) {
    const job = jobs.get(jobMatch[1]);
    if (!job) return json(res, 404, { error: 'unknown job' });
    return serveEvents(req, res, job);
  }

  if (route.startsWith('/api/') && req.method === 'POST' && !isSafePost(req)) {
    return json(res, 403, { error: 'expected same-origin application/json' });
  }

  if (req.method === 'POST' && route === '/api/install') {
    let body;
    try {
      body = await readJson(req);
    } catch (err) {
      return json(res, 400, { error: err.message });
    }
    const tool = TOOLS.find((t) => t.id === body.tool || t.install === body.tool);
    if (!tool) return json(res, 400, { error: 'unknown tool' });
    const sanda = sandaCommand();
    const job = startJob(sanda.bin, [...sanda.args, 'install', tool.install || tool.id]);
    return json(res, 202, { id: job.id, tool: tool.id });
  }

  if (req.method === 'POST' && route === '/api/chat') {
    let body;
    try {
      body = await readJson(req);
    } catch (err) {
      return json(res, 400, { error: err.message });
    }

    const agentId = String(body.agent || '').trim();
    const prompt = String(body.prompt || '').trim();
    if (!prompt) return json(res, 400, { error: 'prompt is required' });
    if (prompt.length > 8000) return json(res, 400, { error: 'prompt is too long (8000 max)' });

    const prepared = await prepareChat(agentId, prompt);
    if (prepared.error) return json(res, 400, prepared);

    const job = startJob(prepared.bin, prepared.args, {
      label: `${CHAT_AGENTS[agentId].label}: ${prompt.slice(0, 60)}`,
      timeoutMs: CHAT_TIMEOUT_MS,
      env: chatEnv(),
      transform: prepared.transform,
    });

    if (body.wait) {
      const done = await job.finished;
      // A resume that fails (session pruned, id unknown) should not poison the
      // next message: forget the id so the following turn starts fresh.
      if (prepared.resumed && done.code !== 0) resetChatSession(agentId);
      return json(res, 200, {
        id: job.id,
        agent: agentId,
        session: readChatSession(agentId),
        code: done.code,
        output: job.lines.map((l) => l.m).join('\n'),
      });
    }

    return json(res, 202, { id: job.id, agent: agentId, session: prepared.session });
  }

  if (req.method === 'POST' && route === '/api/chat/reset') {
    let body;
    try {
      body = await readJson(req);
    } catch (err) {
      return json(res, 400, { error: err.message });
    }
    const agentId = String(body.agent || '').trim();
    if (!CHAT_AGENTS[agentId]) return json(res, 400, { error: 'unknown agent' });
    resetChatSession(agentId);
    return json(res, 200, { ok: true, agent: agentId, session: null });
  }

  if (req.method === 'POST' && route === '/api/exec') {
    let body;
    try {
      body = await readJson(req);
    } catch (err) {
      return json(res, 400, { error: err.message });
    }
    const cmd = String(body.cmd || '').trim();
    if (!cmd) return json(res, 400, { error: 'cmd is required' });
    if (cmd.length > 500) return json(res, 400, { error: 'cmd is too long' });
    return json(res, 200, await runCommand(cmd));
  }

  if (req.method === 'POST' && route === '/api/start-dsh') {
    if (await portOpen(DSH_PORT)) {
      return json(res, 200, { started: false, running: true, pid: servicePid('dsh') });
    }
    if (startingNow('dsh')) return json(res, 200, { started: false, running: true, starting: true });
    const result = await startOnce('dsh', async () => startDshWeb());
    return json(res, result.started ? 202 : 500, result);
  }

  if (req.method === 'POST' && route === '/api/start-opencode') {
    if (await portOpen(OPENCODE_PORT)) {
      return json(res, 200, {
        started: false,
        running: true,
        pid: servicePid('opencode'),
        password: opencodePassword(),
      });
    }
    if (startingNow('opencode')) {
      return json(res, 200, { started: false, running: true, starting: true });
    }
    const result = await startOnce('opencode', async () => startOpencode());
    return json(res, result.started ? 202 : 400, result);
  }

  if (req.method === 'POST' && route === '/api/start-antigravity') {
    if (servicePid('antigravity')) {
      return json(res, 200, {
        started: false,
        running: true,
        pid: servicePid('antigravity'),
        display: detectDisplay(),
      });
    }
    if (startingNow('antigravity')) {
      return json(res, 200, { started: false, running: true, starting: true });
    }
    const result = await startOnce('antigravity', async () => startAntigravity());
    return json(res, result.started ? 202 : 400, result);
  }

  const stopMatch = route.match(/^\/api\/stop-(dsh|opencode|antigravity)$/);
  if (req.method === 'POST' && stopMatch) {
    const result = await stopService(stopMatch[1]);
    return json(res, result.error && !result.stopped ? 400 : 200, result);
  }

  if (req.method === 'GET' || req.method === 'HEAD') {
    if (route.startsWith('/api/')) return json(res, 404, { error: 'not found' });
    return serveStatic(res, route);
  }

  return json(res, 405, { error: 'method not allowed' });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error(`[sanda] request failed: ${err.stack || err.message}`);
    if (!res.headersSent) json(res, 500, { error: err.message });
    else res.end();
  });
});

server.on('error', (err) => {
  console.error(`[sanda] server error: ${err.message}`);
  // Let start.sh report the failure instead of crashing with a stack trace.
  if (err.code === 'EADDRINUSE') process.exit(1);
});

process.on('uncaughtException', (err) => {
  console.error(`[sanda] uncaught exception: ${err.stack || err.message}`);
});

process.on('unhandledRejection', (err) => {
  console.error(`[sanda] unhandled rejection: ${(err && err.stack) || err}`);
});

server.listen(PORT, HOST, () => {
  console.log(`[sanda] dashboard on http://${HOST}:${PORT} (pid ${process.pid})`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
