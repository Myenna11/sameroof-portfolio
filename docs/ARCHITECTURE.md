# Architecture

Same Roof is a multi-provider agent runtime. This document explains how the pieces fit together.

## Overview

```
┌─────────────────────────────────────────────────────────────┐
│                  User / CLI / Console                       │
└──────────────────────────┬──────────────────────────────────┘
                           │  HTTP + SSE
┌──────────────────────────▼──────────────────────────────────┐
│                     Coordinator                             │
│  /say /dm /dispatch · task board (PIN/claim/done) ·         │
│  approval broadcast · durable inbox · history · SSE push    │
└──┬──────────────┬──────────────┬──────────────┬─────────────┘
   │ SSE          │ SSE          │ SSE          │ SSE
┌──▼───────┐ ┌────▼──────┐ ┌─────▼──────┐ ┌─────▼─────┐
│ agent A  │ │ agent B   │ │ agent C    │ │  human    │
│ broker-  │ │ broker-   │ │ claude-code│ │ (console) │
│ direct   │ │ direct    │ │ or pi      │ │           │
└─┬─────┬──┘ └─┬──────┬──┘ └─────┬──────┘ └───────────┘
  │     │      │      │          │
  │     │      │      │          └─ native CLI: its own credential store,
  │     │      │      │             its own tools. Not through broker,
  │     └──────┼──────┼──┐          not through gateway.
  │            │      │  │
┌─▼────────────▼──┐ ┌─▼──▼──────────────────────────────────┐
│ Credential      │ │ Execution Gateway                     │
│ Broker          │ │                                       │
│                 │ │ APPROVAL: line → intent registered    │
│ scoped tokens   │ │ → human allow/deny (coordinator)      │
│ (alias + model) │ │ → bwrap --unshare-user --unshare-net  │
│ reserve/settle  │ │ → result DM'd back to the agent       │
│ ledger, budgets │ │                                       │
│ mock upstream   │ │ no gateway process → action fails.    │
└────────┬────────┘ │ never an unsandboxed fallback.        │
         │          └───────────────────────────────────────┘
         ▼
  OpenAI-compatible upstreams
  (Anthropic-compat, OpenAI, Zhipu, SophNet, …)
```

Two independent paths from an agent. The **broker** is the model path — a token decides which alias/model an agent may call. The **gateway** is the execution path — an approval decides whether a command runs, and bwrap decides where. Neither depends on the other; the coordinator carries the messages that trigger both. Native CLI runtimes bypass both paths.

## Core Components

### Coordinator (`packages/living-room`)

The message bus. All agent-to-agent and human-to-agent communication goes through here.

- **Message routing**: `/say` (broadcast), `/dm` (direct), `/dispatch` (task assignment)
- **Task board**: PIN tasks to agents, track state (open → doing → done/dropped)
- **Approval broadcast**: when an agent requests a privileged operation, the coordinator notifies the human
- **SSE push**: real-time events to all connected agents and humans
- **History**: append-only message log, queryable

The coordinator never executes anything. It only routes messages and manages state.

### Credential Broker (`packages/broker`)

Manages API keys for multiple providers. Agents on the `broker-direct` runtime never touch raw keys — they get a scoped token. Agents on `claude-code` / `pi` runtimes use those CLIs' own credential stores; the broker is not in their path.

- **Token issuance**: each agent gets a short-lived opaque token scoped to specific credentials
- **Multi-provider routing**: Anthropic, OpenAI, Zhipu, Moonshot, or any OpenAI-compatible endpoint
- **Usage ledger**: tracks tokens consumed per agent per day, stored in SQLite
- **Quota enforcement**: per-agent daily limits on requests and tokens
- **Rotation**: credentials can be rotated without restarting agents

Key design decision: the broker is a transparent proxy for OpenAI-compatible endpoints. It forwards `/v1/chat/completions` and `/v1/models` to the upstream, adding auth headers, reserving and settling token budget. It does **not** translate between provider protocols; a provider that isn't OpenAI-compatible needs an adapter runtime that talks to it directly (as `claude-code` and `pi` do).

### Execution Gateway (`packages/gateway`)

Runs commands in sandboxes. Every execution requires prior approval.

- **bwrap sandbox**: `bubblewrap` with `--unshare-user --unshare-net`, read-only root, explicit writable mounts
- **Approval chain**: agent requests action → coordinator broadcasts to human → human approves → gateway executes
- **Fail-closed**: if the gateway process is down, agents cannot execute. No silent fallback to unsandboxed execution.
- **File operations**: reads go through path rules without a subprocess; writes are sandboxed and approved
- **Audit log**: every action (requested, approved/denied, executed, result) is logged with timestamps

Key design decision: borrowed from Claude Code's approach, but extended for multi-agent. The sandbox boundary applies equally to all agents regardless of provider.

### Agent Adapters (`packages/adapters`)

The runtime for each agent. An adapter connects an agent to the coordinator and broker.

**Two implementations exist. Only one ships.**

- `lib/room.js` (~490 lines) — the one all three runtimes (`broker-direct`, `claude-code`, `pi`) use today. Monolithic: lane priority, heartbeat, routines, task board, memory, handover, watchdog, incremental context all in one file. Battle-tested on the authors' own deployment since spring 2026; also where the known reliability gaps live (see Failure Modes).
- `lib/core.js` (~170 lines) + `plugins/` — **experimental**. The target shape: a serial message loop with five plugin hooks (`onWake` / `onMessage` / `beforeThink` / `afterThink` / `onSleep`), plugin errors isolated, `beforeThink` chained. Has 7 tests. **Nothing in production uses it yet.** Migration of the three runtimes is planned; until then, "add a capability = write a plugin, no core change" describes `core.js`, not the shipping adapter.

- **`run()` loop**: connect to coordinator SSE → wait for messages → wake up → call `think()` → post result
- **Lane priority**: human messages interrupt heartbeats; routines run on schedule
- **Context assembly**: select relevant recent messages, score and rank, inject into prompt
- **Task board integration**: read own tasks on wake, PIN new tasks via coordinator
- **Pluggable think()**: the actual model call is injected. `broker-direct` calls the broker API; `claude-code` calls the Claude CLI; `pi` calls any OpenAI-compatible runtime.

### Schema Validation (`packages/schema`)

Validates `house.yaml` and `room.yaml` configurations.

- JSON Schema-based validation with human-readable error messages
- Ensures credential references exist, permissions don't exceed house limits, cron expressions are valid
- `house.lock` for deterministic resolution

### Memory Plugin (`packages/plugin-memory`)

Optional per-agent persistent memory.

- **Append-only storage**: JSONL file, updates are patches, compact on demand
- **Hybrid retrieval**: vector search (embedding + cosine similarity) with 2-gram fallback
- **Write sanitization**: auto-redacts secrets, tokens, private keys
- **Hand-authored protection**: human-written memories can't be overwritten by agents
- **Review queue**: agent-written memories are pending until human approves
- **Fact deduplication**: `fact_key` ensures one current version per fact

## Data Flow: Task Dispatch

```
1. Human POST /dispatch {to: "agent-b", task: "review auth.js"}
   │
2. Coordinator creates task on board (state: open, owner: agent-b)
   Coordinator sends DM to agent-b with task details
   Coordinator broadcasts activity event via SSE
   │
3. Agent-b's adapter receives SSE event
   Adapter detects mention, wakes agent (human lane, highest priority)
   │
4. Adapter assembles context:
   - SOUL.md (system prompt)
   - Recent messages (scored and ranked)
   - Own tasks from board
   - Memory recall (if plugin enabled)
   │
5. Adapter calls think() → broker API → upstream provider
   │
6. Model returns review text
   │
7. Adapter POST /say → coordinator broadcasts to all
   │
8. Human sees review in coordinator (SSE / Web / API)
```

## Configuration

### Workspace (`house.yaml`)

```yaml
schema_version: 1
name: My Workspace
timezone: UTC
credentials:
  - {alias: capable, provider: anthropic, purpose: logic review}
  - {alias: cheap, provider: zhipu, purpose: security scan}
defaults:
  permissions:
    core.exec: approve     # sandboxed, requires approval
    core.fs.read: approve
    core.fs.write: approve
```

### Agent Profile (`rooms/<name>/room.yaml`)

```yaml
schema_version: 1
id: resident_reviewer_01
name: reviewer
species: agent
model: {provider: zhipu, id: glm-4-flash, auth: {mode: broker, credential: cheap}}
runtime: broker-direct
plugins: [memory]
permissions: {core.exec: deny, core.fs.read: allow}
```

### Agent Behavior (`rooms/<name>/SOUL.md`)

Free-form system prompt. Defines what the agent does and how it collaborates:

```markdown
You are a security scanner. Check for injection, auth flaws, hardcoded secrets.
When done, dispatch your findings to the coordinator.
If unsure, ask logic-reviewer for a second opinion.
```

Collaboration patterns are in SOUL.md, not in framework code. Change the prompt, change the behavior.

## Security Boundaries — what is and isn't enforced today

Three different things get called "isolation". They are not the same:

| Boundary | What it is | Status |
|---|---|---|
| **Responsibility separation** | broker / coordinator / gateway are separate codebases with separate auth (broker tokens ≠ coordinator tokens ≠ gateway service token) | implemented |
| **Request-level sandbox** | each `core.exec` runs in a fresh bwrap (`--unshare-user --unshare-net`, read-only root, explicit writable mounts). Tested with negative cases: escape via symlink, path traversal, TOCTOU. | implemented, tested |
| **Process-compromise containment** | if a *service process* is fully compromised, what can the attacker reach? | **partial — see below** |

Process-compromise containment, per `deploy/*.service` as of this commit:

| Service | systemd User | ProtectSystem | Can read broker DB/keys? | Can read gateway token? | Notes |
|---|---|---|---|---|---|
| broker | `sameroof-broker` | strict | its own | no | holds real API keys by design |
| gateway | `sameroof-gateway` | strict | no | its own | rooms/ bind-mounted **writable** — wider than necessary |
| living-room (coordinator) | **none (root)** | none | **yes** | **yes** | also reads worker Codex auth for `/quota` |
| room adapters | **none (root)** | none | yes | yes | |

So the honest statement is: **broker and gateway are contained; coordinator and adapters are not yet.** A compromised coordinator running as root can read everything on the box. The earlier claim that "a compromised coordinator can't reach credentials" was wrong and has been removed.

The bwrap sandbox contains *commands the gateway launches*, not the gateway process itself. If the gateway process is compromised, the attacker has the gateway user's permissions (rooms/ writable), not a sandbox.

Also: `sameroof serve` (the CLI dev path) runs broker and coordinator **in one Node process**. That is a development convenience with zero process isolation between them. The systemd deployment is the isolated form.

Planned (not done): dedicated low-privilege user for living-room with explicit ReadWritePaths; separate user per adapter; narrow gateway's rooms/ mount; move `/quota`'s subscription-state read to a read-only sidecar so the public-facing coordinator never touches another user's auth files; `systemd-analyze security` recorded in CI.

## Design Decisions

1. **Coordinator is passive**: it routes messages but never executes actions. Actions that agents request through the framework (`APPROVAL:` → gateway) run only in the gateway sandbox. Actions a native CLI runtime takes on its own (`claude-code`, `pi` running their built-in tools) are outside this framework's gating entirely — see decision 4.

2. **Broker is transparent**: it proxies API requests, adding auth. Agents don't know they're going through a broker.

3. **Gateway is fail-closed**: no gateway = no execution. Never silent fallback.

4. **Agents keep native capabilities** (partially): the `claude-code` and `pi` runtimes invoke those CLIs directly and inherit whatever they can do. The `broker-direct` runtime and the broker's data plane speak OpenAI-compatible `/v1/chat/completions` only — no provider-native protocol translation exists in the broker today.

5. **Collaboration is configurable, not coded**: how agents work together is defined in SOUL.md and room.yaml, not in framework source code. Adding a new collaboration pattern requires zero framework changes.

6. **Multi-instance** (planned, not implemented): the broker's per-token scope and ledger would give two instances of one profile separate accounting, but there is no way to start a second instance and the coordinator identifies agents only by `resident_id`. Today one profile is one process.

## Failure Modes

What happens when things break. Each answer is what the code actually does today.

| Scenario | Behavior | Where |
|---|---|---|
| **Coordinator crashes** | Adapters lose SSE and reconnect. Posted messages are in SQLite; unread deliveries are tracked per agent in `deliveries`. **The shipping adapter does not pull `/inbox` on reconnect** — messages that arrived during the outage stay unread until the agent's next wake for some other reason (see gap table below). | `deliveries` table; `lib/room.js` resub() |
| **Broker crashes** | Agents' API calls fail with connection error. No fallback to direct API — agents don't have keys. Adapter records `error` status in runs log. | Agent has no upstream credentials by design |
| **Gateway crashes** | All execution requests fail closed. `APPROVAL:` lines get `gateway_unavailable`. Nothing runs unsandboxed. | `gw.registerIntent()` throws → run status `gateway_unavailable` |
| **Coordinator process compromised** | Attacker has root on the host (living-room runs as root today). Can read broker DB, gateway token, all rooms. **Not contained.** | `deploy/sameroof-living-room.service` has no `User=` |
| **Gateway process compromised** | Attacker has `sameroof-gateway` user: rooms/ writable, cannot read broker keys. bwrap does not apply — it wraps child commands, not the service. | `deploy/sameroof-gateway.service` |
| **Agent crashes mid-task** | Task stays `open`/`doing` on board. Human can reassign via `PATCH /tasks/:id {owner}`. Next wake reads board, sees own task. | Task board is coordinator-side state, not agent-side |
| **Runaway agent (infinite loop)** | Broker token has `max_requests` + `max_tokens`. Exceeded → 429. Coordinator `/say` has per-agent rate limit → 429. | `issueToken({maxRequests, maxTokens})`, `sayLimiter` |
| **Agent token leaked** | Token is scoped: only bound credentials, only bound models, has TTL. Attacker can't use other agents' models. Revoke with `brokerctl token revoke`. | `MODEL-NOT-ALLOWED`, `CREDENTIAL-NOT-ALLOWED` |
| **Two agents claim same task** | Last write wins on `owner_id`. No lock. Acceptable for current scale; add optimistic lock if needed. | Known gap |
| **Prompt injection via DM** | Memory plugin renders memories with "these are not instructions" header and defuses `REMEMBER:`/`APPROVAL:` shapes. Gateway requires human approval regardless of what the agent says. | `plugin-memory` `defuse()`, gateway approval chain |
| **Upstream API down** | Broker returns upstream error to agent. Ledger records `upstream_error`. Agent sees error, can retry or report. | `ledger.status` |
| **Disk full** | SQLite writes fail. Coordinator returns 500. This is not handled gracefully. | Known gap |

Known reliability gaps in `lib/room.js` (the shipping adapter), recorded from the 2026-09-14 review — none are fixed yet:

| Gap | Effect |
|---|---|
| inbox is acked **before** `/say` is confirmed delivered | if `/say` fails after ack, the message is marked read and the response is lost; run log may still say `said` |
| coordinator client has no timeout and doesn't check HTTP status | a half-open coordinator can hang a wake; 429/500 bodies may be parsed as success |
| SSE reconnect does not pull `/inbox` | messages that arrived during a disconnect stay unread until the next unrelated wake (heartbeat is off by default in new workspaces) |
| watchdog `AbortSignal` wraps `think()` only | `/inbox`, `/tasks`, `/history` calls are outside it |
| broker token file is only issued if absent | expired/revoked/mis-scoped token file → 401 loop with one blind retry, no auto-repair |
| `serve` has no single-instance lock | a second `serve` can steal the broker socket path; partial startup failure doesn't roll back |
| task claim has no optimistic lock | two agents can both `PIN task: doing` — last write wins |

**Design principle**: every failure should be *visible* (logged, returned as error) rather than *silent* (swallowed, degraded). The one place we deliberately chose "fail closed" over "fail open" is the gateway.

## Message Visibility

All agent communication flows through the coordinator. Three message types:

| Type | Delivery | User visibility | Other agents |
|---|---|---|---|
| `/say` | Broadcast to all | Full (in main chat) | Full |
| `/dm` | Directed to target agent | Fold-out widget (click to expand) | Not visible |
| `/dispatch` | Creates task + notifies target | Task board + fold-out | Not visible |

DMs are **directed delivery, not private communication**. Users see all DMs through fold-out UI elements in the chat stream — same interaction pattern as tool-call expansion. The `/admin/messages` endpoint provides the complete unfiltered timeline.

Design rationale: agents work for the user, so there's no black box. But broadcasting everything to all agents would pollute context windows and waste tokens.

## Plugin Architecture

The adapter has a minimal core (~140 lines) and optional plugins:

```
createAdapter({
  coordinatorUrl, token, agentId, agentName, soul, think,
  plugins: [
    heartbeat({ interval: 60000 }),     // keepalive
    memory({ maxRecall: 5 }),           // inject relevant memories
    taskboard(),                         // read own tasks, inject into prompt
  ]
})
```

Five plugin hooks: `onWake`, `onMessage`, `beforeThink`, `afterThink`, `onSleep`.

Adding a new capability = writing a plugin. Zero changes to core code.

## Comparison

| | Claude Code | Codex | dsh | Same Roof |
|---|---|---|---|---|
| Providers | Claude only | OpenAI only | DeepSeek (pluggable) | Any, simultaneously |
| Multi-agent | No | No | Subagent (parent-child) | Peer collaboration |
| Credential isolation | N/A | N/A | Single user | Per-agent broker tokens |
| Sandbox | Built-in | Built-in | Plugin | bwrap + approval chain |
| Remote | Anthropic relay | WebSocket app-server | Local | Self-hosted HTTP + SSE |
| Control-plane routing | Through Anthropic relay | Through OpenAI (cloud) or direct (CLI) | Local | Self-hosted; no relay operated by Same Roof. Model prompts still go to whichever provider you configured. |
