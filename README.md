# Same Roof

**Multi-provider agent runtime. Different models, one workspace.**

Same Roof lets agents from different providers — Claude, GPT, GLM, Kimi, Codex — work in the same project directory. A broker scopes API access per agent, a gateway runs approved commands in a sandbox, a coordinator carries messages and tasks between them. How they collaborate is yours to configure.

Single-machine, self-hosted, single-tenant, prototype. What each part enforces — and what it doesn't — is stated precisely below and in [Status](#status). This is not a zero-trust runtime.

## Why

Vendor-native harnesses (Claude Code, Codex, DeepSeek Harness) are built around one model ecosystem. General harnesses (Aider, OpenCode) let you switch provider per session. Same Roof is about something narrower: several agents on *different* providers, running *at the same time*, in *one* workspace, under one control plane — with the credential scope, the approvals, and the message history in one place.

What that buys you:

- **Scoped API access** — for agents on the `broker-direct` runtime, the broker holds the real keys and issues each agent a short-lived token bound to specific credential aliases and model ids. A cross-scope call is refused (`MODEL-NOT-ALLOWED`). Agents on `claude-code` / `pi` runtimes use those CLIs' own credential stores, outside broker scope.
- **Sandboxed, approved commands** — actions that go through the gateway (`core.exec`, `core.fs.*`) require an approval and run in a fresh `bwrap` (no network, read-only root, explicit writable mounts). No gateway process → those actions fail; there is no unsandboxed fallback. Native CLI runtimes can do whatever their CLI can do; that is not gated here.
- **Message routing** — agents communicate through a coordinator: broadcast, directed message, task dispatch. Directed messages are visible to humans in the console.
- **Cost accounting** — per-token request/token budgets and a ledger in the broker; prompt-cache-friendly context ordering in the adapter.
- **User-defined collaboration** — you decide who does what, in each agent's `SOUL.md`. The framework provides channels, not workflows.

Not provided today: process-compromise containment for the coordinator and adapters (they run as root in the shipped systemd units), multi-instance agents, provider protocol translation. See [Status](#status).

## Quick start

Requires Node 22+, Linux, `bubblewrap` (for the gateway). No git remote yet — clone from wherever you got this tree.

```bash
npm ci
alias sameroof="node $PWD/packages/cli/index.js"      # or npm link packages/cli

# 1. a workspace anywhere (not inside this repo)
sameroof init ~/my-workspace
cd ~/my-workspace

# 2. a credential in the broker (key goes in the command; see brokerctl for stdin/file input)
sameroof cred add zhipu-key --provider zhipu \
  --base-url https://open.bigmodel.cn/api/paas/v4 --api-key sk-...

# 3. an agent and yourself     (model is provider/id)
sameroof new reviewer --model zhipu/glm-4-flash --credential zhipu-key
sameroof new me --human
sameroof check

# 4. run: broker + coordinator + one adapter process per agent
sameroof serve
# → http://127.0.0.1:8790/console   token: sameroof pair me
```

Then, from another shell, with the token from `sameroof pair me`:

```bash
curl -X POST http://127.0.0.1:8790/dispatch \
  -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \
  -d '{"to":"reviewer","task":"Say hello in five words."}'
curl "http://127.0.0.1:8790/history?limit=5" -H "Authorization: Bearer <token>"
```

No API key? `node examples/code-review/demo.js` runs coordinator + two adapters + broker against the broker's built-in mock upstream, and asserts on delegation and task state. (It does not start the gateway; nothing in that demo executes commands.)

## Architecture

```
┌─────────────────────────────────────────────────────┐
│  User / CLI / Console                               │
└──────────────────────┬──────────────────────────────┘
                       │ HTTP + SSE
┌──────────────────────▼──────────────────────────────┐
│  Coordinator   say / dm / dispatch · task board ·   │
│                approval broadcast · durable inbox   │
└──────┬───────────────┬───────────────┬──────────────┘
       │ SSE           │ SSE           │ SSE
  ┌────▼─────┐   ┌─────▼────┐    ┌─────▼────┐
  │ agent A  │   │ agent B  │    │ agent C  │      each agent = one adapter process
  │ broker-  │   │ broker-  │    │ claude-  │      (lib/room.js)
  │ direct   │   │ direct   │    │ code CLI │
  └──┬────┬──┘   └──┬────┬──┘    └────┬─────┘
     │    │         │    │            │
     │    └────┐    │    └──────┐     │  (native CLI: its own creds, its own tools —
     │         │    │           │     │   not through broker, not through gateway)
  ┌──▼─────────▼────▼──┐   ┌────▼─────▼───────────────┐
  │  Credential Broker │   │  Execution Gateway       │
  │  scoped tokens     │   │  approval → bwrap → result│
  │  ledger, budgets   │   │  fail-closed             │
  └──────────┬─────────┘   └──────────────────────────┘
             │
        upstream model APIs (OpenAI-compatible)
```

Two independent paths. **Broker** is the model path: an agent's token decides which upstream alias and model it may call. **Gateway** is the execution path: an `APPROVAL:` line from the agent becomes a request the human decides on, then bwrap runs it. Neither path knows about the other; the coordinator only carries the messages that trigger them.

## Key concepts

**Workspace** (`house.yaml`) — project-level config: timezone, default permissions, credential aliases, notification targets.

**Agent profile** (`rooms/<name>/room.yaml`) — per-agent config: model provider, credential, permissions, runtime type. One profile = one running process today (multi-instance is planned, see below).

**Credential broker** — manages API keys for multiple providers. Issues short-lived opaque tokens to agents. Tracks usage per agent per day.

**Execution gateway** — runs commands in `bwrap` sandboxes. File reads go through path rules without a subprocess. Every action requires an approval (user-granted or pre-configured). No gateway = no execution, never silent fallback.

**Coordinator** — routes messages between agents and humans. Manages the task board (pin, claim, complete). Broadcasts approval requests.

## Agent collaboration

Same Roof provides the channels. How agents collaborate is up to you.

```yaml
# In an agent's system prompt or SOUL.md:
# "When you finish writing code, ask 审查员 to review it."
# "If you're unsure about the approach, delegate to 规划员."
```

Agents can:
- **Send messages** to other agents via the coordinator (`/say`, `DM:`)
- **Delegate tasks** by pinning items to another agent's board (`PIN: … | 给: name`) — the coordinator @mentions the owner, which wakes it
- **Request approvals** for gateway actions (`APPROVAL: core.exec {…}`)

Whatever pattern you configure, the same limits apply: a broker-direct agent's model calls stay inside its token scope, and a gateway action never runs without an approval. Those two properties don't depend on the collaboration pattern — and they are the only two the framework enforces.

## Multi-instance

**Planned, not implemented.** The broker already issues per-token scope and accounting, so two instances of one profile would get separate ledgers — but there is no `sameroof run` command and the coordinator has no notion of instance identity beyond `resident_id`. Today: one profile, one process.

## Packages

| Package | What it does |
|---|---|
| `broker` | Multi-provider credential management, token issuance, usage ledger |
| `gateway` | bwrap sandbox execution, approval chain, file operations |
| `living-room` | Message routing, task board, approval broadcast, SSE |
| `adapters` | Agent runtime adapters (broker-direct API, claude-code CLI, pi) |
| `schema` | YAML config validation for workspace and agent profiles |
| `cli` | `sameroof` command-line tool |
| `quota` | Per-agent token quota management |
| `jcs` | RFC 8785 JSON canonicalization (used in approval verification) |
| `plugin-memory` | Optional: persistent agent memory with review queue |

## Status

Prototype. Test count is whatever `npm test` prints — don't trust a number in a README.

| | |
|---|---|
| broker (scoped tokens, ledger, mock upstream) | works, tested |
| gateway (bwrap, approval digest, single-use decisions) | works, negative-tested |
| coordinator (say/dm/dispatch, task board, SSE, durable inbox) | works, tested |
| adapters | `lib/room.js` ships; `lib/core.js` is experimental and unused |
| CLI `init/cred/new/check/lock/serve` | works from a clean directory |
| console | first pass; approval details are real, styling isn't |
| memory | append-only + review queue stable; vector retrieval experimental |
| process isolation | broker + gateway hardened; coordinator + adapters run as root |
| multi-instance, provider protocol translation | not implemented |

Known gaps with code pointers: `docs/ARCHITECTURE.md` → Failure Modes. Design rationale and what we'd do differently: `docs/DESIGN_DECISIONS.md`. Most recent external review: `docs/reviews/`.

MIT.
