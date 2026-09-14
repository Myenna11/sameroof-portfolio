# Design Decisions

Key decisions made in Same Roof, with rationale. Use this to prepare for interview questions like "why did you design it this way?" and "what alternatives did you consider?"

---

## 1. Multi-provider, not single-provider

**Decision**: Support multiple LLM providers simultaneously, not just one.

**Why**: Every existing harness (Claude Code, Codex, dsh) locks you into one provider. Real teams want to use expensive models for judgment and cheap models for bulk work. Our broker makes this transparent — agents don't know they're going through a proxy.

**Alternative considered**: Wrapping all providers into a unified API (like LangChain). Rejected because it strips native capabilities — Claude's tool use works differently from GPT's, and abstracting that away loses fidelity.

**Interview answer**: "We don't abstract away provider differences. Each agent talks to its provider natively. The broker handles auth and accounting transparently."

---

## 2. Infrastructure layer, not orchestration framework

**Decision**: Provide channels for collaboration, don't prescribe workflows.

**Why**: Every team's workflow is different. One team wants A→B→C pipelines, another wants agents consulting each other ad hoc. Hardcoding either pattern would limit adoption. Users define collaboration in SOUL.md and room.yaml — zero framework code changes.

**Alternative considered**: Building a visual workflow editor (like n8n / Dify). Rejected for v1 — it's a product feature, not infrastructure. Can be added later on top of the base.

**Interview answer**: "We provide the channels — messaging, task board, dispatch. How agents collaborate is configured by the user, not coded in the framework. Adding a workflow layer later is a product decision, not an architecture change."

---

## 3. Three-layer isolation: broker + coordinator + gateway

**Decision**: Separate credential management, message routing, and execution into three independent processes.

**Why**: Defense in depth. If any one layer is compromised, the other two still hold.
- Broker compromised → attacker has API keys, but can't execute commands (gateway) or impersonate agents (coordinator tokens are separate)
- Coordinator compromised → attacker can read messages, but can't call APIs (no keys) or execute (no sandbox access)
- Gateway compromised → attacker can execute in sandbox, but sandbox is network-isolated and filesystem-restricted

**Alternative considered**: Single monolithic process. Rejected because a single vulnerability would compromise everything.

**Interview answer**: "No single compromise gives you everything. Each layer has its own auth, its own process boundary, its own failure mode."

---

## 4. Fail-closed gateway

**Decision**: If the gateway process is not running, agents cannot execute any operations. No silent fallback.

**Why**: Silent fallback is how security incidents happen. "The sandbox was down so we ran it without a sandbox" is exactly the sentence you never want in a post-mortem. Borrowed from Gemini's execution boundary design.

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

**Alternative considered**: Monolithic adapter (the original room.js at 492 lines). Still works, but harder to explain, harder to test, harder to extend.

**Interview answer**: "The core is so simple it's hard to get wrong. New capabilities are plugins — write beforeThink to inject context, write onMessage to filter. Zero changes to core code."

---

## 7. Append-only memory with review queue

**Decision**: Memory writes are append-only. Updates are patches appended to the same file. Human-written memories are protected — agents can propose changes but humans must approve.

**Why**: 
- Append-only means you never lose data — worst case is duplicates, not deletions.
- Hand-authored protection prevents an agent from overwriting a fact the human explicitly stated.
- Review queue gives humans control without blocking agent operation.

**Alternative considered**: Mutable database (SQLite). Rejected because append-only is simpler, portable (just a file), and naturally supports audit trail.

**Interview answer**: "Memory is append-only JSONL. Agent writes are pending until human approves. Retrieval uses vector similarity with 2-gram fallback. It's a lightweight RAG pipeline — same architecture, different data source."

---

## 8. Remote = self-hosted, no third-party relay

**Decision**: Same Roof runs on your own server. Remote access via any HTTP tunnel (Cloudflare Tunnel, ngrok, etc.), not through our relay.

**Why**: 
- Claude Code routes through Anthropic's servers. Codex cloud routes through OpenAI. Your data passes through a third party.
- Same Roof is pure HTTP + SSE on your own infrastructure. You choose how to expose it.
- For enterprises, "data doesn't leave our network" is often a hard requirement.

**Alternative considered**: Building a relay service (like Claude Code's polling architecture). Deferred — adds operational cost and a trust dependency. Users who want relay can run their own.

**Interview answer**: "Data sovereignty. Your agents, your server, your data. We don't see it, we can't see it. Expose it however you want — Cloudflare Tunnel for zero-config, or nothing at all for pure local use."

---

## How to use this in interviews

When asked "walk me through your architecture", pick 2-3 of these and go deep:
1. Start with the three-layer isolation (#3) — it's the backbone
2. Follow with multi-provider (#1) — it's the differentiator  
3. End with one detail that shows depth — fail-closed (#4) or DM visibility (#5)

When asked "what would you do differently", be honest:
- The adapter layer has two implementations (core.js and room.js) — ideally there'd be one
- CLI doesn't fully work end-to-end yet — sameroof serve starts services but adapter auto-start needs work
- No CI/CD pipeline — tests run locally only
- Frontend needs a full rebuild for the new direction
