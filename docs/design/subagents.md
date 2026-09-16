# Subagents — decision document (v5)

- Author: 规划员
- Date: 2026-09-15
- Supersedes: v4 (7f97263) after `docs/reviews/2026-09-15-reviewer-subagents-v4-rfc-rev2-review.md` — CONDITIONAL ARCHITECTURE PASS; contract B (result-before-poll) and the APPROVAL consumption point fixed here
- Rejected earlier: v1 dynamic residents (a5c9075); coordinator-layer fixed worker pool — see §7
- Depends on: `docs/rfc/2026-09-15-gateway-allow.md` rev 3 (contract A: claim/execute split, register timing) — must land first
- Authorisation on record: 维护者 2026-09-15 — subruns may execute in a read-only sandbox without approval (`core.fs.read: allow`, `core.exec.ro: allow`); writes and writable exec stay `approve`. This is 规划员's record of a conversation; the release gate re-confirms with 维护者 before any `house.yaml` change.
- Status: **V0 implemented, partial scope** — see "V0 scope decisions" below for what was cut from the original v5 text. Commits: 832484f mailbox+loop, 6d4b353 manager, 044ee4a room.js+schema+e2e, 4256699 live on this house, ba0d167 + 67d5719 fixes from 审查员's gate (`docs/reviews/2026-09-16-reviewer-subagent-v0-gate-adc1c96.md`). Real transcript and enablement: `examples/subagent/README.md`.

## V0 scope decisions (2026-09-16, after 审查员's gate)

These were in the v5 text and are **not** in V0. Each is a deliberate cut, not a silent omission.

| item | decision | why |
|---|---|---|
| §6 #2 `/cost` splits subrun tokens | **removed from V0**; tracked as V0.1. Broker ledger has no `run_id` column and `/cost` doesn't read the `x-sameroof-run` header. | The header is already sent; adding the column + `/cost` grouping is ~0.5 d and orthogonal to the safety story. Until then `doctor` shows policy-allowed tool counts per resident; token attribution is per resident, not per subrun. |
| §4.4 `类型: <kind>` and `rooms/<name>/subagents/*.md` personas | **deferred to V1**. `parseSubLine` does not accept `类型:`; `spec.kind` is only logged. Every subrun uses the parent's SOUL + the fixed overlay. | No user need surfaced in the first live runs. Adding it means a second prompt-composition path to test. |
| §4.3 `继承: N` = last N rendered **turns** | **contract changed to last N rendered lines** of the parent's recent-context block, capped at `inherit_max_chars`. | `room.js` builds `recentCtx` as a string, not a turn list; reconstructing turns would mean re-rendering the parent's shift. Lines are what the adapter actually has. |
| §4.5 `delivered_via_dm` record | **kept**: `noteDelivered` now appends a `delivered_via_dm` transcript row (67d5719); the in-memory Set is only a live convenience. | |
| §4.7 unsupported runtime "system note" | **kept, made visible**: the parent's public reply gets `（子任务未派出：本 runtime 不支持 / 未启用）` appended, plus stderr. | 审查员: stderr alone is not a note the human sees. |

Exit criteria: see §6 (renumbered after the `/cost` cut; all met). Cuts: see §6b Future work.
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

A subrun is not a resident and never appears in `/members`, the task board, or SSE presence. It **is** visible where the resident's actions are already visible: broker ledger (tagged `purpose=subagent`; per-resident, **not yet per-subrun** — see Future work), gateway intents, `output_read` audit rows and result DMs (all tagged `run_id=sub_…`), and its own transcript file.

## 3. Prerequisite: gateway `allow` + `core.exec.ro` (G1, G2) → separate RFC

Two distinct facts, kept distinct (审查员 G1):

1. **Technical gap** — `allow` is in the schema and implemented nowhere; the living room's result contract is keyed on `approval_id` (`server.js:450-480`), so a gateway that executes without approval has nowhere to deliver. The fix is `docs/rfc/2026-09-15-gateway-allow.md`: ceiling algebra `deny<approve<allow` with room-only-tightens, a new `core.exec.ro` action (existing bwrap: `--unshare-net` + `--ro-bind` roots + `writable_root_ids` forced empty), a `policy_allow` decision record, a living-room result contract that accepts a policy decision verified against the lock digest, `run_id` carried end to end, and a per-resident rate limit. **2.5 days, its own tests, its own gate.** v2's "living-room likely no change" was wrong; the RFC replaces it.

2. **Policy choice for this house** — 维护者 chose the read-only-sandbox tier on 2026-09-15 (see header). The 2026-09-08 `core.fs.read: approve` was the value picked while fixing a prompt/policy contradiction, not a strictness decision. The house file changes only after the RFC lands and 维护者 confirms the four-line policy in its §2.2.

Exit criterion 1 (§6) is therefore conditional on both, explicitly.

## 4. Design

### 4.1 Where it plugs in — a background manager beside `wake()`, not inside it (G3)

Facts from `lib/room.js`: each wake reads unread messages from `GET /inbox` only (`:205-209`) and acks those ids (`:372`); there is no adapter-side queue. `runOnce` wraps the entire `wake()` in a watchdog (`limits.run_timeout_ms`, `:190-197`) and holds `active` so only one run per resident exists at a time (`:169-185`). A post-turn phase inside `wake()` would extend that watchdog and block human messages for the subrun's duration. So:

**Directive** — `SUB:` is parsed where `PIN:` is parsed, stripped from the reply. The parent's turn then completes normally: reply posted, coordinator inbox acked, `active` released.

**Subrun manager** — a separate object owned by `run()`, outside `runOnce`:

- Own `AbortController` per subrun; own budget clock; `max_parallel` slots. Not covered by the wake watchdog.
- On `SIGTERM`: abort all subruns, wait ≤ 5 s, then let the adapter exit. Transcript lines already written stay.
- While a subrun runs, `requestWake('human', …)` proceeds as today — the parent can talk. A subrun never holds `active`.
- The manager writes to the **adapter-local durable mailbox** (below) and calls `requestWake('agent', 'subresult')` when a subrun reaches a terminal state.

**Adapter-local durable mailbox** — `rooms/<name>/state/mailbox.jsonl`, append-only:

```
{ id, ts, kind: 'subresult', sub_id, status, summary, usage, tool_calls, consumed: false }
```

- Written atomically (tmp + rename of the whole file is acceptable at this size; or append + fsync). Written **before** `requestWake`.
- At the start of `wake()`, after `GET /inbox`, the adapter reads unconsumed mailbox items and renders them into the same inbox block the model sees, labelled `【子任务结果】` — distinct from coordinator messages; **not** faked as a `dm` with `from_id=self`, so hop counting, mention logic and DM visibility rules are untouched.
- **Consumption point, per exit of `wake()`** (the coordinator ack at `room.js:372` happens *before* the reply is dispatched, so "same point as ack" was wrong):

  | exit | when the mailbox item becomes `consumed` |
  |---|---|
  | `(静默)` | immediately after the ack — the model saw it and chose silence |
  | `DM:` | after `POST /dm` returns 200 |
  | `APPROVAL:` | after the living room's `POST /approval` returns an `approval_id` (`room.js:381-387`) — **not** after `registerIntent`; the gateway can register while the living room rejects, and the result would otherwise be lost |
  | `/say` | after `POST /say` returns 200 |
  | think error / abort / crash | **not** consumed → replayed next wake |

  Each consumption write also records `{ sub_id, attempted_at, exit }` in the mailbox item. On replay, the render adds "（上一轮已尝试处理：<exit>）" so the model knows it may have already spoken.

  Guarantee, stated honestly: **at-least-once presentation, best-effort idempotent publication.** A crash after `/say` 200 and before the consumed write replays the item; the model may say a second, shorter follow-up. Duplication is preferred to loss (审查员 D1). "At-most-once consumption" is **not** claimed.
- A wake triggered by `subresult` with an empty coordinator inbox is still a wake: the model is asked to act on the results. `(静默)` is allowed.
- On startup the manager scans `state/subruns/*.jsonl` for transcripts without a terminal line and writes an `interrupted` mailbox item for each, **listing every gateway `request_id` the transcript shows as registered**, and requests a wake. It does **not** re-run those tool calls: they may have executed (the gateway's `request_id` is unique and its audit is authoritative). As **read-only diagnosis**, the manager issues at most one bounded batch of `getIntent` calls (≤ `max_startup_probe`, default 10) to annotate each request_id's terminal state in the `interrupted` item — "3 of 4 tool calls had executed"; if the gateway is unavailable the states are `unknown` and the item is still written. The parent decides whether to `SUB:` again; a new subrun gets new request ids.

Why not the coordinator: subresults are the resident's own working memory, not household communication. Routing them through `/dm` to self would make them visible to humans as chatter and subject to hop limits. The gateway results *are* routed through the coordinator (§4.5) — that is the human-visible audit.

### 4.2 The subrun loop — `lib/subagent.js`

A self-contained, testable module. Signature:

```js
runSubagent({
  brief,            // { task, constraints?, success?, refs: [{kind:'message'|'file', ref, text?}] }
  system,           // resolved system prompt (see 4.4)
  inherit,          // [] or one message holding the parent's last N rendered LINES (see 4.3)
  tools,            // subset of ['core.fs.read','core.exec.ro'] — each must resolve to `allow` for this resident
  budget,           // { modelCalls: 15, toolCalls: 20, ms: 600000 }
  model,            // async (messages, signal) => { text, usage }   — ONE-SHOT, see below
  gateway,          // { registerIntent, getIntent } bound to the parent's gateway token
  runId,            // 'sub_' + id, generated by the manager; passed to every intent
  signal, log
}) => { status: 'ok'|'budget'|'timeout'|'error'|'interrupted', summary, transcript, usage, toolCalls }
```

**`model` is not the parent's `think()` (G4).** In `broker-direct/adapter.js`, `think = wrapThink(call, shift)` — every call appends to the resident's persistent shift (`state/shift-<id>.jsonl`), which is exactly the context the subrun must stay out of. The adapter exports a second function, `callOnce(messages, signal, { purpose })`, that hits the broker with the same token, model and parameters but **no shift**: the subrun owns its own `messages` array. Broker side: tokens carry `purposes` (default `['interactive']`, `store.js:212`) and the proxy rejects a request whose `x-sameroof-purpose` is not in the token's list (`:293`). So the parent's broker token must be issued with `purposes: ['interactive', 'subagent']` for `SUB:` to work. Issuance is **explicit** (`brokerctl token issue … --purposes interactive,subagent`, or `serve` when a room has `subagent.enabled`); the broker never widens an existing token from room config (审查员 D3). An existing token without the purpose fails closed with a clear subresult; the transcript records the 403. Rotation keeps the previous token file as `.bak` as `brokerctl` already does.

Loop: render prompt → `model()` → if reply has `TOOL: <action> <json>` lines, register each intent with `run_id: sub_<id>`, poll `GET /v1/intents/:id` until `state` is terminal, then read the output from `GET /v1/intents/:id/output` (RFC §2.3b; `X-Sameroof-Run` binding header), **append it to the transcript and fsync before** building the next model call, then append it as the next user message → repeat until reply has no `TOOL:` lines (that reply is the summary) or a budget trips.

`getIntent` deliberately returns `[output omitted]` for stdout/stderr/content (`gateway/server.js:474-484`); the loop **never** presents that string as a result. If `/output` returns 404/409/410, the tool result fed to the model is `output_unavailable: <code>` and the loop continues. The 3-read cap is a crash-retry margin: a crash between read and fsync loses that read (one of three); on restart the loop does **not** resume — the subrun becomes `interrupted` (§4.1) and the parent may `SUB:` again, which registers new intents. Possibly-executed actions are never re-run automatically. If `truncated: true`, the tool result is prefixed `[truncated: N of M bytes]` so the model cannot report a partial list as complete. Tests assert all three: real `grep` lines reach the next prompt verbatim; a redacted secret does not; a truncated output is labelled. Every model call and tool call is appended to `transcript` (JSONL) as it happens, so a killed subrun still leaves evidence.

The loop **refuses** `TOOL:` actions that are not in `tools` or whose effective permission is not `allow` — a background worker never blocks on a human. The adapter's allowlist is a convenience, **not the security boundary**: the gateway re-evaluates ceiling, root, action and rate limit on every intent regardless of what the adapter believed (RFC §2.3, §2.6). The refusal is reported in the summary ("needed core.fs.write — approve-only, not available to subruns") so the parent can escalate through its own `APPROVAL:` line.

No `SUB:` inside a subrun: the system prompt doesn't offer it and the parser is not wired. Depth = 1, structurally.

### 4.3 Context: zero by default, inherit by explicit count

- **Default**: the subrun sees `system` (4.4) + `brief` + `refs`. Not the room, not the parent's history, not memory.
- `引用:` — `msg_<id>` → the adapter looks up that message in its own recent-context buffer (it has the text; the coordinator is not asked) and inlines it; a path → **not** inlined by the adapter (it has no file access either); the subrun reads it via `TOOL: core.fs.read` if allowed.
- `继承: N` — the adapter includes the last N **lines** of its own rendered recent-context block (the string it built for `think()` this wake), capped at `subagent.inherit_max_chars`. This is the fork mode. Snapshot is taken at spawn time from data the adapter already holds — the coordinator is never asked to reconstruct anything. (Lines, not turns: `room.js` holds recent context as a rendered string.)
- `带上:` is **required non-empty** unless `继承:` is given. An empty brief is a parse error with a system-message hint, not a spawn.

### 4.4 Persona

The subrun's system prompt = the parent's `SOUL.md` + a fixed overlay (who you are a subrun of, the `TOOL:` syntax, the allowlist, the budget, the summary rule). There is one persona: the parent's. Specialised personas are Future work.

### 4.5 Credentials and attribution — the three domains

| domain | subrun uses | attribution |
|---|---|---|
| coordinator | nothing (no `/say`, no `/dm`, no tasks) | — |
| broker | parent's token, unchanged alias/model scope; token must include purpose `subagent` | headers `x-sameroof-purpose: subagent`, `x-sameroof-run: sub_<id>` are sent; the ledger records `purpose` but **has no `run_id` column** — attribution is per resident (Future work) |
| gateway | parent's token, `run_id: sub_<id>` on every intent; only `core.fs.read` / `core.exec.ro` (both must be `allow`) | audit rows carry `run_id` + `decision_source=policy_allow`; `getIntent` scoped to the token's resident, which is the parent — correct. Gateway enforces independently of the adapter's allowlist. |

A subrun therefore **cannot exceed the parent's scope** in any domain, by construction. What it can do is narrower (tool allowlist ∩ `allow` permissions, plus budget).

Gateway results for subrun intents still get posted to the living room and DM'd to the parent (today's path, extended by the RFC to carry `meta.run_id`, `meta.request_id`, `meta.decision`).

**Contract B — the result DM can arrive before the subrun's first poll.** A policy-allowed intent executes on the gateway's queue and `deliverResult`s at the end of `executeClaimed`; the living room pushes it over SSE immediately. `room.js:428-430` turns every `kind=result` addressed to this resident into a `human`-lane **interrupt**. If the subrun's poll set were the filter, a fast result would interrupt the parent's turn and land in its prompt — exactly the leak the design exists to prevent. So the filter cannot depend on "already polled". Instead:

1. **Before** calling `registerIntent`, the loop pre-generates `request_id` (`gateway-client.newRequestId()` exists) and the manager **persists** `{ sub_id, request_id, registered_at, state: 'pending' }` to `state/subruns/<sub_id>.jsonl` with fsync. Only then is the intent registered. (If the process dies between persist and register, the record is a dangling `pending` that the gateway never saw — startup diagnosis marks it `never_registered` via a 404 from `getIntent`.)
2. The manager keeps an in-memory index of all such records for live subruns, **rebuilt from the transcripts at startup** (a delayed delivery after a restart must not wake the parent either).
3. The filter is applied in **both** places a result can enter: `onMessage` (SSE, `:428`) and the `GET /inbox` read at the top of `wake()`. Rule: `m.kind === 'result'` **and** `m.meta.request_id` is in the index → it belongs to a subrun: ack it, record `delivered_via_dm` on the subrun record, **no wake, no interrupt, not rendered**. Anything else — including a `result` whose `run_id` looks like `sub_…` but whose `request_id` is unknown — is a normal gateway result and wakes the parent as today.
4. The subrun loop still learns terminal state by polling `getIntent` and reads content from `/output`; the DM is not its data path. If the DM arrived first, the poll simply returns terminal on the first try.

Tests (contract): (a) force delivery before the first poll (mock gateway resolves synchronously) — parent not interrupted, result not in parent prompt, subrun still gets output; (b) a human message arrives while a subrun is running — the human wake proceeds and is not interrupted by the subrun's result; (c) restart with a live subrun, then a late result DM — filtered from the transcript-rebuilt index; (d) unknown `request_id` with a `sub_` prefix — wakes the parent normally.

The `run_id` and `request_id` are vouched for by the gateway (RFC §2.5); the prefix is never the test (G4).

The DM remains in the human's fold-out with `decision: policy` — this is the "process is auditable, only the summary enters the parent's context" property, using the existing mechanism.

### 4.6 Budgets and failure

`house.yaml` / `room.yaml`:

```yaml
subagent:
  enabled: false                 # default off; a room opts in
  max_parallel: 2
  budget: { model_calls: 15, tool_calls: 20, minutes: 10 }
  tools: [core.fs.read, core.exec.ro]   # allowlist; each must resolve to `allow` (house ceiling ∧ room)
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
| `claude-code` | `SUB:` not supported by this adapter; the line is dropped and a system note says so. (Claude Code has its own `Agent` tool with a mid-turn loop; whether and how it's exposed to the model in this runtime is that runtime's business, not asserted here.) |
| `pi` | same: not supported by this adapter. pi's agent-loop API has not been read; no claim about native capability. |

V0 is broker-direct only. That is where our own house's long-running residents live.

### 4.8 What the human sees

- Console: the parent's reply ("正在查"), then gateway `result` fold-outs tagged `sub_…` as the subrun works, then the parent's follow-up with the conclusion. No new UI element in V0. A later console change can group `sub_` results under the parent message.
- `/cost`: per resident; a subrun's tokens are counted under its parent (no per-subrun split in V0).
- Files: `rooms/<name>/state/subruns/sub_<id>.jsonl` — full transcript.

## 5. Estimates (after the RFC lands)

| piece | where | estimate |
|---|---|---|
| 1. `callOnce` export (no shift), token purpose `subagent` in `serve` + deploy token issuance | `broker-direct/adapter.js`, `cli` | 0.5 d |
| 2. `lib/subagent.js` loop: prompt render, `TOOL:` parse, gateway register + poll + `/output` read-once, `output_unavailable` / truncation handling, budgets, refusal, transcript append-as-you-go | `packages/adapters` | 1.25 d |
| 3. subrun manager: slots, abort, SIGTERM, startup scan + bounded read-only probe; **pre-registration persist + request_id index (rebuilt at startup) + filter in `onMessage` and `/inbox` read**; local durable mailbox (write, render, per-exit consume incl. APPROVAL-after-living-room, replay with attempt marker); `SUB:` parse | `packages/adapters/lib/room.js` + new `lib/mailbox.js`, `lib/subrun-manager.js` | 2 d |
| 4. `subagent:` schema block | `packages/schema` | 0.25 d |
| 6. demo: parent asked "找出所有调 recall() 的地方" → subrun runs `grep -rn` under `core.exec.ro` → parent replies with the list; human sees policy-allowed results in fold-outs; fault injection: kill adapter mid-subrun, expect `interrupted` next wake | `examples/` + tests | 0.75 d |

**5.25 days** after the RFC's 3.75 → **9 days total**, then a gate each. Existing `room.js` seam tests: unchanged; new tests are additive. Not a promise that no existing test changes — the mailbox read at wake start touches the prompt assembly path, and the seam tests assert on prompt shape; if they break, that's a finding to report, not to paper over.

## 6. Exit criteria for V0 (all met, 2026-09-16)

1. ✓ A broker-direct resident with `subagent.enabled` and `core.fs.read: allow` + `core.exec.ro: allow` can be asked "找出所有调 `recall()` 的地方" and, without any human click, replies within budget with a list that matches `grep -rn`. Live on this house: 检索员, 29 hits / 6 files = ground truth (`examples/subagent/`).
2. ✓ Every gateway `output_read` / result DM for a subrun carries `run_id: sub_…` and `decision_source: policy_allow`.
3. ✓ Killing the adapter mid-subrun produces an `interrupted` mailbox item and a wake on restart; the transcript is intact; nothing re-executes; a human message during a subrun is answered without waiting. **Process-level**: `subagent-lifecycle.test.js` (real adapter child, SIGKILL and SIGTERM, bounded shutdown with a hung handover model call).
4. ✓ A `SUB:` line from a `claude-code` / `pi` resident is dropped with a visible note in the public reply (`（子任务未派出：本 runtime 不支持）`). Not unit-tested.
5. ✓ CI runs all of this on a real gateway (bwrap).
6. ✓ A `result` DM whose `request_id` is not in the manager's index wakes the parent normally (no false silence) — even if its `run_id` looks like `sub_…`.
7. ✓ The subrun's transcript shows tool output came from `/output`; a forced 410 produces `output_unavailable` and the parent is told.
8. ✓ Contract B (a)–(d): result before first poll; human not blocked; late delivery after restart filtered; unknown wakes.
9. ✓ A living-room `POST /approval` failure (500, or 200 without `approval_id`) after a successful `registerIntent` leaves the mailbox item unconsumed with an attempt marker; it is re-presented next wake (`mailbox-consumption.test.js` exit-#10 case, via a controllable proxy).

Removed from V0 (was #2): `/cost` splits a subrun's tokens from its parent's — see Future work.

## 6b. Future work (not in V0; do not describe as current behaviour)

- **V0.1 — per-subrun cost**: broker ledger gains a nullable `run_id` column filled from `x-sameroof-run`; `/cost` groups by it. ~0.5 d.
- **V1 — specialised personas**: `类型: <kind>` selecting `rooms/<name>/subagents/<kind>.md`, whose frontmatter may narrow tools/budget but never widen. Same shape as Claude's `.claude/agents/*.md`.
- **V1 — inherit by turns** instead of lines, if the adapter ever holds recent context as structured turns.
- **Later — cross-resident delegation with reply obligations, worker rosters, dynamic scaling**: the coordinator-layer feature 审查员 specified; builds on top of subruns, not instead of them.

## 7. Rejected alternatives

**7.1 Dynamic resident instances (v1 of this doc).** Modelled a subrun as `resident_x#suffix`. Rejected for the eight reasons in 审查员's review: ID validation across four packages, static member table, task-state semantics, seven per-resident state files, gateway identity, no production supervisor, parser at the wrong layer, one-line context. All eight stem from choosing "new resident" as the unit; none apply to "nested loop in the parent".

**7.2 Fixed worker pool as coordinator residents (审查员 V0).** Safe and buildable, but it validates the wrong thing: that isolated execution is useful — which the three harnesses already prove daily — rather than that *our* mechanism is right. It also has the wrong shape for the stated need: a worker resident is a peer with its own inbox and queue, shared across parents, blocking when busy, and requiring config + restart to scale. It is a reasonable **V1-plus** for cross-resident delegation; it is not the answer to "I want to send a helper out and get a conclusion back."

**7.3 Mid-turn tool loop in the parent.** The three harnesses' actual shape. Rejected for V0 because it changes the `think()` contract for every runtime and moves the parent from "one request per wake" to "many"; the watchdog, incremental-context, and prompt-caching logic in `room.js` all assume one. Worth revisiting once `core.js` replaces `room.js`.

## 8. Open items (no blocking questions)

- Contract B's pre-registration persist adds one fsync per tool call. Acceptable for V0; measure in the demo.
- Whether `max_startup_probe` should be per-subrun or global. Global for V0.
