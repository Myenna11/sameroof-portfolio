'use strict';
// lib/subagent.js with a scripted model and a mock gateway-client. Contracts: zero context, TOOL: parse, refusal of
// non-allowed / approve-only actions, request_id persisted before register, poll → /output, truncation labelling,
// budgets, timeout, abort, transcript order.
const assert = require('node:assert/strict');
const test = require('node:test');
const { runSubagent, parseToolLines } = require('../lib/subagent');

const mkGateway = (opts = {}) => {
  const calls = []; let n = 0;
  return {
    calls,
    newRequestId: () => 'req_t' + String(++n).padStart(6, '0'),
    registerIntent: async ({ requestId, action, params }) => { calls.push({ ev: 'register', requestId, action, params }); if (opts.registerState) return { request_id: requestId, state: opts.registerState }; return { request_id: requestId, state: 'executing' }; },
    getIntent: async (_r, requestId) => { calls.push({ ev: 'poll', requestId }); return { status: 200, body: { state: opts.terminal || 'succeeded', result: { details: { stdout: '[output omitted]' } } } }; },
    readOutput: async (_r, requestId, runId) => { calls.push({ ev: 'output', requestId, runId }); if (opts.outputStatus) return { status: opts.outputStatus, error: { code: opts.outputCode || 'GW-OUTPUT-CONSUMED' } }; return { status: 200, body: { truncated: !!opts.truncated, total_bytes: opts.truncated ? { stdout: 9999 } : {}, result: { details: { exit_code: 0, stdout: opts.stdout || 'a.js:1:recall()\nb.js:7:recall()\n', content: opts.content } } } }; },
  };
};
const mkTranscript = () => { const rows = []; return { rows, append: o => rows.push(o) }; };
const scripted = replies => { let i = 0; return async (messages) => { const r = replies[Math.min(i++, replies.length - 1)]; return typeof r === 'function' ? r(messages) : { text: r, usage: { prompt_tokens: 10, completion_tokens: 5 } }; }; };

test('parseToolLines: extracts TOOL: lines, keeps the rest, flags bad json', () => {
  const { calls, rest } = parseToolLines('thinking…\nTOOL: core.exec.ro {"argv":["/bin/ls"],"cwd":{"root_id":"code","path":""}}\nTOOL: core.fs.read {bad\nmore');
  assert.equal(calls.length, 2); assert.equal(calls[0].action, 'core.exec.ro'); assert.equal(calls[1].parseError, true); assert.equal(rest, 'thinking…\nmore');
});

test('happy path: brief → tool → output verbatim in next prompt → summary; zero context; request_id persisted before register', async () => {
  const gw = mkGateway(); const tr = mkTranscript(); let firstPrompt = null;
  const model = scripted([m => { firstPrompt = m.slice(); return { text: 'TOOL: core.exec.ro {"argv":["/bin/sh","-lc","grep -rn recall ."],"cwd":{"root_id":"code","path":""}}', usage: { prompt_tokens: 1, completion_tokens: 1 } }; }, m => ({ text: `Found 2 callers.\n${m[m.length - 1].content.includes('a.js:1:recall()') ? 'SAW_OUTPUT' : 'NO_OUTPUT'}`, usage: { prompt_tokens: 1, completion_tokens: 1 } })]);
  const r = await runSubagent({ brief: { task: 'find recall callers' }, system: 'SOUL', tools: ['core.exec.ro'], model, gateway: gw, runId: 'sub_x', residentId: 'resident_a', transcript: tr, residentName: '甲' });
  assert.equal(r.status, 'ok'); assert.match(r.summary, /SAW_OUTPUT/); assert.equal(r.toolCalls, 1); assert.deepEqual(r.requestIds, ['req_t000001']);
  assert.equal(firstPrompt.length, 2, 'system + brief only — zero context'); assert.match(firstPrompt[0].content, /子任务执行体/); assert.match(firstPrompt[1].content, /【任务】\nfind recall callers/);
  const evs = tr.rows.map(x => x.ev); assert.ok(evs.indexOf('tool_register') < gw.calls.findIndex(c => c.ev === 'register') + 99, 'transcript row written');
  assert.equal(evs.indexOf('tool_register') > evs.indexOf('model_reply'), true);
  assert.deepEqual(gw.calls.map(c => c.ev), ['register', 'poll', 'output']); assert.equal(gw.calls[2].runId, 'sub_x');
  assert.equal(r.usage.model_calls, 2);
});

test('refusals: approve-only action, action outside allowlist, bad json — all become tool results, loop continues', async () => {
  const gw = mkGateway(); const tr = mkTranscript();
  const model = scripted(['TOOL: core.fs.write {"root_id":"code","path":"x","content":"y"}\nTOOL: core.exec.ro {"argv":["/bin/ls"],"cwd":{"root_id":"code","path":""}}\nTOOL: core.fs.read {nope', m => ({ text: 'done: ' + m[m.length - 1].content.replace(/\n/g, ' | ') })]);
  const r = await runSubagent({ brief: { task: 't' }, tools: ['core.fs.read'], model, gateway: gw, runId: 'sub_x', residentId: 'r', transcript: tr });
  assert.equal(r.status, 'ok');
  assert.match(r.summary, /core\.fs\.write\] 拒绝：子任务不可用/); assert.match(r.summary, /core\.exec\.ro\] 拒绝：子任务不可用/); assert.match(r.summary, /core\.fs\.read\] 拒绝：JSON/);
  assert.equal(gw.calls.length, 0, 'nothing reached the gateway'); assert.equal(r.toolCalls, 0);
});

test('gateway says awaiting_approval (gated root under allow): refused, not waited on', async () => {
  const gw = mkGateway({ registerState: 'awaiting_approval' });
  const model = scripted(['TOOL: core.fs.read {"root_id":"rooms","path":"乙/SOUL.md"}', m => ({ text: m[m.length - 1].content })]);
  const r = await runSubagent({ brief: { task: 't' }, tools: ['core.fs.read'], model, gateway: gw, runId: 'sub_x', residentId: 'r' });
  assert.match(r.summary, /需要人工审批（awaiting_approval）/); assert.deepEqual(gw.calls.map(c => c.ev), ['register']);
});

test('/output 410 → output_unavailable, never [output omitted]; truncated → labelled', async () => {
  const gw1 = mkGateway({ outputStatus: 410, outputCode: 'GW-OUTPUT-CONSUMED' });
  const r1 = await runSubagent({ brief: { task: 't' }, tools: ['core.exec.ro'], model: scripted(['TOOL: core.exec.ro {"argv":["/bin/ls"],"cwd":{"root_id":"code","path":""}}', m => ({ text: m[m.length - 1].content })]), gateway: gw1, runId: 'sub_x', residentId: 'r' });
  assert.match(r1.summary, /output_unavailable: GW-OUTPUT-CONSUMED/); assert.doesNotMatch(r1.summary, /output omitted/);
  const gw2 = mkGateway({ truncated: true, stdout: 'partial' });
  const r2 = await runSubagent({ brief: { task: 't' }, tools: ['core.exec.ro'], model: scripted(['TOOL: core.exec.ro {"argv":["/bin/ls"],"cwd":{"root_id":"code","path":""}}', m => ({ text: m[m.length - 1].content })]), gateway: gw2, runId: 'sub_x', residentId: 'r' });
  assert.match(r2.summary, /\[truncated: \{"stdout":9999\} total bytes; partial below — do not report as complete\]\nexit=0\npartial/);
});

test('budgets: model_calls cap → status budget with last text; tool cap refuses extra calls', async () => {
  const gw = mkGateway();
  const loop = scripted(['TOOL: core.exec.ro {"argv":["/bin/ls"],"cwd":{"root_id":"code","path":""}}\npartial thoughts']);   // never stops asking for tools
  const r = await runSubagent({ brief: { task: 't' }, tools: ['core.exec.ro'], budget: { modelCalls: 3, toolCalls: 2 }, model: loop, gateway: gw, runId: 'sub_x', residentId: 'r' });
  assert.equal(r.status, 'budget'); assert.equal(r.usage.model_calls, 3); assert.equal(r.toolCalls, 2, 'third tool call refused'); assert.match(r.summary, /partial thoughts/);
});

test('timeout and external abort → timeout / interrupted, model call cancelled', async () => {
  const gw = mkGateway();
  const slow = async (_m, signal) => new Promise((_, rej) => signal.addEventListener('abort', () => rej(signal.reason), { once: true }));
  const r1 = await runSubagent({ brief: { task: 't' }, budget: { ms: 120 }, model: slow, gateway: gw, runId: 'sub_x', residentId: 'r' });
  assert.equal(r1.status, 'timeout');
  const ac = new AbortController(); setTimeout(() => ac.abort(new Error('SIGTERM')), 80);
  const r2 = await runSubagent({ brief: { task: 't' }, model: slow, gateway: gw, runId: 'sub_x', residentId: 'r', signal: ac.signal });
  assert.equal(r2.status, 'interrupted');
});

test('inherit: turns are placed between system and brief', async () => {
  let seen; const model = async m => { seen = m.slice(); return { text: 'ok' }; };
  await runSubagent({ brief: { task: 't' }, inherit: [{ role: 'user', content: 'earlier' }, { role: 'assistant', content: 'reply' }], model, gateway: mkGateway(), runId: 'sub_x', residentId: 'r' });
  assert.deepEqual(seen.map(x => x.role), ['system', 'user', 'assistant', 'user']); assert.equal(seen[1].content, 'earlier');
});

test("gateway 'failed' with an exit code (grep rc=2 on one unreadable file) still yields the output, labelled exit=2", async () => {
  const gw = mkGateway({ terminal: 'failed' });
  gw.getIntent = async (_r, requestId) => ({ status: 200, body: { state: 'failed', result: { details: { exit_code: 2, stdout: '[output omitted]' } } } });
  gw.readOutput = async () => ({ status: 200, body: { truncated: false, total_bytes: {}, result: { details: { exit_code: 2, stdout: 'a.js:1:hit\n', stderr: 'grep: x.yaml: Permission denied' } } } });
  const r = await runSubagent({ brief: { task: 't' }, tools: ['core.exec.ro'], model: scripted(['TOOL: core.exec.ro {"argv":["/bin/sh","-lc","grep -rn hit ."],"cwd":{"root_id":"code","path":""}}', m => ({ text: m[m.length - 1].content })]), gateway: gw, runId: 'sub_x', residentId: 'r' });
  assert.match(r.summary, /exit=2\na\.js:1:hit/); assert.match(r.summary, /\[stderr\]\ngrep: x\.yaml: Permission denied/); assert.doesNotMatch(r.summary, /output omitted/);
});
