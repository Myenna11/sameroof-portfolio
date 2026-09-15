'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const test = require('node:test');
const { SubrunManager, Transcript } = require('../lib/subrun-manager');
const { Mailbox } = require('../lib/mailbox');

const mkGw = () => { let n = 0; return { newRequestId: () => 'req_m' + String(++n).padStart(6, '0'), registerIntent: async ({ requestId }) => ({ request_id: requestId, state: 'executing' }), getIntent: async () => ({ status: 200, body: { state: 'succeeded' } }), readOutput: async () => ({ status: 200, body: { truncated: false, total_bytes: {}, result: { details: { exit_code: 0, stdout: 'hit\n' } } } }) }; };
const scripted = (...replies) => { let i = 0; return async (m, signal) => { const r = replies[Math.min(i++, replies.length - 1)]; if (r === 'HANG') return new Promise((_, rej) => signal.addEventListener('abort', () => rej(signal.reason), { once: true })); return { text: r, usage: { prompt_tokens: 1, completion_tokens: 1 } }; }; };
const fixture = (model, cfg = {}) => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'srm-')); const wakes = []; const mb = new Mailbox(path.join(dir, 'mailbox.jsonl')); const m = new SubrunManager({ dir, mailbox: mb, requestWake: (lane, reason) => wakes.push({ lane, reason }), model, gateway: mkGw(), residentId: 'resident_a', residentName: '甲', config: { max_parallel: 2, tools: ['core.exec.ro', 'core.fs.read'], ...cfg } }); return { dir, wakes, mb, m }; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

test('start → runs → mailbox item + wake; request_id indexed BEFORE register; transcript complete', async () => {
  const f = fixture(scripted('TOOL: core.exec.ro {"argv":["/bin/ls"],"cwd":{"root_id":"code","path":""}}', 'done: 1 hit'));
  const { sub_id } = f.m.start({ task: 'find hits' });
  assert.equal(f.m.activeCount, 1);
  await sleep(200);
  assert.equal(f.m.activeCount, 0);
  const p = f.mb.pending(); assert.equal(p.length, 1); assert.equal(p[0].sub_id, sub_id); assert.equal(p[0].status, 'ok'); assert.match(p[0].summary, /1 hit/); assert.deepEqual(p[0].request_ids, ['req_m000001']);
  assert.ok(f.m.ownsRequest('req_m000001')); assert.equal(f.m.ownsRequest('req_other'), false);
  assert.deepEqual(f.wakes, [{ lane: 'agent', reason: `subrun ${sub_id} ok` }]);
  const rows = Transcript.read(path.join(f.dir, 'subruns', sub_id + '.jsonl')); const evs = rows.map(r => r.ev);
  assert.equal(evs[0], 'task'); assert.equal(evs[1], 'start'); assert.ok(evs.includes('tool_register')); assert.equal(evs[evs.length - 1], 'end');
  fs.rmSync(f.dir, { recursive: true, force: true });
});

test('parallel limit enforced; spec can only narrow tools/budget', async () => {
  const f = fixture(scripted('HANG'), { max_parallel: 1 });
  f.m.start({ task: 'a' });
  assert.throws(() => f.m.start({ task: 'b' }), /并行上限 1/);
  await f.m.stop(500);
  const p = f.mb.pending(); assert.equal(p.length, 1); assert.equal(p[0].status, 'interrupted');
  const g = fixture(scripted('TOOL: core.fs.write {"x":1}', 'end'), { tools: ['core.fs.read'] });
  const { sub_id } = g.m.start({ task: 'c', tools: ['core.fs.read', 'core.exec.ro', 'core.fs.write'] });   // asks for more than allowed
  await sleep(150); const rows = Transcript.read(path.join(g.dir, 'subruns', sub_id + '.jsonl'));
  assert.deepEqual(rows.find(r => r.ev === 'start').tools, ['core.fs.read'], 'narrowed to the manager allowlist');
  assert.ok(rows.some(r => r.ev === 'tool_refused' && r.action === 'core.fs.write' && r.reason === 'not_allowed'));
  fs.rmSync(f.dir, { recursive: true, force: true }); fs.rmSync(g.dir, { recursive: true, force: true });
});

test('stop(): aborts live subruns → interrupted items; SIGTERM shape', async () => {
  const f = fixture(scripted('HANG'));
  f.m.start({ task: 'x' }); f.m.start({ task: 'y' });
  const t0 = Date.now(); const left = await f.m.stop(2000);
  assert.ok(Date.now() - t0 < 1500, 'unwound promptly'); assert.equal(left, 0);
  assert.deepEqual(f.mb.pending().map(i => i.status), ['interrupted', 'interrupted']);
  assert.throws(() => f.m.start({ task: 'z' }), /stopped/);
  fs.rmSync(f.dir, { recursive: true, force: true });
});

test('recoverOnStartup: unfinished transcript → interrupted mailbox item, request index rebuilt, no re-execution, bounded probe', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'srm-')); fs.mkdirSync(path.join(dir, 'subruns'));
  const t = new Transcript(path.join(dir, 'subruns', 'sub_old1.jsonl'));
  t.append({ ev: 'task', task: 'old task' }); t.append({ ev: 'start' }); t.append({ ev: 'model_reply', preview: 'was working on it' }); t.append({ ev: 'tool_register', request_id: 'req_old1' }); t.append({ ev: 'tool_register', request_id: 'req_old2' });
  const done = new Transcript(path.join(dir, 'subruns', 'sub_done.jsonl')); done.append({ ev: 'task', task: 'finished' }); done.append({ ev: 'start' }); done.append({ ev: 'tool_register', request_id: 'req_done1' }); done.append({ ev: 'end', status: 'ok' });
  const wakes = []; let registers = 0; const mb = new Mailbox(path.join(dir, 'mailbox.jsonl'));
  const m = new SubrunManager({ dir, mailbox: mb, requestWake: (l, r) => wakes.push(r), model: async () => ({ text: 'x' }), gateway: { newRequestId: () => 'n', registerIntent: async () => { registers++; return {}; } }, residentId: 'r', residentName: 'r' });
  const probed = []; const r = await m.recoverOnStartup(async id => { probed.push(id); return { body: { state: id === 'req_old1' ? 'succeeded' : 'failed_unknown' } }; }, 10);
  assert.equal(r.interrupted, 1); assert.equal(r.probes, 2); assert.equal(registers, 0, 'nothing re-executed');
  const p = mb.pending(); assert.equal(p.length, 1); assert.equal(p[0].sub_id, 'sub_old1'); assert.equal(p[0].status, 'interrupted'); assert.match(p[0].summary, /was working on it/); assert.deepEqual(p[0].request_ids, ['req_old1', 'req_old2']); assert.deepEqual(p[0].request_states, { req_old1: 'succeeded', req_old2: 'failed_unknown' });
  assert.ok(m.ownsRequest('req_old1') && m.ownsRequest('req_old2') && m.ownsRequest('req_done1'), 'index includes finished subruns too — late DMs after restart are recognised');
  assert.deepEqual(wakes, ['subrun 恢复：1 个被中断']);
  const rows = Transcript.read(path.join(dir, 'subruns', 'sub_old1.jsonl')); assert.equal(rows[rows.length - 1].ev, 'end'); assert.equal(rows[rows.length - 1].status, 'interrupted');
  // second startup: nothing new
  const m2 = new SubrunManager({ dir, mailbox: mb, requestWake: () => {}, model: async () => ({}), gateway: {}, residentId: 'r', residentName: 'r' });
  assert.equal((await m2.recoverOnStartup()).interrupted, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});
