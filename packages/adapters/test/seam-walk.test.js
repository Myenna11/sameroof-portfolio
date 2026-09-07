'use strict';
// W3 接缝端到端（W6 每晚要走的那条链，先用假网关走通）：
// 甲在客厅 @乙 → 乙醒（human 车道）→ 乙回 APPROVAL: → 适配器向网关登记 intent → approval_body 原样交客厅 →
// 甲审批 → 网关拉决定流、投结果回客厅 → 客厅 kind=result 只投乙 → 乙被 interrupt 叫醒、看到 [网关结果 …] → 乙在客厅说一句。
// 再走拒绝分支；最后把网关关掉，确认 fail closed（runs 记 gateway_unavailable，客厅没有新审批）。
// 跑的是 lib/room.js 里真的 run()；客厅是真 createLivingRoom；只有 think 和网关是假的。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const jcs = require('@sameroof/jcs');

// 房子放临时目录。room.js 的 RUN（~/.sameroof/run/living-room-tokens.json）在 require 时就按 HOME 定死，
// 所以 HOME 也指到临时目录，客厅的 runDir 对齐到同一处——require room.js 之前就得设好；结束时还原。
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'sameroof-seam-'));
const ENV_KEYS = ['HOME', 'SAMEROOF_ROOT', 'SAMEROOF_LR', 'SAMEROOF_GATEWAY_SOCK', 'SAMEROOF_GATEWAY_TOKEN_FILE'];
const savedEnv = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
const restoreEnv = () => { for (const k of ENV_KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; } };
process.env.HOME = ROOT;
process.env.SAMEROOF_ROOT = ROOT;
delete process.env.SAMEROOF_LR;
const RUN_DIR = path.join(ROOT, '.sameroof', 'run');
const { run } = require('../lib/room');
const { createLivingRoom } = require('../../living-room/server');          // 相对路径：living-room 不是 adapters 的运行时依赖，只在这条链的测试里一起起
const mockGateway = require('./fixtures/mock-gateway');

const ALPHA = 'resident_alpha_01', BETA = 'resident_beta_01';
const SERVICE_TOKEN = 'gw-service-' + 'f0e1d2c3b4a5'.repeat(4);
const ADAPTER_TOKEN = 'adapter-token-' + 'z'.repeat(40);
const ASK = '@乙 帮我记一下今天下雨';
const APPROVAL_LINE = 'APPROVAL: core.fs.write {"root_id":"own-room","path":"notes/today.md","content":"今天下雨","encoding":"utf8","mode":"create"}';
const PARAMS = { root_id: 'own-room', path: 'notes/today.md', content: '今天下雨', encoding: 'utf8', mode: 'create' };

function house() {
  fs.mkdirSync(path.join(ROOT, 'rooms', '甲'), { recursive: true });
  fs.mkdirSync(path.join(ROOT, 'rooms', '乙'), { recursive: true });
  fs.mkdirSync(path.join(ROOT, 'apps', 'house'), { recursive: true });
  fs.mkdirSync(RUN_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(ROOT, 'house.yaml'), 'schema_version: 1\nname: 接缝测试小家\ntimezone: Asia/Shanghai\ndefaults:\n  runtime: pi\n  plugins: [living-room]\n  heartbeat: {enabled: false}\n');
  fs.writeFileSync(path.join(ROOT, 'rooms', '甲', 'room.yaml'), 'schema_version: 1\nid: resident_alpha_01\nname: 甲\nspecies: human\n');
  fs.writeFileSync(path.join(ROOT, 'rooms', '乙', 'room.yaml'), 'schema_version: 1\nid: resident_beta_01\nname: 乙\nspecies: agent\nplugins: [living-room]\nheartbeat: {enabled: false}\n');
  fs.writeFileSync(path.join(ROOT, 'apps', 'house', 'index.html'), '<!doctype html>');
}
function request(port, pathname, options = {}) {
  return new Promise((resolve, reject) => {
    const body = options.body === undefined ? null : Buffer.from(JSON.stringify(options.body));
    const req = http.request({ hostname: '127.0.0.1', port, path: pathname, method: options.method || 'GET', headers: {
      ...(options.token ? { authorization: 'Bearer ' + options.token } : {}),
      ...(body ? { 'content-type': 'application/json', 'content-length': body.length } : {})
    } }, res => {
      const chunks = []; res.on('data', c => chunks.push(c));
      res.on('end', () => { const text = Buffer.concat(chunks).toString(); let value = text; try { value = JSON.parse(text); } catch {} resolve({ status: res.statusCode, body: value }); });
    });
    req.on('error', reject); if (body) req.write(body); req.end();
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const withTimeout = (promise, ms, label) => { let t; return Promise.race([promise, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(label)), ms); })]).finally(() => clearTimeout(t)); };   // 计时器要清掉，不然测试完了进程还得等它
async function until(fn, label, timeoutMs = 8000) {                          // 轮询 + 短 sleep，不用固定长等
  const t0 = Date.now();
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > timeoutMs) throw new Error('等超时：' + label); await sleep(40); }
}
const runsFile = path.join(ROOT, 'state', 'runs', BETA + '.jsonl');
const runs = () => fs.existsSync(runsFile) ? fs.readFileSync(runsFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];

test('接缝走通：说话 → APPROVAL → 网关登记 → 客厅审批 → 决定流 → 结果投回 → 住户醒来 → 拒绝分支 → 网关关了 fail closed', async () => {
  house();
  const serviceTokenFile = path.join(ROOT, 'run', 'gateway-service.token');
  fs.mkdirSync(path.dirname(serviceTokenFile), { recursive: true });
  fs.writeFileSync(serviceTokenFile, SERVICE_TOKEN + '\n', { mode: 0o600 });
  const gwDir = path.join(ROOT, 'gw'); fs.mkdirSync(gwDir, { recursive: true, mode: 0o700 });
  const sock = path.join(gwDir, 'gateway.sock');
  const adapterTokenFile = path.join(gwDir, 'token-' + BETA);
  fs.writeFileSync(adapterTokenFile, ADAPTER_TOKEN + '\n', { mode: 0o600 });
  process.env.SAMEROOF_GATEWAY_SOCK = sock;
  process.env.SAMEROOF_GATEWAY_TOKEN_FILE = adapterTokenFile;

  const room = createLivingRoom({ houseDir: ROOT, runDir: RUN_DIR, dataDir: path.join(ROOT, 'state'), port: 0, approvalLimit: 50, gatewayServiceTokenFile: serviceTokenFile });
  const gw = await mockGateway.start({ socketPath: sock, tokens: { [BETA]: ADAPTER_TOKEN } });
  const ctrl = new AbortController();
  let runP = null;
  try {
    const port = (await room.listen()).port;
    const lr = 'http://127.0.0.1:' + port;
    const alpha = room.tokenStore.issue(ALPHA).token;
    const beta = room.tokenStore.issue(BETA).token;
    const svc = { token: SERVICE_TOKEN };
    const a = (p, o = {}) => request(port, p, { token: alpha, ...o });
    const b = (p, o = {}) => request(port, p, { token: beta, ...o });
    assert.equal((await b('/me')).body.id, BETA);

    // ---- 假 think：只看"没读的客厅记录"那段，免得"刚才的话"里的旧话把它带偏
    const seen = [];
    const think = async (system, user) => {
      seen.push({ system, user });
      const inbox = String(user).split('【你没读的客厅记录')[1] || '';
      if (/\[网关结果 /.test(inbox)) return '记好了。';
      if (inbox.includes('帮我记一下今天下雨')) return APPROVAL_LINE;
      return '(静默)';
    };

    // ---- 起真循环
    runP = run('乙', 'fake', think, { signal: ctrl.signal, lr });
    await until(async () => (await a('/members')).body.find(m => m.id === BETA && m.online), '乙上线（SSE 连上）');
    assert.equal(runs().length, 1); assert.equal(runs()[0].status, 'nothing', '启动那轮：没人找');

    // ======== 1. 甲 @乙 → 乙醒（human 车道）→ 网关登记 → approval_body 原样进客厅
    assert.equal((await a('/say', { method: 'POST', body: { text: ASK } })).status, 200);
    const r1 = await until(() => runs().find(r => r.status === 'approval'), '乙那一轮以 approval 结束');
    assert.equal(r1.lane, 'human');
    assert.equal(r1.reason, '甲 叫我');
    assert.equal(r1.action, 'core.fs.write');
    assert.equal(r1.said, APPROVAL_LINE);
    assert.equal(r1.model_calls, 1);
    assert.ok(r1.heard.some(m => m.text.includes('帮我记一下今天下雨') && m.mentioned), '听到的里有甲那句且标了叫我');
    assert.equal(gw.intents.size, 1, '假网关登记了一条');
    const intent1 = gw.intents.get(r1.gateway_request_id);
    assert.ok(intent1, 'runs 里的 gateway_request_id 就是网关登记的那条');
    assert.equal(intent1.resident_id, BETA);
    assert.equal(intent1.run_id, r1.id, 'intent 绑到了这一轮 run');
    assert.equal(intent1.action, 'core.fs.write');
    assert.deepEqual(intent1.params, PARAMS);
    assert.equal(intent1.params_digest, jcs.digest(PARAMS));
    const detail1 = await a('/approval/' + r1.approval_id);
    assert.equal(detail1.status, 200, JSON.stringify(detail1.body));
    assert.equal(detail1.body.gateway_request_id, r1.gateway_request_id);
    assert.equal(detail1.body.params_digest, jcs.digest(PARAMS), '客厅存的摘要 = jcs.digest(params)');
    assert.equal(detail1.body.params_digest, intent1.response.approval_body.params_digest, '客厅重算的 = 网关算的');
    assert.deepEqual(detail1.body.params, PARAMS, 'params 原样到了客厅');
    assert.equal(detail1.body.digest_kind, 'jcs');
    assert.equal(detail1.body.resident_id, BETA);
    assert.equal(detail1.body.status, 'pending');
    assert.equal(detail1.body.action, 'core.fs.write');
    assert.equal((await b('/approval/' + r1.approval_id)).status, 200, '申请者自己也能看');
    assert.equal((await request(port, '/internal/gateway/approval-results?after_seq=0', svc)).body.items.length, 0, '没决定之前决定流是空的');
    const step1Says = (await a('/history')).body.filter(m => m.from_id === BETA && m.kind === 'say');
    assert.equal(step1Says.length, 0, 'APPROVAL 那轮乙没在客厅说话');

    // ======== 2. 甲同意 → 网关 pump → 客厅 /internal/gateway/results 收到 → result 只投乙
    const dec1 = await a('/approval/' + r1.approval_id, { method: 'POST', body: { decision: 'allow' } });
    assert.equal(dec1.status, 200, JSON.stringify(dec1.body));
    assert.equal(dec1.body.decision, 'allowed');
    assert.equal(dec1.body.decision_seq, 1);
    const p1 = await gw.pump(lr, SERVICE_TOKEN);
    assert.equal(p1.delivered.length, 1); assert.equal(p1.skipped.length, 0);
    assert.equal(p1.delivered[0].status, 'succeeded');
    assert.equal(p1.delivered[0].http, 200, JSON.stringify(p1.delivered[0].response));
    assert.equal(p1.delivered[0].response.delivered_to, BETA);
    assert.equal(p1.delivered[0].response.duplicate, false);
    const msgId1 = p1.delivered[0].response.message_id;
    assert.equal(gw.intents.get(r1.gateway_request_id).state, 'succeeded');
    const resultRows = room.db.prepare("SELECT * FROM messages WHERE kind='result'").all();     // 乙的适配器会立刻醒来把 inbox 标已读，所以看库而不是抢 /inbox
    assert.equal(resultRows.length, 1);
    assert.equal(resultRows[0].id, msgId1);
    assert.equal(resultRows[0].to_id, BETA, 'result 只投给申请住户');
    assert.equal(resultRows[0].from_id, 'house');
    assert.equal(JSON.parse(resultRows[0].meta).deliver, 'interrupt');
    assert.equal(JSON.parse(resultRows[0].meta).gateway_request_id, r1.gateway_request_id);
    assert.equal((await a('/history')).body.filter(m => m.kind === 'result').length, 0, '甲的 /history 看不到 result');
    assert.equal((await a('/history?before=' + Number.MAX_SAFE_INTEGER)).body.filter(m => m.kind === 'result').length, 0);
    assert.equal((await a('/inbox')).body.filter(m => m.kind === 'result').length, 0, '甲的收件箱里也没有');
    assert.equal(room.db.prepare('SELECT used FROM approvals WHERE id=?').get(r1.approval_id).used, 1);

    // ======== 3. 乙被 result 叫醒（human 车道、interrupt）→ 看到 [网关结果 succeeded] → 说"记好了。"
    const r2 = await until(() => runs().find(r => typeof r.reason === 'string' && r.reason.startsWith('网关结果') && r.status !== 'started'), '乙被网关结果叫醒那轮结束');
    assert.equal(r2.reason, '网关结果：succeeded');
    assert.equal(r2.lane, 'human');
    assert.equal(r2.status, 'said', JSON.stringify(r2));
    assert.equal(r2.said, '记好了。');
    assert.ok(r2.heard.some(m => m.id === msgId1 && m.kind === 'result'), '这轮听到的就是那条 result');
    const wake2 = seen.find(s => s.user.includes('[网关结果 succeeded]'));
    assert.ok(wake2, 'think 收到的 user 里有 [网关结果 succeeded]');
    assert.match(wake2.user, /【为什么醒】网关结果：succeeded/);
    assert.match(wake2.user, /\[网关结果 succeeded\] （假网关）已执行 core\.fs\.write/);
    await until(async () => (await a('/history')).body.some(m => m.from_id === BETA && m.kind === 'say' && m.text === '记好了。'), '客厅 history 里有乙那句');
    assert.equal((await b('/inbox')).body.length, 0, '乙的收件箱清空了（result 已读）');

    // ======== 4. 拒绝分支：再来一轮，甲 deny → result status=denied 投回 → 乙醒来看到 [网关结果 denied]
    assert.equal((await a('/say', { method: 'POST', body: { text: ASK } })).status, 200);
    const r3 = await until(() => { const l = runs().filter(r => r.status === 'approval'); return l.length === 2 ? l[1] : null; }, '第二次 approval');
    assert.notEqual(r3.gateway_request_id, r1.gateway_request_id);
    assert.equal(gw.intents.size, 2);
    const dec2 = await a('/approval/' + r3.approval_id, { method: 'POST', body: { decision: 'deny' } });
    assert.equal(dec2.status, 200, JSON.stringify(dec2.body));
    assert.equal(dec2.body.decision, 'denied');
    assert.equal(dec2.body.decision_seq, 2);
    const p2 = await gw.pump(lr, SERVICE_TOKEN);
    assert.equal(p2.delivered.length, 1, '游标记住了，seq 1 不再重投');
    assert.equal(p2.delivered[0].status, 'denied');
    assert.equal(p2.delivered[0].http, 200, JSON.stringify(p2.delivered[0].response));
    assert.equal(p2.next_seq, 2);
    const r4 = await until(() => runs().find(r => r.reason === '网关结果：denied' && r.status !== 'started'), '乙被 denied 结果叫醒那轮结束');
    assert.equal(r4.lane, 'human');
    assert.ok(seen.some(s => s.user.includes('[网关结果 denied]')), 'think 看到了 [网关结果 denied]');
    assert.ok(r4.heard.some(m => m.id === p2.delivered[0].response.message_id && m.kind === 'result'));
    const p3 = await gw.pump(lr, SERVICE_TOKEN);
    assert.equal(p3.delivered.length, 0, '再 pump 一次什么都没有');
    assert.equal(room.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE kind='result'").get().n, 2);

    // ======== 5. fail closed：网关 socket 关了 → 乙再发 APPROVAL → runs 记 gateway_unavailable，客厅没有新审批
    await gw.close();
    assert.ok(!fs.existsSync(sock), 'socket 文件没了');
    const approvalsBefore = room.db.prepare('SELECT COUNT(*) AS n FROM approvals').get().n;
    assert.equal(approvalsBefore, 2);
    const historyBefore = (await a('/history')).body.length;
    assert.equal((await a('/say', { method: 'POST', body: { text: ASK } })).status, 200);
    const r5 = await until(() => runs().find(r => r.status === 'gateway_unavailable'), '乙那轮记 gateway_unavailable');
    assert.equal(r5.lane, 'human');
    assert.match(r5.error, /^GATEWAY-(SOCKET-MISSING|UNAVAILABLE|TIMEOUT)/);
    assert.equal(r5.gateway_request_id, undefined);
    assert.equal(r5.approval_id, undefined);
    assert.equal(room.db.prepare('SELECT COUNT(*) AS n FROM approvals').get().n, approvalsBefore, '客厅没有新审批');
    assert.equal(gw.intents.size, 2, '网关也没多登记');
    assert.equal((await a('/activity?kind=approval_request')).body.length, 2);
    const historyAfter = (await a('/history')).body;
    assert.equal(historyAfter.length, historyBefore + 1, '客厅里只多了甲那句，乙没说也没登记审批');
    assert.equal(runs().filter(r => r.status === 'approval').length, 2);

    // ======== 收尾：abort → run() resolve，交接信写了
    ctrl.abort();
    await withTimeout(runP, 8000, 'abort 之后 run() 8 秒没 resolve');
    runP = null;
    assert.ok(fs.existsSync(path.join(ROOT, 'rooms', '乙', 'handover', 'latest.md')), '睡前写了交接信');
    await until(async () => !(await a('/members')).body.find(m => m.id === BETA).online, '乙的 SSE 断了，客厅标下线');
    assert.ok(runs().every(r => r.status !== 'started'), '没有半截的 run');
  } finally {
    ctrl.abort();
    if (runP) await withTimeout(runP, 3000, 'run() 没停').catch(() => {});
    await gw.close().catch(() => {});
    await room.close();
    restoreEnv();
    fs.rmSync(ROOT, { recursive: true, force: true });
  }
});
