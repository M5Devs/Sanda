#!/usr/bin/env node
// Reverse proxy for the DeepSeek Harness web UI.
//
// dsh listens on 127.0.0.1:3081 behind a per-process token: every request
// without `?token=` or the `dsh-auth-*` cookie it mints gets a plain 401. That
// breaks the common Codespaces paths (the PORTS-tab link, or a first visit
// whose redirect drops the query). This proxy owns the public port 3080, reads
// the token dsh prints, and exchanges it for the cookie on the browser's
// behalf — so opening port 3080 just works, and the token is never needed.
//
// Zero dependencies: node:http + node:net only.

const http = require('http');
const net = require('net');
const fs = require('fs');
const { spawn } = require('child_process');

const LISTEN_PORT = Number(process.env.SANDA_DSH_PORT || 3080);
const TARGET_PORT = Number(process.env.SANDA_DSH_TARGET_PORT || 3081);
const LOG = process.env.SANDA_DSH_LOG || '/tmp/sanda-dsh-web.log';
function findOnPath(name) {
  for (const dir of (process.env.PATH || '').split(':')) {
    if (!dir) continue;
    const candidate = `${dir}/${name}`;
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

// Prefer an installed dsh; npx would re-resolve the package on every start.
const BIN = process.env.SANDA_DSH_BIN || findOnPath('dsh');
const NPX = !BIN || process.env.SANDA_DSH_NPX === '1';
const TRUSTED_HOST =
  process.env.SANDA_DSH_TRUSTED_HOST ||
  (process.env.CODESPACE_NAME && process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN
    ? `${process.env.CODESPACE_NAME}-${LISTEN_PORT}.${process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN}`
    : '');

const ANSI = /\u001b\[[0-9;?]*[A-Za-z]|\u001b\][^\u0007]*\u0007/g;
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

function log(message) {
  process.stdout.write(`[proxy] ${message}\n`);
}

function readToken() {
  try {
    const text = fs.readFileSync(LOG, 'utf8').replace(ANSI, '').replace(/\r/g, '');
    const matches = [...text.matchAll(/[?&]token=([^\s"'&<>]+)/g)];
    if (!matches.length) return null;
    const raw = matches[matches.length - 1][1];
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  } catch {
    return null;
  }
}

// dsh binds its session cookie to the request authority, so the exchange has to
// carry the browser's own Host. One cookie per authority is enough.
const cookies = new Map();

function mintCookie(authority) {
  const token = readToken();
  if (!token) return Promise.resolve(null);
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: TARGET_PORT,
        path: `/?token=${encodeURIComponent(token)}`,
        method: 'GET',
        headers: { host: authority, 'accept-encoding': 'identity' },
      },
      (res) => {
        res.resume();
        const set = res.headers['set-cookie'];
        const cookie = res.statusCode === 303 && set && set.length ? set[0].split(';')[0] : null;
        if (cookie) cookies.set(authority, cookie);
        resolve(cookie);
      }
    );
    req.setTimeout(5000, () => req.destroy(new Error('timeout')));
    req.on('error', () => resolve(null));
    req.end();
  });
}

function authorityOf(req) {
  return req.headers.host || `127.0.0.1:${LISTEN_PORT}`;
}

function hasSession(req) {
  return Boolean(req.headers.cookie && /dsh-auth-/.test(req.headers.cookie));
}

async function ensureCookie(req) {
  if (hasSession(req)) return null;
  const authority = authorityOf(req);
  return cookies.get(authority) || (await mintCookie(authority));
}

function upstreamHeaders(req, cookie, upgrade = false) {
  const headers = { ...req.headers };
  for (const key of Object.keys(headers)) {
    if (HOP_BY_HOP.has(key.toLowerCase())) delete headers[key];
  }
  // An upgrade needs its own handshake headers back; they are only hop-by-hop
  // for plain requests.
  if (upgrade) {
    headers.connection = 'Upgrade';
    if (req.headers.upgrade) headers.upgrade = req.headers.upgrade;
  }
  if (cookie && !headers.cookie) headers.cookie = cookie;
  return headers;
}

function proxyOnce(req, res, cookie) {
  return new Promise((resolve) => {
    const upstream = http.request(
      {
        host: '127.0.0.1',
        port: TARGET_PORT,
        path: req.url,
        method: req.method,
        headers: upstreamHeaders(req, cookie),
      },
      (up) => {
        if (up.statusCode === 401) {
          up.resume();
          resolve({ status: 401 });
          return;
        }
        const headers = { ...up.headers };
        for (const key of Object.keys(headers)) {
          if (HOP_BY_HOP.has(key.toLowerCase())) delete headers[key];
        }
        const set = up.headers['set-cookie'] || [];
        if (cookie) headers['set-cookie'] = [`${cookie}; Path=/; HttpOnly; SameSite=Strict`, ...set];
        else if (!set.length) delete headers['set-cookie'];
        res.writeHead(up.statusCode || 502, headers);
        up.pipe(res);
        up.on('end', () => resolve({ status: up.statusCode }));
        up.on('error', () => resolve({ status: up.statusCode }));
      }
    );
    upstream.on('error', (err) => {
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
        res.end('dsh is starting up; reload in a moment.\n');
      } else {
        res.end();
      }
      resolve({ status: 502, error: err });
    });
    req.pipe(upstream);
  });
}

// Cheap TCP probe: the proxy listens before dsh has finished booting.
function probeTarget(timeoutMs = 500) {
  return new Promise((resolve) => {
    const socket = net.connect(TARGET_PORT, '127.0.0.1');
    const done = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

async function handle(req, res) {
  if (req.url === '/__sanda_proxy' || req.url.startsWith('/__sanda_proxy?')) {
    const body = JSON.stringify({
      port: LISTEN_PORT,
      targetPort: TARGET_PORT,
      up: await probeTarget(),
      token: Boolean(readToken()),
      authenticated: cookies.size > 0,
    });
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(body);
    return;
  }

  const cookie = await ensureCookie(req);
  const first = await proxyOnce(req, res, cookie);
  if (first.status !== 401) return;

  // The cookie we had was stale (dsh restarted with a new signing secret) or
  // minting failed. Mint again; a GET can simply be replayed after a redirect.
  cookies.clear();
  const fresh = await mintCookie(authorityOf(req));
  if (!fresh) {
    res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    res.end('dsh is not ready yet (no token in its log); reload in a moment.\n');
    return;
  }
  if (req.method === 'GET' || req.method === 'HEAD') {
    res.writeHead(302, {
      location: req.url || '/',
      'set-cookie': `${fresh}; Path=/; HttpOnly; SameSite=Strict`,
      'cache-control': 'no-store',
    });
    res.end();
    return;
  }
  res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
  res.end('dsh session refreshed; retry this request.\n');
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    log(`error: ${err && err.message}`);
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
    res.end('proxy error\n');
  });
});

// WebSocket / streaming upgrades are piped raw; the cookie is injected so a
// fresh browser can open one before its first page load completes.
server.on('upgrade', (req, socket, head) => {
  ensureCookie(req)
    .catch(() => null)
    .then((cookie) => {
      const upstream = net.connect(TARGET_PORT, '127.0.0.1', () => {
        const headers = upstreamHeaders(req, cookie, true);
        const lines = [`${req.method} ${req.url} HTTP/1.1`];
        for (const [key, value] of Object.entries(headers)) {
          if (Array.isArray(value)) for (const item of value) lines.push(`${key}: ${item}`);
          else if (value !== undefined) lines.push(`${key}: ${value}`);
        }
        upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
        if (head && head.length) upstream.write(head);
        upstream.pipe(socket);
        socket.pipe(upstream);
      });
      upstream.on('error', () => socket.destroy());
      socket.on('error', () => upstream.destroy());
      socket.on('close', () => upstream.destroy());
    });
});

// ---- dsh child ------------------------------------------------------------

const args = ['web', '--host', '127.0.0.1', '--port', String(TARGET_PORT), '--no-open'];
if (TRUSTED_HOST) args.push('--trusted-host', TRUSTED_HOST);

const logFd = fs.openSync(LOG, 'a');
const child = spawn(NPX ? findOnPath('npx') || 'npx' : BIN, NPX ? ['-y', '@deepseek-ai/dsh', ...args] : args, {
  cwd: process.env.SANDA_REPO_DIR || process.cwd(),
  env: process.env,
  stdio: ['ignore', logFd, logFd],
});
fs.closeSync(logFd);

child.on('error', (err) => {
  log(`cannot start dsh: ${err.message}`);
  process.exit(1);
});
child.on('exit', (code, signal) => {
  log(`dsh exited (${signal || code}); stopping the proxy`);
  server.close();
  process.exit(0);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    log(`port ${LISTEN_PORT} is already taken — the dashboard may already be running dsh.`);
    process.exit(1);
  }
  log(`server error: ${err.message}`);
  process.exit(1);
});

server.listen(LISTEN_PORT, '0.0.0.0', () => {
  log(`listening on 0.0.0.0:${LISTEN_PORT} -> 127.0.0.1:${TARGET_PORT} (auto sign-in)`);
  log(`dsh output -> ${LOG}`);
  if (TRUSTED_HOST) log(`open https://${TRUSTED_HOST}/ — no token needed`);
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    try {
      child.kill(signal);
    } catch {
      /* already gone */
    }
    process.exit(0);
  });
}
