#!/usr/bin/env node
// Same Roof — Code Review Demo (canonical)
//
// What this exercises, for real, in one process:
//   human --/dispatch--> coordinator --SSE--> logic-reviewer adapter (lib/room.js)
//   logic-reviewer --scoped token--> broker --> model
//   logic-reviewer replies with a PIN: line --> coordinator creates task + @mentions security-scanner
//   security-scanner wakes --scoped token--> broker --> model --> marks task done
//   broker refuses a cross-scope call; ledger shows who used which alias/model
//
// Modes:
//   node demo.js            mock: broker's built-in mock upstream, no API key. Model text is SCRIPTED;
//                           everything else (routing, token scope, delegation, task lifecycle, ledger) is real.
//   SOPHNET_KEY=… node demo.js --live
//                           real upstream (sophnet, OpenAI-compatible). ONE provider, TWO scoped aliases.
//
// Not exercised here: the execution gateway. Neither agent has core.exec/fs permissions in this demo;
// there is no sandbox to show. See packages/gateway/test for bwrap negative tests.
'use strict';
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http');

const LIVE = process.argv.includes('--live');
const API_KEY = process.env.SOPHNET_KEY || '';
if (LIVE && !API_KEY) { console.error('--live needs SOPHNET_KEY'); process.exit(1); }
const UPSTREAM = 'https://www.sophnet.com/api/open-apis/v1';
const MODELS = LIVE ? { logic: 'GLM-5', security: 'qwen3.6-flash' } : { logic: 'mock-logic', security: 'mock-security' };
const ALIASES = LIVE ? { logic: 'capable-model', security: 'cheap-model' } : { logic: 'mock-cheap', security: 'mock-cheap' };

// ---- temp workspace ----
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'sameroof-demo-'));
const RUN = path.join(ROOT, '.sameroof', 'run');
for (const d of ['rooms/human', 'rooms/logic-reviewer', 'rooms/security-scanner', 'apps/house', 'state']) fs.mkdirSync(path.join(ROOT, d), { recursive: true });
fs.mkdirSync(RUN, { recursive: true, mode: 0o700 });
fs.writeFileSync(path.join(ROOT, 'house.yaml'), 'schema_version: 1\nname: Code Review Demo\ntimezone: UTC\ndefaults:\n  runtime: broker-direct\n  plugins: [living-room]\n  heartbeat: {enabled: false}\n');
fs.writeFileSync(path.join(ROOT, 'rooms/human/room.yaml'), 'schema_version: 1\nid: resident_human_01\nname: human\nspecies: human\n');
fs.writeFileSync(path.join(ROOT, 'rooms/logic-reviewer/room.yaml'), 'schema_version: 1\nid: resident_logic_01\nname: logic-reviewer\nspecies: agent\nplugins: [living-room]\nheartbeat: {enabled: false}\n');
fs.writeFileSync(path.join(ROOT, 'rooms/security-scanner/room.yaml'), 'schema_version: 1\nid: resident_security_01\nname: security-scanner\nspecies: agent\nplugins: [living-room]\nheartbeat: {enabled: false}\n');
fs.copyFileSync(path.join(__dirname, 'rooms/logic-reviewer/SOUL.md'), path.join(ROOT, 'rooms/logic-reviewer/SOUL.md'));
fs.copyFileSync(path.join(__dirname, 'rooms/security-scanner/SOUL.md'), path.join(ROOT, 'rooms/security-scanner/SOUL.md'));
fs.writeFileSync(path.join(ROOT, 'apps/house/index.html'), '<!doctype html>');
const SAMPLE = fs.readFileSync(path.join(__dirname, 'sample-code/auth.js'), 'utf8');

const saved = {}; for (const k of ['HOME', 'SAMEROOF_ROOT', 'SAMEROOF_LR', 'SAMEROOF_ENABLE_MOCK']) saved[k] = process.env[k];
process.env.HOME = ROOT; process.env.SAMEROOF_ROOT = ROOT; delete process.env.SAMEROOF_LR;
if (!LIVE) process.env.SAMEROOF_ENABLE_MOCK = '1';

const { createLivingRoom } = require('../../packages/living-room/server');
const { run } = require('../../packages/adapters/lib/room');
const { BrokerStore } = require('../../packages/broker/store');
const { createBroker } = require('../../packages/broker/server');

// ---- helpers ----
const req = (port, p, o = {}) => new Promise((res, rej) => {
  const b = o.body ? Buffer.from(JSON.stringify(o.body)) : null;
  const r = http.request({ hostname: '127.0.0.1', port, path: p, method: o.method || 'GET', headers: { ...(o.token ? { authorization: 'Bearer ' + o.token } : {}), ...(b ? { 'content-type': 'application/json', 'content-length': b.length } : {}) } }, x => { let s = ''; x.on('data', c => s += c); x.on('end', () => { let v; try { v = JSON.parse(s); } catch { v = s; } res({ status: x.statusCode, body: v }); }); });
  r.on('error', rej); if (b) r.write(b); r.end();
});
const brokerCall = (sock, tok, model, system, user) => new Promise((res, rej) => {
  const b = JSON.stringify({ model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], max_tokens: 800, temperature: 0.3 });
  const r = http.request({ socketPath: sock, path: '/v1/chat/completions', method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + tok, 'content-length': Buffer.byteLength(b) } }, x => { let s = ''; x.on('data', c => s += c); x.on('end', () => { try { const j = JSON.parse(s); if (j.error) return rej(new Error(j.error.code + ': ' + j.error.message)); res(j.choices?.[0]?.message?.content || ''); } catch { rej(new Error('bad broker response: ' + s.slice(0, 120))); } }); });
  r.on('error', rej); r.setTimeout(90000, () => { r.destroy(); rej(new Error('timeout')); }); r.write(b); r.end();
});
const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (fn, label, ms = LIVE ? 120000 : 20000) => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw new Error('timeout: ' + label); await sleep(150); } };
const box = t => console.log('\n' + '─'.repeat(60) + '\n' + t + '\n' + '─'.repeat(60));

// Scripted responses for mock mode. In live mode the model writes these; SOUL.md tells it the PIN: shape.
const SCRIPT = {
  logic: (taskLine) => [
    'Review of auth.js — logic & architecture',
    '',
    'CRITICAL L11-12: SQL built by string interpolation. Use parameterized queries.',
    'CRITICAL L27: response returns the full user row including password. Select only safe fields.',
    'WARNING  L20-22: token is a deterministic HMAC of username — no expiry, no nonce. Use a random session id or JWT with exp.',
    'WARNING  L32: password reset over GET with email in query string. Use POST.',
    '',
    'Handing off to security-scanner for a vulnerability pass.',
    'PIN: Security scan of auth.js (see review above) | 给: security-scanner | 验收: findings posted with severity and line numbers',
  ].join('\n'),
  security: (taskId) => [
    'Security scan of auth.js',
    '',
    'CRITICAL L5:     hardcoded secret in source. Move to env / secret manager, rotate now.',
    'CRITICAL L11-12: SQL injection via username/password. Parameterize.',
    'HIGH     L24:    session cookie lacks httpOnly/secure/sameSite.',
    'HIGH     L38:    new password returned in HTTP response body.',
    'MEDIUM   L33:    Math.random() for password generation — not CSPRNG. Use crypto.randomBytes.',
    '',
    `PIN ${taskId}: done 5 findings posted (2 critical, 2 high, 1 medium)`,
  ].join('\n'),
};

async function main() {
  console.log(`Same Roof · code-review demo · ${LIVE ? 'LIVE (sophnet)' : 'MOCK (broker built-in upstream, scripted model text)'}`);

  // 0. broker + scoped tokens
  const store = new BrokerStore({ home: path.join(ROOT, '.sameroof'), enableMock: !LIVE });
  if (LIVE) {
    store.addCredential({ alias: ALIASES.logic, provider: 'sophnet', baseUrl: UPSTREAM, apiKey: API_KEY });
    store.addCredential({ alias: ALIASES.security, provider: 'sophnet', baseUrl: UPSTREAM, apiKey: API_KEY });
  }
  const tokLogic = store.issueToken({ residentId: 'resident_logic_01', credentials: [ALIASES.logic], models: [MODELS.logic], writeFile: false });
  const tokSec = store.issueToken({ residentId: 'resident_security_01', credentials: [ALIASES.security], models: [MODELS.security], writeFile: false });
  const broker = createBroker({ store }); await broker.listen(); const sock = broker.socketPath;
  box('0  broker up · two tokens, each scoped to one alias + one model');
  console.log(`   logic-reviewer   → ${ALIASES.logic} / ${MODELS.logic}`);
  console.log(`   security-scanner → ${ALIASES.security} / ${MODELS.security}`);
  console.log(LIVE ? '   (same upstream provider; isolation is by alias+model scope, not by provider)' : '   (mock upstream; tokens and scope checks are real)');

  // 1. coordinator
  const room = createLivingRoom({ houseDir: ROOT, runDir: RUN, dataDir: path.join(ROOT, 'state'), port: 0 });
  const port = (await room.listen()).port; const lr = 'http://127.0.0.1:' + port;
  const human = room.tokenStore.issue('resident_human_01').token;
  const h = (p, o = {}) => req(port, p, { token: human, ...o });
  box(`1  coordinator up on :${port}`);

  // 2. adapters (real lib/room.js loop; only think() is ours)
  const c1 = new AbortController(), c2 = new AbortController();
  const mkThink = (who, tok, model, soulFile, script) => async (system, user) => {
    const inbox = String(user).split('【你没读的客厅记录')[1] || '';
    if (!/auth\.js|Security scan|Review/i.test(inbox)) return '(静默)';
    const soul = fs.readFileSync(soulFile, 'utf8');
    const t0 = Date.now();
    const text = await brokerCall(sock, tok, model, system + '\n' + soul, String(user));   // full prompt (recent context + board + inbox), through broker either way
    console.log(`   ${who} → broker → ${model}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    if (LIVE) return text;
    // room.js renders my own tasks under 【黑板上我的事】 — take the id from there, not from the inbox
    const mine = String(user).split('【黑板上我的事】')[1] || '';
    const taskId = (mine.match(/task_[a-z0-9]{6,20}/i) || [])[0];
    return script(taskId || '');
  };
  const p1 = run('logic-reviewer', 'fake', mkThink('logic-reviewer', tokLogic.secret, MODELS.logic, path.join(ROOT, 'rooms/logic-reviewer/SOUL.md'), SCRIPT.logic), { signal: c1.signal, lr });
  const p2 = run('security-scanner', 'fake', mkThink('security-scanner', tokSec.secret, MODELS.security, path.join(ROOT, 'rooms/security-scanner/SOUL.md'), SCRIPT.security), { signal: c2.signal, lr });
  await until(async () => ((await h('/members')).body || []).filter(m => m.online).length >= 2, 'both adapters online');
  box('2  both adapters online (lib/room.js), connected over SSE');

  // 3. human posts the code to the room, then dispatches a short task that refers to it.
  //    (task titles are capped at 300 chars — the code goes in a /say, the agent sees it in recent context)
  const s = await h('/say', { method: 'POST', body: { text: 'Here is auth.js for review:\n```javascript\n' + SAMPLE + '\n```' } });
  if (s.status !== 200) throw new Error('say failed: ' + JSON.stringify(s.body));
  const d = await h('/dispatch', { method: 'POST', body: { to: 'logic-reviewer', task: 'Review the auth.js I just posted: logic, architecture, performance. Then hand security to security-scanner.' } });
  if (d.status !== 200) throw new Error('dispatch failed: ' + JSON.stringify(d.body));
  const task1 = d.body.task_id;
  box(`3  human → /say (code, ${SAMPLE.length} chars) → /dispatch → logic-reviewer   (${task1})`);

  // 4. logic-reviewer reviews and PINs a task to security-scanner (coordinator @mentions it → it wakes)
  const review = await until(async () => ((await h('/history?limit=50')).body || []).find(m => m.from_id === 'resident_logic_01' && m.kind === 'say'), 'logic-reviewer posts review');
  console.log('\n' + review.text.split('\n').slice(0, 6).map(l => '   ' + l).join('\n') + '\n   …');
  const task2 = await until(async () => ((await h('/tasks')).body || []).find(t => t.owner_id === 'resident_security_01' && t.id !== task1), 'security-scanner task created by logic-reviewer');
  box(`4  logic-reviewer → PIN: → coordinator created ${task2.id} for security-scanner (created_by=${task2.created_by})`);
  if (task2.created_by !== 'resident_logic_01') throw new Error('delegation was not by logic-reviewer');

  // 5. security-scanner scans and marks its task done
  const findings = await until(async () => ((await h('/history?limit=50')).body || []).find(m => m.from_id === 'resident_security_01' && m.kind === 'say'), 'security-scanner posts findings');
  console.log('\n' + findings.text.split('\n').slice(0, 6).map(l => '   ' + l).join('\n') + '\n   …');
  const done2 = await until(async () => { const t = ((await h('/tasks?state=done')).body || []).find(t => t.id === task2.id); return t && t.state === 'done' ? t : null; }, `${task2.id} reaches done`);
  box(`5  security-scanner → PIN ${task2.id}: done   (state=${done2.state}, result="${(done2.result || '').slice(0, 50)}")`);

  // 6. human closes the original task
  await h('/tasks/' + task1, { method: 'PATCH', body: { state: 'done', result: 'reviewed + scanned' } });
  const t1 = ((await h('/tasks?state=done')).body || []).find(t => t.id === task1);
  console.log(`   human → PATCH ${task1} → ${t1 ? t1.state : '?'}`);

  // 7. scope check + ledger
  box('6  broker: cross-scope call must fail');
  try { await brokerCall(sock, tokLogic.secret, MODELS.security, 'x', 'x'); throw new Error('SHOULD HAVE BEEN REJECTED'); }
  catch (e) { if (/SHOULD/.test(e.message)) throw e; console.log(`   logic-reviewer token → ${MODELS.security}: ${e.message.slice(0, 70)}`); }
  const ledger = store.db.prepare('SELECT resident_id, credential_alias, model, actual_tokens, latency_ms, status FROM ledger ORDER BY ts').all();
  box('7  broker ledger');
  for (const r of ledger) console.log(`   ${r.resident_id.padEnd(22)} ${r.credential_alias.padEnd(14)} ${(r.model || '').padEnd(16)} ${String(r.actual_tokens ?? '-').padStart(5)} tok ${String(r.latency_ms ?? '-').padStart(6)}ms  ${r.status}`);

  // 8. what the user would see: all messages incl. the delegation DM/system lines
  const all = (await h('/admin/messages?limit=100')).body || [];
  box('8  coordinator message kinds (what /console renders)');
  const kinds = {}; for (const m of all) kinds[m.kind] = (kinds[m.kind] || 0) + 1;
  console.log('   ' + Object.entries(kinds).map(([k, v]) => `${k}:${v}`).join('  '));

  console.log('\nOK · dispatch → coordinator → adapter → broker → model → PIN delegation → second adapter → task done · scope enforced · ledger complete\n');

  // Shutdown: abort adapters, close servers, bounded wait. Adapters may have a second wake in flight
  // (they get @mentioned by the PIN system message); we don't wait for it — hard-exit after 5s.
  c1.abort(); c2.abort();
  const forceExit = setTimeout(() => { console.error('(shutdown timed out; forcing exit)'); process.exit(0); }, 5000);
  await sleep(400);
  await Promise.race([Promise.all([room.close().catch(() => {}), broker.close().catch(() => {})]), sleep(3000)]);
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch {}
  for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  clearTimeout(forceExit);
  process.exit(0);
}
main().catch(e => { console.error('\nFAIL:', e.message); process.exit(1); });
