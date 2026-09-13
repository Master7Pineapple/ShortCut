#!/usr/bin/env node
'use strict';
/**
 * ShortCut agent CLI - the shell-side door to the agent API (src/renderer/agent.js).
 *
 *   node tools/agent.js catalog                  every op, effect, graphic, transition...
 *   node tools/agent.js describe [--full]        the open project as JSON
 *   node tools/agent.js run    <ops.json>        a batch of ops (one undo entry)
 *   node tools/agent.js build  <spec.json>       a B2B short spec, expanded and run
 *   node tools/agent.js expand <spec.json>       the ops a spec compiles to, without running
 *
 * If an editor is running with `--agent`, the command drives THAT window over its localhost
 * server (the token is read from %APPDATA%/shortcut-editor/agent-server.json). Otherwise it
 * launches a headless editor for the one command and exits. `--headless` forces the latter.
 *
 * Output is JSON on stdout; the exit code is 1 when the result says ok:false. `--verbose`
 * passes the headless editor's own stderr through.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const pos = args.filter((a) => !a.startsWith('--'));
const cmd = pos[0];
const file = pos[1];

function usage() {
  console.error('usage: node tools/agent.js <catalog|describe|run|build|expand> [file.json] [--full] [--headless]');
  process.exit(2);
}
if (!['catalog', 'describe', 'run', 'build', 'expand'].includes(cmd)) usage();
if (['run', 'build', 'expand'].includes(cmd) && !file) usage();

function readDoc() {
  if (!file) return {};
  const text = file === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(file, 'utf8');
  return JSON.parse(text);
}

function serverInfo() {
  const base = process.env.APPDATA || (process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library', 'Application Support') : path.join(os.homedir(), '.config'));
  const p = path.join(base, 'shortcut-editor', 'agent-server.json');
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; }
}

function request(info, method, route, body) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({
      host: '127.0.0.1', port: info.port, path: '/' + route, method,
      headers: Object.assign({ 'x-shortcut-token': info.token },
        data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}),
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(0);
    if (data) req.write(data);
    req.end();
  });
}

function headless(doc) {
  return new Promise((resolve) => {
    const tmp = path.join(os.tmpdir(), 'shortcut-agent-' + process.pid + '-' + Date.now());
    const inFile = tmp + '.json', outFile = tmp + '.out.json';
    fs.writeFileSync(inFile, JSON.stringify(doc));
    const electron = path.join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron');
    const p = spawn(electron, ['.'], {
      cwd: ROOT, shell: process.platform === 'win32',
      env: Object.assign({}, process.env, { SHORTCUT_AGENT: inFile, SHORTCUT_AGENT_OUT: outFile }),
      stdio: ['ignore', 'ignore', flag('--verbose') ? 'inherit' : 'ignore'],
    });
    p.on('close', () => {
      let out;
      try { out = JSON.parse(fs.readFileSync(outFile, 'utf8')); }
      catch (e) { out = { ok: false, error: 'the headless editor produced no result' }; }
      for (const f of [inFile, outFile]) { try { fs.unlinkSync(f); } catch (e) { /* gone */ } }
      resolve(out);
    });
  });
}

(async () => {
  let doc = readDoc();
  if (cmd === 'describe' && flag('--full')) doc.full = true;
  const info = flag('--headless') ? null : serverInfo();
  let out;
  if (info) {
    try {
      const route = cmd;
      out = await request(info, cmd === 'catalog' ? 'GET' : 'POST', route, cmd === 'catalog' ? null : doc);
    } catch (e) {
      out = null;   // a stale info file from an editor that has gone: fall back
    }
  }
  if (!out) {
    const methodDoc = cmd === 'run' || cmd === 'build'
      ? (cmd === 'build' && !doc.spec ? { spec: doc } : doc)
      : { method: cmd, payload: doc };
    if (cmd === 'expand') methodDoc.payload = doc.spec ? doc : { spec: doc };
    out = await headless(methodDoc);
  }
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  process.exit(out && out.ok === false ? 1 : 0);
})();
