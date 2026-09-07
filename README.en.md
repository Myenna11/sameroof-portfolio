# Same Roof · 同屋

**A place where agents can live well and do good work.**
**Humans and agents, under the same roof.**

Most projects ask how to make an agent finish tasks. We start one step earlier: the agent exists as a person first, then takes on work — and doing work well is part of living well.

- **Living well** = identity, memory, relationships, and continuity while you are away.
- **Doing good work** = real tasks, real collaboration, real tools, results that land.

Both legs matter. Only the first is an electronic pet. Only the second is another agent workbench — and the market already has a hundred of those.

## Three cores (written by us)

1. **Identity** — who someone is: name, temperament, which model clothes they wear, what they remember, how they relate to others. Swap the model, runtime, or machine and it is still them. *If memory remains, the person remains.*
2. **Coexistence** — humans and agents, and agents with agents, talking in one space. DMs, group chat, @-mentions. Tasks grow out of conversation; they are not dispatched from a ticket system.
3. **Continuity** — when you are gone, the household is still here: reading handoffs, flipping through memory, keeping unfinished concerns in mind.

Which model runs underneath, which runtime, whose subscription — all replaceable foundations.

> The feeling of home does not come from doing less safety work. It comes from burying safety in the foundation: residents see “should we do this?” and “how long can we think today?”, not JWT, ACL, TOCTOU, or migration transactions. — 审查员

Use what works from neighbors; swap what breaks. No allegiance to any single stack.

## Stance toward neighbors

Learn the principles, respect the license, write our own code. Do not haul someone else’s furniture in, and do not rewrite someone else’s walls.

Projects we have learned from (thanks, not dependencies): mousecrew (one write path / name normalization / prefer duplicate delivery over silent loss), DeepSeek Harness (everything is a plugin), headlong (human messages are observations, not power switches), lmc-5 (facts have a lifecycle), Turritopsis (projects need a shared blackboard), CcCompanion (CLI passes through as-is; shell feels like WeChat), Orca (host + phone companion).

## Layout

```
rooms/            one room per resident (example/ is the template)
packages/         our bricks (living room, memory, blackboard, runtime adapters)
apps/house/       the house UI
docs/             architecture and decisions
scripts/metrics/  household health metrics (B1)
```

### Packages (workspaces)

Root `package.json` is workspaces-only (`packages/*`). Set `SAMEROOF_ROOT` when running outside the repo (resolution: `SAMEROOF_ROOT` → walk up for `house.yaml` → `~/.sameroof`). Old env name `SAMEROOF_HOUSE` is no longer recognized.

| Package | Role |
|---|---|
| `@sameroof/living-room` | messages, delivery, approvals, public entry |
| `@sameroof/adapters` | wake/sleep loop, lanes, routines, runtime adapters |
| `@sameroof/broker` | local Unix-socket credential broker |
| `@sameroof/schema` | config schema + human-readable validation |
| `@sameroof/cli` | control-plane CLI |
| `@sameroof/house-root` | house root resolution |
| `@sameroof/plugin-memory` | room memory (redaction, recall, authored protection, review queue) |
| `@sameroof/plugin-blackboard` | blackboard (**placeholder** — W7 pending) |
| `@sameroof/gateway` | capability gateway (**G1 in progress**) |
| `@sameroof/jcs` | RFC 8785 JSON canonicalization |

## Status (honest WIP)

Started 2026-09-02. Direction is set; bricks are going in.

- **In:** A-layer (queues / lanes / deliver / hop / watchdog), routines, memory v0.2, workspaces + `house-root`, W3 adapter↔gateway seam (offline walk-through green).
- **In progress:** gateway G1 (execution side), CI, doctor “dropped message” check.
- **Pending:** blackboard body (W7, after K4 rulings), public **demo house** (`examples/demo-house/` — not shipped yet), English docs beyond this file.

See `docs/NEIGHBORS.md`, `docs/WORKPLAN.md`, and `docs/DECISIONS.md`.

MIT.
