'use strict';
// Subrun manager (design docs/design/subagents.md §4.1, §4.5, §4.6). Owned by run(), lives OUTSIDE runOnce()/wake():
// never holds `active`, never inside the wake watchdog. Starts subruns, bounds concurrency, persists transcripts,
// keeps the request_id index that lets the adapter recognise a subrun's gateway result DM (contract B), writes results
// to the local mailbox and asks for a wake. On startup, marks unfinished subruns `interrupted` without re-running anything.
const fs = require('node:fs');
const path = require('node:path');
const { runSubagent } = require('./subagent');

class Transcript {
  constructor(file) { this.file = file; fs.mkdirSync(path.dirname(file), { recursive: true }); }
  append(obj) { const fd = fs.openSync(this.file, 'a'); try { fs.writeSync(fd, JSON.stringify(obj) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
  static read(file) { try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } }
}

class SubrunManager {
  /**
   * @param {object} o
   * @param {string} o.dir            state dir for this resident (rooms/<name>/state)
   * @param {object} o.mailbox        Mailbox instance
   * @param {function} o.requestWake  (lane, reason) → void
   * @param {function} o.model        one-shot model call (callOnce)
   * @param {object} o.gateway        gateway-client bound functions
   * @param {string} o.residentId
   * @param {string} o.residentName
   * @param {object} o.config         { max_parallel, budget:{model_calls,tool_calls,minutes}, tools, inherit_max_chars, summary_max_words }
   * @param {function} [o.log]
   */
  constructor(o) {
    Object.assign(this, { dir: o.dir, mailbox: o.mailbox, requestWake: o.requestWake, model: o.model, gateway: o.gateway, residentId: o.residentId, residentName: o.residentName, log: o.log || (() => {}) });
    this.cfg = { max_parallel: 2, budget: { model_calls: 15, tool_calls: 20, minutes: 10 }, tools: ['core.fs.read'], inherit_max_chars: 12000, summary_max_words: 300, ...(o.config || {}) };
    this.live = new Map();          // sub_id → { ac, promise, requestIds:Set, startedAt }
    this.requestIndex = new Map();  // request_id → sub_id  (contract B)
    this.transcriptDir = path.join(this.dir, 'subruns'); fs.mkdirSync(this.transcriptDir, { recursive: true });
    this.stopped = false;
  }
  get activeCount() { return this.live.size; }

  /** Contract B: does this gateway request_id belong to one of my subruns (live or recorded)? */
  ownsRequest(requestId) { return this.requestIndex.has(requestId); }
  noteDelivered(requestId) { const s = this.live.get(this.requestIndex.get(requestId)); if (s) s.delivered.add(requestId); }

  /** Rebuild the request index from transcripts and turn unfinished ones into `interrupted` mailbox items. No re-execution. */
  async recoverOnStartup(probe = null, maxProbe = 10) {
    let interrupted = 0, probes = 0;
    for (const f of fs.readdirSync(this.transcriptDir).filter(n => n.endsWith('.jsonl'))) {
      const rows = Transcript.read(path.join(this.transcriptDir, f));
      const start = rows.find(r => r.ev === 'start'); if (!start) continue;
      const subId = f.replace(/\.jsonl$/, '');
      const reqs = rows.filter(r => r.ev === 'tool_register').map(r => r.request_id);
      for (const r of reqs) this.requestIndex.set(r, subId);            // late result DMs after restart are still recognised
      if (rows.some(r => r.ev === 'end')) continue;
      const states = {};
      if (probe) for (const r of reqs) { if (probes >= maxProbe) { states[r] = 'unknown'; continue; } probes++; try { const g = await probe(r); states[r] = g && g.body ? g.body.state : 'unknown'; } catch { states[r] = 'unknown'; } }
      const task = rows.find(r => r.ev === 'task'); const lastReply = [...rows].reverse().find(r => r.ev === 'model_reply');
      this.mailbox.put({ kind: 'subresult', sub_id: subId, status: 'interrupted', task: task ? task.task : null, summary: (lastReply ? lastReply.preview : '') || '(进程重启前未完成，无结论)', request_ids: reqs, request_states: states, elapsed_ms: null });
      new Transcript(path.join(this.transcriptDir, f)).append({ ts: new Date().toISOString(), ev: 'end', status: 'interrupted', reason: 'adapter_restart', request_states: states });
      interrupted++;
    }
    if (interrupted) this.requestWake('agent', `subrun 恢复：${interrupted} 个被中断`);
    return { interrupted, probes };
  }

  /**
   * Start a subrun. Returns { sub_id } immediately or throws when over the parallel limit.
   * @param {object} spec  { task, brief, refs, tools?, inherit?:[], budget?:{}, kind? }
   */
  start(spec) {
    if (this.stopped) throw new Error('subrun manager stopped');
    if (this.live.size >= this.cfg.max_parallel) throw new Error(`subrun 并行上限 ${this.cfg.max_parallel} 已满`);
    const subId = 'sub_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    const ac = new AbortController();
    const transcript = new Transcript(path.join(this.transcriptDir, subId + '.jsonl'));
    transcript.append({ ts: new Date().toISOString(), ev: 'task', task: spec.task, kind: spec.kind || null });
    const tools = (spec.tools || this.cfg.tools).filter(t => this.cfg.tools.includes(t));   // spec can only narrow
    const b = { ...this.cfg.budget, ...(spec.budget || {}) };
    const budget = { modelCalls: Math.min(b.model_calls, this.cfg.budget.model_calls), toolCalls: Math.min(b.tool_calls, this.cfg.budget.tool_calls), ms: Math.min(b.minutes, this.cfg.budget.minutes) * 60000 };
    const entry = { ac, requestIds: new Set(), delivered: new Set(), startedAt: Date.now(), task: spec.task };
    this.live.set(subId, entry);
    // wrap gateway so every request_id is indexed the moment it is generated (before registerIntent — contract B)
    const gw = { ...this.gateway, newRequestId: () => { const id = this.gateway.newRequestId(); this.requestIndex.set(id, subId); entry.requestIds.add(id); return id; } };
    const t0 = Date.now();
    entry.promise = runSubagent({ brief: { task: spec.task, constraints: spec.brief, refs: spec.refs || [] }, system: spec.system || '', inherit: spec.inherit || [], tools, budget, model: this.model, gateway: gw, runId: subId, residentId: this.residentId, residentName: this.residentName, transcript, signal: ac.signal, summaryMaxWords: this.cfg.summary_max_words, log: this.log })
      .catch(e => ({ status: 'error', summary: '', usage: {}, toolCalls: 0, requestIds: [...entry.requestIds], error: String(e.message).slice(0, 300) }))
      .then(res => {
        this.live.delete(subId);
        this.mailbox.put({ kind: 'subresult', sub_id: subId, status: res.status, task: spec.task, summary: res.summary, usage: res.usage, tool_calls: res.toolCalls, request_ids: res.requestIds, elapsed_ms: Date.now() - t0, error: res.error || null });
        this.requestWake('agent', `subrun ${subId} ${res.status}`);
        return res;
      });
    return { sub_id: subId };
  }

  /** Abort everything; wait up to ms for loops to unwind. Results still land in the mailbox as interrupted. */
  async stop(ms = 5000) {
    this.stopped = true;
    for (const [, s] of this.live) s.ac.abort(new Error('SIGTERM'));
    await Promise.race([Promise.allSettled([...this.live.values()].map(s => s.promise)), new Promise(r => setTimeout(r, ms))]);
    return this.live.size;
  }
}
module.exports = { SubrunManager, Transcript };
