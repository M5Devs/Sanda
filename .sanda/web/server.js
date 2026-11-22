#!/usr/bin/env node
'use strict';

// Sanda dashboard — zero-dependency HTTP server for port 4040.
//
// Serves a mobile-first control panel and a tiny JSON API:
//   GET  /api/health                liveness probe
//   GET  /api/status                installed tools + ports
//   GET  /api/ports                 which local ports are listening
//   POST /api/install  {tool}       start `sanda install <tool>`, returns {id}
//   GET  /api/jobs/:id/events       SSE stream of install output
//   POST /api/exec     {cmd}        run a shell command, returns its output
//   POST /api/start-dsh             start the DeepSeek Harness web UI
//
// It binds to 127.0.0.1 and is meant to be reached through Codespaces port
// forwarding. State-changing requests must be same-origin and JSON-encoded.

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const { spawn } = require('child_process');

const PORT = Number(process.env.SANDA_WEB_PORT || 4040);
const HOST = process.env.SANDA_WEB_HOST || '127.0.0.1';
const WEB_DIR = __dirname;
const PUBLIC_DIR = path.join(WEB_DIR, 'public');
const REPO_DIR = path.resolve(WEB_DIR, '..', '..');
const SANDA_BIN = process.env.SANDA_BIN || 'sanda';
const EXEC_TIMEOUT_MS = 30000;
const MAX_OUTPUT = 65536;

const TOOLS = [
  { id: 'dsh', label: 'DeepSeek Harness', hint: 'web UI on :3080', bin: 'dsh' },
  { id: 'opencode', label: 'OpenCode', hint: 'terminal agent', bin: 'opencode' },
  { id: 'pi', label: 'Pi coding agent', hint: 'terminal agent', bin: 'pi' },
  { id: 'codex', label: 'OpenAI Codex CLI', hint: 'terminal agent', bin: 'codex' },
  { id: 'agy', label: 'Antigravity CLI', hint: 'command: agy', bin: 'agy' },
  {
    id: 'antigravity-desktop',
    install: 'agy-desktop',
    label: 'Antigravity Desktop',
    hint: 'GUI app',
    bin: 'antigravity',
    extraPaths: [
      path.join(os.homedir(), '.local/bin/antigravity'),
      path.join(os.homedir(), '.local/opt/antigravity/antigravity'),
      path.join(os.homedir(), '.local/opt/antigravity/Antigravity-x64/antigravity'),
    ],
  },
];

// nvm keeps npm globals outside the default PATH of a non-login shell.
function buildSearchPath() {
  const dirs = [];
  const add = (d) => {
    if (d && !dirs.includes(d)) dirs.push(d);
  };
  add(path.join(os.homedir(), '.local/bin'));
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

// ---- jobs: one per install, streamed over SSE -----------------------------

const jobs = new Map();
let jobSeq = 0;

function pruneJobs() {
  if (jobs.size <= 40) return;
  for (const [id, job] of jobs) {
    if (jobs.size <= 30) break;
    if (job.done) jobs.delete(id);
  }
}

function startJob(cmd, args) {
  const id = `job${++jobSeq}`;
  const job = { id, cmd, args, lines: [], done: false, code: null, subs: new Set() };
  jobs.set(id, job);
  pruneJobs();

  const child = spawn(cmd, args, { cwd: REPO_DIR, env: process.env });
  const push = (stream, chunk) => {
    for (const line of chunk.toString('utf8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      const entry = { t: Date.now(), s: stream, m: line };
      job.lines.push(entry);
      if (job.lines.length > 2000) job.lines.shift();
      for (const res of job.subs) res.write(`data: ${JSON.stringify(entry)}\n\n`);
    }
  };

  child.stdout.on('data', (c) => push('out', c));
  child.stderr.on('data', (c) => push('err', c));
  child.on('error', (err) => {
    push('err', Buffer.from(`failed to start: ${err.message}`));
  });
  child.on('close', (code) => {
    job.done = true;
    job.code = code;
    const payload = JSON.stringify({ code });
    for (const res of job.subs) {
      res.write(`event: done\ndata: ${payload}\n\n`);
      res.end();
    }
    job.subs.clear();
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

// Cross-site posts cannot set a JSON content type without a preflight, and we
// send no CORS headers, so this blocks drive-by requests from other origins.
function isSafePost(req) {
  const type = String(req.headers['content-type'] || '');
  if (!type.includes('application/json')) return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function runCommand(cmd) {
  return new Promise((resolve) => {
    const child = spawn('/bin/bash', ['-lc', cmd], { cwd: REPO_DIR, env: process.env });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (code, timedOut) => {
      if (settled) return;
      settled = true;
      resolve({ code, stdout, stderr, timedOut: Boolean(timedOut) });
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(124, true);
    }, EXEC_TIMEOUT_MS);

    child.stdout.on('data', (c) => {
      stdout = (stdout + c.toString('utf8')).slice(-MAX_OUTPUT);
    });
    child.stderr.on('data', (c) => {
      stderr = (stderr + c.toString('utf8')).slice(-MAX_OUTPUT);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      stderr += err.message;
      finish(127, false);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      finish(code, false);
    });
  });
}

function startDshWeb() {
  const npx = which('npx');
  if (!npx) return { started: false, error: 'npx not found' };

  const args = ['-y', '@deepseek-ai/dsh', 'web', '--port', '3080', '--no-open'];
  const cs = process.env.CODESPACE_NAME;
  const domain = process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN;
  if (cs && domain) args.push('--trusted-host', `${cs}-3080.${domain}`);

  const log = fs.openSync('/tmp/sanda-dsh-web.log', 'a');
  const child = spawn(npx, args, {
    cwd: REPO_DIR,
    env: process.env,
    detached: true,
    stdio: ['ignore', log, log],
  });
  child.unref();
  fs.writeFileSync('/tmp/sanda-dsh-web.pid', String(child.pid));
  return { started: true, pid: child.pid };
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
    return json(res, 200, { ok: true, pid: process.pid, port: PORT });
  }

  if (req.method === 'GET' && route === '/api/status') {
    const [dshUp, desktopUp] = await Promise.all([portOpen(3080), portOpen(6080)]);
    return json(res, 200, {
      tools: toolStatus(),
      ports: { dashboard: PORT, dsh: 3080, desktop: 6080 },
      running: { dsh: dshUp, desktop: desktopUp },
      codespace: process.env.CODESPACE_NAME || null,
    });
  }

  if (req.method === 'GET' && route === '/api/ports') {
    const [dshUp, desktopUp] = await Promise.all([portOpen(3080), portOpen(6080)]);
    return json(res, 200, { dsh: dshUp, desktop: desktopUp, dashboard: true });
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
    const job = startJob(SANDA_BIN, ['install', tool.install || tool.id]);
    return json(res, 202, { id: job.id, tool: tool.id });
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
    if (await portOpen(3080)) return json(res, 200, { started: false, running: true });
    const result = startDshWeb();
    return json(res, result.started ? 202 : 500, result);
  }

  if (req.method === 'GET' || req.method === 'HEAD') {
    if (route.startsWith('/api/')) return json(res, 404, { error: 'not found' });
    return serveStatic(res, route);
  }

  return json(res, 405, { error: 'method not allowed' });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    if (!res.headersSent) json(res, 500, { error: err.message });
    else res.end();
  });
});

server.listen(PORT, HOST, () => {
  console.log(`[sanda] dashboard on http://${HOST}:${PORT}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
