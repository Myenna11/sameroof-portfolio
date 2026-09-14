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

function callSophnet(model, system, user) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], max_tokens: 800, temperature: 0.3 });
    const url = new URL(API_URL);
    const req = https.request({ hostname: url.hostname, port: 443, path: url.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${API_KEY}`, 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      let data = ''; res.on('data', c => data += c);
      res.on('end', () => { try { const j = JSON.parse(data); resolve(j.choices?.[0]?.message?.content || '(no output)'); } catch { resolve('(parse error)'); } });
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
    console.log('\n🤖 logic-reviewer calling GLM-5...');
    const t = Date.now();
    const result = await callSophnet('GLM-5', system + '\n' + fs.readFileSync(path.join(ROOT, 'rooms', 'logic-reviewer', 'SOUL.md'), 'utf8'),
      'Review this code:\n```javascript\n' + SAMPLE + '\n```');
    console.log(`   ⏱ ${((Date.now() - t) / 1000).toFixed(1)}s`);
    return result;
  };
  const logicP = run('logic-reviewer', 'fake', logicThink, { signal: ctrl1.signal, lr: 'http://127.0.0.1:' + port });

  // 3. Start security-scanner agent
  const securityThink = async (system, user) => {
    const inbox = String(user);
    if (!inbox.includes('auth.js') && !inbox.includes('security') && !inbox.includes('scan') && !inbox.includes('Security') && !inbox.includes('vulnerabilit')) return '(静默)';
    console.log('\n🤖 security-scanner calling qwen3.6-flash...');
    const t = Date.now();
    const result = await callSophnet('qwen3.6-flash', system + '\n' + fs.readFileSync(path.join(ROOT, 'rooms', 'security-scanner', 'SOUL.md'), 'utf8'),
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

  // 6. Check task board
  const tasks = (await request(port, '/tasks', { token: humanToken })).body;
  console.log(`\n📋 Task board: ${tasks?.length || 0} tasks`);
  (tasks || []).forEach(t => console.log(`   ${t.id} | ${t.state} | ${t.title?.slice(0, 50)}`));

  // Cleanup
  console.log('\n' + '─'.repeat(50));
  console.log('\n✅ End-to-end flow complete:');
  console.log('   dispatch → coordinator → adapter wake → real API call → result posted');
  console.log('   Two agents, two models, full coordinator routing.\n');

  ctrl1.abort(); ctrl2.abort();
  await new Promise(r => setTimeout(r, 500));  // let adapters shut down
  await room.close().catch(() => {});
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch {}
  for (const k of Object.keys(savedEnv)) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
}

main().catch(e => { console.error('❌ Error:', e.message, e.stack?.split('\n')[1]); process.exit(1); });
