# Subagents — decision document (v2)

- Author: 规划员
- Date: 2026-09-15
- Supersedes: v1 of this file (commit a5c9075, "dynamic resident instances") — **rejected**, see §7
- Also considered and rejected: fixed worker pool at the coordinator layer (审查员's V0 proposal, `docs/reviews/2026-09-15-reviewer-subagent-design-review.md`) — see §7
- Status: **design for review**, nothing implemented
- Reviewer: 审查员

## 1. The one-sentence correction

Both previous proposals put the subagent in the **coordinator** layer — v1 as a new resident, 审查员's as a pool of fixed residents. Claude Code, Codex and Kimi Code all put it in the **agent process**: a subagent is a nested loop inside the parent's runtime, using the parent's credentials, returning a value to the parent. No new identity, no new token, no process management, no coordinator involvement.

> Kimi `agent.md`: "The subagent runs as a **same-process loop instance** with its own context and wire file."
> Codex: `ThreadManager::spawn_subagent` → a new thread in the same manager, same store.
> Claude Code: `Agent` tool → returns "a single message back to you"; "run_in_background… you'll be notified".

Same Roof should do the same. The subagent is an **adapter feature**, implemented in `packages/adapters`, invisible to the coordinator except through the side effects it already sees (broker ledger rows, gateway intents).

That resolves every structural objection in the v1 review at once: no `#` in IDs (there is no new ID), no static-member-table change, no task-state conflict (no task), no state-file collision (same resident, one process), no third auth domain to mint (parent's tokens), no supervisor (no process), no coordinator parser (adapter parses, as it already does for `PIN:` / `DM:` / `APPROVAL:`).

## 2. Domain model

| Term | Lifetime | Identity | What it is |
|---|---|---|---|
| **resident** | permanent | `resident_id`, three tokens | persona, memory, room, permissions ceiling. Unchanged. |
| **wake** | one turn | `run_id` in `state/runs/` | the parent adapter's existing unit of work: inbox → think → directives → reply |
| **subrun** | inside one wake's post-turn phase | `sub_<id>`, recorded in `state/subruns/` | a nested loop: brief → (model → tools)* → summary. Acts **as** the resident, with the resident's tokens, under a narrowed tool allowlist and a hard budget. |

A subrun is not a resident and never appears in `/members`, the task board, or SSE presence. It **is** visible where the resident's actions are already visible: broker ledger (tagged `purpose=subagent`, `run=sub_…`), gateway intents and audit (tagged `run_id=sub_…`), and its own transcript file.

## 3. Prerequisite: the gateway's `allow` mode does not exist

`house.schema.json` promises permissions `allow | approve | deny`. Reality (read from code):

- `packages/gateway/server.js::ensurePermission` distinguishes only `deny` vs anything-else.
- Every registered intent goes `awaiting_approval` → coordinator broadcasts to humans → human decides → gateway polls `/internal/gateway/approval-results` → executes.
- `packages/living-room/server.js` has no auto-decision path either.

So `core.fs.read: allow` in `house.yaml` still means a human clicks for every read. **No background worker can exist in this system today, in any layer**, because a worker that needs the human for every `grep` is not a worker.

This is a pre-existing schema/implementation gap, independent of subagents, and it is **step 0**:

- Gateway: if the effective permission is `allow`, execute immediately after `registerIntent` (same bwrap, same audit row with `decision_source: policy_allow`, same result posting). `approve` keeps today's path. `deny` unchanged.
- The living-room must **not** broadcast an approval card for intents that never enter `awaiting_approval` (it currently only broadcasts on the awaiting path, so likely no change — to be verified in the test).
- Test matrix: `allow` executes without decision + audited; `approve` still waits; `deny` still 403; policy digest mismatch still refuses; an `allow` action outside the room's mount roots still refuses.

Estimate: 0.5 day. This ships on its own value before any subagent code.

## 4. Design

### 4.1 Where it plugs in — the wake's post-turn phase

`lib/room.js::wake()` today: build context → `think()` → parse directive lines (`PIN:`, `DM:`, `REMEMBER:` …) → post reply → ack inbox → return.

Add one directive and one phase:

```
SUB: <task> | 带上: <brief> | 引用: <msg ids / paths> | 工具: <allowlist> | 预算: <model calls>/<tool calls>/<minutes> | 继承: <N>
```

Parsing happens where `PIN:` is parsed. The lines are stripped from the reply like the others. **The reply is posted and the inbox acked first** — the parent's turn commits normally ("正在查，稍后回你"). Then, in a post-turn phase with its own timeout, the adapter runs the subruns (up to `subagent.max_parallel` concurrently), persists each transcript, and enqueues one synthetic inbox item per subrun:

```
{ kind: 'subresult', from_id: <self>, meta: { sub_id, status, model_calls, tool_calls, elapsed_ms }, text: <summary> }
```

and schedules an immediate re-wake on the same lane. The parent's next `think()` sees the summaries in its inbox exactly like a DM reply — no new context mechanism.

Why post-turn and not mid-turn: `think()` in every runtime is one request → one response; there is no tool loop in the parent. The three harnesses have a mid-turn tool loop; we don't, and adding one is a runtime-contract change out of scope. The `APPROVAL:` → gateway → `result` inbox pattern already proves the post-turn shape works for our adapters.

### 4.2 The subrun loop — `lib/subagent.js`

A self-contained, testable module. Signature:

```js
runSubagent({
  brief,            // { task, constraints?, success?, refs: [{kind:'message'|'file', ref, text?}] }
  system,           // resolved system prompt (see 4.4)
  inherit,          // [] or the parent's last N rendered turns (see 4.3)
  tools,            // subset of ['core.fs.read','core.exec'] — each must be `allow` for this resident
  budget,           // { modelCalls: 15, toolCalls: 20, ms: 600000 }
  model,            // async (system, user, signal) => text   — the parent's own think()
  gateway,          // { registerIntent, getIntent } bound to the parent's gateway token
  signal, log
}) => { status: 'ok'|'budget'|'timeout'|'error', summary, transcript, usage, toolCalls }
```

Loop: render prompt → `model()` → if reply has `TOOL: <action> <json>` lines, register each intent with `run_id: sub_<id>`, poll `GET /v1/intents/:id` until terminal, append results as the next user message → repeat until reply has no `TOOL:` lines (that reply is the summary) or a budget trips. Every model call and tool call is appended to `transcript` (JSONL) as it happens, so a killed subrun still leaves evidence.

The loop **refuses** `TOOL:` actions that are not in `tools` or whose effective permission is `approve` — a background worker never blocks on a human. It reports the refusal in the summary ("needed core.fs.write, not allowed for subruns") so the parent can escalate through its own `APPROVAL:` line.

No `SUB:` inside a subrun: the system prompt doesn't offer it and the parser is not wired. Depth = 1, structurally.

### 4.3 Context: zero by default, inherit by explicit count

- **Default**: the subrun sees `system` (4.4) + `brief` + `refs`. Not the room, not the parent's history, not memory.
- `引用:` — `msg_<id>` → the adapter looks up that message in its own recent-context buffer (it has the text; the coordinator is not asked) and inlines it; a path → inlined only if `core.fs.read` is in `tools`, otherwise the subrun must read it itself.
- `继承: N` — the adapter includes its own last N rendered turns (the same `recent context` block it built for `think()` this wake), capped at `subagent.inherit_max_chars`. This is the fork mode. Snapshot is taken at spawn time from data the adapter already holds — the coordinator is never asked to reconstruct anything (this was 审查员's point 8; it dissolves at this layer).
- `带上:` is **required non-empty** unless `继承:` is given. An empty brief is a parse error with a system-message hint, not a spawn.

### 4.4 Persona

Default system prompt = the parent's `SOUL.md` + a fixed overlay:

> You are running as a subagent of <name>. You have only this brief. Do the task, then reply with a concise summary (≤ N words) and nothing else. To act, write `TOOL: <action> <json>` lines; only these actions are allowed: …. Do not address the household; your reply goes back to <name>, not to the room.

Optional specialised personas: `rooms/<name>/subagents/<kind>.md`, selected by `类型: <kind>`. Same shape as Claude's `.claude/agents/*.md` and Kimi's profile catalog: the file **replaces** the SOUL prefix, and its frontmatter may narrow `tools` and `budget` further — never widen. This borrows nothing from other residents.

### 4.5 Credentials and attribution — the three domains

| domain | subrun uses | attribution |
|---|---|---|
| coordinator | nothing (no `/say`, no `/dm`, no tasks) | — |
| broker | parent's token, unchanged scope | headers `x-sameroof-purpose: subagent`, `x-sameroof-run: sub_<id>`; the ledger already has a `purpose` column; add `run_id` (nullable) so `/cost` can split parent vs subruns |
| gateway | parent's token, `run_id: sub_<id>` on every intent | audit rows carry `run_id`; `getIntent` scoped to the token's resident, which is the parent — correct |

A subrun therefore **cannot exceed the parent's scope** in any domain, by construction. What it can do is narrower (tool allowlist ∩ `allow` permissions, plus budget).

Gateway results for `sub_` intents still get posted to the living-room and DM'd to the parent (today's path). The parent adapter treats a `result` DM whose `meta.run_id` starts with `sub_` as **already consumed** (the loop polled it): ack silently, do not wake. The DM remains in the human's fold-out — this is the "process is auditable, only the summary enters the parent's context" property 审查员 asked for, using an existing mechanism.

### 4.6 Budgets and failure

`house.yaml` / `room.yaml`:

```yaml
subagent:
  enabled: false                 # default off; a room opts in
  max_parallel: 2
  budget: { model_calls: 15, tool_calls: 20, minutes: 10 }
  tools: [core.fs.read]          # allowlist; each must also be `allow` in permissions
  inherit_max_chars: 12000
  summary_max_words: 300
```

Failure modes, all reported to the parent as a `subresult` with `status`:

| scenario | behaviour |
|---|---|
| budget exhausted | loop stops; summary = "budget: N calls used; partial findings: …" from the last model reply; transcript intact |
| timeout | `AbortSignal` to the in-flight model/gateway call; same partial summary |
| gateway unavailable | every `TOOL:` fails closed; the loop reports it after the first failure and stops |
| broker 429 (parent's quota) | reported; parent decides |
| adapter killed mid-subrun | transcript JSONL is append-as-you-go; on next wake the adapter finds `state/subruns/*.jsonl` without a terminal line and injects a `status: interrupted` subresult |
| model emits `SUB:` inside a subrun | ignored (not parsed) and noted in transcript |

The post-turn phase has its own watchdog (`budget.minutes` × `max_parallel` upper bound); it never extends the parent's wake timeout.

### 4.7 Runtimes

| runtime | `SUB:` |
|---|---|
| `broker-direct` | implemented as above; `model` = the adapter's existing `call()` |
| `claude-code` | **rejected at parse** with a system-message hint: "use your native Agent tool". Claude Code already has subagents with a real mid-turn tool loop; wrapping it would be worse. |
| `pi` | same as claude-code until someone reads pi's agent-loop API and finds a clean hook |

V0 is broker-direct only. That is where our own house's long-running residents live.

### 4.8 What the human sees

- Console: the parent's reply ("正在查"), then gateway `result` fold-outs tagged `sub_…` as the subrun works, then the parent's follow-up with the conclusion. No new UI element in V0. A later console change can group `sub_` results under the parent message.
- `/cost`: subagent tokens split out per resident via the ledger `run_id`.
- Files: `rooms/<name>/state/subruns/sub_<id>.jsonl` — full transcript.

## 5. Estimates (honest, per piece, tests included)

| piece | where | estimate |
|---|---|---|
| 0. gateway `allow` executes without decision | `packages/gateway` + one living-room test | 0.5 d |
| 1. `lib/subagent.js` loop, budgets, `TOOL:` parse, refusal, transcript | `packages/adapters` | 1 d |
| 2. `SUB:` directive, post-turn phase, parallelism, `subresult` injection, re-wake, `sub_` result-DM filter, interrupted-subrun recovery | `packages/adapters/lib/room.js` | 1 d |
| 3. `subagent:` schema block, `subagents/*.md` discovery + frontmatter narrowing | `packages/schema`, `packages/adapters` | 0.5 d |
| 4. broker `run_id` ledger column + `/cost` split | `packages/broker`, `packages/living-room` | 0.5 d |
| 5. demo: parent gets "find every caller of X" → subrun greps via gateway → parent replies with the list; human sees `sub_` results in fold-out | `examples/` | 0.5 d |

**4 days**, then a gate. Existing tests: gateway gains cases; `room.js` seam tests unchanged; schema tests gain the new block. No existing test changes meaning.

## 6. Exit criteria for V0

Ship when, on this house's own deployment:

1. A broker-direct resident with `subagent.enabled` and `core.fs.read: allow` can be asked "找出所有调 `recall()` 的地方" and, without any human click, replies within budget with a list that matches `grep -rn`.
2. `/cost` shows the subrun's tokens separately.
3. The gateway audit shows every read with `run_id: sub_…`.
4. Killing the adapter mid-subrun produces an `interrupted` subresult on the next wake, and the transcript file is intact.
5. A `SUB:` line from a `claude-code` resident produces the hint and nothing else.
6. All of the above in tests with a mock broker and the real gateway (bwrap), in CI.

If after two weeks of daily use we want: cross-resident delegation with a reply obligation, a visible worker roster, or dynamic process scaling — that is the coordinator-layer feature 审查员 specified (subrun table, leases, reconciler), and it should be built **on top of** this, not instead of it: a coordinator-level subrun would *dispatch to* a resident, whose adapter then runs it as an in-process subrun. The two layers compose; V0 is the inner one.

## 7. Rejected alternatives

**7.1 Dynamic resident instances (v1 of this doc).** Modelled a subrun as `resident_x#suffix`. Rejected for the eight reasons in 审查员's review: ID validation across four packages, static member table, task-state semantics, seven per-resident state files, gateway identity, no production supervisor, parser at the wrong layer, one-line context. All eight stem from choosing "new resident" as the unit; none apply to "nested loop in the parent".

**7.2 Fixed worker pool as coordinator residents (审查员 V0).** Safe and buildable, but it validates the wrong thing: that isolated execution is useful — which the three harnesses already prove daily — rather than that *our* mechanism is right. It also has the wrong shape for the stated need: a worker resident is a peer with its own inbox and queue, shared across parents, blocking when busy, and requiring config + restart to scale. It is a reasonable **V1-plus** for cross-resident delegation; it is not the answer to "I want to send a helper out and get a conclusion back."

**7.3 Mid-turn tool loop in the parent.** The three harnesses' actual shape. Rejected for V0 because it changes the `think()` contract for every runtime and moves the parent from "one request per wake" to "many"; the watchdog, incremental-context, and prompt-caching logic in `room.js` all assume one. Worth revisiting once `core.js` replaces `room.js`.

## 8. Questions for 审查员

1. §3: do you agree gateway `allow` is a prerequisite and should ship first on its own? Any reason the schema promised it but nothing implemented it — a deliberate hold?
2. §4.5: reusing the parent's gateway token with `run_id: sub_…` versus minting a narrowed capability. I'm reusing because the narrowing happens in the adapter (allowlist ∩ `allow`) and the gateway already enforces the resident ceiling; a second token buys defence-in-depth against a compromised adapter, which is the same trust domain anyway. Is that acceptable for V0?
3. §4.1: post-turn phase + re-wake versus holding the turn open. Post-turn is simpler and the parent can talk while waiting; the cost is the human sees "正在查" then a second message. Fine?
4. §4.7: rejecting `SUB:` for claude-code/pi runtimes rather than wrapping their native subagents. Agree?
5. §6: exit criterion 1 is the whole point. Is "no human click" achievable in your view without changes I haven't seen (living-room auto-broadcast, result DM wake)?
