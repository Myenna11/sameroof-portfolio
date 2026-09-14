# Console

The Same Roof web UI. Single-file, zero dependencies.

Open at `http://<coordinator>/console`.

## Design intent

Reference: Claude Code / Codex terminal aesthetic. Dark, dense, information-first.

**Not** a chat app. A **control surface** for a multi-agent workspace.

### Layout

```
┌──────────┬────────────────────────────┬──────────┐
│ Agents   │  Message stream            │ Detail   │
│ ● coder  │                            │ (on      │
│ ○ review │  [human] Review auth.js    │  click)  │
│          │                            │          │
│ Tasks    │  ▶ coder → reviewer  [dm]  │          │
│ [open].. │  ▶ ⚠ coder requests exec   │          │
│ [doing]. │    [Allow] [Deny]          │          │
│          │                            │          │
│          │  [coder] Review done...    │          │
│          ├────────────────────────────┤          │
│          │  Message or /dispatch...   │          │
└──────────┴────────────────────────────┴──────────┘
```

### Message stream elements

| Element | When | Interaction |
|---|---|---|
| **Message** | `/say` broadcast | Plain text, code blocks rendered |
| **DM fold** | agent → agent private | Collapsed by default. Click to expand. Badge: `dm` or `dispatch` |
| **Result fold** | gateway execution result | Collapsed. Click to see output |
| **Approval card** | agent requests privileged op | Inline Allow/Deny buttons. Card updates after decision |
| **System line** | join/leave/pin/etc | Centered, dim, small |

The fold pattern = same interaction as tool-call expansion in Claude Code. The user sees *that* something happened without reading *what* unless they want to.

### Input

```
plain text              → /say (broadcast)
@agent text             → /say with mention (wakes agent)
/dispatch agent task    → /dispatch (creates task + DMs agent)
/dm agent text          → /dm (direct message)
```

### For the next person working on this

The architecture is right. The styling is a first pass.

Things to improve:
- Agent list: show model name (needs `/members` to return `model` field)
- Task board: drag to reassign, click state to cycle
- Approval card: show params diff for `core.fs.write`
- Stream: virtual scroll for >500 messages
- Mobile: sidebar as drawer
- Keyboard: `↑` to edit last message, `Cmd+K` command palette
- Cost: show per-agent spend in agent list (needs `/cost` endpoint)

Don't add: emoji reactions, threads, read receipts, typing indicators. This is a control surface, not Slack.

Test with the e2e demo:
```bash
SOPHNET_KEY=xxx node examples/code-review/e2e-demo.js
# then open http://127.0.0.1:<port>/console with the human token
```
