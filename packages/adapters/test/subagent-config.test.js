'use strict';
// 审查员 P1-3: partial room budget must not wipe house caps (NaN → unlimited); room can only tighten; enabled = room ?? house.
const assert = require('node:assert/strict');
const test = require('node:test');
const { mergeSubagentConfig } = require('../lib/room');
const { SubrunManager } = require('../lib/subrun-manager');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');

test('house full budget + room only minutes → model_calls/tool_calls keep house caps; minutes takes the tighter', () => {
  const c = mergeSubagentConfig({ enabled: true, budget: { model_calls: 15, tool_calls: 20, minutes: 10 }, tools: ['core.fs.read', 'core.exec.ro'] }, { budget: { minutes: 2 } });
  assert.deepEqual(c.budget, { model_calls: 15, tool_calls: 20, minutes: 2 });
  assert.equal(c.enabled, true);
  for (const v of Object.values(c.budget)) assert.ok(Number.isInteger(v) && v > 0);
});
test('room cannot widen: bigger budget, extra tool, higher parallel are clamped to house', () => {
  const c = mergeSubagentConfig({ enabled: true, max_parallel: 1, budget: { model_calls: 5, tool_calls: 3, minutes: 1 }, tools: ['core.fs.read'] }, { max_parallel: 8, budget: { model_calls: 100, tool_calls: 100, minutes: 60 }, tools: ['core.fs.read', 'core.exec.ro'] });
  assert.equal(c.max_parallel, 1); assert.deepEqual(c.budget, { model_calls: 5, tool_calls: 3, minutes: 1 }); assert.deepEqual(c.tools, ['core.fs.read']);
});
test('enabled precedence: room false overrides house true; house true alone enables; nothing → false', () => {
  assert.equal(mergeSubagentConfig({ enabled: true }, { enabled: false }).enabled, false);
  assert.equal(mergeSubagentConfig({ enabled: true }, {}).enabled, true);
  assert.equal(mergeSubagentConfig(undefined, undefined).enabled, false);
});
test('manager fails closed on a non-finite cap even if config bypassed the schema', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-'));
  const m = new SubrunManager({ dir, mailbox: { put() {}, pending: () => [] }, requestWake() {}, model: async () => ({ text: 'x' }), gateway: {}, residentId: 'r', residentName: 'r', config: { budget: { model_calls: undefined, tool_calls: 20, minutes: 10 }, tools: ['core.fs.read'] } });
  assert.throws(() => m.start({ task: 't' }), /fail closed/);
  fs.rmSync(dir, { recursive: true, force: true });
});
