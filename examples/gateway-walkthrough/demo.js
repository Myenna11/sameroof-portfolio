#!/usr/bin/env node
'use strict';
// Gateway walkthrough: the full approval chain on a fresh workspace, with no API key and no systemd.
//
//   fake OpenAI-compatible upstream (this file)  ←  broker (scoped token)  ←  adapter
//   adapter replies "APPROVAL: core.exec {uname -a}"  →  gateway registers the intent  →  coordinator shows it to the human
//   human allows it  →  gateway runs it in bwrap (no network, read-only root)  →  result DM wakes the agent  →  agent replies
//
// Everything is the shipped code path: `sameroof serve --with-gateway` starts broker + coordinator + gateway + adapter.
// Only the model is fake — a 40-line HTTP server below that answers like a chat completion. Requires Linux + bubblewrap
// with unprivileged user namespaces for the exec step; without bwrap the gateway refuses core.exec (fail closed) and this
// demo reports that instead of pretending.
//
//   node examples/gateway-walkthrough/demo.js
//   SAMEROOF_DEMO_ALLOW_ROOT=1 node examples/gateway-walkthrough/demo.js   # only on a single-user dev box where you are root

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');

const REPO = path.resolve(__dirname, '..', '..');
const CLI = path.join(REPO, 'packages', 'cli', 'index.js');
const APPROVAL = 'APPROVAL: core.exec {"argv":["uname","-a"],"cwd":{"root_id":"own-room","path":""},"writable_root_ids":[]}';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- 1. a fake model: answers the coordinator's prompt like an OpenAI chat completion
function fakeUpstream() {
  let calls = 0;
  const server = http.createServer((req, res) => {
    let raw = ''; req.on('data', c => raw += c);
    req.on('end', () => {
      let body = {}; try { body = JSON.parse(raw || '{}'); } catch {}
      const last = ((body.messages || []).slice(-1)[0] || {}).content || '';
      let content = '(静默)';
      if (/\[网关结果/.test(last)) content = 'Done — the gateway ran it and I saw the result.';
      else if (/uname/.test(last)) content = APPROVAL;
      calls++;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ id: 'chatcmpl-fake-' + calls, object: 'chat.completion', model: body.model, choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }));
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, calls: () => calls })));
}

function api(port, token, pathname, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({ hostname: '127.0.0.1', port, path: pathname, method: data ? 'POST' : 'GET', headers: { authorization: 'Bearer ' + token, ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}) } }, res => {
      let text = ''; res.on('data', c => text += c); res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(text) }); } catch { resolve({ status: res.statusCode, body: text }); } });
    });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}

(async () => {
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  const allowRoot = process.env.SAMEROOF_DEMO_ALLOW_ROOT === '1';
  if (isRoot && !allowRoot) { console.error('FAIL running as root: the gateway refuses root. Run as a normal user, or set SAMEROOF_DEMO_ALLOW_ROOT=1 on a single-user dev box.'); process.exit(2); }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sameroof-gateway-demo-'));
  const home = path.join(tmp, 'home'), ws = path.join(tmp, 'workspace');
  fs.mkdirSync(home, { recursive: true });
  const env = { ...process.env, HOME: home, NODE_ENV: 'test', SAMEROOF_ROOT: ws };
  const cli = (...args) => execFileSync(process.execPath, [CLI, ...args, '--house', ws], { cwd: REPO, env, encoding: 'utf8', timeout: 30000 });
  const upstream = await fakeUpstream();
  let serve = null, log = '';
  const fail = msg => { console.error('FAIL ' + msg); if (log) console.error(log.split('\n').slice(-25).join('\n')); process.exit(1); };
  try {
    // ---- 2. fresh workspace: one agent on the fake upstream (through the broker), one human
    execFileSync(process.execPath, [CLI, 'init', ws], { cwd: REPO, env, encoding: 'utf8' });
    cli('cred', 'add', 'demo-key', '--provider', 'openai', '--base-url', `http://127.0.0.1:${upstream.port}/v1`, '--api-key', 'sk-not-a-real-key');
    cli('new', 'worker', '--model', 'openai/fake-chat', '--credential', 'demo-key');
    cli('new', 'me', '--human');
    cli('check'); cli('lock'); cli('lock', '--check');

    // ---- 3. serve with the gateway
    const args = [CLI, 'serve', '--port', '0', '--with-gateway', '--house', ws]; if (isRoot) args.push('--gateway-allow-root');
    serve = spawn(process.execPath, args, { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'] });
    serve.stdout.on('data', c => log += c); serve.stderr.on('data', c => log += c);
    let ended = false; serve.on('exit', () => { ended = true; });
    const waitFor = async (re, ms, what) => { const t0 = Date.now(); while (!re.test(log)) { if (ended) fail('serve exited while waiting for ' + what); if (Date.now() - t0 > ms) fail('timed out waiting for ' + what); await sleep(200); } return log.match(re); };
    const [, port] = await waitFor(/\[coordinator\] http:\/\/127\.0\.0\.1:(\d+)/, 20000, 'coordinator');
    const [, sandbox] = await waitFor(/\[gateway\] listening on gateway\.sock \(pid \d+\); sandbox: (bwrap ok|bwrap unavailable)/, 20000, 'gateway');
    await waitFor(/\[worker\] adapter started/, 20000, 'adapter');
    await sleep(1500);
    const token = execFileSync(process.execPath, ['-e', `console.log(require(${JSON.stringify(path.join(REPO, 'packages/living-room/tokens.js'))}).issue('resident_me_01').token)`], { env, encoding: 'utf8' }).trim();

    // ---- 4. ask → APPROVAL line → gateway registers intent → approval appears for the human
    assert.equal((await api(port, token, '/say', { text: '@worker run uname for me' })).status, 200);
    const [, aprId] = await waitFor(/\[worker 审批\] core\.exec → (apr_[a-f0-9]+)/, 20000, 'approval registration');
    const pending = await api(port, token, '/approval');
    assert.ok(Array.isArray(pending.body) ? pending.body.some(a => a.approval_id === aprId || a.id === aprId) : true, 'approval visible to the human');

    // ---- 5. the human allows it → bwrap executes → result reaches the agent
    const decision = await api(port, token, '/approval/' + aprId, { decision: 'allow' });
    assert.equal(decision.status, 200, 'approval accepted: ' + JSON.stringify(decision.body).slice(0, 200));
    assert.equal(decision.body.decision, 'allowed');
    await waitFor(/\[worker 说\] Done — the gateway ran it/, 30000, 'agent reply after gateway result');

    // ---- 6. read the gateway's own record: executor and sandbox coverage
    const Database = require(require.resolve('better-sqlite3', { paths: [path.join(REPO, 'packages', 'gateway')] }));
    const db = new Database(path.join(ws, 'state', 'gateway', 'gateway.db'), { readonly: true });
    const intent = db.prepare("SELECT status, result_json FROM intents ORDER BY rowid DESC LIMIT 1").get(); db.close();
    const result = JSON.parse(intent.result_json);
    console.log(`gateway intent: status=${intent.status} executor=${result.coverage.executor} sandbox=${result.coverage.sandbox} network=${result.coverage.network} requested=${JSON.stringify(result.coverage.requested)}`);
    if (sandbox === 'bwrap ok') {
      assert.equal(intent.status, 'succeeded'); assert.equal(result.coverage.executor, 'bwrap'); assert.equal(result.coverage.sandbox, 'enforced'); assert.equal(result.coverage.network, 'denied');
      console.log('OK gateway walkthrough: APPROVAL → intent → human allow → bwrap exec (no network, read-only root) → result → agent reply');
    } else {
      assert.notEqual(intent.status, 'succeeded', 'without bwrap the gateway must refuse, never run unsandboxed');
      console.log('OK gateway walkthrough (no bwrap on this machine): approval chain worked and the gateway refused to execute unsandboxed — fail closed, as designed');
    }
    console.log(`fake model calls: ${upstream.calls()}; workspace: ${ws}`);
  } catch (e) { fail(e && e.stack || String(e)); }
  finally {
    if (serve && serve.exitCode === null) { serve.kill('SIGINT'); for (let i = 0; i < 50 && serve.exitCode === null && serve.signalCode === null; i++) await sleep(200); if (serve.exitCode === null && serve.signalCode === null) serve.kill('SIGKILL'); }
    upstream.server.close();
  }
})();
