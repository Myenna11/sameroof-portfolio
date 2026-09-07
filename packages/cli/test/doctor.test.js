'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const { inspectLostMessages } = require('../doctor');

test('doctor only reports old queued deliveries absent from that resident run.heard', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sameroof-doctor-'));
  try {
    fs.mkdirSync(path.join(root, 'state', 'runs'), { recursive: true });
    const db = new DatabaseSync(path.join(root, 'state', 'house.db'));
    db.exec('CREATE TABLE deliveries(message_id TEXT,resident_id TEXT,status TEXT,ts TEXT,PRIMARY KEY(message_id,resident_id))');
    const ins = db.prepare('INSERT INTO deliveries VALUES(?,?,?,?)');
    ins.run('msg_heard', 'resident_a_01', 'queued', '2026-09-07T09:00:00.000Z');
    ins.run('msg_lost', 'resident_a_01', 'queued', '2026-09-07T09:01:00.000Z');
    ins.run('msg_new', 'resident_a_01', 'queued', '2026-09-07T09:58:00.000Z');
    ins.run('msg_read', 'resident_a_01', 'read', '2026-09-07T09:00:00.000Z');
    ins.run('msg_heard', 'resident_b_01', 'queued', '2026-09-07T09:00:00.000Z');
    db.close();
    fs.writeFileSync(path.join(root, 'state', 'runs', 'resident_a_01.jsonl'), JSON.stringify({ resident_id: 'resident_a_01', heard: [{ id: 'msg_heard' }] }) + '\n');
    const report = inspectLostMessages({ house: root, 'queued-minutes': 10 }, Date.parse('2026-09-07T10:00:00.000Z'));
    assert.equal(report.ok, false);
    assert.deepEqual(report.suspects.map(x => `${x.resident_id}/${x.message_id}`).sort(), ['resident_a_01/msg_lost', 'resident_b_01/msg_heard']);
    assert.equal(report.queued_checked, 3);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
