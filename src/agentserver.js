'use strict';
/**
 * The agent API's door from outside the renderer.
 *
 * Two ways in, both of which end in `Agent.dispatch(method, payload)` inside the live
 * renderer (src/renderer/agent.js) - there is no second implementation of anything here:
 *
 *   HEADLESS   SHORTCUT_AGENT=<file.json> electron .
 *              Runs one ops list or one short spec, prints the result as JSON, exits.
 *              Exit code 0 when it succeeded, 1 when it did not.
 *
 *   SERVER     electron . --agent            (or SHORTCUT_AGENT_PORT=<port>)
 *              The editor opens as usual AND listens on 127.0.0.1, so an agent can drive
 *              the window a person is watching. Bound to loopback only, and every request
 *              needs the token written to <userData>/agent-server.json - a web page in a
 *              browser can reach localhost, but it cannot read that file or send the header
 *              without a CORS preflight this server never answers.
 *
 * Requests are serialised: the renderer runs one batch at a time, and a second POST waits
 * for the first rather than being refused.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_PORT = 47810;
const MAX_BODY = 32 * 1024 * 1024;

let queue = Promise.resolve();

/** Call `Agent.dispatch` in the renderer, one call at a time. */
function call(win, method, payload) {
  const job = queue.then(async () => {
    if (!win || win.isDestroyed()) return { ok: false, error: 'the editor window is gone' };
    const js = 'window.Agent ? Agent.dispatch(' + JSON.stringify(method) + ', ' +
      JSON.stringify(payload == null ? {} : payload) + ') : ({ ok: false, error: "agent.js is not loaded" })';
    return win.webContents.executeJavaScript(js, true);
  });
  queue = job.catch(() => {});
  return job;
}

/** A spec is an object with beats; an ops list is an array or `{ ops }`. */
function methodFor(doc) {
  if (Array.isArray(doc) || (doc && Array.isArray(doc.ops))) return 'run';
  if (doc && (Array.isArray(doc.beats) || (doc.spec && Array.isArray(doc.spec.beats)))) {
    return doc.expandOnly ? 'expand' : 'build';
  }
  if (doc && typeof doc.method === 'string') return doc.method;
  return 'run';
}

async function runHeadless(win, file) {
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.log(JSON.stringify({ ok: false, error: 'could not read ' + file + ': ' + e.message }));
    return 1;
  }
  const method = methodFor(doc);
  const payload = doc && doc.method ? doc.payload : doc;
  let out;
  try { out = await call(win, method, payload); } catch (e) { out = { ok: false, error: e.message }; }
  const text = JSON.stringify(out, null, 2);
  if (process.env.SHORTCUT_AGENT_OUT) fs.writeFileSync(process.env.SHORTCUT_AGENT_OUT, text);
  console.log(text);
  return out && out.ok === false ? 1 : 0;
}

/** The port asked for, or null when the server is not wanted. */
function portFromEnv(env, argv) {
  if (env.SHORTCUT_AGENT_PORT) return Number(env.SHORTCUT_AGENT_PORT) || DEFAULT_PORT;
  const flag = (argv || []).find((a) => a === '--agent' || a.startsWith('--agent-port='));
  if (!flag) return null;
  return flag === '--agent' ? DEFAULT_PORT : (Number(flag.split('=')[1]) || DEFAULT_PORT);
}

function start(getWin, port, userData) {
  const token = crypto.randomBytes(24).toString('hex');
  const infoPath = path.join(userData, 'agent-server.json');
  const send = (res, code, obj) => {
    const body = JSON.stringify(obj);
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/health') return send(res, 200, { ok: true, app: 'shortcut' });
    const auth = req.headers['x-shortcut-token'] || String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (auth !== token) return send(res, 401, { ok: false, error: 'missing or wrong token - read it from ' + infoPath });

    const route = url.pathname.replace(/^\/+/, '');
    const methods = { run: 'POST', build: 'POST', expand: 'POST', describe: 'GET|POST', catalog: 'GET' };
    if (!methods[route]) return send(res, 404, { ok: false, error: 'routes: ' + Object.keys(methods).map((m) => '/' + m).join(' ') });

    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { send(res, 413, { ok: false, error: 'body too large' }); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', async () => {
      if (res.writableEnded) return;
      let payload = {};
      if (chunks.length) {
        try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch (e) { return send(res, 400, { ok: false, error: 'body is not JSON: ' + e.message }); }
      }
      if (route === 'describe' && url.searchParams.get('full')) payload.full = true;
      try {
        const out = await call(getWin(), route, payload);
        send(res, out && out.ok === false ? 422 : 200, out);
      } catch (e) {
        send(res, 500, { ok: false, error: e.message });
      }
    });
  });

  let tries = 0;
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE' && tries < 10) { tries++; server.listen(port + tries, '127.0.0.1'); return; }
    console.log('Agent server failed: ' + e.message);
  });
  server.on('listening', () => {
    const actual = server.address().port;
    fs.writeFileSync(infoPath, JSON.stringify({ port: actual, token, pid: process.pid }, null, 2));
    console.log('Agent server on http://127.0.0.1:' + actual + ' (token in ' + infoPath + ')');
  });
  server.listen(port, '127.0.0.1');

  const cleanup = () => { try { fs.unlinkSync(infoPath); } catch (e) { /* already gone */ } };
  process.on('exit', cleanup);
  return { server, infoPath, close: () => { server.close(); cleanup(); } };
}

module.exports = { call, runHeadless, portFromEnv, start, methodFor, DEFAULT_PORT };
