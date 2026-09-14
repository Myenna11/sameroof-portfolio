#!/usr/bin/env node
// Same Roof — End-to-End Code Review Demo
// Actually runs: coordinator → agent adapter → broker API → result posted back
// This proves the full stack works, not just console.log.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');

const API_URL = 'https://www.sophnet.com/api/open-apis/v1/chat/completions';
const API_KEY = process.env.SOPHNET_KEY || '';
if (!API_KEY) { console.error('Set SOPHNET_KEY'); process.exit(1); }

// -- Setup temp house --
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'sameroof-e2e-'));
const RUN_DIR = path.join(ROOT, '.sameroof', 'run');
fs.mkdirSync(path.join(ROOT, 'rooms', 'human'), { recursive: true });
fs.mkdirSync(path.join(ROOT, 'rooms', 'logic-reviewer'), { recursive: true });
fs.mkdirSync(path.join(ROOT, 'rooms', 'security-scanner'), { recursive: true });
fs.mkdirSync(path.join(ROOT, 'apps', 'house'), { recursive: true });
fs.mkdirSync(path.join(ROOT, 'state'), { recursive: true });
fs.mkdirSync(RUN_DIR, { recursive: true, mode: 0o700 });

fs.writeFileSync(path.join(ROOT, 'house.yaml'), `schema_version: 1
name: Code Review E2E
timezone: UTC
defaults:
  runtime: broker-direct
  plugins: [living-room]
  heartbeat: {enabled: false}
`);
fs.writeFileSync(path.join(ROOT, 'rooms', 'human', 'room.yaml'), 'schema_version: 1\nid: resident_human_01\nname: human\nspecies: human\n');
fs.writeFileSync(path.join(ROOT, 'rooms', 'logic-reviewer', 'room.yaml'), 'schema_version: 1\nid: resident_logic_01\nname: logic-reviewer\nspecies: agent\nplugins: [living-room]\nheartbeat: {enabled: false}\n');
fs.writeFileSync(path.join(ROOT, 'rooms', 'security-scanner', 'room.yaml'), 'schema_version: 1\nid: resident_security_01\nname: security-scanner\nspecies: agent\nplugins: [living-room]\nheartbeat: {enabled: false}\n');
fs.writeFileSync(path.join(ROOT, 'rooms', 'logic-reviewer', 'SOUL.md'), 'You are a code reviewer focused on logic, architecture, and performance. Be concise. Cite line numbers.');
fs.writeFileSync(path.join(ROOT, 'rooms', 'security-scanner', 'SOUL.md'), 'You are a security scanner. Find injection, auth flaws, hardcoded secrets, unsafe input. Cite line numbers and give fixes.');
fs.writeFileSync(path.join(ROOT, 'apps', 'house', 'index.html'), '<!doctype html>');

const SAMPLE = fs.readFileSync(path.join(__dirname, 'sample-code', 'auth.js'), 'utf8');

// -- Override env for room.js --
const savedEnv = {};
for (const k of ['HOME', 'SAMEROOF_ROOT', 'SAMEROOF_LR']) { savedEnv[k] = process.env[k]; }
process.env.HOME = ROOT;
process.env.SAMEROOF_ROOT = ROOT;
delete process.env.SAMEROOF_LR;

const { createLivingRoom } = require('../../packages/living-room/server');
const { run } = require('../../packages/adapters/lib/room');
const { BrokerStore } = require('../../packages/broker/store');
const { createBroker } = require('../../packages/broker/server');

// -- HTTP helpers --
function request(port, pathname, options = {}) {
  return new Promise((resolve, reject) => {
    const body = options.body ? Buffer.from(JSON.stringify(options.body)) : null;
    const req = require('http').request({ hostname: '127.0.0.1', port, path: pathname, method: options.method || 'GET',
      headers: { ...(options.token ? { authorization: 'Bearer ' + options.token } : {}), ...(body ? { 'content-type': 'application/json', 'content-length': body.length } : {}) }
    }, res => {
      const chunks = []; res.on('data', c => chunks.push(c));
      res.on('end', () => { let v; try { v = JSON.parse(Buffer.concat(chunks).toString()); } catch { v = Buffer.concat(chunks).toString(); } resolve({ status: res.statusCode, body: v }); });
    });
    req.on('error', reject); if (body) req.write(body); req.end();
  });
}

// Call the model THROUGH THE BROKER — agent never sees the real API key.
// The broker socket accepts the agent's short-lived token, looks up which credential it's bound to,
// and forwards to upstream with the real key. This is credential isolation in practice.
function callViaBroker(socketPath, agentToken, model, system, user) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], max_tokens: 800, temperature: 0.3 });
    const req = require('http').request({ socketPath, path: '/v1/chat/completions', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${agentToken}`, 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      let data = ''; res.on('data', c => data += c);
      res.on('end', () => { try { const j = JSON.parse(data); if (j.error) return reject(new Error(j.error.code + ': ' + j.error.message)); resolve(j.choices?.[0]?.message?.content || '(no output)'); } catch { resolve('(parse error: ' + data.slice(0, 100) + ')'); } });
    });
    req.on('error', reject); req.setTimeout(60000, () => { req.destroy(); reject(new Error('timeout')); });
    req.write(body); req.end();
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, label, ms = 15000) {
  const t = Date.now();
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw new Error('timeout: ' + label); await sleep(100); }
}

async function main() {
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║  Same Roof · End-to-End Code Review Demo        ║');
  console.log('║  coordinator → adapter → real API → result back  ║');
  console.log('╚══════════════════════════════════════════════════╝\n');

  // 0. Start broker with two credentials (same upstream, different aliases = credential isolation)
  const brokerStore = new BrokerStore({ home: path.join(ROOT, '.sameroof') });
  brokerStore.addCredential({ alias: 'capable-model', provider: 'sophnet', baseUrl: 'https://www.sophnet.com/api/open-apis/v1', apiKey: API_KEY });
  brokerStore.addCredential({ alias: 'cheap-model', provider: 'sophnet', baseUrl: 'https://www.sophnet.com/api/open-apis/v1', apiKey: API_KEY });
  const logicTok = brokerStore.issueToken({ residentId: 'resident_logic_01', credentials: ['capable-model'], models: ['GLM-5'], writeFile: false });
  const secTok = brokerStore.issueToken({ residentId: 'resident_security_01', credentials: ['cheap-model'], models: ['qwen3.6-flash'], writeFile: false });
  const broker = createBroker({ store: brokerStore });
  await broker.listen();
  const brokerSock = broker.socketPath;
  console.log(`✅ Broker running on ${path.basename(brokerSock)}`);
  console.log(`   logic-reviewer   token → capable-model (GLM-5 only)`);
  console.log(`   security-scanner token → cheap-model (qwen3.6-flash only)`);
  console.log(`   Neither agent has the real API key.\n`);

  // 1. Start coordinator
  const room = createLivingRoom({ houseDir: ROOT, runDir: RUN_DIR, dataDir: path.join(ROOT, 'state'), port: 0 });
  const port = (await room.listen()).port;
  const humanToken = room.tokenStore.issue('resident_human_01').token;
  console.log(`✅ Coordinator running on port ${port}`);

  const ctrl1 = new AbortController();
  const ctrl2 = new AbortController();

  // 2. Start logic-reviewer agent
  const logicThink = async (system, user) => {
    const inbox = String(user);
    if (!inbox.includes('auth.js') && !inbox.includes('Review')) return '(静默)';
    console.log('\n🤖 logic-reviewer → broker → GLM-5...');
    const t = Date.now();
    const result = await callViaBroker(brokerSock, logicTok.secret, 'GLM-5', system + '\n' + fs.readFileSync(path.join(ROOT, 'rooms', 'logic-reviewer', 'SOUL.md'), 'utf8'),
      'Review this code:\n```javascript\n' + SAMPLE + '\n```');
    console.log(`   ⏱ ${((Date.now() - t) / 1000).toFixed(1)}s`);
    return result;
  };
  const logicP = run('logic-reviewer', 'fake', logicThink, { signal: ctrl1.signal, lr: 'http://127.0.0.1:' + port });

  // 3. Start security-scanner agent
  const securityThink = async (system, user) => {
    const inbox = String(user);
    if (!inbox.includes('auth.js') && !inbox.includes('security') && !inbox.includes('scan') && !inbox.includes('Security') && !inbox.includes('vulnerabilit')) return '(静默)';
    console.log('\n🤖 security-scanner → broker → qwen3.6-flash...');
    const t = Date.now();
    const result = await callViaBroker(brokerSock, secTok.secret, 'qwen3.6-flash', system + '\n' + fs.readFileSync(path.join(ROOT, 'rooms', 'security-scanner', 'SOUL.md'), 'utf8'),
      'Scan this code for security vulnerabilities:\n```javascript\n' + SAMPLE + '\n```');
    console.log(`   ⏱ ${((Date.now() - t) / 1000).toFixed(1)}s`);
    return result;
  };
  const securityP = run('security-scanner', 'fake', securityThink, { signal: ctrl2.signal, lr: 'http://127.0.0.1:' + port });

  // Wait for agents to come online
  await until(async () => {
    const members = (await request(port, '/members', { token: humanToken })).body;
    return members?.filter(m => m.online).length >= 2;
  }, 'both agents online');
  console.log('✅ Both agents online\n');

  // 4. Human dispatches code review to logic-reviewer
  console.log('👤 human → /dispatch {to: "logic-reviewer", task: "Review auth.js"}');
  const dispatch1 = await request(port, '/dispatch', {
    method: 'POST', token: humanToken,
    body: { to: 'logic-reviewer', task: 'Review auth.js for logic and architecture issues:\n```javascript\n' + SAMPLE + '\n```' }
  });
  console.log(`   ✅ ${dispatch1.body.task_id} dispatched\n`);

  // Wait for logic-reviewer to respond
  await sleep(2000);  // give adapter time to wake
  const logicDone = await until(async () => {
    const history = (await request(port, '/history', { token: humanToken })).body;
    return history?.find(m => m.from_id === 'resident_logic_01' && m.kind === 'say');
  }, 'logic-reviewer responds', 80000);

  console.log('\n📝 logic-reviewer posted review:');
  console.log(logicDone.text?.slice(0, 500) + (logicDone.text?.length > 500 ? '\n   ...(truncated)' : ''));

  // 5. Dispatch security scan
  console.log('\n👤 human → /dispatch {to: "security-scanner", task: "Scan auth.js"}');
  const dispatch2 = await request(port, '/dispatch', {
    method: 'POST', token: humanToken,
    body: { to: 'security-scanner', task: 'Scan auth.js for security vulnerabilities:\n```javascript\n' + SAMPLE + '\n```' }
  });
  console.log(`   ✅ ${dispatch2.body.task_id} dispatched\n`);

  await sleep(2000);
  const secDone = await until(async () => {
    const history = (await request(port, '/history', { token: humanToken })).body;
    return history?.find(m => m.from_id === 'resident_security_01' && m.kind === 'say');
  }, 'security-scanner responds', 80000);

  console.log('\n📝 security-scanner posted findings:');
  console.log(secDone.text?.slice(0, 500) + (secDone.text?.length > 500 ? '\n   ...(truncated)' : ''));

  // 5b. Prove credential isolation: logic-reviewer's token CANNOT use security-scanner's model
  console.log('\n🔒 Isolation check: logic-reviewer token trying to call qwen3.6-flash...');
  try {
    await callViaBroker(brokerSock, logicTok.secret, 'qwen3.6-flash', 'x', 'x');
    console.log('   ❌ SHOULD HAVE FAILED');
  } catch (e) {
    console.log(`   ✅ Rejected by broker: ${e.message.slice(0, 80)}`);
  }

  // 5c. Show the broker's ledger
  const ledger = brokerStore.db.prepare('SELECT resident_id, credential_alias, model, actual_tokens, latency_ms, status FROM ledger ORDER BY ts').all();
  console.log('\n📒 Broker ledger (who used what):');
  for (const row of ledger) console.log(`   ${row.resident_id.padEnd(24)} ${row.credential_alias.padEnd(14)} ${(row.model || '?').padEnd(16)} ${String(row.actual_tokens || 0).padStart(5)} tok  ${String(row.latency_ms || 0).padStart(6)}ms  ${row.status}`);

  // 6. Check task board
  const tasks = (await request(port, '/tasks', { token: humanToken })).body;
  console.log(`\n📋 Task board: ${tasks?.length || 0} tasks`);
  (tasks || []).forEach(t => console.log(`   ${t.id} | ${t.state} | ${t.title?.slice(0, 50)}`));

  // Cleanup
  console.log('\n' + '─'.repeat(50));
  console.log('\n✅ End-to-end flow complete:');
  console.log('   dispatch → coordinator → adapter wake → BROKER → upstream API → result posted');
  console.log('   Two agents, two credentials, isolated tokens, full ledger.\n');

  ctrl1.abort(); ctrl2.abort();
  await new Promise(r => setTimeout(r, 500));  // let adapters shut down
  await room.close().catch(() => {});
  await broker.close().catch(() => {});
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch {}
  for (const k of Object.keys(savedEnv)) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
}

main().catch(e => { console.error('❌ Error:', e.message, e.stack?.split('\n')[1]); process.exit(1); });
