# Design Decisions

Key decisions made in Same Roof, with rationale. Use this to prepare for interview questions like "why did you design it this way?" and "what alternatives did you consider?"

---

## 1. Multi-provider, not single-provider

**Decision**: Support multiple LLM providers simultaneously, not just one.

**Why**: Vendor-native harnesses centre on one model ecosystem; multi-provider harnesses like Aider or OpenCode switch provider per session but still run one agent. The gap Same Roof targets is *concurrent* heterogeneous agents in one workspace — an expensive model for judgment and a cheap one for bulk work, running side by side, under one ledger and one approval flow. The broker makes the model path transparent for `broker-direct` agents; native CLI agents keep their own path.

**Alternative considered**: Wrapping all providers into a unified API (like LangChain). Rejected because it strips native capabilities — Claude's tool use works differently from GPT's, and abstracting that away loses fidelity.

**Interview answer**: "The broker is an OpenAI-compatible proxy with per-agent scope and accounting. For providers that aren't OpenAI-compatible, the runtime talks to them directly — `claude-code` and `pi` runtimes do that. I don't have a universal protocol translator and I'm not claiming one."

---

## 2. Infrastructure layer, not orchestration framework

**Decision**: Provide channels for collaboration, don't prescribe workflows.

**Why**: Every team's workflow is different. One team wants A→B→C pipelines, another wants agents consulting each other ad hoc. Hardcoding either pattern would limit adoption. Users define collaboration in SOUL.md and room.yaml — zero framework code changes.

**Alternative considered**: Building a visual workflow editor (like n8n / Dify). Rejected for v1 — it's a product feature, not infrastructure. Can be added later on top of the base.

**Interview answer**: "We provide the channels — messaging, task board, dispatch. How agents collaborate is configured by the user, not coded in the framework. Adding a workflow layer later is a product decision, not an architecture change."

---

## 3. Three-layer isolation: broker + coordinator + gateway

**Decision**: Separate credential management, message routing, and execution into three independent processes.

**Why**: separate responsibilities, separate auth, separate failure modes. Each layer can be reasoned about, tested, and restarted on its own.

**What it does and doesn't buy you today** (be precise here — this is where a security-minded interviewer will push):
- Broker and gateway run as dedicated users with `ProtectSystem=strict`. A compromised broker leaks API keys but can't run commands or read the gateway token. A compromised gateway gets its user's file permissions (rooms/ writable), not a sandbox — bwrap wraps *child commands*, not the gateway service.
- The coordinator and adapters currently run as **root** with no systemd hardening. A compromised coordinator can read everything. This is a deployment gap, not a design property.
- `sameroof serve` runs broker + coordinator in one process. Dev convenience; no isolation.

**Alternative considered**: Single monolithic process. Rejected because it makes the *responsibility* boundaries invisible in code, even before you get to process isolation.

**Interview answer**: "Three services, three auth domains, three failure modes. The broker and gateway are contained today; the coordinator isn't yet — it's on the list. I'd rather say that than claim a zero-trust story the unit files don't back up."

---

## 4. Fail-closed gateway

**Decision**: If the gateway process is not running, agents cannot execute any operations. No silent fallback.

**Why**: Silent fallback is how security incidents happen. "The sandbox was down so we ran it without a sandbox" is exactly the sentence you never want in a post-mortem.

**Alternative considered**: Graceful degradation — allow read-only operations without sandbox. Rejected because the boundary between "safe reads" and "unsafe operations" is context-dependent and too easy to get wrong.

**Interview answer**: "Fail-closed means the absence of security infrastructure is itself a denial, not a degradation. This is a deliberate design choice — we'd rather have a visible failure than an invisible vulnerability."

---

## 5. DM = directed delivery, not private communication

**Decision**: DMs between agents are only delivered to the target agent (reducing noise), but users can see all DMs through a fold-out UI element and the admin message stream.

**Why**: Agents work for the user. The user should have full visibility into what agents are doing. But broadcasting every agent-to-agent message to all agents would pollute their context windows and waste tokens.

**Alternative considered**:
- Fully private DMs (like human chat). Rejected — creates a black box where agents negotiate without oversight.
- Fully public (everything in the broadcast). Rejected — N agents sending DMs creates O(N²) noise.
- Configurable visibility per workspace. Rejected — overengineering. The fold-out pattern handles both use cases without configuration.

**Interview answer**: "DMs reduce noise, not add secrecy. Users see everything through fold-outs in the UI, same interaction pattern as tool-call expansion. The admin stream shows the complete timeline."

---

## 6. Adapter core ≤ 150 lines, everything else is plugins

**Decision**: The adapter core only does: connect SSE → receive message → call think() → post response. Heartbeat, cron, memory, task board are all optional plugins.

**Why**: The core should be boring and correct. Every feature added to the core is a feature that can break the message loop. Plugins can crash independently without taking down the adapter.

**Plugin hooks**: onWake, onMessage, beforeThink, afterThink, onSleep — five hooks cover all extension points.

**Status**: `core.js` exists, has 7 tests (serial queue, plugin isolation, timeout, chained hooks), and **nothing in production uses it**. All three shipping runtimes still run on the monolithic `room.js`. The migration is planned, not done.

**Alternative considered**: Keep evolving the monolithic `room.js`. It works and has months of real use; it's also where every known reliability gap lives. `core.js` is the attempt to not carry those forward.

**Interview answer**: "I have two adapter implementations and I'm not proud of that. The old one ships and has the bugs I've documented; the new one has the shape I want and isn't wired in yet. If you ask me what I'd do with another week, it's finishing that migration."

---

## 7. Append-only memory with review queue

**Decision**: Memory writes are append-only. Updates are patches appended to the same file. Human-written memories are protected — agents can propose changes but humans must approve.

**Why**:
- Append-only means you never lose data — worst case is duplicates, not deletions.
- Hand-authored protection prevents an agent from overwriting a fact the human explicitly stated.
- Review queue gives humans control without blocking agent operation.

**Alternative considered**: Mutable database (SQLite). Rejected because append-only is simpler, portable (just a file), and naturally supports audit trail.

**Retrieval status**: 2-gram overlap is the stable path. Vector retrieval (embedding + cosine, with unindexed-candidate fallback and atomic index writes) exists and is tested against a local HTTPS mock, but there is no `/v1/embeddings` route in the broker yet, so in a real deployment the embedding call goes direct to a provider, not through the broker's credential scope. Treat it as **optional/experimental** until that route exists.

**Interview answer**: "Memory is append-only JSONL with a review queue and hand-authored protection. Retrieval is 2-gram by default; vector retrieval is wired and tested but I'd call it experimental until embeddings go through the broker like chat does."

---

## 8. Remote = self-hosted, no third-party relay

**Decision**: Same Roof runs on your own server. Remote access via any HTTP tunnel (Cloudflare Tunnel, ngrok, etc.), not through our relay.

**Why**:
- Claude Code's remote mode routes the *control plane* (your commands, your file contents, the agent's output) through Anthropic's relay. Codex cloud routes it through OpenAI.
- Same Roof's control plane — coordinator messages, task board, approvals, console — is HTTP + SSE on your own host. There is no relay operated by us.
- **This is not "data doesn't leave the network."** For `broker-direct` agents, model prompts (with whatever context the adapter assembled) go to the configured upstream — Anthropic, OpenAI, Zhipu, SophNet. For `claude-code` / `pi` agents, the CLI's own auth, updates, telemetry and tool network access happen outside Same Roof's control; the gateway does not mediate them. The boundary you get: the *coordinator's* traffic stays on your host, and for broker-direct agents you choose the upstream per agent. Nothing more than that is enforced.

**Alternative considered**: Building a relay service (like Claude Code's polling architecture). Deferred — adds operational cost and a trust dependency. Users who want relay can run their own.

**Interview answer**: "The control plane is yours: messages, tasks, approvals, the console — on your host, no relay through us. Broker-direct agents send prompts to the upstream you configured for them. Native CLI agents have their own network behaviour that I don't constrain. I'm not claiming an egress boundary; I'm claiming you can see and choose what the framework itself sends where."

---

## How to use this in interviews

When asked "walk me through your architecture", pick 2-3 of these and go deep:
1. Start with the three-layer isolation (#3) — it's the backbone
2. Follow with multi-provider (#1) — it's the differentiator
3. End with one detail that shows depth — fail-closed (#4) or DM visibility (#5)

When asked "what would you do differently", be honest:
- Two adapter implementations; the shipping one has the known reliability gaps listed in ARCHITECTURE.md (ack-before-deliver, no client timeouts, no inbox catch-up on reconnect)
- Coordinator and adapters run as root in the systemd deployment; only broker and gateway are hardened
- Vector memory retrieval doesn't go through the broker yet
- Console is a first-pass control surface: token in localStorage, `style-src 'unsafe-inline'` still on
- Task claim has no optimistic lock
- CI (`.github/workflows/ci.yml`) has: all package tests, `sameroof check`, `lock --check`, `git diff --check` (commit + whole tree, on a depth-2 checkout), the canonical mock demo with assertions, and a fresh-workspace `serve → dispatch → reply → shutdown` smoke. It has **never run on GitHub** — the repo has no remote yet; every step was executed locally by hand.
