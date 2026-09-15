'use strict';
// Adapter-local durable mailbox (design docs/design/subagents.md §4.1, G3).
// Subrun results are the resident's own working memory, not household communication: they are never routed
// through the coordinator. Append-only JSONL, atomic writes, replay-on-crash.
//
// Guarantee: at-least-once PRESENTATION, best-effort idempotent publication. An item is `consumed` only after the
// wake's exit action succeeded (per-exit table in the design); a crash before that replays it next wake with an
// `attempts` marker so the model knows it may have already spoken.
const fs = require('node:fs');
const path = require('node:path');

class Mailbox {
  constructor(file) { this.file = file; fs.mkdirSync(path.dirname(file), { recursive: true }); }
  _readAll() {
    if (!fs.existsSync(this.file)) return [];
    const out = [];
    for (const line of fs.readFileSync(this.file, 'utf8').split('\n')) { if (!line.trim()) continue; try { out.push(JSON.parse(line)); } catch {} }
    return out;
  }
  _writeAll(items) {
    const tmp = this.file + '.tmp';
    const fd = fs.openSync(tmp, 'w'); try { fs.writeSync(fd, items.map(i => JSON.stringify(i)).join('\n') + (items.length ? '\n' : '')); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, this.file);
  }
  /** Append a new item. Returns the stored item (with id/ts). */
  put(item) {
    const rec = { id: 'mb_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8), ts: new Date().toISOString(), consumed: false, attempts: [], ...item };
    const fd = fs.openSync(this.file, 'a'); try { fs.writeSync(fd, JSON.stringify(rec) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    return rec;
  }
  /** Unconsumed items, oldest first. */
  pending() { return this._readAll().filter(i => !i.consumed); }
  /** Record that a wake presented these items and exited via `exit` (say/dm/approval/silent/error). Consumed only for successful exits. */
  markAttempt(ids, exit, consumed) {
    const set = new Set(ids); if (!set.size) return 0;
    const items = this._readAll(); let n = 0;
    for (const i of items) if (set.has(i.id) && !i.consumed) { i.attempts = [...(i.attempts || []), { at: new Date().toISOString(), exit }]; if (consumed) i.consumed = true; n++; }
    this._writeAll(items); return n;
  }
  /** Render pending items for the model. Distinct from coordinator messages; never disguised as a DM. */
  static render(items) {
    if (!items.length) return '';
    const lines = ['【子任务结果】'];
    for (const i of items) {
      const prior = (i.attempts || []).length ? `（上一轮已尝试处理：${i.attempts[i.attempts.length - 1].exit}）` : '';
      const head = `- [${i.status}] ${i.sub_id}${prior} ${i.task ? '· ' + String(i.task).slice(0, 120) : ''}`.trim();
      const meta = [i.usage && i.usage.model_calls != null ? `model ${i.usage.model_calls}` : null, i.tool_calls != null ? `tools ${i.tool_calls}` : null, i.elapsed_ms != null ? `${(i.elapsed_ms / 1000).toFixed(1)}s` : null].filter(Boolean).join(' · ');
      lines.push(head + (meta ? `  (${meta})` : ''));
      if (i.summary) lines.push(String(i.summary).split('\n').map(l => '  ' + l).join('\n'));
      if (i.request_ids && i.request_ids.length) lines.push('  tool intents: ' + i.request_ids.join(', '));
    }
    return lines.join('\n');
  }
}
module.exports = { Mailbox };
