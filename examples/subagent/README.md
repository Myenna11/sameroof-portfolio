# Subagent V0: reproducible evidence and scope

A broker-direct resident can launch a read-only nested model/tool loop inside
its adapter. A subrun is not a separate resident, process or public identity.
Results return through a local mailbox; the parent decides how to present them.

## Reproduce without a real model account

On Linux with Node.js 22+, installed workspace dependencies and working bubblewrap:

```sh
node --test --test-concurrency=1 packages/adapters/test/subagent-e2e.test.js packages/adapters/test/subagent-lifecycle.test.js packages/adapters/test/mailbox-consumption.test.js
```

These tests use real coordinators, gateways and adapters with scripted model
responses. They check read-only execution, mailbox consumption, interrupted
subrun recovery and parent responsiveness. No private production transcript or
real-model latency claim is included in this edition.

## Configure an actual workspace

Use a separate workspace, not the mock root config. Provide a real broker
credential and narrowly scoped gateway mounts. Enable only `core.fs.read` and
`core.exec.ro` as policy-allowed tools for the subrun; exclude personal rooms.
The broker token must carry purpose `subagent`. Re-issue old tokens deliberately;
never copy a production token into Git.

```yaml
subagent:
  enabled: true
  max_parallel: 2
  tools: [core.fs.read, core.exec.ro]
  budget: {model_calls: 15, tool_calls: 20, minutes: 10}
```

Directive example:

```text
SUB: Find call sites | 带上: Search only src/ and return file paths and lines | 工具: core.fs.read,core.exec.ro
```

The root mock demo does not start a gateway. Subagent use requires separate
gateway setup; see the [RFC](../../docs/rfc/2026-09-15-gateway-allow.md) and
[design](../../docs/design/subagents.md).

## Limits

- Broker-direct only; no nested subagents, writes or waiting for human approval.
- Mailbox presentation is at-least-once, not exactly-once whole-turn execution.
- Per-subrun cost splitting and dedicated personas are not implemented.
- `继承: N` inherits rendered lines, not complete historical turns.
- Ordinary parent reply publication has its own
  [outbox contract](../../docs/design/delivery-recovery.md).
