# Design decisions

These decisions describe the implemented prototype, not a production guarantee.
Code and reproducible tests take precedence over historical design prose.

## Separate coordination, model access and execution

The coordinator owns messages, tasks and approvals but does not run requested
commands. The broker owns upstream credentials for broker-direct model calls;
the gateway owns policy evaluation and sandboxed tool execution. Separating these
roles makes each contract testable and limits accidental credential propagation.

This is not process-level zero trust: coordinator and adapter systemd templates
still run as root. Native CLI adapters use their own credentials and tools outside
these boundaries. A gateway child-process sandbox does not contain compromise
of the gateway process itself.

## Offer collaboration channels, not a fixed workflow

Broadcast, directed message, task assignment and approval allow different agent
roles to cooperate without hard-coding a pipeline. This is flexible but does not
provide a distributed workflow engine, deterministic model decisions or a
multi-instance scheduler. Task ownership remains last-write-wins.

## Make permission failure explicit

Gateway-mediated actions use deny/approve/allow policy with narrowed paths and
tools. A read-only pre-authorized action need not require a click; actions outside
that allowance require approval or are denied. The gateway does not fall back to
unsandboxed execution when unavailable. Tests include negative network/filesystem
cases, policy narrowing and approval consumption.

## Persist a reply before attempting publication

ACK-before-publication loses input when the reply request fails. The shipping
adapter now writes an outbox first, publishes with a resident- and payload-bound
key, persists acceptance and then ACKs the selected input IDs. SQLite commits
message, delivery rows and deduplication receipt together. A lost response can be
retried without creating a second message; a failed ACK need not rerun the model.

The tradeoff is persistent receipt storage and an operator-visible pending state.
Recovery needs another wake, reconnect or restart. Directives before the outbox
write and approval requests are not covered by this publication contract.
See [delivery recovery](design/delivery-recovery.md).

## Keep subagents inside the parent adapter

A subrun is a broker-direct nested model/tool loop, not a new coordinator resident.
It uses a narrowed read-only tool set, transcript and local mailbox. This avoids
inventing resident lifecycles for short-lived work. It also means no independent
process isolation, no nested subagents and no cross-resident execution identity.
Per-subrun token cost attribution remains future work.

## Separate visible evidence from inferred state

The web workbench displays recorded sessions, service logs and subrun records.
It labels missing or truncated data, excludes system messages and redacts known
credential syntax. It is not a live PTY and does not reconstruct hidden reasoning.
Usage panels distinguish resident-attributed run totals from account quota
readings; absent readings are unknown, not zero.

Browser requests are scoped to connection generation and selection, so stale
responses cannot overwrite a new room or disconnected demo. SSE refresh has a
polling fallback, including private messages. These choices reduce UI races but
do not create durable offline drafts or reliable delivery across a page reload.

## Prefer inspectable memory over opaque mutation

Stable retrieval uses lexical overlap. Memory writes are append-only with a
review queue and protection for human-authored facts. Vector retrieval remains
experimental; embedding requests are not yet routed through the broker. Log
retention, disk-full behavior and multi-writer concurrency require further work.

## Verify failure behavior, not only successful demos

Tests cover real coordinator/proxy contracts, scripted model adapters, actual
adapter child processes, response truncation after commit, failed ACK and restart.
The mock demo proves wiring and task lifecycle, not model quality. CI includes
configuration/lock checks, package/web tests and a fresh-workspace smoke test.
