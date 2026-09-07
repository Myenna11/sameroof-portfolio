// 同屋 · 客厅的"房间"只读口子（规划员）：人推门进去能看见的东西。凭证只给状态，永不回显。
'use strict';
const fs = require('fs'), path = require('path');
const yaml = require('js-yaml');
const YAML = require('yaml');                                              // 改 room.yaml 用 Document 级改写，保住人写的注释（DECISIONS #14：house/room.yaml 是人写的意图）
const memoryPlugin = require('@sameroof/plugin-memory');
const { validateRoom } = require('@sameroof/schema');

// K1：房间 extensions 只开放 dev.sameroof.* 这一片给 PUT（形状同 room.schema.json 的 propertyNames，再收窄到我们自己的前缀）
const EXT_NS_RE = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*){2,}$/;
const EXT_OURS = 'dev.sameroof.';
const EXT_NOTE = '适配器重启后生效';

const readLines = f => fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(l => l.trim()) : [];
const readJsonl = (f, limit = 100, before = null) => {
  if (!fs.existsSync(f)) return [];
  const rows = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const filtered = before ? rows.filter(r => (r.ts || '') < before) : rows;
  return filtered.slice(-limit);
};

function mount({ houseDir, residents, byId, house, writeJson: rawWriteJson, readJson, HttpError, emitActivity }) {
  const writeJson = (res, status, value) => { rawWriteJson(res, status, value); return true; };   // 回 true：写完就算开过门。之前回 undefined，server.js 会继续找门 → 404 → res.destroy() 掐掉 keep-alive 连接（W4 顺手修）
  const roomDir = r => r._dir || path.join(houseDir, 'rooms', r.name);
  const findRoom = seg => { const r = byId.get(seg) || residents.find(x => x.name === seg); if (!r) throw new HttpError(404, 'ROOM-NOT-FOUND', '没这间屋。'); return r; };
  const canSee = (me, r) => me.species === 'human' || me.id === r.id;   // 人能看全屋；agent 只能看自己
  const isHuman = me => me.species === 'human';
  const isSelf = (me, r) => me.id === r.id;
  const bad = (code, message, issues) => { const e = new HttpError(400, code, message); if (issues) e.issues = issues; return e; };

  // PUT /rooms/:id/extensions（K1，实现员的投递开关面）：body { "<dev.sameroof.xxx>": object|array|null, … }
  // 每个命名空间整段替换（null = 删掉这一段），没提到的命名空间不动；room.yaml 其它字段一律不碰。
  // 写法：读 yaml → 改 extensions → dump 到 .tmp → 过 @sameroof/schema 校验 → rename 顶上；校验不过就把 .tmp 删了，盘上什么都没发生。
  // 注意：js-yaml dump 会丢掉原文件里的注释（房间里自己写的行内注释会没），先审后合。
  async function putExtensions(req, r, me, res) {
    const body = await readJson(req);                                    // 先把请求体读完再判权限（keep-alive 上别留没读的字节）
    if (!isHuman(me) && !isSelf(me, r)) throw new HttpError(403, 'ROOM-FORBIDDEN', '只能改自己的房间。');
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw bad('ROOM-EXT-INVALID', '请求体得是 { "<namespace>": object|array|null } 这样的对象。');
    const keys = Object.keys(body);
    if (!keys.length) throw bad('ROOM-EXT-INVALID', '至少给一个命名空间。');
    for (const k of keys) {
      if (!EXT_NS_RE.test(k) || !k.startsWith(EXT_OURS)) throw bad('ROOM-EXT-NAMESPACE', '命名空间“' + k + '”不合法：只能改 dev.sameroof.<key>。');
      const v = body[k];
      if (v !== null && (typeof v !== 'object')) throw bad('ROOM-EXT-INVALID', '“' + k + '”得是对象、数组或 null（null = 删掉这段）。');
    }
    const file = path.join(roomDir(r), 'room.yaml');
    if (!fs.existsSync(file)) throw new HttpError(404, 'ROOM-NOT-FOUND', '这间屋没有 room.yaml。');
    const ydoc = YAML.parseDocument(fs.readFileSync(file, 'utf8'));
    if (ydoc.errors && ydoc.errors.length) throw new HttpError(500, 'ROOM-YAML-INVALID', 'room.yaml 解析失败：' + ydoc.errors[0].message);
    const cur = ydoc.get('extensions'); const next = Object.assign({}, cur && typeof cur.toJSON === 'function' ? cur.toJSON() : (cur || {}));
    const deleted = [];
    for (const k of keys) {
      if (body[k] === null) { if (k in next) deleted.push(k); delete next[k]; ydoc.deleteIn(['extensions', k]); }
      else { next[k] = body[k]; ydoc.setIn(['extensions', k], body[k]); }
    }
    if (!Object.keys(next).length) ydoc.delete('extensions');
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, ydoc.toString({ lineWidth: 0 }), 'utf8');                  // 注释、顺序、中文都原样
    const issues = validateRoom(tmp).map(i => ({ ...i, file }));            // issue 里的 file 换回真名，别把 .tmp 露出去
    if (issues.length) { try { fs.unlinkSync(tmp); } catch {} throw bad('ROOM-EXT-INVALID', '改完的 room.yaml 过不了校验，没写盘。', issues); }
    fs.renameSync(tmp, file);
    if (Object.keys(next).length) r.extensions = next; else delete r.extensions;   // 客厅内存里的住户对象也跟上，GET /rooms/:id 立刻能读到
    emitActivity({ kind: 'config_change', actor_id: me.id, text: me.name + ' 改了 ' + r.name + ' 的扩展配置：' + keys.join(', '), meta: { room_id: r.id, namespaces: keys, deleted } });
    return writeJson(res, 200, { id: r.id, extensions: next, note: EXT_NOTE });
  }
  const credStatus = r => {
    const auth = (r.model && r.model.auth) || {}; const alias = auth.credential;
    const entry = (house.credentials || []).find(c => c.alias === alias);
    return alias ? { alias, mode: auth.mode || (entry && entry.mode) || 'broker', provider: entry ? entry.provider : (r.model && r.model.provider), registered: !!entry } : null;
  };
  return async function handle(req, url, me, res) {
    const m = url.pathname.match(/^\/rooms\/([^/]+)(?:\/([a-z]+))?$/); if (!m) return false;
    if (req.method === 'PUT' && m[2] === 'extensions') return putExtensions(req, findRoom(decodeURIComponent(m[1])), me, res);
    if (req.method !== 'GET') return false;
    const r = findRoom(decodeURIComponent(m[1])); const sub = m[2] || 'config';
    if (!canSee(me, r)) throw new HttpError(403, 'ROOM-FORBIDDEN', '只能看自己的房间。');
    const dir = roomDir(r); const limit = Math.min(Number(url.searchParams.get('limit') || 50), 500); const before = url.searchParams.get('before');
    const statePath = path.join(houseDir, 'state', `adapter-${r.id}.json`);
    const st = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : null;
    switch (sub) {
      case 'config': {
        const soulPath = path.join(dir, 'SOUL.md');
        const d = house.defaults || {};
        return writeJson(res, 200, {
          id: r.id, name: r.name, species: r.species, aliases: r.aliases || [], avatar: r.avatar || (r.extensions || {})['dev.sameroof.avatar'] || null,
          model: r.model ? { provider: r.model.provider, id: r.model.id, auth: credStatus(r), fallback: (r.model.fallback || []).map(f => ({ provider: f.provider, id: f.id })) } : null,
          runtime: { value: r.runtime || d.runtime, from: r.runtime ? 'room' : 'house' },
          plugins: { value: r.plugins || d.plugins, from: r.plugins ? 'room' : 'house' },
          heartbeat: { value: r.heartbeat || d.heartbeat, from: r.heartbeat ? 'room' : 'house' },
          schedule: { quiet_hours: (r.heartbeat && r.heartbeat.quiet_hours) || (r.schedule && r.schedule.quiet_hours) || (house.schedule || {}).quiet_hours, timezone: house.timezone },
          permissions: Object.fromEntries(Object.entries(Object.assign({}, d.permissions || {}, r.permissions || {})).map(([k, v]) => [k, { value: v, from: (r.permissions || {})[k] ? 'room' : 'house_cap' }])),
          context: Object.assign({ recent_messages: 20, recent_max_chars: 4000, memory_hits: 4, memory_recent: 3 }, (house.extensions || {})['dev.sameroof.context'] || {}, (r.extensions || {})['dev.sameroof.context'] || {}),
          relations: me.species === 'human' ? (r.relations || {}) : undefined,     // 高敏感：只给人看
          extensions: r.extensions || {},                                          // K1：开关现值（deliver / limits / …），PUT /rooms/:id/extensions 改
          soul: fs.existsSync(soulPath) ? fs.readFileSync(soulPath, 'utf8') : null,
          state: st ? { wakes_today: st.wakes_today, day: st.day, last_wake: st.last_wake, last_sleep: st.last_sleep } : null,
        });
      }
      case 'memory': {   // v0.2：经插件折叠读（旧行补默认值、update 行折进去）；reviewed 留作兼容 = review==='approved'
        const rows = memoryPlugin.open(dir).list({ limit, before });
        return writeJson(res, 200, rows.map(x => ({ id: x.id, ts: x.ts, content: x.content, source: x.source, by: x.by, confidence: x.confidence, reviewed: x.review === 'approved', review: x.review, authored: !!x.authored, version_status: x.version_status, fact_key: x.fact_key, supersedes: x.supersedes, superseded_by: x.superseded_by, merged_into: x.merged_into, redacted: !!x.redacted, archived: !!x.archived, hits: x.hits || 0, tags: x.tags || [] })));
      }
      case 'handover': {
        const latest = path.join(dir, 'handover', 'latest.md'), hist = path.join(dir, 'handover', 'history.md');
        return writeJson(res, 200, { latest: fs.existsSync(latest) ? fs.readFileSync(latest, 'utf8') : null, history: fs.existsSync(hist) ? fs.readFileSync(hist, 'utf8').split('\n---\n').filter(s => s.trim()).slice(-limit) : [] });
      }
      case 'concerns': return writeJson(res, 200, { open: readLines(path.join(dir, 'concerns.md')).map(l => l.replace(/^-\s*/, '')), done: readLines(path.join(dir, 'concerns.done.md')).map(l => l.replace(/^-\s*/, '')).slice(-limit) });
      case 'notes': return writeJson(res, 200, readLines(path.join(dir, 'notes.md')).map(l => l.replace(/^-\s*/, '')).slice(-limit));
      case 'runs': return writeJson(res, 200, readJsonl(path.join(houseDir, 'state', 'runs', `${r.id}.jsonl`), limit, before).reverse());
      case 'budget': {
        const runs = readJsonl(path.join(houseDir, 'state', 'runs', `${r.id}.jsonl`), 2000);
        const day = st ? st.day : null; const today = runs.filter(x => day && x.ts.startsWith(day));
        const sum = (arr, f) => arr.reduce((a, x) => a + (f(x) || 0), 0);
        const hb = r.heartbeat || (house.defaults || {}).heartbeat || {}; const cap = ((hb.budget || {}).per_day) || {};
        return writeJson(res, 200, { day, cap, used: { requests: sum(today, x => x.model_calls), tokens: sum(today, x => x.usage && x.usage.total_tokens), wakes: today.length, said: today.filter(x => x.status === 'said' || x.status === 'dm').length, silent: today.filter(x => x.status === 'silent').length, passive: today.filter(x => String(x.status).startsWith('passive') || x.status === 'nothing' || x.status === 'deferred').length }, estimate: (r.model && r.model.auth && r.model.auth.mode) === 'runtime_managed' ? 'runtime_managed：用量为估算' : 'broker：以账本为准' });
      }
      default: throw new HttpError(404, 'ROOM-SUB-NOT-FOUND', '房间里没有这一页。');
    }
  };
}
module.exports = { mount, readJsonl };
