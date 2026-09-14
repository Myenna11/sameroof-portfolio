# Same Roof

**Multi-provider agent runtime. Different models, one workspace.**

Same Roof lets agents from different providers — Claude, GPT, GLM, Kimi, Codex — work in the same project directory with isolated credentials, sandboxed execution, and configurable collaboration.

Single-machine, self-hosted, single-tenant. Prototype quality: see [Status](#status) for what's real and what isn't.

## Why

Every agent harness today is single-provider. Claude Code runs Claude. Codex runs OpenAI. DeepSeek Harness runs DeepSeek.

Same Roof runs all of them, in one workspace:

- **Credential isolation** — a broker issues short-lived tokens per agent. Agents never see each other's keys.
- **Sandboxed execution** — `bwrap`-based sandbox with approval chains. Fail-closed: no sandbox, no execution.
- **Message routing** — agents communicate through a coordinator. Delegate tasks, request reviews, share results.
- **Cost control** — per-agent quotas, usage ledger, prompt caching.
- **User-defined collaboration** — you decide who does what. The framework provides the infrastructure, not the workflow.

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

No API key? `node examples/code-review/demo.js` runs the whole stack against the broker's built-in mock upstream.

## Architecture

```
┌─────────────────────────────────────────────────┐
│  User / CLI / API                               │
└──────────────────────┬──────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────┐
│  Coordinator (message routing, task board,       │
│               approval broadcast, SSE)           │
└───┬──────────────┬──────────────┬───────────────┘
    │              │              │
┌───▼───┐    ┌─────▼────┐   ┌────▼────┐
│Agent A│    │ Agent B  │   │Agent C  │
│Claude │    │ GPT/Codex│   │ GLM     │
│(native│    │ (native  │   │(native  │
│ CLI)  │    │  API)    │   │ API)    │
└───┬───┘    └─────┬────┘   └────┬────┘
    │              │              │
┌───▼──────────────▼──────────────▼───────────────┐
│  Credential Broker                               │
│  (multi-provider token issuance, usage ledger)   │
└──────────────────────┬──────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────┐
│  Execution Gateway                               │
│  (bwrap sandbox, approval chain, fail-closed)    │
└─────────────────────────────────────────────────┘
```

## Key concepts

**Workspace** (`house.yaml`) — project-level config: timezone, default permissions, credential aliases, notification targets.

**Agent profile** (`rooms/<name>/room.yaml`) — per-agent config: model provider, credential, permissions, runtime type. One profile can run multiple instances.

**Credential broker** — manages API keys for multiple providers. Issues short-lived opaque tokens to agents. Tracks usage per agent per day.

**Execution gateway** — runs commands in `bwrap` sandboxes. File reads go through path rules without a subprocess. Every action requires an approval (user-granted or pre-configured). No gateway = no execution, never silent fallback.

**Coordinator** — routes messages between agents and humans. Manages the task board (pin, claim, complete). Broadcasts approval requests.

## Agent collaboration

Same Roof provides the channels. How agents collaborate is up to you.

```yaml
# In an agent's system prompt or SOUL.md:
# "When you finish writing code, ask 审查员 to review it."
# "If you're unsure about the approach, delegate to 规划员."
# "For repetitive file scanning, spawn a GLM sub-instance."
```

Agents can:
- **Send messages** to other agents via the coordinator
- **Delegate tasks** by pinning items to another agent's board
- **Request approvals** for privileged operations
- **Spawn sub-instances** of any configured agent profile

The framework ensures credential isolation and sandbox enforcement regardless of collaboration pattern.

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
