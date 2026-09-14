# Architecture

Same Roof is a multi-provider agent runtime. This document explains how the pieces fit together.

## Overview

```
┌─────────────────────────────────────────────────────────────┐
│                     User / CLI / API                        │
└──────────────────────────┬──────────────────────────────────┘
                           │  HTTP + SSE
┌──────────────────────────▼──────────────────────────────────┐
│                     Coordinator                             │
│                                                             │
│  Message routing    Task board      Approval broadcast      │
│  /say /dm /dispatch /tasks          /approval               │
│  SSE push           PIN/claim/done  approve/deny            │
│  History            Due dates       Gateway results         │
│                                                             │
└──┬──────────────┬──────────────┬──────────────┬─────────────┘
   │              │              │              │
   │   SSE        │   SSE        │   SSE        │
   │              │              │              │
┌──▼───┐    ┌─────▼────┐   ┌────▼────┐   ┌────▼────┐
│Agent │    │  Agent   │   │  Agent  │   │  Human  │
│  A   │    │    B     │   │    C    │   │         │
│      │    │          │   │         │   │  (Web/  │
│Claude│    │   GPT    │   │   GLM   │   │  Mobile)│
└──┬───┘    └─────┬────┘   └────┬────┘   └─────────┘
   │              │              │
   │  API call    │  API call    │  API call
   │              │              │
┌──▼──────────────▼──────────────▼────────────────────────────┐
│                   Credential Broker                         │
│                                                             │
│  Token issuance     Multi-provider     Usage ledger         │
│  per-agent tokens   routing            per-agent-per-day    │
│  short-lived        any OpenAI-compat  cost tracking        │
│  rotate/revoke      endpoint           quota enforcement    │
│                                                             │
└──────────────────────────┬──────────────────────────────────┘
                           │
              ┌────────────┼────────────┐
              ▼            ▼            ▼
         Anthropic     OpenAI       Zhipu/Qwen
         (Claude)      (GPT/Codex)  (GLM/Qwen)
                    ... any provider

┌─────────────────────────────────────────────────────────────┐
│                   Execution Gateway                         │
│                                                             │
│  bwrap sandbox      Approval chain     Fail-closed          │
│  per-request        user must approve  no gateway = no exec │
│  isolation          before execution   never silent fallback│
│                                                             │
│  File read: path rules, no subprocess                       │
│  File write: sandboxed, approved                            │
│  Shell exec: bwrap --unshare-user --unshare-net             │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

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

Manages API keys for multiple providers. Agents never touch raw keys.

- **Token issuance**: each agent gets a short-lived opaque token scoped to specific credentials
- **Multi-provider routing**: Anthropic, OpenAI, Zhipu, Moonshot, or any OpenAI-compatible endpoint
- **Usage ledger**: tracks tokens consumed per agent per day, stored in SQLite
- **Quota enforcement**: per-agent daily limits on requests and tokens
- **Rotation**: credentials can be rotated without restarting agents

Key design decision: the broker is a transparent proxy. It forwards API requests to the upstream provider, adding auth headers. Agents send standard OpenAI-format requests; the broker translates if needed.

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

## Design Decisions

1. **Coordinator is passive**: it routes messages but never executes actions. Execution is always in the gateway sandbox.

2. **Broker is transparent**: it proxies API requests, adding auth. Agents don't know they're going through a broker.

3. **Gateway is fail-closed**: no gateway = no execution. Never silent fallback. This is borrowed from Gemini's approach.

4. **Agents keep native capabilities**: Claude Code agent uses `claude` CLI natively. GPT agent uses OpenAI API natively. The framework doesn't wrap or abstract away provider-specific features.

5. **Collaboration is configurable, not coded**: how agents work together is defined in SOUL.md and room.yaml, not in framework source code. Adding a new collaboration pattern requires zero framework changes.

6. **Multi-instance by design**: one agent profile can run multiple instances with separate session contexts but shared credentials (with independent usage tracking).

## Comparison

| | Claude Code | Codex | dsh | Same Roof |
|---|---|---|---|---|
| Providers | Claude only | OpenAI only | DeepSeek (pluggable) | Any, simultaneously |
| Multi-agent | No | No | Subagent (parent-child) | Peer collaboration |
| Credential isolation | N/A | N/A | Single user | Per-agent broker tokens |
| Sandbox | Built-in | Built-in | Plugin | bwrap + approval chain |
| Remote | Anthropic relay | WebSocket app-server | Local | Self-hosted HTTP + SSE |
| Data routing | Through Anthropic | Through OpenAI (cloud) or direct (CLI) | Local | Self-hosted, no third party |
