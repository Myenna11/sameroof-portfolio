# Ordinary reply publication recovery

Scope: adapter `/say` and `/dm` publication. This does not make a model turn,
tool execution, approval request or multi-file update exactly-once.

## Contract

1. The adapter snapshots the IDs of the inbox/mailbox items used for the reply.
2. Before publishing, it durably writes `rooms/<resident>/state/delivery-outbox.json`
   with route, body and a random `send_` key. One adapter process owns this file.
3. The coordinator binds the key to authenticated resident and canonical payload.
   Message, recipient deliveries and receipt are committed in one SQLite
   transaction. Repeating the same request returns the original message; changing
   the payload under the same key returns 409. Other residents cannot claim it.
4. Only a 2xx response containing a message ID advances the outbox to `accepted`.
   The adapter then marks its selected mailbox items consumed and ACKs only the
   selected inbox IDs. Successful ACK clears the file durably.
5. On a subsequent wake or process restart, pending publication is recovered
   before checking model budget or making another model call. An accepted record
   retries ACK only. Uncertain publication retries the persisted key and body.
   After recovery, a serialized wake checks for newer input.

The outbox uses write/fsync/rename/directory-fsync on Linux. An unreadable or
malformed record fails closed: it is not silently replaced by a new reply.
Explicit validation rejection (400/404/413/422) drops the rejected draft but
leaves input unread, allowing a later turn to correct it. Network failure,
truncated response, 429, 5xx or malformed success retains the draft. HTTP calls
are bounded and reject interrupted response streams.

Recovery is triggered by a later wake/reconnect/startup, not an independent
always-running retry worker. With heartbeat disabled and no further events, a
failed publication can remain pending until explicitly woken or restarted.
Operators must not delete a pending outbox merely to clear an error.

## Persistence and limits

The additive `message_requests` table stores `(resident_id, request_id)`, payload
digest and original response. It survives coordinator restart. Receipts currently
have the same indefinite lifecycle as message history; there is no automatic
pruning. Any future retention policy must keep receipts at least as long as an
outbox can be retried, or define an explicit retry expiry contract.

Approval requests still require confirmed acceptance before input ACK, but do
not participate in this durable outbox. Side effects of directives processed
before the outbox is written can still repeat after a crash. A model interrupted
before its reply is persisted must be called again. Multiple processes owning
the same adapter directory are unsupported. These are explicit boundaries, not
claims of end-to-end exactly-once processing.

## Release and rollback

- Verify the repository configuration, refreshed `house.lock`, package tests,
  web contract tests and mock-only demo before release.
- Back up the coordinator SQLite database consistently (SQLite backup API, not
  a naked copy of an active WAL database) and retain the prior code/lock release.
- Coordinate adapter shutdown before changing the production checkout. Start the
  new coordinator first, then adapters. An old coordinator ignores retry keys,
  so **do not run the new adapter outbox against an old coordinator**.
- The new receipt table is additive and old code can ignore it, but reverting
  adapters with pending outboxes can strand replies or duplicate work. Drain or
  explicitly reconcile pending records first; keep the database and outbox
  together. Do not drop receipts or rotate tokens during rollback.
- The web-only portion can be released separately without restarting residents.

## Regression evidence

- `apps/roof/integration.test.cjs`: real proxy/coordinator authentication limits,
  tasks, private messages, payload-bound retries and coordinator restart.
- `apps/roof/ui-state.test.cjs`: shipping browser functions with controlled async
  completion order; switch-room/disconnect, duplicate sends, newer drafts,
  out-of-order snapshots, stale errors and private-message polling.
- `packages/adapters/test/delivery-outbox.test.js`: persistence phases, uncertain
  replies, failed ACK, validation rejection and corrupt record handling.
- `packages/adapters/test/delivery-recovery.test.js`: actual adapter child
  processes, real coordinator, response truncated after commit, failed ACK and
  two process restarts, for both public and private replies. No provider calls.
