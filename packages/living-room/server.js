#!/usr/bin/env node
// 同屋 · 客厅 v0.1 — 人和 agent 说话的地方。只搬文字，不执行任何工具。
// 三条硬道理：一个写入口；名字先归一化再比较；宁送两遍不丢一条。
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const yaml = require('js-yaml');
const Database = require('better-sqlite3');

const HOUSE = process.env.SAMEROOF_HOUSE || path.resolve(__dirname, '../..');
const RUN = path.join(process.env.HOME || '/root', '.sameroof', 'run');
const DATA = path.join(HOUSE, 'state');
fs.mkdirSync(RUN, { recursive: true });
fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(path.join(DATA, 'living-room'), { recursive: true });

// ---------- 住户 ----------
const RESERVED = new Set(['system', 'all', 'everyone', 'house']);
const norm = s => String(s).normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
function loadResidents() {
  const dir = path.join(HOUSE, 'rooms');
  const list = [];
  for (const d of fs.readdirSync(dir)) {
    const f = path.join(dir, d, 'room.yaml');
    if (!fs.existsSync(f)) continue;
    const r = yaml.load(fs.readFileSync(f, 'utf8'));
    if (!r || !r.id || !r.name) throw new Error(`${f}: 缺 id 或 name`);
    r.species = r.species || 'agent';
    r._names = [r.name, ...(r.aliases || [])].map(norm);
    r._dir = path.join(dir, d);
    list.push(r);
  }
  // 唯一 + 不互为前缀，冲突启动拒绝
  const all = [];
  for (const r of list) for (const n of r._names) {
    if (RESERVED.has(n)) throw new Error(`${r.name}: "${n}" 是保留名`);
    for (const [m, who] of all) if (n === m || n.startsWith(m) || m.startsWith(n))
      throw new Error(`名字冲突：${r.name} 的 "${n}" 与 ${who} 的 "${m}" 相同或互为前缀，启动拒绝`);
    all.push([n, r.name]);
  }
  return list;
}
const residents = loadResidents();
const byId = new Map(residents.map(r => [r.id, r]));
const byName = new Map(); for (const r of residents) for (const n of r._names) byName.set(n, r);

// ---------- token：每个住户一把，只认 id，不信请求体里的 from ----------
const tokenFile = path.join(RUN, 'living-room-tokens.json');
let tokens = fs.existsSync(tokenFile) ? JSON.parse(fs.readFileSync(tokenFile, 'utf8')) : {};
let changed = false;
for (const r of residents) if (!tokens[r.id]) { tokens[r.id] = crypto.randomBytes(24).toString('hex'); changed = true; }
if (changed) fs.writeFileSync(tokenFile, JSON.stringify(tokens, null, 2), { mode: 0o600 });
const idByToken = new Map(Object.entries(tokens).map(([id, t]) => [t, id]));

// ---------- 权威数据：SQLite ----------
const db = new Database(path.join(DATA, 'house.db'));
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS messages(
  id TEXT PRIMARY KEY, seq INTEGER UNIQUE, ts TEXT NOT NULL, kind TEXT NOT NULL,
  from_id TEXT NOT NULL, to_id TEXT, text TEXT NOT NULL, mentions TEXT NOT NULL, reply_to TEXT, meta TEXT);
CREATE TABLE IF NOT EXISTS deliveries(
  message_id TEXT NOT NULL, resident_id TEXT NOT NULL, status TEXT NOT NULL, ts TEXT NOT NULL,
  PRIMARY KEY(message_id, resident_id));
CREATE TABLE IF NOT EXISTS approvals(
  id TEXT PRIMARY KEY, resident_id TEXT, action TEXT, params_digest TEXT, params TEXT,
  status TEXT, decided_by TEXT, created_ts TEXT, expires_ts TEXT, used INTEGER DEFAULT 0);
`);
const seqRow = db.prepare('SELECT MAX(seq) AS m FROM messages').get();
let seq = seqRow.m || 0;
const insMsg = db.prepare('INSERT INTO messages(id,seq,ts,kind,from_id,to_id,text,mentions,reply_to,meta) VALUES(?,?,?,?,?,?,?,?,?,?)');
const insDel = db.prepare('INSERT OR IGNORE INTO deliveries(message_id,resident_id,status,ts) VALUES(?,?,?,?)');
const ackDel = db.prepare("UPDATE deliveries SET status='read', ts=? WHERE message_id=? AND resident_id=? AND status!='read'");
const unread = db.prepare("SELECT m.* FROM deliveries d JOIN messages m ON m.id=d.message_id WHERE d.resident_id=? AND d.status!='read' ORDER BY m.seq");
const history = db.prepare("SELECT * FROM messages WHERE kind!='dm' AND seq>? ORDER BY seq LIMIT ?");

// ---------- 唯一写入口 ----------
const listeners = new Set();
const presence = new Map(); // id -> {online, last_seen, last_said}
function mentionsIn(text) {
  const found = new Set();
  for (const m of String(text).matchAll(/@([^\s@，,。！!？?：:；;]+)/g)) {
    const n = norm(m[1]);
    for (const [name, r] of byName) if (n === name || n.startsWith(name)) found.add(r.id);
  }
  return [...found];
}
function post({ kind, from_id, to_id = null, text, reply_to = null, meta = null }) {
  const id = 'msg_' + crypto.randomBytes(8).toString('hex');
  const ts = new Date().toISOString();
  const mentions = kind === 'dm' ? [to_id] : mentionsIn(text).filter(x => x !== from_id);
  const row = { id, seq: ++seq, ts, kind, from_id, to_id, text, mentions, reply_to, meta };
  const targets = kind === 'dm' ? [to_id] : residents.map(r => r.id).filter(x => x !== from_id);
  db.transaction(() => {
    insMsg.run(id, row.seq, ts, kind, from_id, to_id, text, JSON.stringify(mentions), reply_to, meta ? JSON.stringify(meta) : null);
    for (const t of targets) insDel.run(id, t, 'queued', ts);
  })();
  if (kind !== 'dm') fs.appendFileSync(path.join(DATA, 'living-room', ts.slice(0, 7) + '.jsonl'), JSON.stringify(row) + '\n');
  const p = presence.get(from_id) || {}; p.last_said = ts; presence.set(from_id, p);
  for (const l of listeners) if (kind !== 'dm' || l.id === to_id || l.id === from_id) l.send(row);
  return row;
}

// ---------- HTTP ----------
const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };
const readBody = req => new Promise(r => { let b = ''; req.on('data', c => b += c); req.on('end', () => { try { r(JSON.parse(b || '{}')); } catch { r(null); } }); });
function auth(req) {
  const t = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const id = idByToken.get(t);
  return id ? byId.get(id) : null;
}
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const me = auth(req);
  if (!me) return json(res, 401, { error: '不认识你。每个住户一把 token，在 ~/.sameroof/run/living-room-tokens.json' });
  const p = presence.get(me.id) || {}; p.last_seen = new Date().toISOString(); presence.set(me.id, p);

  if (req.method === 'POST' && url.pathname === '/say') {
    const b = await readBody(req); if (!b || !b.text) return json(res, 400, { error: '要有 text' });
    return json(res, 200, post({ kind: 'say', from_id: me.id, text: String(b.text), reply_to: b.reply_to || null }));
  }
  if (req.method === 'POST' && url.pathname === '/dm') {
    const b = await readBody(req); if (!b || !b.text || !b.to) return json(res, 400, { error: '要有 to 和 text' });
    const to = byName.get(norm(b.to)) || byId.get(b.to); if (!to) return json(res, 404, { error: '没这个人' });
    return json(res, 200, post({ kind: 'dm', from_id: me.id, to_id: to.id, text: String(b.text) }));
  }
  if (req.method === 'GET' && url.pathname === '/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    const l = { id: me.id, send: row => res.write(`data: ${JSON.stringify(row)}\n\n`) };
    listeners.add(l); presence.get(me.id).online = true;
    res.write(': hi\n\n'); const ka = setInterval(() => res.write(': ka\n\n'), 25000);
    req.on('close', () => { listeners.delete(l); clearInterval(ka); presence.get(me.id).online = false; });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/history') {
    const since = Number(url.searchParams.get('since') || 0), limit = Math.min(Number(url.searchParams.get('limit') || 50), 200);
    return json(res, 200, history.all(since, limit).map(r => ({ ...r, mentions: JSON.parse(r.mentions) })));
  }
  if (req.method === 'GET' && url.pathname === '/inbox') {
    return json(res, 200, unread.all(me.id).map(r => ({ ...r, mentions: JSON.parse(r.mentions), from: byId.get(r.from_id)?.name })));
  }
  if (req.method === 'POST' && url.pathname === '/inbox/ack') {
    const b = await readBody(req); const ids = (b && b.ids) || []; const ts = new Date().toISOString();
    db.transaction(() => { for (const i of ids) ackDel.run(ts, i, me.id); })();
    return json(res, 200, { acked: ids.length });
  }
  if (req.method === 'GET' && url.pathname === '/members') {
    return json(res, 200, residents.map(r => ({ id: r.id, name: r.name, species: r.species, ...(presence.get(r.id) || {}) })));
  }
  if (req.method === 'POST' && url.pathname === '/approval') {
    const b = await readBody(req); if (!b || !b.action) return json(res, 400, { error: '要有 action' });
    const id = 'apr_' + crypto.randomBytes(6).toString('hex'); const now = Date.now();
    const digest = crypto.createHash('sha256').update(JSON.stringify(b.params || {})).digest('hex');
    const ttl = Number(b.ttl_seconds || 1800);
    db.prepare('INSERT INTO approvals(id,resident_id,action,params_digest,params,status,created_ts,expires_ts) VALUES(?,?,?,?,?,?,?,?)')
      .run(id, me.id, b.action, digest, JSON.stringify(b.params || {}), 'pending', new Date(now).toISOString(), new Date(now + ttl * 1000).toISOString());
    post({ kind: 'system', from_id: me.id, text: `${me.name} 想 ${b.action}，等审批。`, meta: { approval_id: id, action: b.action, params_digest: digest } });
    return json(res, 200, { approval_id: id, params_digest: digest, expires_in: ttl });
  }
  if (req.method === 'POST' && url.pathname.startsWith('/approval/')) {
    if (me.species !== 'human') return json(res, 403, { error: '只有人能审批' });
    const id = url.pathname.split('/')[2]; const b = await readBody(req);
    const a = db.prepare('SELECT * FROM approvals WHERE id=?').get(id); if (!a) return json(res, 404, {});
    if (a.status !== 'pending' || Date.parse(a.expires_ts) < Date.now()) return json(res, 409, { error: '已过期或已决定' });
    const decision = b && b.decision === 'allow' ? 'allowed' : 'denied';
    db.prepare('UPDATE approvals SET status=?, decided_by=? WHERE id=?').run(decision, me.id, id);
    post({ kind: 'system', from_id: me.id, text: `${me.name} ${decision === 'allowed' ? '同意' : '拒绝'}了 ${byId.get(a.resident_id)?.name} 的 ${a.action}。`, meta: { approval_id: id, decision } });
    return json(res, 200, { approval_id: id, decision, params_digest: a.params_digest, expires_at: a.expires_ts, single_use: true });
  }
  if (req.method === 'GET' && url.pathname.startsWith('/approval/')) {
    const a = db.prepare('SELECT * FROM approvals WHERE id=?').get(url.pathname.split('/')[2]);
    if (!a) return json(res, 404, {}); const expired = Date.parse(a.expires_ts) < Date.now();
    return json(res, 200, { ...a, status: expired && a.status === 'pending' ? 'expired' : a.status });
  }
  json(res, 404, { error: '没这个门' });
});

// 过期审批 → deny（fail closed）
setInterval(() => db.prepare("UPDATE approvals SET status='expired' WHERE status='pending' AND expires_ts<?").run(new Date().toISOString()), 60000);

const PORT = Number(process.env.SAMEROOF_PORT || 8790);
server.listen(PORT, '127.0.0.1', () => {
  console.log(`同屋·客厅 开门 http://127.0.0.1:${PORT}  住户：${residents.map(r => r.name).join('、')}`);
  console.log(`token 在 ${tokenFile}`);
});
