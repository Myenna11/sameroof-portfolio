'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');
const jcs = require('@sameroof/jcs');
const { createGateway } = require('../server');

function makeHouse(root) {
  for (const [name, id] of [['alpha', 'resident_alpha_01'], ['beta', 'resident_beta_01']]) {
    fs.mkdirSync(path.join(root, 'rooms', name), { recursive: true });
    fs.writeFileSync(path.join(root, 'rooms', name, 'room.yaml'), `schema_version: 1\nid: ${id}\nname: ${name}\nspecies: human\n`);
  }
  fs.writeFileSync(path.join(root, 'house.yaml'), `schema_version: 1
name: security-test
timezone: UTC
defaults:
  runtime: test
  plugins: []
  heartbeat: {}
  context: {recent_messages: 0, recent_max_chars: 0, memory_hits: 0, memory_recent: 0}
  approve_timeout: 1m
  permissions:
    core.fs.read: approve
    core.fs.write: approve
    core.exec: approve
credentials: []
notify: {admin: alpha}
`);
}

function fixture(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sameroof-security-')); makeHouse(root);
  const delivered = []; const resultClient = Object.hasOwn(options, 'resultClient') ? options.resultClient : async value => { delivered.push(value); return { message_id: 'msg_' + value.row.request_id }; };
  const gateway = createGateway({ houseDir: root, runDir: path.join(root, 'gateway-run'), stateDir: path.join(root, 'gateway-state'), lockRequired: false, bwrapProbe: false, resultClient, ...options });
  const token = gateway.issueAdapterToken('resident_alpha_01').token;
  return { root, gateway, token, delivered, close: async () => { await gateway.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}

function intent(id, file = id + '.txt', content = id) {
  return { request_id: id, resident_id: 'resident_alpha_01', action: 'core.fs.write', params: { root_id: 'own-room', path: file, content, mode: 'create' }, requested_ttl_seconds: 60 };
}
function approval(value, id = 'apr_' + value.request_id.slice(4)) {
  return { approval_id: id, gateway_request_id: value.request_id, resident_id: value.resident_id, action: value.action, params_digest: jcs.digest(value.params), decision: 'allowed', single_use: true, expires_at: new Date(Date.now() + 60000).toISOString() };
}

test('approval service missing, wrong-token response, and broken stream never execute', async () => {
  for (const mode of ['missing', 'wrong-token', 'broken']) {
    let server; const f = fixture({ resultClient: undefined });
    try {
      const value = intent('req_service_' + mode.replace('-', '_'), mode + '.txt'); f.gateway.registerIntent(value, f.token);
      if (mode !== 'missing') {
        fs.writeFileSync(f.gateway.serviceTokenFile, 'service-' + 'x'.repeat(40), { mode: 0o600 });
        server = http.createServer((req, res) => { if (mode === 'broken') return req.socket.destroy(); res.writeHead(401); res.end('{}'); });
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); f.gateway.options.livingRoomPort = server.address().port;
      }
      await assert.rejects(f.gateway.pollApprovalResults());
      assert.equal(fs.existsSync(path.join(f.root, 'rooms', 'alpha', mode + '.txt')), false);
      assert.equal(f.gateway.state.db.prepare('SELECT status FROM intents WHERE request_id=?').get(value.request_id).status, 'awaiting_approval');
    } finally { if (server) await new Promise(resolve => server.close(resolve)); await f.close(); }
  }
});

test('all approval bindings fail closed and concurrent consumption executes exactly once', async () => {
  const f = fixture();
  try {
    const mutations = [
      a => { a.gateway_request_id = 'req_wrong_request'; },
      a => { a.resident_id = 'resident_beta_01'; },
      a => { a.action = 'core.fs.read'; },
      a => { a.params_digest = '0'.repeat(64); }
    ];
    for (let i = 0; i < mutations.length; i++) {
      const value = intent('req_binding0' + i, `binding-${i}.txt`); f.gateway.registerIntent(value, f.token); const bad = approval(value, 'apr_binding0' + i); mutations[i](bad);
      await assert.rejects(f.gateway.execute(value.request_id, bad), e => e.code === 'GW-APPROVAL-MISMATCH');
      assert.equal(fs.existsSync(path.join(f.root, 'rooms', 'alpha', `binding-${i}.txt`)), false);
    }
    const value = intent('req_concurr01', 'concurrent.txt'); f.gateway.registerIntent(value, f.token); const allowed = approval(value, 'apr_concurr01');
    const settled = await Promise.allSettled([f.gateway.execute(value.request_id, allowed), f.gateway.execute(value.request_id, allowed)]);
    assert.equal(settled.filter(x => x.status === 'fulfilled').length, 1); assert.equal(settled.filter(x => x.status === 'rejected').length, 1);
    assert.equal(fs.readFileSync(path.join(f.root, 'rooms', 'alpha', 'concurrent.txt'), 'utf8'), value.params.content);
    assert.equal(f.gateway.state.db.prepare("SELECT count(*) AS n FROM audit WHERE request_id=? AND event='executed'").get(value.request_id).n, 1);
  } finally { await f.close(); }
});

test('pending and approval expiry are terminal; executing crash recovers as failed_unknown without replay', async () => {
  const f = fixture();
  try {
    const pending = intent('req_expire001', 'pending.txt'); f.gateway.registerIntent(pending, f.token);
    f.gateway.state.db.prepare('UPDATE intents SET expires_at=? WHERE request_id=?').run(new Date(Date.now() - 1000).toISOString(), pending.request_id);
    assert.equal(f.gateway.expirePending(), 1); assert.equal(f.gateway.state.db.prepare('SELECT status FROM intents WHERE request_id=?').get(pending.request_id).status, 'expired');
    const expired = intent('req_expire002', 'approval.txt'); f.gateway.registerIntent(expired, f.token); const old = approval(expired, 'apr_expire002'); old.expires_at = new Date(Date.now() - 1000).toISOString();
    await assert.rejects(f.gateway.execute(expired.request_id, old), e => e.code === 'GW-APPROVAL-EXPIRED'); assert.equal(fs.existsSync(path.join(f.root, 'rooms', 'alpha', 'approval.txt')), false);
  } finally { await f.close(); }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sameroof-crash-')); makeHouse(root); const options = { houseDir: root, runDir: path.join(root, 'run'), stateDir: path.join(root, 'state'), lockRequired: false, bwrapProbe: false, resultClient: async () => ({}) };
  const first = createGateway(options); const token = first.issueAdapterToken('resident_alpha_01').token; const value = intent('req_crash0001', 'crash.txt'); first.registerIntent(value, token);
  first.state.db.prepare("UPDATE intents SET status='executing' WHERE request_id=?").run(value.request_id); first.state.close();
  const recovered = createGateway(options);
  try {
    assert.equal(recovered.state.db.prepare('SELECT status FROM intents WHERE request_id=?').get(value.request_id).status, 'failed_unknown');
    assert.equal(fs.existsSync(path.join(root, 'rooms', 'alpha', 'crash.txt')), false);
    assert.equal(JSON.parse(recovered.state.db.prepare('SELECT result_json FROM results WHERE request_id=?').get(value.request_id).result_json).status, 'failed_unknown');
  } finally { await recovered.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('path races stay fd-anchored; dangling links, directories, FIFO, and sockets are rejected', async () => {
  let raced = false; const f = fixture({ pathRaceHook: ({ action, opened }) => {
    if (action !== 'write' || raced) return; raced = true; const original = path.dirname(opened.target); const moved = original + '-moved'; const evil = path.join(f.root, 'evil'); fs.mkdirSync(evil); fs.writeFileSync(path.join(evil, 'target.txt'), 'evil'); fs.renameSync(original, moved); fs.symlinkSync(evil, original);
  } });
  let socketServer;
  try {
    const own = path.join(f.root, 'rooms', 'alpha'); fs.mkdirSync(path.join(own, 'safe')); fs.writeFileSync(path.join(own, 'safe', 'target.txt'), 'safe');
    const replace = { ...intent('req_race0001'), params: { root_id: 'own-room', path: 'safe/target.txt', content: 'updated', mode: 'replace' } }; f.gateway.registerIntent(replace, f.token); const result = await f.gateway.execute(replace.request_id, approval(replace, 'apr_race0001'));
    assert.equal(result.status, 'succeeded'); assert.equal(fs.readFileSync(path.join(own, 'safe-moved', 'target.txt'), 'utf8'), 'updated'); assert.equal(fs.readFileSync(path.join(f.root, 'evil', 'target.txt'), 'utf8'), 'evil');
    fs.symlinkSync('missing-target', path.join(own, 'dangling')); assert.throws(() => f.gateway.registerIntent({ request_id: 'req_dangle001', resident_id: 'resident_alpha_01', action: 'core.fs.read', params: { root_id: 'own-room', path: 'dangling' } }, f.token), e => e.code === 'GW-PATH-SYMLINK');
    fs.mkdirSync(path.join(own, 'layer')); fs.symlinkSync(f.root, path.join(own, 'layer', 'escape')); assert.throws(() => f.gateway.registerIntent(intent('req_layersym1', 'layer/escape/out.txt'), f.token), e => e.code === 'GW-PATH-SYMLINK');
    fs.mkdirSync(path.join(own, 'directory')); execFileSync('mkfifo', [path.join(own, 'fifo')]); const socketPath = path.join(own, 'socket'); socketServer = net.createServer(); await new Promise(resolve => socketServer.listen(socketPath, resolve));
    for (const [i, name] of ['directory', 'fifo', 'socket'].entries()) {
      const read = { request_id: 'req_special0' + i, resident_id: 'resident_alpha_01', action: 'core.fs.read', params: { root_id: 'own-room', path: name } }; assert.throws(() => f.gateway.registerIntent(read, f.token), e => e.code === 'GW-PATH-TYPE');
    }
    assert.throws(() => f.gateway.registerIntent(intent('req_prefix001', '../alpha-evil/x'), f.token), e => e.code === 'GW-PATH-OUTSIDE');
  } finally { if (socketServer) await new Promise(resolve => socketServer.close(resolve)); await f.close(); }
});

test('environment variants and every room.yaml are denied to direct file actions before approval', async () => {
  const f = fixture();
  try {
    const paths = ['.env', '.env.production', '.envrc', 'prod.env', 'nested/release.env', '.git/config', '.git/hooks/post-commit', 'house.yaml', 'house.lock', 'room.yaml', '.sameroof/token'];
    for (let i = 0; i < paths.length; i++) assert.throws(() => f.gateway.registerIntent(intent('req_protect0' + i, paths[i]), f.token), e => e.code === 'GW-PATH-PROTECTED');
    const readRoomConfig = { request_id: 'req_roomyaml1', resident_id: 'resident_alpha_01', action: 'core.fs.read', params: { root_id: 'own-room', path: 'room.yaml' } };
    assert.throws(() => f.gateway.registerIntent(readRoomConfig, f.token), e => e.code === 'GW-PATH-PROTECTED');
  } finally { await f.close(); }
});

test('real bwrap sees only runtime plus approved roots; host secrets, other rooms, protected files, env, and network are unavailable', async () => {
  const f = fixture({ bwrapProbe: undefined }); let hostServer;
  try {
    assert.equal(f.gateway.sandboxAvailable, true, 'bwrap user/network namespace probe must pass');
    const alpha = path.join(f.root, 'rooms', 'alpha'); const beta = path.join(f.root, 'rooms', 'beta');
    fs.writeFileSync(path.join(alpha, 'visible.txt'), 'visible'); fs.writeFileSync(path.join(alpha, '.env'), 'CREDENTIAL=do-not-read'); fs.writeFileSync(path.join(alpha, '.envrc'), 'export CREDENTIAL=envrc-secret'); fs.writeFileSync(path.join(alpha, 'prod.env'), 'CREDENTIAL=suffix-secret'); fs.mkdirSync(path.join(alpha, '.git', 'hooks'), { recursive: true }); fs.writeFileSync(path.join(alpha, '.git', 'config'), 'git-secret'); fs.writeFileSync(path.join(alpha, '.git', 'hooks', 'x'), 'hook-secret'); fs.writeFileSync(path.join(beta, 'secret.txt'), 'other-room-secret'); fs.mkdirSync(path.join(f.root, 'state')); fs.writeFileSync(path.join(f.root, 'state', 'living-room.token'), 'living-secret');
    const roomConfigBefore = fs.readFileSync(path.join(alpha, 'room.yaml'), 'utf8');
    const hostSecret = path.join(os.tmpdir(), 'sameroof-host-secret-' + crypto.randomUUID()); fs.writeFileSync(hostSecret, 'root-only-host-secret', { mode: 0o600 });
    hostServer = net.createServer(); await new Promise(resolve => hostServer.listen(0, '127.0.0.1', resolve)); const port = hostServer.address().port;
    const script = `set -eu
test "$(cat '${alpha}/visible.txt')" = visible
test ! -e /etc/shadow
test ! -r /etc/shadow
test ! -r '${hostSecret}'
test ! -e '${beta}/secret.txt'
test ! -e '${f.root}/state/living-room.token'
test ! -e '${f.gateway.adapterTokensDir}/resident_alpha_01'
test ! -e /var/lib/sameroof-gateway
test ! -e /var/lib/sameroof-broker
test ! -e /var/lib/sameroof-living-room
test ! -s '${alpha}/.env'
test ! -s '${alpha}/.envrc'
test ! -s '${alpha}/prod.env'
test ! -s '${alpha}/room.yaml'
test ! -s '${alpha}/.git/config'
if printf bad > '${alpha}/.env' 2>/dev/null; then exit 31; fi
if printf bad > '${alpha}/.envrc' 2>/dev/null; then exit 33; fi
if printf bad > '${alpha}/prod.env' 2>/dev/null; then exit 34; fi
if printf bad > '${alpha}/room.yaml' 2>/dev/null; then exit 35; fi
if printf bad > '${beta}/new-secret' 2>/dev/null; then exit 32; fi
test -z "$(/usr/bin/env | /usr/bin/grep GW_HOST_SECRET || true)"
# network probe without node: bash's /dev/tcp builtin. Inside --unshare-net the connect must fail.
# (node lives outside /usr on GitHub runners — setup-node uses /opt/hostedtoolcache — so /usr/bin/node isn't in the sandbox there.)
if /usr/bin/bash -c "exec 3<>/dev/tcp/127.0.0.1/${port}" 2>/dev/null; then exit 41; fi
printf isolated`;
    const value = { request_id: 'req_bwrap001', resident_id: 'resident_alpha_01', action: 'core.exec', params: { argv: ['/bin/sh', '-lc', script], cwd: { root_id: 'project', path: '' }, writable_root_ids: ['project'], timeout_ms: 5000 } };
    f.gateway.options.mounts = [{ id: 'project', path: f.root, residents: { resident_alpha_01: 'read-write' } }]; process.env.GW_HOST_SECRET = 'inherited-host-secret';
    f.gateway.registerIntent(value, f.token); const result = await f.gateway.execute(value.request_id, approval(value, 'apr_bwrap001'));
    assert.equal(result.status, 'succeeded', JSON.stringify(result)); assert.equal(result.coverage.host_filesystem, 'minimal'); assert.match(result.details.stdout, /isolated/); assert.equal(fs.readFileSync(path.join(alpha, '.env'), 'utf8'), 'CREDENTIAL=do-not-read'); assert.equal(fs.readFileSync(path.join(alpha, '.envrc'), 'utf8'), 'export CREDENTIAL=envrc-secret'); assert.equal(fs.readFileSync(path.join(alpha, 'prod.env'), 'utf8'), 'CREDENTIAL=suffix-secret'); assert.equal(fs.readFileSync(path.join(alpha, 'room.yaml'), 'utf8'), roomConfigBefore); assert.equal(fs.existsSync(path.join(beta, 'new-secret')), false);
    fs.rmSync(hostSecret, { force: true });
  } finally { delete process.env.GW_HOST_SECRET; if (hostServer) await new Promise(resolve => hostServer.close(resolve)); await f.close(); }
});

test('audit omits raw content/output/tokens; failed result delivery retries without re-execution', async () => {
  let calls = 0; const f = fixture({ resultClient: async () => { calls++; if (calls === 1) throw new Error('temporary'); return { message_id: 'msg_retry' }; } });
  try {
    const value = intent('req_retry0001', 'retry.txt', 'payload-that-must-not-enter-audit'); f.gateway.registerIntent(value, f.token); const result = await f.gateway.execute(value.request_id, approval(value, 'apr_retry0001'));
    assert.equal(result.delivery_error, 'GW-RESULT-DELIVERY-FAILED'); const file = path.join(f.root, 'rooms', 'alpha', 'retry.txt'); const before = fs.statSync(file);
    assert.deepEqual(await f.gateway.retryUndelivered(), { pending: 0, delivered: 1 }); const after = fs.statSync(file);
    assert.equal(calls, 2); assert.equal(before.ino, after.ino); assert.equal(before.mtimeMs, after.mtimeMs); assert.equal(f.gateway.state.db.prepare("SELECT count(*) AS n FROM audit WHERE request_id=? AND event='executed'").get(value.request_id).n, 1);
    assert.deepEqual(JSON.parse(f.gateway.state.db.prepare('SELECT result_json FROM results WHERE request_id=?').get(value.request_id).result_json), { delivered: true });
    const audit = JSON.stringify(f.gateway.state.db.prepare('SELECT * FROM audit').all()); assert.doesNotMatch(audit, /payload-that-must-not-enter-audit/); assert.doesNotMatch(audit, new RegExp(f.token));

    const wrapper = path.join(f.root, 'fake-bwrap'); fs.writeFileSync(wrapper, `#!/bin/sh\nprintf '%s' '${f.token}'\nprintf '%s' ' permission denied' >&2\nexit 1\n`, { mode: 0o700 }); f.gateway.bwrapPath = wrapper; f.gateway.bwrapProbe = () => true; f.gateway.sandboxAvailable = true;
    const run = { request_id: 'req_auditexec', resident_id: 'resident_alpha_01', action: 'core.exec', params: { argv: ['/bin/true'], cwd: { root_id: 'own-room', path: '' }, writable_root_ids: [], timeout_ms: 1000 } }; f.gateway.registerIntent(run, f.token); const runResult = await f.gateway.execute(run.request_id, approval(run, 'apr_auditexec'));
    assert.equal(runResult.status, 'failed'); assert.equal(runResult.next.kind, 'request_writable_root'); assert.doesNotMatch(runResult.details.stdout, new RegExp(f.token)); assert.match(runResult.details.stdout, /已脱敏/);
    const stored = f.gateway.state.db.prepare('SELECT result_json FROM intents WHERE request_id=?').get(run.request_id).result_json; assert.doesNotMatch(stored, new RegExp(f.token)); assert.match(stored, /\[output omitted\]/);
    const finalAudit = JSON.stringify(f.gateway.state.db.prepare('SELECT * FROM audit').all()); assert.doesNotMatch(finalAudit, new RegExp(f.token)); assert.doesNotMatch(finalAudit, /permission denied/);
    for (const requestId of [value.request_id, run.request_id]) { const counts = f.gateway.state.db.prepare("SELECT event,count(*) AS n FROM audit WHERE request_id=? AND event IN ('asked','decided') GROUP BY event").all(requestId); assert.deepEqual(Object.fromEntries(counts.map(x => [x.event, x.n])), { asked: 1, decided: 1 }); }
    for (const envelope of [result, runResult]) { assert.equal(typeof envelope.status, 'string'); assert.ok(envelope.coverage); assert.ok(envelope.next); }
  } finally { await f.close(); }
});
