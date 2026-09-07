// 同屋 · 客厅的"记忆审核队列"口子（规划员，W4）：人（或住户本人）在壳上点 通过/丢弃/合并/取代 的四个按钮走这里。
// 真相在房间的 memory/memories.jsonl（插件只追加），客厅只做鉴权 + 转调 + 发一条 note 活动。
'use strict';
const path = require('path');
const memoryPlugin = require('@sameroof/plugin-memory');

const MEM_ID_RE = /^mem_[a-f0-9]{8,24}$/;
const CONTENT_MAX = 4000;

function mount({ houseDir, residents, byId, writeJson: rawWriteJson, readJson, HttpError, emitActivity }) {
  const writeJson = (res, status, value) => { rawWriteJson(res, status, value); return true; };   // 回 true 告诉 server.js"这门我开过了"，别再往下找门（否则会 404 → res.destroy 掐掉 keep-alive 连接）
  const roomDir = r => r._dir || path.join(houseDir, 'rooms', r.name);
  const findRoom = seg => { const r = byId.get(seg) || residents.find(x => x.name === seg); if (!r) throw new HttpError(404, 'ROOM-NOT-FOUND', '没这间屋。'); return r; };
  const isHuman = me => me.species === 'human';
  const isSelf = (me, r) => me.id === r.id;
  const memId = s => { if (!MEM_ID_RE.test(s)) throw new HttpError(400, 'MEM-ID-INVALID', '记忆 id 不合法。'); return s; };
  const content = body => {
    if (!body || typeof body.content !== 'string' || !body.content.trim()) throw new HttpError(400, 'MEM-CONTENT-REQUIRED', '要有 content。');
    if (body.content.length > CONTENT_MAX) throw new HttpError(413, 'MEM-CONTENT-TOO-LONG', 'content 最长 ' + CONTENT_MAX + ' 个字符。');
    return body.content;
  };
  // 插件抛的错（带 status/code）原样翻成 HttpError；别的算内部错误
  const call = fn => { try { return fn(); } catch (error) { if (error instanceof memoryPlugin.MemoryError) throw new HttpError(error.status, error.code, error.message); throw error; } };
  const note = (me, r, text, meta) => emitActivity({ kind: 'note', actor_id: me.id, text: me.name + ' ' + text, meta: { room_id: r.id, ...meta } });
  const brief = m => ({ id: m.id, ts: m.ts, content: m.content, source: m.source, by: m.by, confidence: m.confidence, tags: m.tags || [], review: m.review, authored: !!m.authored, version_status: m.version_status, fact_key: m.fact_key, supersedes: m.supersedes, superseded_by: m.superseded_by, merged_into: m.merged_into, redacted: !!m.redacted, archived: !!m.archived, hits: m.hits || 0 });

  return async function handle(req, url, me, res) {
    const m = url.pathname.match(/^\/rooms\/([^/]+)\/memory\/(?:(pending|merge|supersede)|([^/]+)\/(approve|discard))$/);
    if (!m) return false;
    const r = findRoom(decodeURIComponent(m[1])); const M = memoryPlugin.open(roomDir(r));
    const op = m[2] || m[4]; const id = m[3] ? memId(decodeURIComponent(m[3])) : null;
    const who = { by: me.id, species: me.species };

    if (op === 'pending') {                                         // 人，或该住户本人
      if (req.method !== 'GET') throw new HttpError(405, 'MEM-METHOD', 'pending 只能 GET。');
      if (!isHuman(me) && !isSelf(me, r)) throw new HttpError(403, 'MEM-FORBIDDEN', '只能看自己的待审记忆。');
      const limit = Math.min(Number(url.searchParams.get('limit') || 50), 500);
      return writeJson(res, 200, M.pending(limit).map(brief));
    }
    if (req.method !== 'POST') throw new HttpError(405, 'MEM-METHOD', '这扇门只能 POST。');
    const body = op === 'merge' || op === 'supersede' ? await readJson(req) : null;   // 先把请求体读完再判权限，免得 keep-alive 连接上留下没读的字节

    if (op === 'approve') {                                         // 只有人
      if (!isHuman(me)) throw new HttpError(403, 'MEM-HUMAN-ONLY', '只有人能通过记忆。');
      const rec = call(() => M.approve(id, who));
      note(me, r, '通过了 ' + r.name + ' 的一条记忆。', { op: 'approve', memory_id: id, supersedes: rec.supersedes || null });
      return writeJson(res, 200, brief(rec));
    }
    if (op === 'discard') {                                         // 人，或该住户本人
      if (!isHuman(me) && !isSelf(me, r)) throw new HttpError(403, 'MEM-FORBIDDEN', '只能丢弃自己的待审记忆。');
      const rec = call(() => M.discard(id, who));
      note(me, r, '丢弃了 ' + r.name + ' 的一条待审记忆。', { op: 'discard', memory_id: id });
      return writeJson(res, 200, brief(rec));
    }
    if (op === 'merge') {                                           // 只有人
      if (!isHuman(me)) throw new HttpError(403, 'MEM-HUMAN-ONLY', '只有人能合并记忆。');
      if (!Array.isArray(body.ids) || body.ids.length < 2 || body.ids.length > 50 || !body.ids.every(x => typeof x === 'string' && MEM_ID_RE.test(x))) throw new HttpError(400, 'MEM-IDS-INVALID', 'ids 得是 2-50 个合法记忆 id。');
      const text = content(body);
      const rec = call(() => M.merge(body.ids, { content: text, ...who }));
      note(me, r, '把 ' + r.name + ' 的 ' + body.ids.length + ' 条记忆合并成一条。', { op: 'merge', memory_id: rec.id, merged_from: body.ids });
      return writeJson(res, 200, brief(rec));
    }
    if (op === 'supersede') {                                       // 人；住户本人只能取代自己屋里的非亲笔
      if (typeof body.old_id !== 'string') throw new HttpError(400, 'MEM-ID-INVALID', '要有 old_id。');
      const oldId = memId(body.old_id); const text = content(body);
      if (!isHuman(me)) {
        if (!isSelf(me, r)) throw new HttpError(403, 'MEM-FORBIDDEN', '只能取代自己屋里的记忆。');
        const old = M.get(oldId); if (!old) throw new HttpError(404, 'MEM-NOT-FOUND', '没有这条记忆：' + oldId);
        if (old.authored) throw new HttpError(403, 'MEM-HUMAN-ONLY', '亲笔记忆只有人能提议取代。');
      }
      const rec = call(() => M.supersede(oldId, { content: text, ...who }));
      note(me, r, '给 ' + r.name + ' 的一条记忆提了新版本，等审。', { op: 'supersede', memory_id: rec.id, supersedes: oldId });
      return writeJson(res, 200, brief(rec));
    }
    return false;
  };
}
module.exports = { mount, MEM_ID_RE };
