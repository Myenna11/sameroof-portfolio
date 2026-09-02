// 同屋 · 记忆插件 v0.1（每间屋自己的记忆，文件即真相，随房间迁移）
// 规则来自 ROOM_SPEC"记忆的来源规则"：每条记忆带来源、时间、置信度、审查状态；外部输入不可信，不能自动升级成身份规则。
'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto');

function grams(s) { s = String(s).normalize('NFKC').toLowerCase().replace(/\s+/g, ''); const g = new Set(); for (let i = 0; i < s.length - 1; i++) g.add(s.slice(i, i + 2)); if (s.length === 1) g.add(s); return g; }

function open(roomDir) {
  const dir = path.join(roomDir, 'memory'); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'memories.jsonl');
  const load = () => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : [];
  return {
    /** 写一条记忆。source: self(自己写) | human(人说的) | inbox(客厅听来的) | external(网页邮件等) */
    remember({ content, source = 'self', confidence, tags = [], by }) {
      content = String(content || '').trim(); if (!content) return null;
      const rec = { id: 'mem_' + crypto.randomBytes(6).toString('hex'), ts: new Date().toISOString(), content, source, by: by || null,
        confidence: confidence ?? (source === 'human' ? 0.9 : source === 'self' ? 0.7 : 0.4),
        reviewed: source === 'human', tags, weight: 1, hits: 0 };
      fs.appendFileSync(file, JSON.stringify(rec) + '\n'); return rec;
    },
    recent(n = 5) { return load().slice(-n); },
    /** 按 2-gram 重叠召回；命中会加热（写回 hits） */
    recall(query, n = 5) {
      const all = load(); if (!all.length) return [];
      const q = grams(query); const scored = all.map(m => { const g = grams(m.content); let hit = 0; for (const x of q) if (g.has(x)) hit++; return { m, s: hit / Math.sqrt(g.size + 1) * (0.5 + m.confidence) }; })
        .filter(x => x.s > 0.15).sort((a, b) => b.s - a.s).slice(0, n);
      if (scored.length) { const ids = new Set(scored.map(x => x.m.id)); fs.writeFileSync(file, all.map(m => JSON.stringify(ids.has(m.id) ? { ...m, hits: (m.hits || 0) + 1, last_hit: new Date().toISOString() } : m)).join('\n') + '\n'); }
      return scored.map(x => x.m);
    },
    count() { return load().length; },
    render(list) { return list.map(m => `- (${m.ts.slice(0, 10)}·${m.source}${m.reviewed ? '' : '·未审'}) ${m.content}`).join('\n'); },
  };
}
module.exports = { open };
