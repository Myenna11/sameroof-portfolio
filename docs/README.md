# Documentation map

- [Architecture and failure modes](ARCHITECTURE.md): component and trust boundaries.
- [Design decisions](DESIGN_DECISIONS.md): tradeoffs and current limitations.
- [API](API.md), [gateway](GATEWAY.md), [room schema](ROOM_SPEC.md): implementation contracts.
- [Subagent V0](design/subagents.md): design evolution; current scope is labelled.
- [Publication recovery](design/delivery-recovery.md): outbox, deduplication and ACK ordering.
- [Gateway allow RFC](rfc/2026-09-15-gateway-allow.md): policy-mediated read-only execution.
- [Primary web interface](../apps/roof/README.md): demo/authentication and record visibility.

Older UI documents describe compatibility surfaces, not the primary web design.
Private correspondence and actual deployment records are intentionally absent.
Historical commit IDs in retained design prose refer to the source project's
design timeline, not necessarily resolvable hashes in this rewritten edition.
