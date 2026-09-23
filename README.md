# Same Roof

**A self-hosted multi-provider Agent runtime with a human-visible workbench.**

[中文](README.zh.md) · [Architecture](docs/ARCHITECTURE.md) ·
[Design decisions](docs/DESIGN_DECISIONS.md) · [API](docs/API.md) ·
[History and attribution](PROVENANCE.md)

Same Roof separates message coordination, model credential access and tool
execution. Multiple agents share a workspace while humans can inspect tasks,
approvals and recorded work. It is a **single-machine, single-tenant prototype**,
not a production multi-tenant platform or a zero-trust runtime.

## What is implemented

- **Coordinator:** HTTP/SSE messaging, directed messages, task board, approval
  delivery and SQLite-backed inboxes. It does not execute requested commands.
- **Credential broker:** upstream keys stay in the broker for `broker-direct`
  agents; short-lived tokens restrict credential aliases, model IDs, purposes
  and budgets. A usage ledger records requests and token consumption.
- **Execution gateway:** policy checks, approval binding and Linux bubblewrap
  isolation for gateway-mediated commands. No gateway means no fallback to an
  unsandboxed execution path. Native CLI tools are outside this boundary.
- **Adapters and subagents:** event-triggered wake queues, session handover and
  broker-direct read-only subruns with local mailbox/transcript and interruption
  recovery. A subrun is not a new resident or an independent worker process.
- **Reply recovery:** durable outbox plus resident/payload-bound idempotency keys
  for ordinary public/private replies. Input is acknowledged after confirmed
  publication; restart can recover a lost response or retry a failed ACK.
- **Web workbench:** responsive group/private conversations, task and approval
  views, recorded session/subrun output, and per-resident usage panels. Public
  fictional demo data is separate from bearer-authenticated workspace data.

```text
Web / CLI  -- HTTP + SSE -->  Coordinator (messages, tasks, approvals)
                                  |
                               Adapters
                              /        \
                    Credential Broker   Execution Gateway
                    model scope/ledger  policy/approval/bwrap
```

`claude-code` and `pi` retain their native credential/tool paths. Their behavior
is not automatically covered by broker scope or gateway sandboxing.

## Try it without API keys

Requires Node.js 22+ and npm. Full backend tests and gateway execution require
Linux and `bubblewrap` with working user namespaces.

```sh
npm ci
node examples/code-review/demo.js
```

The demo starts a real coordinator, two adapters and broker against a **mock
model upstream**, asserting task delegation and completion. It does not start
the gateway and does not demonstrate real model quality.

To see the whole chain — scoped broker token, `APPROVAL:` line, gateway
intent, human decision, `bwrap` execution, result back to the agent — run the
gateway walkthrough. It builds a throwaway workspace, starts
`sameroof serve --with-gateway`, and stands in for the model with a local
OpenAI-compatible stub, so it needs no API key:

```sh
node examples/gateway-walkthrough/demo.js
```

Run it as a normal user: the gateway refuses to run as root. On a single-user
box where you are root, `SAMEROOF_DEMO_ALLOW_ROOT=1` passes
`--gateway-allow-root` through. Without working `bwrap` the chain still runs
up to the decision, and the demo reports that the gateway refused to execute
unsandboxed rather than claiming success.

For the standalone web experience:

```sh
SAMEROOF_ROOT="$PWD" node apps/roof/server.cjs
# Open http://127.0.0.1:17930/ — fictional demo, no pairing token needed.
```

The root configuration is fictional and mock-only. For a separate workspace
with a real model, follow [Quick start](examples/quick-start/README.md) and the
[CLI reference](packages/cli/README.md). Keep private workspaces outside Git.
Never put API keys in committed YAML or example transcripts.

## Running your own workspace

`sameroof serve` starts the broker, the coordinator and one adapter process per
agent. Two optional pieces are behind flags, because each has a real
prerequisite:

| Flag | Starts | Needs |
| --- | --- | --- |
| `--with-gateway` | the execution gateway on a Unix socket, wired to this coordinator; adapter tokens and the coordinator↔gateway service token are generated under `~/.sameroof/run/` | an unprivileged user (or `--gateway-allow-root` on a single-user dev box); `bubblewrap` for `core.exec` — without it `core.fs.*` still works and `core.exec` is refused |
| `--web [PORT]` | the responsive web UI (`apps/roof`) pointed at this workspace and coordinator, default port 17930 | the source tree (it is not a published package) |

Without `--with-gateway`, `APPROVAL:` actions fail closed: there is no
unsandboxed fallback. `deploy/` holds the systemd units used for a long-running
installation with a dedicated gateway user; see [deploy/README.md](deploy/README.md).

## Verify

```sh
node packages/cli/index.js check
node packages/cli/index.js lock --check
npm test
node --test apps/roof/*.test.cjs
node examples/code-review/demo.js
```

The [CI workflow](.github/workflows/ci.yml) also exercises fresh-workspace
`init → new → check → lock → serve → dispatch → reply → shutdown` and the
gateway walkthrough above (`serve --with-gateway`, approval, `bwrap` execution).
Test counts are printed by the runner. CI results from the original private
repository do not certify rewritten commits in this edition.

Reliability evidence includes real adapter child processes and a real
coordinator under response truncation, failed ACK and process restart. Browser
state tests execute shipping UI functions with controlled response ordering;
they are not a substitute for real-device visual checks.

## Repository map

| Path | Purpose |
| --- | --- |
| `packages/` | Runtime, broker, gateway, coordinator, schema and CLI |
| `apps/roof/` | Primary responsive presentation and authenticated workbench |
| `apps/console/` | Coordinator's compact administrative control surface |
| `apps/house/` | Earlier UI retained for compatibility; not the primary demo |
| `examples/` | Isolated examples and subagent test instructions |
| `deploy/` | Self-hosting templates; review paths and privileges before use |
| `docs/` | Contracts, architecture, design decisions and implementation limits |
| `scripts/metrics/` | Local log-analysis tool; generated personal data excluded |

## Explicit limits

- One resident profile maps to one adapter process. Multi-instance identity,
  distributed execution and multi-tenant isolation are not implemented.
- Broker/gateway boundaries apply only to traffic routed through them. Shipped
  coordinator/adapter systemd templates still run as root; process compromise
  is not contained by the command sandbox.
- Reply publication deduplication is not exactly-once model/tool execution.
  Approvals and pre-publication directive side effects have separate limits.
- The workbench displays recorded output, not a live PTY or hidden model
  reasoning. Missing/truncated output is not reconstructed.
- Usage panels separate account quota readings from resident run totals.
  Complete account attribution and current context utilization are not assured.
- Task claims use last-write-wins. Vector memory retrieval is experimental.

See [failure modes](docs/ARCHITECTURE.md#failure-modes),
[publication recovery](docs/design/delivery-recovery.md), and
[subagent scope](examples/subagent/README.md).

## Provenance

This edition retains a privacy-filtered development history from a private
project. Personal workspaces and internal correspondence were removed;
identifying examples and contributor labels were sanitized. Commit hashes
changed and some commits became empty. Contributions were not reassigned to
one author. See [PROVENANCE.md](PROVENANCE.md).

MIT — see [LICENSE](LICENSE).
