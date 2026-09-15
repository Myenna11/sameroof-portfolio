# Subagents — three implementations read from source, and a design for Same Roof

- Author: 规划员
- Date: 2026-09-15
- Status: **design for review**, nothing implemented
- Reviewer requested: 审查员

## 0. Why we want this

Not for the interview. We (维护者 + the agents in her workspace) hit this daily: one agent gets a task that needs a long, noisy sub-job (grep a repo, run a test suite, read twenty files) and either does it inline — polluting its own context with tool dumps — or hands it to a *peer* via `PIN:`, which works but has the wrong shape: the peer is a different persona with its own SOUL, its own ongoing conversation, and no obligation to report back in a form the delegator can consume.

What we want is the thing every single-agent harness now has: **spawn a scoped worker, get a conclusion back, keep my own context clean.** The question is how to add it to a *peer* coordinator without breaking the peer model.

## 1. What the three do — from code, not docs

Sources actually read (commit / version, paths):

| | Version | What I read |
|---|---|---|
| Claude Code | `@anthropic-ai/claude-code@2.1.210` (Bun-compiled binary) | `sdk-tools.d.ts` (`AgentInput`, `AgentOutput`, `TaskOutputInput`, `TaskStopInput`); `strings` of the binary for the Agent tool's system prompt and fork guidance |
| Codex | `openai/codex@fc269b6` (2026-09-15) | `codex-rs/ext/agent/src/lib.rs`, `core/src/thread_manager.rs::spawn_subagent`, `core/src/tools/handlers/multi_agents_spec.rs`, `agent-graph-store/src/{store,types}.rs`, `config/src/config_toml.rs` |
| Kimi Code | `MoonshotAI/kimi-code@486dcd2` (2026-09-15) | `packages/agent-core-v2/src/agent/tools/agent/{agentTool.ts,agent.ts,agent.md,agent-fork.md,subagent-task.ts}`, `app/agentProfileCatalog/profile-shared.ts`, `session/subagent/configSection.ts`, `features/tower/tools/spawn/spawn.md`, `features/tower/tools/send/send.md` |

### 1.1 Claude Code

**Tool shape** (`AgentInput`): `description`, `prompt`, `subagent_type?`, `model?`, `run_in_background?` (default **true**), `name?` (makes it addressable via `SendMessage({to: name})`), `mode?` (permission mode), `isolation?: "worktree" | "remote"`.

**Context inheritance**: two regimes, stated verbatim in the prompt the binary ships:
> Any agent other than a fork starts with zero context.
> (except subagent_type: "fork", which inherits your context)

A non-fork child gets **only the prompt**. The system prompt then spends a paragraph teaching the parent to brief well ("like a smart colleague who just walked into the room… Explain what you're trying to accomplish and why. Describe what you've already learned or ruled out."). Fork inherits the parent's messages (`forkContextMessages`) and the parent's model, and the prompt becomes "a *directive* — what to do, not what the situation is."

**Result path**: "When the agent is done, it will return a single message back to you. **The result returned by the agent is not visible to the user.**" Parent must re-summarize. Background completion "arrives as a user-role message in a later turn". Explicit anti-patterns in the prompt: **"Don't peek"** (an `outputFile` exists but the parent is told not to read it mid-flight — "pulls the fork's tool noise into your context, which defeats the point"), **"Don't race"** (never fabricate the child's result), **"Trust but verify"** ("an agent's summary describes what it intended to do, not necessarily what it did").

**Lifecycle**: `TaskOutput(task_id, block, timeout)` to wait; `TaskStop(task_id)` to kill; resume "with the agent's ID or name to continue a previously spawned agent with its context intact". Agent types come from `.claude/agents/*.md` frontmatter (model, reasoning effort, tools). Parallel = multiple `Agent` tool calls in one assistant message. `isolation: "worktree"` gives the child its own git worktree, auto-cleaned if untouched. "Agent teams" (`teammateId`, `name@team`, tmux/iTerm2 panes) are a separate, longer-lived layer.

**Limits**: not recoverable from strings (depth/concurrency are likely in code, not prompt text). One SDK-context note: "run_in_background, name, and mode parameters are not available in this context. Only synchronous subagents are supported."

### 1.2 Codex

Two generations coexist behind `multi_agent_v2`.

**Tool shape v1** (`spawn_agent_common_properties_v1`): `message | items`, `agent_type?`, **`fork_context?: bool`** ("True forks the current thread history into the new agent; **false or omitted starts with only the initial prompt**"), `model?`, `reasoning_effort?`.

**Tool shape v2**: `message`, `agent_type?`, **`fork_turns?: "none" | "all" | N`** — "**Defaults to `all`**". So v2 flipped the default: the child inherits the whole parent history unless told otherwise.

**Mechanics**: `ThreadManager::spawn_subagent(parent_id, opts)` reads the parent thread **with history**, calls `fork_history_from_snapshot(ForkSnapshot::Interrupted, …)`, and starts a new thread with that as `initial_history`. Every child is a real thread in the same store as the parent. The **parent/child topology is persisted** (`AgentGraphStore::upsert_thread_spawn_edge(parent, child, Open|Closed)`, `list_thread_spawn_descendants`), so the graph survives restarts and is queryable.

**Result path (v2)**: mailbox model. `send_input` delivers to a running agent at message boundaries; **`wait_agent`** "waits for a mailbox update from any live agent… **Does not return the content**; returns a summary of which agents have updates"; the parent then reads. `close_agent` closes the child *and any open descendants*. Key rule from the tool description: **"Completed agents remain open and count toward the concurrency limit until closed."** `interrupt` stops a turn but keeps the agent.

**Config** (`config_toml.rs`): `max_concurrent_threads_per_session` (alias `max_threads`), `max_depth` (**v1 only; ignored by v2**), `default_subagent_model`, `default_subagent_reasoning_effort`. Child inherits parent model by default ("sub-agents that inherit your current model by default. Do not set the `model` field unless the user explicitly asks"). Agent roles = TOML files with a config layer + nickname candidates.

### 1.3 Kimi Code

**Tool shape** (`SubagentToolInputSchema`, zod): `prompt`, `description`, `subagent_type?` (default `coder`), `resume?` (agent id), `run_in_background?` ("**Prefer false** unless the task can run independently"), `fork?` (behind `SUBAGENT_FORK_FLAG_ID`, experimental), `model?` (alias from a pool, or `"primary"`).

**Context inheritance**: zero by default, same wording lineage as Claude Code (`agent.md`: "The subagent starts with zero context — it has not seen this conversation. Brief it like a colleague who just walked into the room"). `fork: true` = "a snapshot of this agent's **completed** conversation history… inheriting this agent's agent type, tool set, and model"; with fork, `subagent_type` must match the parent's and `model` must be the parent's or `"primary"`.

**Execution**: "The subagent runs as a **same-process loop instance** with its own context and wire file." `SubagentTask` wraps a `completion: Promise<{result, usage, stopReason}>` and an `AbortController`; the parent's abort propagates. Repeat-breaker: if the child issues the same tool call repeatedly it is stopped and its output labelled "a handoff, not a finished result".

**Depth**: enforced structurally, not by a counter. `subagentAllowlistFor()` computes which profiles a caller may spawn; `withoutDelegatingTargets()` **removes from that list any profile that itself possesses the `Agent` or `AgentSwarm` tool**. So a child that could delegate is not spawnable → depth is 1 unless the catalog is explicitly `['*']`.

**Model**: a **`[secondary_model]` pool** is enabled by default — subagents run on a cheaper configured model unless `"primary"` is requested. Default timeout **2 h** (`DEFAULT_SUBAGENT_TIMEOUT_MS`).

**Beyond subagents — "tower"**: a separate feature layering *peers* on top: a roster of long-lived workers/reviewers, each in its own **git worktree**, briefed from **mission files**, with `TowerInbox` / `TowerSend` (to a name, `"tower"`, or `"all"`) as a mailbox, and a merge gate that diffs the worker's branch against a snapshot of the parent's WIP. Workers are spawned as background subagents but "you never need the agent's return value inline; its output flows back through the tower protocol files." This is the closest thing to Same Roof's coordinator inside a single-agent harness.

## 2. Comparison on the axes that matter for us

| | Claude Code | Codex v1 → v2 | Kimi Code | **Same Roof today** |
|---|---|---|---|---|
| child's starting context | **zero** unless `subagent_type:"fork"` | v1 zero unless `fork_context`; **v2 all** unless `fork_turns` | **zero** unless `fork` (experimental) | peer: its own full history, none of the delegator's |
| who sees the child's result | parent only; parent re-summarizes for user | parent (mailbox) | parent only | everyone (`/say`) or delegator+humans (`DM`) |
| sync or async | async by default; `run_in_background:false` to block | mailbox + `wait_agent`; never blocks a turn | **sync by default**; background opt-in | always async — a `PIN:` never blocks |
| child lifetime | resumable by id until stopped | **stays open (counts against limit) until `close_agent`**; graph persisted | resumable by id; parent abort cascades | permanent resident |
| depth | n/a from strings | v1 `max_depth`; v2 none | **structural**: a delegating profile can't be a target | n/a |
| concurrency | n/a from strings | `max_concurrent_threads_per_session` | timeout 2 h | n/a |
| child's model | override per call; fork inherits | inherits parent by default | **cheaper pool by default** | fixed per profile (`room.yaml`) |
| child's identity | `.claude/agents/*.md` frontmatter | agent-roles TOML | profile catalog | `room.yaml` + `SOUL.md` |
| credentials | CLI's own store | CLI's own store | CLI's own store | broker token, scoped per resident |
| isolation | `worktree` / `remote` | sandbox per command | tower: worktree per worker | bwrap per approved command |
| "trust but verify" | told to the parent in prose | — | repeat-breaker labels output as handoff | task board `result` + gateway audit log = evidence the human can read |

Three things stand out:

1. **Zero-context is the industry default** (Claude, Codex v1, Kimi). Codex v2 flipping to "all" is the outlier, and its own tool description hedges with `fork_turns:N`. My original instinct — "the parent writes `带上:` explicitly" — is the mainstream choice, not a shortcut.
2. **Nobody shows the child's result to the human directly.** All three route it to the parent, who is told to re-summarize. Same Roof's DM visibility rule (humans see all DMs via fold-out) would make us the *only* one where the human can read the raw sub-result. That is a feature, not a bug — it's exactly the "trust but verify" evidence Claude Code asks the parent to produce.
3. **Codex keeps children open and persists the graph; Claude/Kimi treat them as resumable tasks.** For a coordinator with a task board, Codex's model maps cleanly: a child is a task with a `parent` edge; "done" ≠ "closed".

## 3. Design for Same Roof

### 3.1 Vocabulary

- **Profile**: `rooms/<name>/room.yaml` + `SOUL.md`. Unchanged.
- **Resident**: today = one profile = one process = one `resident_id`. Unchanged for peers.
- **Instance**: a running process of a profile. Today every resident has exactly one, implicit. A **sub-instance** is an additional instance started by another resident, identified as `resident_logic_01#a3f2` (profile id + short suffix).

Sub-instances share the profile's SOUL, model, broker credential alias and ledger row (settled per instance, aggregated per profile), and permissions ceiling. They have their own process, own context, own inbox.

### 3.2 The spawn line

Agents already speak in trailing directive lines (`PIN:`, `DM:`, `APPROVAL:`). Add one:

```
SPAWN: <task, one line> | 带上: <context the child needs> | 类型: <profile name, optional> | 期限: <duration, optional>
```

- `带上:` is **required to be non-empty** unless `继承: 历史` (see 3.4). This is the zero-context default, enforced at parse time — a `SPAWN:` with an empty `带上:` is rejected with a system message telling the parent to brief.
- `类型:` defaults to the parent's own profile (a fork-shaped worker). Any other value must be in the parent's `spawn.allow` list (3.6).
- `期限:` defaults to `spawn.default_ttl` (proposal: 30 min — far below Kimi's 2 h, because our agents are talking to a human who is waiting).

### 3.3 What the coordinator does with it

1. Parse `SPAWN:` from the reply (same place `PIN:` is parsed).
2. Check the parent's spawn permission and concurrency (3.6). Refuse with a system message if not allowed.
3. Create a task: `origin: subagent`, `parent_instance: <parent id>`, `owner: <new instance id>`, `state: open`, `due: now + 期限`. **This task is the child's identity on the board**, exactly like Codex's persisted spawn edge.
4. Emit a `spawn` event on the coordinator's internal channel with `{instance_id, profile, task_id, brief: 带上}`.
5. `serve` (the process manager) receives the event, spawns `adapter.js <profile> --instance <suffix> --task <task_id>`, issues a broker token for the instance (same alias/model scope as the profile; the ledger row carries the instance id).
6. The child's first inbox contains one synthetic DM from the parent: the task line + the `带上:` block. Nothing else.

### 3.4 Context inheritance — two modes, zero is default

- **Default (zero)**: child sees SOUL + the `带上:` block + the task. Not the parent's history, not the room's history. `context.recent_messages` is forced to 0 for the instance.
- **`继承: 历史`** (fork): child's initial context = the parent's last N turns as rendered by the parent's adapter (the same `recent context` block the parent's own `think()` saw). N = `spawn.fork_turns`, default 10. With fork, `类型:` must equal the parent's profile (Kimi's rule — a fork that changes persona is incoherent).

Not in v1: forking *another* agent's history, forking room history, reading the parent's memory plugin. Codex v2's "all" default is explicitly rejected — our parents run for hours and days; "all" would be tens of thousands of tokens per spawn.

### 3.5 Result path and visibility

- Child finishes by `PIN <task_id>: done <result>` — same as any task. Or `drop <reason>`.
- On `done`/`drop`/`blocked` of a subagent task, the coordinator **DMs the parent instance**: `你的子任务 task_xxx 完成：<result>`. That DM wakes the parent (human lane, like any DM). The parent sees the result in its next `think()`.
- Because it is a DM, **humans see it in the console fold-out**. This is where we deliberately differ from all three: the raw sub-result is inspectable by the person, not only by the parent. The task board row shows `parent`, `result`, and links to the gateway audit log if the child executed anything.
- No `wait_agent` / `TaskOutput(block)`. Parents never block. If a parent needs the result before continuing, it says so and goes idle; the DM wakes it. (Codex v2's "never blocks a turn" is the model; Claude's `run_in_background:false` is the anti-model for a coordinator with many residents.)
- Optional: `SPAWN: … | 回报给: <name>` sends the completion DM to a different resident (e.g. the human) instead of the parent. Off by default.

### 3.6 Lifecycle, limits, permissions

- **Exit**: child process exits after `done`/`drop`. Its transcript and memory (if enabled) persist under `rooms/<profile>/instances/<suffix>/`. This is Claude/Kimi "resumable task" shape, not Codex "stays open". Rationale: an idle process costs a broker token slot and RAM; a persisted transcript costs nothing.
- **Resume**: `SPAWN: <task> | 继续: <instance id>` starts a new process that loads the persisted transcript as initial context. v2; not required for the first cut.
- **TTL**: `serve` kills the child at `due`; coordinator marks the task `blocked: timeout` and DMs the parent. Default 30 min.
- **Concurrency**: `spawn.max_children` per parent (default 2) and `spawn.max_instances` per profile (default 3). Counted from open subagent tasks on the board, not from processes — same as Codex ("count toward the limit until closed"), but "closed" for us is `done`/`drop`/`blocked`.
- **Depth**: **structural, Kimi's way.** A sub-instance's adapter is started with `--no-spawn`; the `SPAWN:` parser rejects lines from any instance id containing `#`. No counter to get wrong.
- **Permission**: `house.yaml` / `room.yaml`:
  ```yaml
  spawn:
    mode: deny | allow | approve     # default deny
    allow: [profile, profile]        # 类型: targets; default [self]
    max_children: 2
    max_instances: 3
    default_ttl: 30m
    fork_turns: 10
  ```
  `approve` routes the spawn through the existing approval flow (coordinator broadcasts to the human, gateway-style). This is the one place we are stricter than all three: none of them ask the human before spawning.
- **Broker**: instance tokens carry the instance id; ledger rows carry it; quota is enforced per profile (sum of instances). A runaway spawner burns its own profile's budget, not the house's.

### 3.7 What this does to the peer model

Nothing. A sub-instance is a resident that (a) has a `parent` field on its one task, (b) can't spawn, (c) exits when done. Message routing, DM visibility, task board, approval — all unchanged. `PIN:` between peers keeps working exactly as today. The coordinator gains one parser branch and one auto-DM rule; `serve` gains a spawn listener and a TTL reaper; `room.js` gains an `--instance` flag that changes the id and forces `recent_messages: 0`.

### 3.8 Not doing

- Worktree / filesystem isolation per instance (Claude `isolation:"worktree"`, Kimi tower). Our isolation is per command via the gateway; per-instance FS scoping is a gateway feature and a separate design.
- Per-spawn model override. If you want a cheap worker, make a cheap profile and `类型:` it. (Kimi's secondary pool is nice; it's a profile-catalog feature for later.)
- `SendMessage` to a running child mid-flight. It has an inbox like any resident; a parent can `DM:` it. That's already true.
- Nested spawn. Structurally impossible in v1.

## 4. Work estimate

| piece | where | size |
|---|---|---|
| `SPAWN:` parse, permission/limit check, task with `parent`, spawn event, completion auto-DM, TTL → blocked | `packages/living-room` | ~250 lines + tests |
| spawn listener, `--instance` process launch, broker token per instance, TTL reaper, `--no-spawn` | `packages/cli` (serve) | ~120 lines + tests |
| `--instance` flag, forced `recent_messages: 0`, `继承: 历史` rendering, exit after done | `packages/adapters/lib/room.js` | ~80 lines + tests |
| schema for `spawn:` block | `packages/schema` | ~30 lines |
| ledger/quota by instance | `packages/broker` | ~40 lines |
| demo: parent spawns a grep-worker, gets a conclusion back, human sees the raw result in the fold-out | `examples/` | ~150 lines |

Two working days, then a review round. Everything is additive; no existing test should change.

## 5. Questions for 审查员

1. **Zero-context default vs Codex v2's "all"** — I'm going with zero + explicit `带上:` + opt-in fork of N turns. Do you see a case where our parents (long-lived, human-facing) would be better served by all-history default?
2. **Exit-after-done vs stay-open** — Codex keeps children open until closed; I exit and persist the transcript. The cost of exit is that "ask the same child a follow-up" needs a resume path (v2). Is that acceptable for a first cut?
3. **`approve` mode for spawn** — none of the three ask the human before spawning. I've made it available but default `deny` (not `approve`). Should default be `approve` for humans-in-the-loop houses like ours?
4. **Counting concurrency from the task board, not processes** — matches Codex's semantics but means a crashed child whose task never reached a terminal state holds a slot until the TTL reaper runs. Acceptable, or count processes?
5. Anything in the three implementations I've misread. The Claude Code material is from binary strings and a `.d.ts`; I could not read its handler code.
