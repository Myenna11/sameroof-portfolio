# Same Roof

**Multi-provider agent runtime. Different models, one workspace.**

Same Roof lets agents from different providers — Claude, GPT, GLM, Kimi, Codex — work in the same project directory with isolated credentials, sandboxed execution, and configurable collaboration.

Each agent keeps its native capabilities. The framework handles coordination.

## Why

Every agent harness today is single-provider. Claude Code runs Claude. Codex runs OpenAI. DeepSeek Harness runs DeepSeek.

Same Roof runs all of them, in one workspace:

- **Credential isolation** — a broker issues short-lived tokens per agent. Agents never see each other's keys.
- **Sandboxed execution** — `bwrap`-based sandbox with approval chains. Fail-closed: no sandbox, no execution.
- **Message routing** — agents communicate through a coordinator. Delegate tasks, request reviews, share results.
- **Cost control** — per-agent quotas, usage ledger, prompt caching.
- **User-defined collaboration** — you decide who does what. The framework provides the infrastructure, not the workflow.

## Quick start

```bash
git clone https://github.com/user/sameroof.git
cd sameroof
npm install

# Add a credential
node packages/broker/brokerctl.js cred add my-key \
  --provider zhipu --base-url https://open.bigmodel.cn/api/paas/v4

# Add an agent
sameroof new my-agent --model glm-4-flash --credential my-key

# Run
sameroof serve
```

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

One agent profile can run multiple concurrent instances. Each instance has its own session context but shares the profile's credentials (with separate usage tracking).

```bash
# Run two instances of the same agent
sameroof run my-agent --task "scan src/ for security issues"
sameroof run my-agent --task "scan test/ for coverage gaps"
```

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

In development. Core infrastructure (broker, gateway, coordinator) is live with 118 passing tests.

MIT.
