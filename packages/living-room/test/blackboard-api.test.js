// 黑板（W7）：钉/改状态的权限矩阵、due 校验、归档规则、activity 与 system 小字。
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createLivingRoom } = require('../server');

function request(port, pathname, options = {}) {
  return new Promise((resolve, reject) => {
    const body = options.body === undefined ? null : Buffer.from(JSON.stringify(options.body));
    const req = http.request({ hostname: '127.0.0.1', port, path: pathname, method: options.method || 'GET', headers: {
      ...(options.token ? { authorization: 'Bearer ' + options.token } : {}),
      ...(body ? { 'content-type': 'application/json', 'content-length': body.length } : {})
    } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => { let value = Buffer.concat(chunks).toString(); try { value = JSON.parse(value); } catch {} resolve({ status: res.statusCode, body: value }); });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sameroof-blackboard-'));
  for (const [name, yamlText] of [['甲', 'id: resident_alpha_01\nname: 甲\nspecies: human\n'], ['乙', 'id: resident_beta_01\nname: 乙\nspecies: agent\n'], ['丙', 'id: resident_gamma_01\nname: 丙\nspecies: agent\n']]) {
    fs.mkdirSync(path.join(root, 'rooms', name), { recursive: true });
    fs.writeFileSync(path.join(root, 'rooms', name, 'room.yaml'), yamlText);
  }
  fs.mkdirSync(path.join(root, 'apps', 'house'), { recursive: true });
  fs.writeFileSync(path.join(root, 'apps', 'house', 'index.html'), '<!doctype html>');
  fs.copyFileSync(path.join(__dirname, 'fixtures', 'house.yaml'), path.join(root, 'house.yaml'));
  return root;
}

test('黑板：钉 / 改状态权限矩阵 / due 校验 / activity 与 system 小字 / 归档', async () => {
  const root = fixture();
  const room = createLivingRoom({ houseDir: root, runDir: path.join(root, 'run'), dataDir: path.join(root, 'state'), port: 0 });
  try {
    const port = (await room.listen()).port;
    const human = room.tokenStore.issue('resident_alpha_01').token;
    const beta = room.tokenStore.issue('resident_beta_01').token;
    const gamma = room.tokenStore.issue('resident_gamma_01').token;
    const activity = kind => room.db.prepare('SELECT * FROM activity WHERE kind=? ORDER BY seq').all(kind).map(r => ({ ...r, meta: r.meta ? JSON.parse(r.meta) : null }));
    const systemMsgs = () => room.db.prepare("SELECT * FROM messages WHERE kind='system' ORDER BY seq").all().map(r => ({ ...r, mentions: JSON.parse(r.mentions) }));

    // 乙钉给丙：任何住户能钉；owner 按名字找；origin 没传 → ui:乙；activity 一条 + system 小字一条 @丙
    const pin = await request(port, '/tasks', { method: 'POST', token: beta, body: { title: '把 demo 家的 README 写了', owner: '丙', accept: '前十分钟两条路都写清', due_at: '2026-09-08T21:00+08:00' } });
    assert.equal(pin.status, 200, JSON.stringify(pin.body));
    const task = pin.body;
    assert.match(task.id, /^task_[a-z0-9]+$/);
    assert.deepEqual({ state: task.state, owner_id: task.owner_id, owner: task.owner, created_by: task.created_by, origin: task.origin, due_at: task.due_at, accept: task.accept, archived: task.archived },
      { state: 'open', owner_id: 'resident_gamma_01', owner: '丙', created_by: 'resident_beta_01', origin: 'ui:乙', due_at: '2026-09-08T13:00:00.000Z', accept: '前十分钟两条路都写清', archived: false });
    let acts = activity('thread_update');
    assert.equal(acts.length, 1);
    assert.equal(acts[0].text, '[pin] 乙 pinned "把 demo 家的 README 写了" → 丙');
    assert.deepEqual({ task_id: acts[0].meta.task_id, owner_id: acts[0].meta.owner_id, state: acts[0].meta.state, origin: acts[0].meta.origin }, { task_id: task.id, owner_id: 'resident_gamma_01', state: 'open', origin: 'ui:乙' });
    let sys = systemMsgs();
    assert.equal(sys.length, 1);
    assert.equal(sys[0].text, 'Task pinned: 把 demo 家的 README 写了 (assigned to 丙)');
    assert.deepEqual(sys[0].mentions, ['resident_gamma_01']);
    const gammaInbox = await request(port, '/inbox', { token: gamma });
    assert.ok(gammaInbox.body.some(m => m.id === sys[0].id && m.mentions.includes('resident_gamma_01')), '丙的收件箱里有这条小字');

    // origin_message_id → msg:<id>；owner 缺省 = 自己；给自己钉的不 @ 自己
    const said = await request(port, '/say', { method: 'POST', token: human, body: { text: '明天把 README 写了' } });
    const pin2 = await request(port, '/tasks', { method: 'POST', token: gamma, body: { title: '自己给自己的', origin_message_id: said.body.id } });
    assert.equal(pin2.status, 200);
    assert.equal(pin2.body.origin, 'msg:' + said.body.id);
    assert.equal(pin2.body.owner_id, 'resident_gamma_01');
    assert.deepEqual(systemMsgs()[1].mentions, []);

    // 校验：due_at 不带时区 / 乱写 → 400 TASK-DUE-INVALID；due_cron 非法 → 400；两个都给 → 400；owner 不存在 → 404；没 title → 400
    for (const body of [{ title: 'x', due_at: '2026-09-08T21:00' }, { title: 'x', due_at: '明天' }, { title: 'x', due_cron: '99 * * * *' }, { title: 'x', due_cron: '0 9 * *' }, { title: 'x', due_at: '2026-09-08T21:00Z', due_cron: '0 9 * * *' }]) {
      const r = await request(port, '/tasks', { method: 'POST', token: beta, body });
      assert.equal(r.status, 400, JSON.stringify(body)); assert.equal(r.body.error.code, 'TASK-DUE-INVALID');
    }
    const unknown = await request(port, '/tasks', { method: 'POST', token: beta, body: { title: 'x', owner: '没有人' } });
    assert.equal(unknown.status, 404); assert.equal(unknown.body.error.code, 'TASK-OWNER-UNKNOWN');
    assert.equal((await request(port, '/tasks', { method: 'POST', token: beta, body: { owner: '丙' } })).body.error.code, 'TASK-TITLE-REQUIRED');
    const cronOk = await request(port, '/tasks', { method: 'POST', token: human, body: { title: '每天九点看一眼', owner: 'resident_beta_01', due_cron: '0  9 * * 1-5' } });
    assert.equal(cronOk.status, 200); assert.equal(cronOk.body.due_cron, '0 9 * * 1-5'); assert.equal(cronOk.body.origin, 'ui:甲');

    // 改状态：别人（乙，钉的人但不是主人）403；主人 200；人 200
    const P = '/tasks/' + task.id;
    const forbidden = await request(port, P, { method: 'PATCH', token: beta, body: { state: 'doing' } });
    assert.equal(forbidden.status, 403); assert.equal(forbidden.body.error.code, 'TASK-FORBIDDEN');
    const doing = await request(port, P, { method: 'PATCH', token: gamma, body: { state: 'doing' } });
    assert.equal(doing.status, 200); assert.equal(doing.body.state, 'doing');
    acts = activity('thread_update'); assert.equal(acts.length, 4); assert.equal(acts[3].text, '▶ 丙 started "把 demo 家的 README 写了"'); assert.equal(acts[3].meta.from_state, 'open');
    const same = await request(port, P, { method: 'PATCH', token: gamma, body: { state: 'doing' } });      // 没进展不更新：什么都没变就不发 activity
    assert.equal(same.status, 200); assert.equal(activity('thread_update').length, 4);
    const bad = await request(port, P, { method: 'PATCH', token: gamma, body: { state: 'flying' } });
    assert.equal(bad.status, 400); assert.equal(bad.body.error.code, 'TASK-STATE-INVALID');
    const blocked = await request(port, P, { method: 'PATCH', token: gamma, body: { state: 'blocked', notes: '等 W5' } });
    assert.equal(blocked.body.state, 'blocked'); assert.equal(blocked.body.notes, '等 W5');
    assert.equal(activity('thread_update').pop().text, '⛔ 丙 blocked on "把 demo 家的 README 写了"：等 W5');
    const done = await request(port, P, { method: 'PATCH', token: human, body: { state: 'done', result: '写好了在 README.en.md' } });
    assert.equal(done.status, 200); assert.equal(done.body.state, 'done'); assert.equal(done.body.result, '写好了在 README.en.md');
    assert.equal(activity('thread_update').pop().text, '✅ 丙 completed "把 demo 家的 README 写了"：写好了在 README.en.md');
    assert.equal((await request(port, '/tasks/task_000000', { method: 'PATCH', token: human, body: { state: 'done' } })).body.error.code, 'TASK-NOT-FOUND');
    assert.equal((await request(port, '/tasks/nope', { method: 'PATCH', token: human, body: { state: 'done' } })).body.error.code, 'TASK-ID-INVALID');

    // 重派：人把 cronOk 改派给丙；丙 drop → 钉的人（甲）收到一条 system 小字
    const reassign = await request(port, '/tasks/' + cronOk.body.id, { method: 'PATCH', token: human, body: { owner: '丙' } });
    assert.equal(reassign.status, 200); assert.equal(reassign.body.owner_id, 'resident_gamma_01');
    assert.equal(activity('thread_update').pop().text, '[pin] 甲 reassigned "每天九点看一眼" → 丙');
    const dropped = await request(port, '/tasks/' + cronOk.body.id, { method: 'PATCH', token: gamma, body: { state: 'dropped', notes: '不该我做' } });
    assert.equal(dropped.body.state, 'dropped');
    assert.equal(activity('thread_update').pop().text, '🗑 丙 dropped "每天九点看一眼"：不该我做');
    sys = systemMsgs(); const last = sys[sys.length - 1];
    assert.deepEqual(last.mentions, ['resident_alpha_01']); assert.match(last.text, /丙 dropped "每天九点看一眼"/);

    // 列表：任何住户可看；owner=me；state 过滤；排序有 due 的在前
    const all = await request(port, '/tasks', { token: beta });
    assert.equal(all.status, 200); assert.equal(all.body.length, 3);
    const mine = await request(port, '/tasks?owner=me&state=open,doing,blocked', { token: gamma });
    assert.deepEqual(mine.body.map(t => t.id), [pin2.body.id]);
    assert.equal((await request(port, '/tasks?state=flying', { token: gamma })).body.error.code, 'TASK-STATE-INVALID');
    assert.equal((await request(port, '/tasks?owner=' + encodeURIComponent('没有人'), { token: gamma })).status, 404);
    assert.equal((await request(port, P, { token: beta })).body.id, task.id);

    // 归档：done/dropped 满 7 天标 archived_ts；默认列表不含，include_archived=1 含；刚 done 的不动
    assert.equal(room.blackboard.archive(), 0);
    room.db.prepare('UPDATE tasks SET updated_ts=? WHERE id=?').run(new Date(Date.now() - 8 * 86400000).toISOString(), task.id);
    assert.equal(room.blackboard.archive(), 1);
    const after = await request(port, '/tasks', { token: beta });
    assert.deepEqual(after.body.map(t => t.id).sort(), [pin2.body.id, cronOk.body.id].sort());
    const withArchived = await request(port, '/tasks?include_archived=1', { token: beta });
    assert.equal(withArchived.body.length, 3); assert.equal(withArchived.body.find(t => t.id === task.id).archived, true);
    const reopened = await request(port, P, { method: 'PATCH', token: human, body: { state: 'open' } });   // 人拉回来：归档标记清掉
    assert.equal(reopened.body.archived, false);
    assert.equal((await request(port, '/tasks', { token: beta })).body.length, 3);
  } finally { await room.close(); }
});
