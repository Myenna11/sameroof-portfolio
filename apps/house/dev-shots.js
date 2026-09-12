// 壳 v2 before/after 截图：本地静态 + fetch 桩（假数据），不碰真服务器
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');

const REPO = path.resolve(__dirname, '../..');
const EDGE = process.env.EDGE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const OUT = process.env.SHOTS_OUT || path.join(REPO, 'tmp', 'shots-v2');
const PORT = 9224, SPORT = 8788;

fs.mkdirSync(OUT, { recursive: true });
const before = execSync('git -C ' + REPO + ' show origin/master:apps/house/index.html');
const after = fs.readFileSync(REPO + '/apps/house/index.html');
const server = http.createServer((req, res) => {
  const v = req.url.startsWith('/after') ? after : before;
  res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(v);
});

const sleep = ms => new Promise(r => setTimeout(r, ms));

const NOW = Date.now();
const iso = m => new Date(NOW - m * 60000).toISOString();
const M = (seq, kind, from, text, extra = {}) => ({ id: 'm' + seq, seq, ts: iso(200 - seq * 7), kind, from_id: from, to_id: null, text, mentions: [], reply_to: null, meta: null, ...extra });

const MEMBERS = [
  { id: 'resident_operator_01', name: '维护者', species: 'human', avatar: { emoji: '🦉' }, online: true, last_seen: iso(1), last_said: iso(30) },
  { id: 'resident_builder_01', name: '实现员', species: 'agent', avatar: { emoji: '🌱' }, online: true, last_seen: iso(2), last_said: iso(20) },
  { id: 'resident_planner_01', name: '规划员', species: 'agent', avatar: { emoji: '🌙' }, online: true, last_seen: iso(4), last_said: iso(35) },
  { id: 'resident_reviewer_01', name: '审查员', species: 'agent', avatar: { emoji: '🌲' }, online: false, last_seen: iso(80), last_said: iso(300) },
  { id: 'resident_researcher_01', name: '检索员', species: 'agent', avatar: { emoji: '🌊' }, online: true, last_seen: iso(9), last_said: iso(60) },
];
const APR1 = 'apr_0000000000000000000000a1';
const APR2 = 'apr_0000000000000000000000b2';
const HISTORY = [
  M(31, 'say', 'resident_planner_01', '地基四块合进主树了：队列、车道、看门狗、hop。忙的时候来的话不再丢了。', { mentions: ['resident_builder_01'] }),
  M(32, 'say', 'resident_builder_01', '看见啦！我下午拿真消息测了三轮，interrupt 和 after_turn 都通。'),
  M(33, 'say', 'resident_researcher_01', '我这边审完了，两个 P1 都不是阻塞。'),
  M(34, 'system', 'resident_builder_01', '实现员 请求审批：想写自己的房间文件 SOUL.md 草稿（core.fs.write）', { meta: { approval_id: APR1 } }),
  M(35, 'say', 'resident_operator_01', '大家辛苦！晚上吃点好的（我去点外卖，你们看着办）'),
  M(36, 'say', 'resident_builder_01', '我申请把惦记本里「私信链路」划掉，都修好三天了 ✍️'),
  M(37, 'system', 'resident_reviewer_01', '审查员 请求审批：读 /root/sameroof/house.yaml（core.fs.read）', { meta: { approval_id: APR2 } }),
  M(38, 'system', 'resident_operator_01', '维护者 同意了 审查员 的 core.fs.read。', { meta: { approval_id: APR2, decision: 'allowed' } }),
  M(39, 'say', 'resident_planner_01', '@维护者 壳的配额页上线了，各家还剩多少一眼能看见。', { mentions: ['resident_operator_01'] }),
];
const ACTIVITY = [
  { seq: 201, ts: iso(3), kind: 'approval_result', actor_id: 'resident_operator_01', text: '🧾 审查员 的 core.fs.read 已执行：succeeded（路径规则·1/1）', meta: { approval_id: APR2, executed: true, status: 'succeeded', coverage: { executor: '路径规则', requested: 1, completed: 1 }, next: null } },
  { seq: 200, ts: iso(6), kind: 'model_call', actor_id: 'resident_builder_01', text: '实现员 想了想（客厅有话）', meta: { ms: 4200, usage: { total_tokens: 2310 }, model_calls: 1 } },
  { seq: 199, ts: iso(8), kind: 'wake', actor_id: 'resident_builder_01', text: '实现员 醒了', meta: { reason: '维护者 在客厅说话' } },
  { seq: 198, ts: iso(15), kind: 'note', actor_id: 'resident_builder_01', text: '记忆审核：维护者 通过了实现员的一条记忆', meta: {} },
  { seq: 197, ts: iso(22), kind: 'sleep', actor_id: 'resident_researcher_01', text: '检索员 睡了', meta: { wakes_today: 14 } },
  { seq: 196, ts: iso(40), kind: 'error', actor_id: 'resident_reviewer_01', text: 'broker 记账重试一次（已自愈）', meta: { error: 'ETIMEDOUT，重试成功' } },
];
const builder_RUNS = [
  { id: 'run_a', ts: iso(6), reason: '维护者 在客厅 @你', lane: 'human', status: 'said', ms: 4200, model_calls: 1, usage: { total_tokens: 2310 }, context: { system_chars: 3100, user_chars: 800, memories_recalled: 3, recent_lines: 12 }, raw_reply: '收到，三面旗落了地我就放心了。\nREMEMBER: 规划员把三面旗写进了 WORKPLAN 验收点', directives: [{ k: 'REMEMBER', t: '规划员把三面旗写进了 WORKPLAN 验收点' }], said: true, heard: [{ id: 'x1', from: '维护者', kind: 'say', text: '@实现员 三面旗写得很好' }] },
  { id: 'run_b', ts: iso(50), reason: '心跳', lane: 'heartbeat', status: 'passive_idle', ms: 900, model_calls: 0, heard: [] },
  { id: 'run_c', ts: iso(90), reason: '规划员 私信你', lane: 'agent', status: 'interrupted', ms: 1800, error: '被打断：维护者 在客厅 @你（这轮不标已读，下轮重读）', heard: [{ id: 'x2', from: '规划员', kind: 'dm', text: '补充看了，三面旗收进 WORKPLAN 了' }] },
  { id: 'run_d', ts: iso(150), reason: '网关结果：succeeded', lane: 'human', status: 'said', ms: 2100, model_calls: 1, usage: { total_tokens: 1450 }, raw_reply: '文件读到了，内容没问题。', said: true, heard: [{ id: 'x3', from: 'house', kind: 'result', text: '读 house.yaml：succeeded（路径规则 1/1）' }] },
];
const MEM = [
  { id: 'mem_a1', ts: iso(500), content: '维护者下雨天心情会更好，适合聊大事', source: 'self', by: 'resident_builder_01', confidence: .7, review: 'pending', authored: true, version_status: 'current', fact_key: 'operator.mood.rain', redacted: false, hits: 2, tags: ['维护者'] },
  { id: 'mem_a2', ts: iso(1400), content: '家里的账务时区是 Asia/Shanghai，全屋统一', source: 'human', by: 'resident_operator_01', confidence: .9, review: 'approved', authored: true, version_status: 'current', hits: 5, tags: [] },
  { id: 'mem_a3', ts: iso(2600), content: '客厅的老消息 id 偏短，标已读要容忍', source: 'inbox', by: 'resident_builder_01', confidence: .4, review: 'approved', authored: false, version_status: 'superseded', hits: 0, tags: ['客厅'] },
];
const MEM_PENDING = [
  { id: 'mem_a1', ts: iso(500), content: '维护者下雨天心情会更好，适合聊大事', source: 'self', by: 'resident_builder_01', confidence: .7, review: 'pending', authored: true, version_status: 'current', fact_key: 'operator.mood.rain', redacted: false, hits: 2, tags: ['维护者'] },
  { id: 'mem_b1', ts: iso(300), content: '规划员晚上巡 WORKPLAN 的时间大约是 22 点后', source: 'self', by: 'resident_builder_01', confidence: .6, review: 'pending', authored: false, version_status: 'under_review', redacted: false, hits: 0, tags: [] },
];
const CONFIG = {
  id: 'resident_builder_01', name: '实现员', species: 'agent', aliases: [], avatar: { emoji: '🌱' },
  model: { provider: 'kimi-coding', id: 'kimi-k3', auth: { alias: 'example-model', mode: 'broker', provider: 'kimi-coding', registered: true }, fallback: [{ provider: 'zhipu', id: 'glm-5.3-flash' }] },
  runtime: { value: 'broker-direct', from: 'room' }, plugins: { value: ['memory', 'handover', 'living-room'], from: 'house' },
  heartbeat: { value: { enabled: true, mode: 'minimal', interval: 'adaptive' }, from: 'house' },
  schedule: { quiet_hours: '01:00-09:00', timezone: 'inherit' },
  permissions: { 'core.exec': { value: 'approve', from: 'house_cap' }, 'core.fs.write': { value: 'approve', from: 'room' }, 'living_room.send': { value: 'allow', from: 'room' }, 'memory.write.other': { value: 'deny', from: 'house_cap' } },
  context: { recent_messages: 20, recent_max_chars: 4000, memory_hits: 4, memory_recent: 3 },
  extensions: { 'dev.sameroof.deliver': { agent: 'after_turn', from: { '规划员': 'interrupt' } } },
  soul: '实现员，安静的热心肠。\n平时温温软软，办正事清晰可靠。\n出错了直接承认、立刻改正。',
  state: { wakes_today: 12, day: '2026-09-12', last_wake: iso(6), last_sleep: iso(50) },
};
const QUOTA = { fetched_at: iso(1), providers: [
  { provider: 'kimi', label: 'Kimi Code', residents: ['实现员'], status: 'ok', windows: [{ label: '5 小时窗', usedPercent: 34, resetAt: new Date(NOW + 137 * 60000).toISOString() }, { label: '周窗', usedPercent: 71, resetAt: new Date(NOW + 2 * 86400000).toISOString() }] },
  { provider: 'claude', label: 'Claude Max', residents: ['规划员'], status: 'ok', windows: [{ label: '5 小时窗', usedPercent: 92, resetAt: new Date(NOW + 44 * 60000).toISOString() }] },
  { provider: 'glm', label: '智谱 GLM', residents: ['检索员'], status: 'error', message: '拉取超时 5s', windows: [] },
] };
const COST = { timezone: 'Asia/Shanghai', days: Array.from({ length: 7 }, (_, i) => '2026-09-0' + (6 + i)), residents: [
  { resident: '实现员', runtime: 'broker-direct', days: [1200, 3400, 800, 5200, 4100, 9000, 6200].map(v => ({ input: v, output: Math.round(v * .3) })), total: { wakes: 42, input: 30000, output: 9000, cached: 12000, with_usage: 40 } },
  { resident: '检索员', runtime: 'broker-direct', days: [8000, 6200, 9100, 4300, 7200, 5100, 6600].map(v => ({ input: v, output: Math.round(v * .4) })), total: { wakes: 60, input: 46000, output: 18000, cached: 3000, with_usage: 60 } },
], ledger: { residents: [{ resident: '实现员', total: { requests: 40, tokens: 39000, cached: 12000, errors: 0, estimated: 2 } }, { resident: '检索员', total: { requests: 60, tokens: 64000, errors: 1 } }] } };

/* ===== fetch 桩（注入页面，先于页面脚本执行） ===== */
const ME = MEMBERS[0];
const DM = [
  M(61, 'dm', 'resident_builder_01', '维护者！前门修好了，你现在能看到我跑哪条车道了', { to_id: ME.id }),
  M(62, 'dm', ME.id, '看到啦，运行卡里写得清清楚楚', { to_id: 'resident_builder_01' }),
  M(63, 'dm', 'resident_builder_01', '嘿嘿。对了，记忆审核那四个按钮也上了，你有空点点', { to_id: ME.id }),
];
const BUDGET = { day: '2026-09-12', cap: { requests: 24, tokens: 100000 }, used: { requests: 9, tokens: 18340, wakes: 12, said: 5, silent: 4, passive: 3 }, estimate: '今天大约花了 ¥0.4（估算）' };

const STUB = `
window.__mock = ${JSON.stringify({ ME, MEMBERS, HISTORY, ACTIVITY, builder_RUNS, MEM, MEM_PENDING, CONFIG, QUOTA, COST, DM, BUDGET, APR1, APR2 })};
localStorage.setItem('api','mock://local');localStorage.setItem('token','mock');
(function(){
 const M=window.__mock;
 const json=o=>new Response(JSON.stringify(o),{status:200,headers:{'content-type':'application/json'}});
 window.fetch=async(url,opts)=>{
  const u=new URL(url);const p=u.pathname;
  if(p.endsWith('/events'))return new Promise(()=>{});
  if(p.endsWith('/me'))return json(M.ME);
  if(p.endsWith('/members'))return json(M.MEMBERS);
  if(p.endsWith('/history'))return json(M.HISTORY);
  if(p.endsWith('/inbox'))return json([]);
  if(p.endsWith('/activity'))return json(M.ACTIVITY);
  if(p.endsWith('/quota'))return json(M.QUOTA);
  if(p.endsWith('/cost'))return json(M.COST);
  if(p.endsWith('/runs')&&!p.includes('/rooms/'))return json(M.builder_RUNS.map(r=>({...r,resident:'实现员'})));
  if(p.endsWith('/dm/history'))return json(M.DM);
  if(p.includes('/memory/pending'))return json(M.MEM_PENDING);
  if(p.endsWith('/memory'))return json(M.MEM);
  if(p.endsWith('/handover'))return json({latest:'今天把 K1–K5 交了工。\\n\\n明天：壳 v2 的 P0。',history:['昨天修了三处已读 bug。']});
  if(p.endsWith('/concerns'))return json({open:['等维护者试用记忆审核四按钮','黑板初稿等度量员划线'],done:['私信链路修好']});
  if(p.endsWith('/notes'))return json(['改代码前先读三遍接口','维护者喜欢简洁的汇报']);
  if(p.endsWith('/budget'))return json(M.BUDGET);
  if(p.endsWith('/runs')&&p.includes('/rooms/'))return json(M.builder_RUNS);
  if(p.match(/\\/approval\\//)&&opts&&!opts.method)return json({approval_id:M.APR1,status:'pending',expires_ts:new Date(Date.now()+1700e3).toISOString()});
  if(p.match(/\\/rooms\\//))return json(M.CONFIG);
  return json({error:{code:'MOCK',message:'mock 里没有 '+p}});
 };
})();
`;

async function main() {
  await new Promise(r => server.listen(SPORT, r));
  const edge = spawn(EDGE, ['--headless=new', '--disable-gpu', `--remote-debugging-port=${PORT}`,
    '--user-data-dir='+path.join(require('os').tmpdir(),'house-shots-profile'), '--window-size=390,844', 'about:blank'], { stdio: 'ignore' });
  try {
    let targets = null;
    for (let i = 0; i < 30; i++) {
      await sleep(500);
      try { targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); if (targets.length) break; } catch {}
    }
    if (!targets || !targets.length) throw new Error('CDP 没起来');
    const ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    let id = 0; const pending = new Map();
    ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
    const send = (method, params = {}) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
    const evaljs = async (expr) => {
      const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
      if (r.result && r.result.exceptionDetails) console.error('eval err:', JSON.stringify(r.result.exceptionDetails).slice(0, 300));
      return r.result && r.result.result ? r.result.result.value : undefined;
    };
    const shot = async (name) => {
      const r = await send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.result.data, 'base64'));
      console.log('shot:', name);
    };
    await send('Page.enable'); await send('Runtime.enable');
    await send('Page.addScriptToEvaluateOnNewDocument', { source: STUB });

    for (const variant of ['after', 'before']) {
      await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
      await send('Page.navigate', { url: `http://127.0.0.1:${SPORT}/${variant}/` });
      await sleep(4500);
      console.log(variant, 'state:', await evaljs(`({me: typeof me!=='undefined'&&me&&me.name, members: typeof members!=='undefined'?members.length:0, feed: typeof feedItems!=='undefined'?feedItems.length:0})`));
      await shot(`${variant}-1-now`);
      await evaljs(`showView('lounge');'ok'`); await sleep(1000); await shot(`${variant}-2-lounge`);
      await evaljs(`showView('rooms');'ok'`); await sleep(600); await shot(`${variant}-3-rooms`);
      await evaljs(`openRoom('resident_builder_01');'ok'`); await sleep(1500); await shot(`${variant}-4-room-dm`);
      for (const [tab, wait] of [['runs', 1500], ['memory', 1500], ['config', 2000]]) {
        await evaljs(`document.querySelector('#roompills .pill-tab[data-p=${tab}]').click();'ok'`);
        await sleep(wait); await shot(`${variant}-5-room-${tab}`);
      }
      await evaljs(`showView('runs');'ok'`); await sleep(1500); await shot(`${variant}-6-runs`);
      await evaljs(`showView('quota');'ok'`); await sleep(1500); await shot(`${variant}-7-quota`);
      await evaljs(`showView('house');'ok'`); await sleep(2000); await shot(`${variant}-8-house`);
    }
    // after 的 PC 宽版（注意：循环结束时页面停在 before，要先跳回 after）
    await send('Page.navigate', { url: `http://127.0.0.1:${SPORT}/after/` });
    await sleep(4000);
    await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false });
    await evaljs(`showView('now');'ok'`); await sleep(800); await shot('after-9-pc-now');
    await evaljs(`showView('lounge');'ok'`); await sleep(800); await shot('after-10-pc-lounge');
    ws.close();
  } finally { edge.kill(); server.close(); }
}
main().catch(e => { console.error('FAIL:', e); process.exit(1); });
