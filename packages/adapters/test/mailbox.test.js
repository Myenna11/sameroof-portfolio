'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const test = require('node:test');
const { Mailbox } = require('../lib/mailbox');

test('mailbox: put → pending → attempt(not consumed) → still pending with marker → attempt(consumed) → gone', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-')); const mb = new Mailbox(path.join(dir, 'state', 'mailbox.jsonl'));
  const a = mb.put({ kind: 'subresult', sub_id: 'sub_a', status: 'ok', summary: 'found 3 callers', task: 'find recall callers' });
  const b = mb.put({ kind: 'subresult', sub_id: 'sub_b', status: 'interrupted', summary: null });
  assert.deepEqual(mb.pending().map(i => i.sub_id), ['sub_a', 'sub_b']);
  assert.equal(mb.markAttempt([a.id], 'error', false), 1);
  const p = mb.pending(); assert.equal(p.length, 2); assert.equal(p[0].attempts.length, 1); assert.equal(p[0].attempts[0].exit, 'error');
  assert.match(Mailbox.render(p), /上一轮已尝试处理：error/);
  assert.equal(mb.markAttempt([a.id, b.id], 'say', true), 2);
  assert.deepEqual(mb.pending(), []);
  // file survives a "crash" (re-open) and consumed items stay consumed
  const mb2 = new Mailbox(mb.file); assert.deepEqual(mb2.pending(), []);
  assert.equal(mb2._readAll().length, 2, 'append-only: consumed rows retained');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('mailbox: render is distinct from a DM and lists tool intents', () => {
  const s = Mailbox.render([{ id: 'x', sub_id: 'sub_z', status: 'ok', summary: 'line1\nline2', request_ids: ['req_1', 'req_2'], usage: { model_calls: 2 }, tool_calls: 2, elapsed_ms: 4200 }]);
  assert.match(s, /^【子任务结果】/); assert.match(s, /\[ok\] sub_z/); assert.match(s, /model 2 · tools 2 · 4\.2s/); assert.match(s, /tool intents: req_1, req_2/); assert.doesNotMatch(s, /私信/);
});

test('mailbox: corrupt line is skipped, others survive', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-')); const f = path.join(dir, 'mailbox.jsonl');
  fs.writeFileSync(f, JSON.stringify({ id: 'a', sub_id: 's1', status: 'ok', consumed: false }) + '\n{not json\n' + JSON.stringify({ id: 'b', sub_id: 's2', status: 'ok', consumed: false }) + '\n');
  assert.deepEqual(new Mailbox(f).pending().map(i => i.sub_id), ['s1', 's2']);
  fs.rmSync(dir, { recursive: true, force: true });
});
