// 同屋 · 客厅的"房间"只读口子（规划员）：人推门进去能看见的东西。凭证只给状态，永不回显。
'use strict';
const fs = require('fs'), path = require('path');
const yaml = require('js-yaml');
const memoryPlugin = require('@sameroof/plugin-memory');

const readLines = f => fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(l => l.trim()) : [];
const readJsonl = (f, limit = 100, before = null) => {
  if (!fs.existsSync(f)) return [];
  const rows = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const filtered = before ? rows.filter(r => (r.ts || '') < before) : rows;
  return filtered.slice(-limit);
};

function mount({ houseDir, residents, byId, house, writeJson: rawWriteJson, HttpError }) {
  const writeJson = (res, status, value) => { rawWriteJson(res, status, value); return true; };   // 回 true：写完就算开过门。之前回 undefined，server.js 会继续找门 → 404 → res.destroy() 掐掉 keep-alive 连接（W4 顺手修）
  const roomDir = r => r._dir || path.join(houseDir, 'rooms', r.name);
  const findRoom = seg => { const r = byId.get(seg) || residents.find(x => x.name === seg); if (!r) throw new HttpError(404, 'ROOM-NOT-FOUND', '没这间屋。'); return r; };
  const canSee = (me, r) => me.species === 'human' || me.id === r.id;   // 人能看全屋；agent 只能看自己
  const credStatus = r => {
    const auth = (r.model && r.model.auth) || {}; const alias = auth.credential;
    const entry = (house.credentials || []).find(c => c.alias === alias);
    return alias ? { alias, mode: auth.mode || (entry && entry.mode) || 'broker', provider: entry ? entry.provider : (r.model && r.model.provider), registered: !!entry } : null;
  };
  return async function handle(req, url, me, res) {
    const m = url.pathname.match(/^\/rooms\/([^/]+)(?:\/([a-z]+))?$/); if (!m || req.method !== 'GET') return false;
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
module.exports = { mount };
