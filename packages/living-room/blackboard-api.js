// 同屋 · 客厅的"黑板"（规划员，W7）：家里共享的一块软木板，钉的是"事"，不是"消息"。
// 真相在客厅 sqlite 的 tasks 表；适配器那边只有 PIN 指令 + 心跳读黑板 + due 落 routine（packages/adapters/lib/blackboard.js）。
// 设计依据：docs/questions/2026-09-07-builder-blackboard-shape.md（形状/生命周期/权限）、
//   …-planner-reply-builder-k1-k5.md K4（PIN 单前缀、due_at=routine at、origin 能跳不强制）、…-metrics-reply-k4-blackboard.md（验收可选、改派用重钉、时间由房子供给、没进展不更新）。
'use strict';
const crypto = require('crypto');
const { validateCronExpression } = require('@sameroof/schema');

const STATES = ['open', 'doing', 'blocked', 'done', 'dropped'];
const ACTIVE = ['open', 'doing', 'blocked'];                       // 壳上默认只看这三种
const TASK_ID_RE = /^task_[a-z0-9]{6,20}$/;
const MSG_ID_RE = /^msg_[a-f0-9]{16,24}$/;
const TITLE_MAX = 300, TEXT_MAX = 1000, ORIGIN_MAX = 120;
const ARCHIVE_AFTER_MS = 7 * 86400000;                            // done/dropped 满 7 天收起（只标 archived_ts，不删行）
const DUE_AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/i;   // 客厅只收带时区的 ISO；"不带时区按房子 tz"是适配器的事（时间由房子供给）

const newId = () => 'task_' + Date.now().toString(36) + crypto.randomBytes(4).toString('hex').slice(0, 6);

// 到期时间：ISO 8601 带 Z 或 ±HH:MM，回标准 UTC ISO；非法 → 400 TASK-DUE-INVALID
function normalizeDueAt(v, HttpError) {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string' || !DUE_AT_RE.test(v.trim()) || !Number.isFinite(Date.parse(v.trim()))) throw new HttpError(400, 'TASK-DUE-INVALID', 'due_at 得是带时区的 ISO 8601（如 2026-09-08T21:00+08:00 或 …Z）。');
  return new Date(Date.parse(v.trim())).toISOString();
}
function normalizeDueCron(v, HttpError) {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string' || !v.trim()) throw new HttpError(400, 'TASK-DUE-INVALID', 'due_cron 得是五段 cron 字符串。');
  const error = validateCronExpression(v.trim());
  if (error) throw new HttpError(400, 'TASK-DUE-INVALID', 'due_cron 非法：' + error + '。');
  return v.trim().split(/\s+/).join(' ');
}
function optionalText(body, key, max, HttpError) {
  const v = body[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw new HttpError(400, 'TASK-TEXT-INVALID', key + ' 得是字符串。');
  if (v.length > max) throw new HttpError(413, 'TASK-TEXT-TOO-LONG', key + ' 最长 ' + max + ' 个字符。');
  return v.trim();
}

function mount({ residents, byId, byName, norm, db, writeJson: rawWriteJson, readJson, HttpError, emitActivity, post }) {
  const writeJson = (res, status, value) => { rawWriteJson(res, status, value); return true; };   // 回 true：这门我开过了（同 memory-api / rooms-api）
  db.exec([
    'CREATE TABLE IF NOT EXISTS tasks(',
    'id TEXT PRIMARY KEY, title TEXT NOT NULL, owner_id TEXT NOT NULL, state TEXT NOT NULL, origin TEXT, created_by TEXT NOT NULL,',
    'created_ts TEXT NOT NULL, updated_ts TEXT NOT NULL, due_at TEXT, due_cron TEXT, accept TEXT, notes TEXT, result TEXT, blocks_json TEXT, archived_ts TEXT);',
    'CREATE INDEX IF NOT EXISTS tasks_owner_state ON tasks(owner_id, state);',
  ].join('\n'));
  const getTask = db.prepare('SELECT * FROM tasks WHERE id=?');
  const insTask = db.prepare('INSERT INTO tasks(id,title,owner_id,state,origin,created_by,created_ts,updated_ts,due_at,due_cron,accept,notes,result,blocks_json,archived_ts) VALUES(@id,@title,@owner_id,@state,@origin,@created_by,@created_ts,@updated_ts,@due_at,@due_cron,@accept,@notes,@result,@blocks_json,NULL)');
  const updTask = db.prepare('UPDATE tasks SET title=@title,owner_id=@owner_id,state=@state,updated_ts=@updated_ts,due_at=@due_at,due_cron=@due_cron,accept=@accept,notes=@notes,result=@result,blocks_json=@blocks_json,archived_ts=@archived_ts WHERE id=@id');
  const archiveStale = db.prepare("UPDATE tasks SET archived_ts=? WHERE archived_ts IS NULL AND state IN ('done','dropped') AND updated_ts<?");

  const nameOf = id => (byId.get(id) || {}).name || id;
  const findMember = value => (typeof value === 'string' && value.trim()) ? (byId.get(value.trim()) || byName.get(norm(value))) : null;
  const isHuman = me => me.species === 'human';
  const view = row => ({ ...row, blocks: row.blocks_json ? JSON.parse(row.blocks_json) : [], blocks_json: undefined, owner: nameOf(row.owner_id), created_by_name: nameOf(row.created_by), archived: !!row.archived_ts });
  const sortKey = t => [t.due_at ? 0 : 1, t.due_at || '', t.created_ts];      // 有到期的在前、到期近的在前；没到期的按钉上的时间
  const cmp = (a, b) => { const x = sortKey(a), y = sortKey(b); for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1; return 0; };

  // 归档：done/dropped 满 7 天标 archived_ts。客厅启动时跑一次，之后每小时一次（server.js 挂 timer）；回标了几条
  function archive(now = Date.now()) {
    return archiveStale.run(new Date(now).toISOString(), new Date(now - ARCHIVE_AFTER_MS).toISOString()).changes;
  }

  function list(url, me) {
    const ownerParam = url.searchParams.get('owner');
    let ownerId = null;
    if (ownerParam) { const r = ownerParam === 'me' ? me : findMember(ownerParam); if (!r) throw new HttpError(404, 'TASK-OWNER-UNKNOWN', '家里没有这个人：' + ownerParam); ownerId = r.id; }
    const stateParam = url.searchParams.get('state');
    const states = stateParam ? stateParam.split(',').map(s => s.trim()).filter(Boolean) : null;
    if (states) for (const s of states) if (!STATES.includes(s)) throw new HttpError(400, 'TASK-STATE-INVALID', 'state 只能是 ' + STATES.join('/') + '。');
    const includeArchived = ['1', 'true', 'yes'].includes(String(url.searchParams.get('include_archived') || '0'));
    const clauses = [], args = [];
    if (ownerId) { clauses.push('owner_id=?'); args.push(ownerId); }
    if (states && states.length) { clauses.push('state IN (' + states.map(() => '?').join(',') + ')'); args.push(...states); }
    if (!includeArchived) clauses.push('archived_ts IS NULL');
    const rows = db.prepare('SELECT * FROM tasks' + (clauses.length ? ' WHERE ' + clauses.join(' AND ') : '')).all(...args);
    return rows.map(view).sort(cmp);
  }

  async function create(req, me) {
    const body = await readJson(req);
    if (!body || typeof body.title !== 'string' || !body.title.trim()) throw new HttpError(400, 'TASK-TITLE-REQUIRED', '要有 title（一句人话）。');
    if (body.title.length > TITLE_MAX) throw new HttpError(413, 'TASK-TEXT-TOO-LONG', 'title 最长 ' + TITLE_MAX + ' 个字符。');
    const owner = body.owner === undefined || body.owner === null || body.owner === '' || body.owner === 'me' ? me : findMember(body.owner);
    if (!owner) throw new HttpError(404, 'TASK-OWNER-UNKNOWN', '家里没有这个人：' + String(body.owner).slice(0, 60));
    const due_at = normalizeDueAt(body.due_at, HttpError), due_cron = normalizeDueCron(body.due_cron, HttpError);
    if (due_at && due_cron) throw new HttpError(400, 'TASK-DUE-INVALID', 'due_at 与 due_cron 二选一。');
    let origin = optionalText(body, 'origin', ORIGIN_MAX, HttpError);
    if (!origin) origin = (typeof body.origin_message_id === 'string' && MSG_ID_RE.test(body.origin_message_id)) ? 'msg:' + body.origin_message_id : 'ui:' + me.name;
    const blocks = Array.isArray(body.blocks) ? body.blocks.filter(x => typeof x === 'string' && TASK_ID_RE.test(x)).slice(0, 20) : [];
    const ts = new Date().toISOString();
    const row = { id: newId(), title: body.title.trim(), owner_id: owner.id, state: 'open', origin, created_by: me.id, created_ts: ts, updated_ts: ts,
      due_at, due_cron, accept: optionalText(body, 'accept', TEXT_MAX, HttpError) || null, notes: optionalText(body, 'notes', TEXT_MAX, HttpError) || null, result: null, blocks_json: blocks.length ? JSON.stringify(blocks) : null };
    insTask.run(row);
    const task = view(getTask.get(row.id));
    emitActivity({ kind: 'thread_update', actor_id: me.id, text: '📌 ' + me.name + ' 钉了「' + task.title + '」给 ' + owner.name, meta: { task_id: task.id, owner_id: owner.id, state: 'open', origin, op: 'pin' } });
    // 客厅一条 system 小字，@ 主人——让他醒来看到。自己钉给自己的不 @（他已经知道了，别再把自己叫醒一遍）
    post({ kind: 'system', from_id: me.id, text: '已钉上黑板：' + task.title + '（给 ' + owner.name + '）', mentions: owner.id === me.id ? [] : [owner.id], meta: { task_id: task.id, owner_id: owner.id, origin } });
    return task;
  }

  async function update(req, me, id) {
    const body = await readJson(req);                                   // 先读完请求体再判权限（keep-alive 上别留没读的字节）
    const row = getTask.get(id);
    if (!row) throw new HttpError(404, 'TASK-NOT-FOUND', '黑板上没有这件事：' + id);
    if (!isHuman(me) && me.id !== row.owner_id) throw new HttpError(403, 'TASK-FORBIDDEN', '只有主人本人和家里的人能改这件事。');
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'TASK-BODY-INVALID', '请求体得是对象。');
    const next = { ...row };
    const changes = [];
    if (body.state !== undefined) {
      if (typeof body.state !== 'string' || !STATES.includes(body.state)) throw new HttpError(400, 'TASK-STATE-INVALID', 'state 只能是 ' + STATES.join('/') + '。');
      if (body.state !== row.state) { next.state = body.state; changes.push('state'); }
    }
    for (const key of ['notes', 'result', 'title', 'accept']) {
      const v = optionalText(body, key, key === 'title' ? TITLE_MAX : TEXT_MAX, HttpError);
      if (v === undefined) continue;
      if (key === 'title' && !v) throw new HttpError(400, 'TASK-TITLE-REQUIRED', 'title 不能空。');
      if ((v || null) !== (row[key] || null)) { next[key] = v || null; changes.push(key); }
    }
    if (body.owner !== undefined && body.owner !== null) {                // 重派：改 owner（度量员：改派不单开指令，重钉或改 owner 都行）
      const owner = body.owner === 'me' ? me : findMember(body.owner);
      if (!owner) throw new HttpError(404, 'TASK-OWNER-UNKNOWN', '家里没有这个人：' + String(body.owner).slice(0, 60));
      if (owner.id !== row.owner_id) { next.owner_id = owner.id; changes.push('owner'); }
    }
    if (body.due_at !== undefined || body.due_cron !== undefined) {
      const due_at = body.due_at === undefined ? row.due_at : normalizeDueAt(body.due_at, HttpError);
      const due_cron = body.due_cron === undefined ? row.due_cron : normalizeDueCron(body.due_cron, HttpError);
      if (due_at && due_cron) throw new HttpError(400, 'TASK-DUE-INVALID', 'due_at 与 due_cron 二选一。');
      if (due_at !== row.due_at) { next.due_at = due_at; changes.push('due_at'); }
      if (due_cron !== row.due_cron) { next.due_cron = due_cron; changes.push('due_cron'); }
    }
    if (!changes.length) return view(row);                              // 没进展不更新：什么都没变就不写、不发 activity
    next.updated_ts = new Date().toISOString();
    if (changes.includes('state') && ACTIVE.includes(next.state)) next.archived_ts = null;   // 从 done/dropped 拉回来的，归档标记清掉
    updTask.run(next);
    const task = view(getTask.get(id));
    const ownerName = nameOf(task.owner_id);
    const tail = (label, v) => (v ? '：' + v : '');
    const text = !changes.includes('state')
      ? (changes.includes('owner') ? '📌 ' + me.name + ' 把「' + task.title + '」改派给 ' + ownerName : '✏️ ' + me.name + ' 更新了「' + task.title + '」' + tail('notes', changes.includes('notes') ? task.notes : ''))
      : task.state === 'done' ? '✅ ' + ownerName + ' 做完了「' + task.title + '」' + tail('result', task.result)
      : task.state === 'blocked' ? '⛔ ' + ownerName + ' 卡住了「' + task.title + '」' + tail('notes', task.notes)
      : task.state === 'dropped' ? '🗑 ' + ownerName + ' 放下了「' + task.title + '」' + tail('notes', task.notes)
      : task.state === 'doing' ? '▶ ' + ownerName + ' 开工了「' + task.title + '」'
      : '📌 ' + me.name + ' 把「' + task.title + '」重新挂回黑板';
    emitActivity({ kind: 'thread_update', actor_id: me.id, text, meta: { task_id: task.id, owner_id: task.owner_id, state: task.state, origin: task.origin, op: 'update', changes, ...(changes.includes('state') ? { from_state: row.state } : {}) } });
    if (changes.includes('state') && task.state === 'dropped' && row.created_by !== me.id && byId.has(row.created_by)) {   // 放下了：告诉钉的人一声
      post({ kind: 'system', from_id: me.id, text: ownerName + ' 放下了黑板上的「' + task.title + '」' + tail('', task.notes) + '（是 ' + nameOf(row.created_by) + ' 钉的）', mentions: [row.created_by], meta: { task_id: task.id, owner_id: task.owner_id, state: 'dropped' } });
    }
    return task;
  }

  async function handle(req, url, me, res) {
    if (url.pathname === '/tasks') {
      if (req.method === 'GET') return writeJson(res, 200, list(url, me));
      if (req.method === 'POST') return writeJson(res, 200, await create(req, me));
      throw new HttpError(405, 'TASK-METHOD', '/tasks 只能 GET 或 POST。');
    }
    const m = url.pathname.match(/^\/tasks\/([^/]+)$/); if (!m) return false;
    const id = decodeURIComponent(m[1]);
    if (!TASK_ID_RE.test(id)) throw new HttpError(400, 'TASK-ID-INVALID', '任务 id 不合法。');
    if (req.method === 'GET') { const row = getTask.get(id); if (!row) throw new HttpError(404, 'TASK-NOT-FOUND', '黑板上没有这件事：' + id); return writeJson(res, 200, view(row)); }
    if (req.method === 'PATCH') return writeJson(res, 200, await update(req, me, id));
    throw new HttpError(405, 'TASK-METHOD', '/tasks/:id 只能 GET 或 PATCH。');
  }
  return { handle, archive };
}
module.exports = { mount, STATES, ACTIVE, TASK_ID_RE, ARCHIVE_AFTER_MS };
