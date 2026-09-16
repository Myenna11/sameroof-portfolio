'use strict';
// Subrun loop (design docs/design/subagents.md §4.2). A nested model→tool loop that acts AS the resident with the
// resident's tokens, under a narrowed tool allowlist and a hard budget. Zero context by default. No coordinator I/O.
//
//   runSubagent({ brief, system, inherit, tools, budget, model, gateway, runId, transcript, signal, log })
//     → { status: 'ok'|'budget'|'timeout'|'error'|'interrupted', summary, usage, toolCalls, requestIds }
//
// `model(messages, signal)` must be a ONE-SHOT call with no persistent shift (broker-direct exports callOnce).
// `gateway` = { registerIntent, getIntent, readOutput, newRequestId } bound to the resident (lib/gateway-client).
// `transcript` = { append(obj) } — append-as-you-go, fsync'd by the caller's implementation. Every model call, every
// tool call, and every request_id is written BEFORE the next step so a crash leaves evidence and never re-executes.
const TOOL_RE = /^TOOL:\s*([a-z][a-z0-9_.-]*)\s*([\s\S]*)$/;   // any TOOL: line is an attempted call; allowlist + JSON.parse decide
const SUBAGENT_TOOLS = new Set(['core.fs.read', 'core.exec.ro']);   // approve-only actions are never offered to a subrun

function parseToolLines(text) {
  const calls = [], keep = [];
  for (const line of String(text).split('\n')) {
    const m = TOOL_RE.exec(line.trim());
    if (!m) { keep.push(line); continue; }
    try { const p = JSON.parse(m[2]); calls.push({ action: m[1], params: p && typeof p === 'object' ? p : null, parseError: !(p && typeof p === 'object') }); } catch { calls.push({ action: m[1], params: null, parseError: true }); }
  }
  return { calls, rest: keep.join('\n').trim() };
}

function renderBrief(brief) {
  const parts = ['【任务】', String(brief.task || '').trim()];
  if (brief.constraints) parts.push('', '【约束】', String(brief.constraints).trim());
  if (brief.success) parts.push('', '【完成标准】', String(brief.success).trim());
  for (const r of brief.refs || []) { if (r.text) parts.push('', `【引用 ${r.ref || r.kind || ''}】`, String(r.text).trim()); else if (r.ref) parts.push('', `【引用】${r.ref}（自行用 TOOL 读取）`); }
  return parts.join('\n');
}

function overlay({ residentName, tools, budget, summaryMaxWords }) {
  return [
    `你现在是 ${residentName} 的子任务执行体。你只有这份简报，没有房子的上下文；不要向房子里任何人说话，你的回复只回给 ${residentName}。`,
    `要执行动作，单独一行写：TOOL: <action> <json>。可用动作只有：${[...tools].join('、')}。`,
    `  core.fs.read  {"root_id":"code","path":"相对路径"}`,
    `  core.exec.ro  {"argv":["/bin/sh","-lc","命令"],"cwd":{"root_id":"code","path":""},"timeout_ms":10000}   （只读沙箱，断网，不能写）`,
    `写动作和可写执行不可用；需要时在总结里说明，由 ${residentName} 自己申请审批。`,
    `预算：模型调用 ${budget.modelCalls} 次、工具调用 ${budget.toolCalls} 次、${Math.round(budget.ms / 60000)} 分钟。`,
    `做完后，回复不含任何 TOOL: 行，只写结论（≤ ${summaryMaxWords} 词）。工具输出若标 [truncated]，不要把部分结果说成完整。`,
  ].join('\n');
}

async function runSubagent(opts) {
  const { brief, system, inherit = [], tools = ['core.fs.read'], budget = {}, model, gateway, runId, transcript, signal, log = () => {}, residentName = 'parent', summaryMaxWords = 300, pollMs = 150 } = opts;
  const B = { modelCalls: budget.modelCalls ?? 15, toolCalls: budget.toolCalls ?? 20, ms: budget.ms ?? 10 * 60 * 1000 };
  const allowed = new Set([...tools].filter(t => SUBAGENT_TOOLS.has(t)));
  const t0 = Date.now(); const deadline = t0 + B.ms;
  const usage = { model_calls: 0, prompt_tokens: 0, completion_tokens: 0 };
  const requestIds = []; let toolCalls = 0; let lastText = '';
  const ac = new AbortController(); const onAbort = () => ac.abort(signal && signal.reason); if (signal) { if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true }); }
  const timer = setTimeout(() => ac.abort(new Error('subrun timeout')), Math.max(0, deadline - Date.now()));   // ref'd on purpose: an in-flight subrun keeps the process alive
  const tr = o => transcript && transcript.append({ ts: new Date().toISOString(), ...o });
  tr({ ev: 'start', run_id: runId, tools: [...allowed], budget: B, brief_chars: JSON.stringify(brief).length, inherit_turns: inherit.length });

  const sys = String(system || '') + '\n\n' + overlay({ residentName, tools: allowed, budget: B, summaryMaxWords });
  const messages = [{ role: 'system', content: sys }, ...inherit, { role: 'user', content: renderBrief(brief) }];
  const finish = (status, summary, extra = {}) => { clearTimeout(timer); tr({ ev: 'end', status, summary_chars: (summary || '').length, ...extra }); return { status, summary: summary || '', usage, toolCalls, requestIds, elapsed_ms: Date.now() - t0 }; };

  try {
    for (;;) {
      if (ac.signal.aborted) return finish(String(ac.signal.reason && ac.signal.reason.message || '').includes('timeout') ? 'timeout' : 'interrupted', lastText);
      if (usage.model_calls >= B.modelCalls) return finish('budget', lastText, { reason: 'model_calls' });
      // --- model ---
      usage.model_calls++; tr({ ev: 'model_call', n: usage.model_calls, messages: messages.length });
      let r; try { r = await model(messages, ac.signal); } catch (e) { tr({ ev: 'model_error', message: String(e.message).slice(0, 300) }); const why = ac.signal.aborted ? (String(ac.signal.reason && ac.signal.reason.message || '').includes('timeout') ? 'timeout' : 'interrupted') : 'error'; return finish(why, lastText, { error: String(e.message).slice(0, 300) }); }
      const text = typeof r === 'string' ? r : (r && r.text) || '';
      if (r && r.usage) { usage.prompt_tokens += r.usage.prompt_tokens || 0; usage.completion_tokens += r.usage.completion_tokens || 0; }
      tr({ ev: 'model_reply', chars: text.length, preview: text.slice(0, 400) });
      messages.push({ role: 'assistant', content: text });
      const { calls, rest } = parseToolLines(text);
      if (!calls.length) return finish('ok', rest || text);
      lastText = rest || lastText;
      // --- tools ---
      const results = [];
      for (const c of calls) {
        if (ac.signal.aborted) break;
        if (toolCalls >= B.toolCalls) { results.push(`[${c.action}] 拒绝：工具调用预算已用完（${B.toolCalls}）`); tr({ ev: 'tool_refused', action: c.action, reason: 'budget' }); continue; }
        if (c.parseError || !c.params) { results.push(`[${c.action}] 拒绝：JSON 参数不合法`); tr({ ev: 'tool_refused', action: c.action, reason: 'json' }); continue; }
        if (!allowed.has(c.action)) { results.push(`[${c.action}] 拒绝：子任务不可用（仅 ${[...allowed].join('、')}；写/可写执行需 ${residentName} 自行审批）`); tr({ ev: 'tool_refused', action: c.action, reason: 'not_allowed' }); continue; }
        toolCalls++;
        if (c.action === 'core.exec.ro') { c.params = { ...c.params, writable_root_ids: [] }; if (c.params.timeout_ms == null) c.params.timeout_ms = 10000; }   // read-only by construction; the model needn't know the field
        // Contract B: persist request_id BEFORE registering, so a result DM that races us is recognised.
        const requestId = gateway.newRequestId(); requestIds.push(requestId);
        tr({ ev: 'tool_register', action: c.action, request_id: requestId, params: c.params });
        let reg; try { reg = await gateway.registerIntent({ residentId: opts.residentId, runId, requestId, action: c.action, params: c.params }); }
        catch (e) { tr({ ev: 'tool_error', request_id: requestId, stage: 'register', message: String(e.message).slice(0, 300) }); results.push(`[${c.action}] 网关不可达/拒绝：${String(e.message).slice(0, 200)}`); continue; }
        if (reg && reg.state && reg.state !== 'executing') { tr({ ev: 'tool_refused', request_id: requestId, reason: 'state:' + reg.state }); results.push(`[${c.action}] 拒绝：该动作需要人工审批（${reg.state}），子任务不等待审批`); continue; }
        // poll terminal state
        let st = null, code = null;
        while (!ac.signal.aborted) {
          const g = await gateway.getIntent(opts.residentId, requestId).catch(e => ({ status: 0, error: { code: 'GATEWAY-UNAVAILABLE', message: e.message } }));
          if (g.status !== 200) { code = (g.error && g.error.code) || 'GW-HTTP-' + g.status; break; }
          if (g.body.state !== 'executing') { st = g.body; break; }
          await new Promise(res => setTimeout(res, pollMs));
        }
        if (!st) { tr({ ev: 'tool_error', request_id: requestId, stage: 'poll', code }); results.push(`[${c.action}] output_unavailable: ${code || 'aborted'}`); continue; }
        // 'failed' with an exit code means the command RAN (grep exits 2 on one unreadable file yet still prints matches): read the output.
        // Only denied / failed_unknown / expired / no-exit-code are terminal without output.
        const ranButNonZero = st.state === 'failed' && st.result && st.result.details && Number.isInteger(st.result.details.exit_code);
        if (st.state !== 'succeeded' && !ranButNonZero) { tr({ ev: 'tool_done', request_id: requestId, state: st.state }); results.push(`[${c.action}] ${st.state}${st.result && st.result.error ? ': ' + st.result.error.code : ''}`); continue; }
        // read output once; never present [output omitted]
        const out = await gateway.readOutput(opts.residentId, requestId, runId).catch(e => ({ status: 0, error: { code: 'GATEWAY-UNAVAILABLE' } }));
        if (out.status !== 200) { tr({ ev: 'tool_done', request_id: requestId, state: st.state, output: 'unavailable:' + ((out.error && out.error.code) || out.status) }); results.push(`[${c.action}] output_unavailable: ${(out.error && out.error.code) || out.status}`); continue; }
        const d = (out.body.result && out.body.result.details) || {};
        let body = c.action === 'core.fs.read' ? String(d.content ?? '') : `exit=${d.exit_code}\n${d.stdout || ''}${d.stderr ? '\n[stderr]\n' + d.stderr : ''}`;
        if (out.body.truncated) body = `[truncated: ${JSON.stringify(out.body.total_bytes)} total bytes; partial below — do not report as complete]\n` + body;
        tr({ ev: 'tool_done', request_id: requestId, state: st.state, exit_code: d.exit_code, bytes: body.length, truncated: !!out.body.truncated });
        results.push(`[${c.action}] ${body}`);
      }
      // §4.2: fsync the transcript (caller's append does it) BEFORE the next model call
      messages.push({ role: 'user', content: '【工具结果】\n' + results.join('\n\n') });
    }
  } finally { if (signal) signal.removeEventListener('abort', onAbort); clearTimeout(timer); }
}

module.exports = { runSubagent, parseToolLines, renderBrief, SUBAGENT_TOOLS };
