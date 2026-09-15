'use strict';
// The exact path a subrun loop takes: registerIntent (policy allow) → getIntent until terminal → readOutput once.
// Real gateway over its Unix socket, real bwrap if present.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createGateway } = require('@sameroof/gateway/server');
const gw = require('../lib/gateway-client');

const sandboxOk = () => { try { const { spawnSync } = require('node:child_process'); return spawnSync('/usr/bin/bwrap', ['--unshare-user', '--unshare-net', '--ro-bind', '/', '/', '/bin/true'], { stdio: 'ignore', timeout: 5000 }).status === 0; } catch { return false; } };
const HOUSE = `schema_version: 1
name: gwc
timezone: UTC
defaults:
  runtime: test
  plugins: []
  heartbeat: {}
  context: {recent_messages: 0, recent_max_chars: 0, memory_hits: 0, memory_recent: 0}
  approve_timeout: 1m
  permissions:
    core.fs.read: allow
    core.exec.ro: allow
    core.exec: approve
    core.fs.write: approve
credentials: []
notify: {admin: 甲}
`;

test('gateway-client: register(allow) → getIntent → readOutput over the socket, grep lines intact; second run id 404', { skip: !sandboxOk() && 'bwrap unavailable' }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sameroof-gwc-'));
  fs.mkdirSync(path.join(root, 'rooms', '甲'), { recursive: true });
  fs.writeFileSync(path.join(root, 'rooms', '甲', 'room.yaml'), 'schema_version: 1\nid: resident_alpha_01\nname: 甲\nspecies: human\n');
  fs.writeFileSync(path.join(root, 'rooms', '甲', 'code.js'), 'a();\nrecall(x);\nb();\nawait recall(y);\n');
  fs.writeFileSync(path.join(root, 'house.yaml'), HOUSE);
  const gateway = createGateway({ houseDir: root, runDir: path.join(root, 'run'), stateDir: path.join(root, 'state'), lockRequired: false, resultClient: async () => ({ message_id: 'm' }) });
  const saved = { sock: process.env.SAMEROOF_GATEWAY_SOCK, tok: process.env.SAMEROOF_GATEWAY_TOKEN_FILE };
  try {
    await gateway.listen();
    gateway.issueAdapterToken('resident_alpha_01');
    process.env.SAMEROOF_GATEWAY_SOCK = gateway.socketPath;
    process.env.SAMEROOF_GATEWAY_TOKEN_FILE = path.join(gateway.adapterTokensDir, 'resident_alpha_01');

    const requestId = gw.newRequestId();
    const reg = await gw.registerIntent({ residentId: 'resident_alpha_01', runId: 'sub_client01', requestId, action: 'core.exec.ro', params: { argv: ['/bin/sh', '-lc', 'grep -n recall code.js'], cwd: { root_id: 'own-room', path: '' }, writable_root_ids: [], timeout_ms: 5000 } });
    assert.equal(reg.request_id, requestId);
    assert.equal(reg.state, 'executing', 'policy path returns executing immediately');

    let st; for (let i = 0; i < 100; i++) { st = await gw.getIntent('resident_alpha_01', requestId); if (st.body && st.body.state !== 'executing') break; await new Promise(r => setTimeout(r, 30)); }
    assert.equal(st.status, 200); assert.equal(st.body.state, 'succeeded', JSON.stringify(st.body));
    assert.equal(st.body.result.details.stdout, '[output omitted]');

    const out = await gw.readOutput('resident_alpha_01', requestId, 'sub_client01');
    assert.equal(out.status, 200, JSON.stringify(out));
    assert.equal(out.body.result.details.stdout, '2:recall(x);\n4:await recall(y);\n', 'line structure preserved');
    assert.equal(out.body.truncated, false); assert.equal(out.body.reads_remaining, 2);

    const wrong = await gw.readOutput('resident_alpha_01', requestId, 'sub_other');
    assert.equal(wrong.status, 404); assert.equal(wrong.error.code, 'GW-OUTPUT-NOT-FOUND');
  } finally {
    if (saved.sock === undefined) delete process.env.SAMEROOF_GATEWAY_SOCK; else process.env.SAMEROOF_GATEWAY_SOCK = saved.sock;
    if (saved.tok === undefined) delete process.env.SAMEROOF_GATEWAY_TOKEN_FILE; else process.env.SAMEROOF_GATEWAY_TOKEN_FILE = saved.tok;
    await gateway.close(); fs.rmSync(root, { recursive: true, force: true });
  }
});
