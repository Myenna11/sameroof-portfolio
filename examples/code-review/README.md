# Code Review Demo

Two agents review one file. The human dispatches once; the first agent delegates to the second through the coordinator.

```
human ──/say (code)──▶ coordinator
human ──/dispatch────▶ coordinator ──SSE @mention──▶ logic-reviewer
                                                        │ scoped token
                                                        ▼
                                                      broker ──▶ model
                                                        │
                            logic-reviewer replies ◀────┘
                            "...review... PIN: Security scan | 给: security-scanner"
                                     │
coordinator creates task ◀───────────┘  (created_by = logic-reviewer)
coordinator ──SSE @mention──▶ security-scanner ──scoped token──▶ broker ──▶ model
                                     │
                            "...findings... PIN task_xxx: done"
                                     │
coordinator marks task done ◀────────┘
```

## Run

```bash
node demo.js                        # mock — no API key needed
SOPHNET_KEY=… node demo.js --live   # real models via sophnet
node demo-scripted.js               # old scripted walkthrough: prints a story, exercises nothing
```

## What each mode proves

| | mock | --live |
|---|---|---|
| coordinator routing, SSE, @mention wake | real | real |
| adapter loop (`lib/room.js`) | real | real |
| broker token issuance, alias/model scope, ledger | real | real |
| cross-scope call rejected (`MODEL-NOT-ALLOWED`) | real | real |
| agent-to-agent delegation via `PIN:` | real | real |
| task lifecycle open → done, `created_by` check | real | real |
| model text | scripted | GLM-5 / qwen3.6-flash |
| upstream | broker built-in mock | sophnet (one provider, two aliases) |
| execution gateway / bwrap sandbox | **not exercised** | **not exercised** |

The demo asserts on `created_by` and task `state`; it fails if delegation or completion didn't actually happen.

## What it does not show

- **No sandbox.** Neither agent has `core.exec` / `core.fs.*`. The gateway isn't started. For bwrap isolation see `packages/gateway/test/`.
- **One upstream provider.** `--live` uses two aliases on the same sophnet key. Multi-provider is a broker config matter (`sameroof cred add` with different `--base-url`s), not something this demo demonstrates.
- **Old adapter.** Agents run on `packages/adapters/lib/room.js`, not the experimental `lib/core.js`.

## Files

```
demo.js                          canonical demo (mock + --live)
demo-scripted.js                 legacy: prints a pre-written transcript
house.yaml                       documents the workspace shape demo.js builds
rooms/logic-reviewer/SOUL.md     tells the model the PIN: hand-off shape
rooms/security-scanner/SOUL.md   tells the model how to mark its task done
sample-code/auth.js              intentionally vulnerable
```
