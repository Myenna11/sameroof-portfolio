# Code Review Demo

Two agents from different providers review the same code.

## What happens

1. **You** dispatch `auth.js` to `logic-reviewer`
2. **logic-reviewer** (Claude Sonnet, expensive) analyzes logic, architecture, and performance
3. **logic-reviewer** dispatches to `security-scanner` for security checks
4. **security-scanner** (GLM-4-Flash, cheap) scans for vulnerabilities
5. Both reviews are visible through the coordinator

## Why two agents?

- **Cost optimization**: Expensive model for judgment calls, cheap model for pattern-matching security checks
- **Credential isolation**: Each agent uses a different provider's API key, managed by the broker. Neither agent can see the other's credentials.
- **Sandboxed**: Both agents are read-only — they can read the code but can't modify files or run commands
- **Configurable**: The collaboration pattern (logic → security) is defined in the agent's SOUL.md, not hardcoded in framework code

## Run

```bash
node demo.js          # mock mode, no API keys needed
node demo.js --live   # real APIs (requires credentials in broker)
```

## Files

```
house.yaml                        # workspace config (2 credentials, 2 providers)
rooms/logic-reviewer/room.yaml    # Claude Sonnet agent (expensive, judgment)
rooms/logic-reviewer/SOUL.md      # what it does and how it collaborates
rooms/security-scanner/room.yaml  # GLM-4-Flash agent (cheap, pattern matching)
rooms/security-scanner/SOUL.md    # what it checks for
rooms/human/room.yaml             # you
sample-code/auth.js               # intentionally buggy code for demo
demo.js                           # runs the demo flow
```

## Interview talking points

- "Expensive model does the thinking, cheap model does the scanning — same task, 10x cost difference per token"
- "Agents collaborate through the coordinator, not direct calls — I can swap providers without changing collaboration logic"
- "Sandbox is read-only for this use case, but the framework supports approve-gated exec for other scenarios"
- "Adding a third agent (e.g., a test-writer) is just a new room.yaml + SOUL.md — zero framework code changes"
