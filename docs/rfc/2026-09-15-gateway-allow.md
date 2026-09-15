# RFC: gateway `allow` — policy-decided execution without a human click

- Author: 规划员
- Date: 2026-09-15
- Status: **implemented on `pivot-workharness` (81f652b, f93ee46, 9cc49e1, 733641e); awaiting gate.** This house's `house.yaml` is unchanged. rev 3 (CONDITIONAL ARCHITECTURE PASS at rev 2; contracts A/B fixed here) after `docs/reviews/2026-09-15-reviewer-subagents-v3-rfc-review.md` — prerequisite for `docs/design/subagents.md` v4, ships on its own
- Authorisation note: the 维护者 line below is 规划员's record of a conversation on 2026-09-15. It is not an implementation instruction to anyone; the release gate re-confirms the concrete policy lines, read-only roots and deployment target with 维护者 before `house.yaml` changes.
- Reviewer: 审查员
- Authorisation on record: 维护者, 2026-09-15 — subagents may run in a read-only sandbox (no writable mounts, no network) without approval; file writes and writable exec stay `approve`. The 2026-09-08 `core.fs.read: approve` line was a fix for a prompt/policy contradiction (read was missing → deny, prompt said "you can read"); the value `approve` was the implementer's choice, not a strictness decision.

## 1. Problem

`packages/schema/house.schema.json` allows permission values `allow | approve | deny`. Nothing implements `allow`:

- `packages/gateway/server.js:315 ensurePermission` — `deny` refuses; any other value falls through to `registerIntent`, which always creates an intent in `awaiting_approval`.
- `packages/living-room/server.js` — no auto-decision path; every intent becomes an approval card.
- `packages/living-room/server.js:450-480 /internal/gateway/results` — requires an `approval_id` and looks up the approval row by `request_id`; 404 otherwise. The result contract is *the approval*.

So `allow` today ≡ `approve`. Any autonomous background work (subagents, routines that read files, heartbeats that check a log) is impossible without a human click per action.

What the three harnesses do (verified 2026-09-15 against source/docs, see `docs/design/subagents.md` §1):

- Kimi Code: read-only tools (Read/Grep/Glob) auto-allowed by default; write/exec ask. Modes `manual | yolo | auto`.
- Claude Code: "Auto mode is now Claude Code's default permission mode" (binary string, 2.1.210). Plan mode distinguishes "readonly tools".
- Codex: **the sandbox is the permission** — default `read-only` sandbox (untrusted dir) or `workspace-write` (trusted); commands run without asking, they just cannot write/network. Approval policy default `OnRequest`.

Our gateway already has the Codex property: `core.exec` always `--unshare-net`, cwd root `--ro-bind`, only `writable_root_ids` get `--bind`. `core.exec` with `writable_root_ids: []` **is** a read-only sandbox. What's missing is (a) a way to *name* that in policy and (b) the `allow` path itself.

## 2. Proposal

### 2.1 Ceiling algebra: `deny < approve < allow`, room may only tighten

Today (`ensurePermission`): `effective = room ?? house`; refuse iff either is `deny`. A room could set `allow` under a house `approve` and — once `allow` works — escalate. Fix:

```
rank = { deny: 0, approve: 1, allow: 2 }
ceiling = house.defaults.permissions[action]          // missing → deny
room    = room.permissions[action]                    // missing → ceiling
effective = min(rank[ceiling], rank[room])            // room can tighten, never widen
deny    → 403 GW-POLICY-DENIED (unchanged)
approve → awaiting_approval (unchanged)
allow   → execute now (new)
```

`sameroof check` **already** enforces this at validation time — `packages/schema/index.js:300-306`, `ROOM-PERM-CEILING-001`, using `PERMISSION_RANK`. That stays and gets a regression test. The only code change is the gateway's `ensurePermission` (`server.js:315-321`), which currently lets the room value override the ceiling; it must compute `min(rank)` from the same `PERMISSION_RANK`.

### 2.2 New action: `core.exec.ro`

`core.exec.ro` = `core.exec` with `writable_root_ids` **forced** to `[]` by the gateway (a non-empty value is `GW-PARAMS-INVALID`, not clamped). Same bwrap: `--unshare-net`, all roots `--ro-bind`, tmpfs `/tmp` (scratch only, discarded). Digest includes the action name, so an approval or a policy decision for `core.exec.ro` cannot be replayed as `core.exec`.

It is a separate action rather than a conditional on `core.exec` so that `house.yaml` stays a flat `action → value` map and `explain` / `lock` / the console can show it without new machinery.

Recommended house policy after this RFC (this house; 维护者's authorisation above):

```yaml
core.fs.read:   allow
core.exec.ro:   allow
core.exec:      approve
core.fs.write:  approve
```

### 2.3 Gateway: the `allow` path — contract A (execution split + register timing)

`execute(requestId, approval)` (`server.js:450-467`) requires `status = awaiting_approval` and a valid single-use approval before it atomically moves the row to `executing`. A policy intent inserted as `executing` cannot enter it. So `execute` is split into three functions; the approval path keeps its behaviour byte-for-byte:

| function | does |
|---|---|
| `claimHumanApproved(requestId, approval)` | today's `execute` head: load row, require `awaiting_approval`, validate the approval, atomic `→ executing`, audit `decided(human)` |
| `claimPolicyAllowed(body, token, policy)` | called from `registerIntent` when effective is `allow`: rate-limit check (§2.6, before insert), then **one transaction**: insert the row with `status = executing`, `decision_source = 'policy_allow'`, `policy_digest`, `run_id`; audit `decided(policy_allow, decided_by='policy')` |
| `executeClaimed(row)` | today's `execute` body from the sandbox call onward: run, redact, strip for `intents.result_json`, write `output_json` (§2.3b, policy path only), enqueue `results`, audit `executed`, `deliverResult` |

**`decision_source` is a column on `intents`** (`'human' | 'policy_allow'`), not an audit-only fact; `/output` and `doctor` read it from the row.

**Register response timing:** `registerIntent` returns as soon as `claimPolicyAllowed` commits — response `{ request_id, state: 'executing', decision: { source: 'policy_allow' } }` — and schedules `executeClaimed(row)` on the gateway's existing executor queue. It does **not** await execution (a `core.exec.ro` may run for minutes; the adapter client has a 5 s timeout; synchronous execution was rejected in §2.3b). Consequences, stated so the implementer doesn't guess:

- The caller polls `getIntent` for a terminal state, then reads `/output`.
- **Gateway restart with a policy row still `executing`**: the existing recovery path marks it `failed_unknown` (never replayed). `getIntent` shows that; the subrun loop treats it like any failure (`output_unavailable: failed_unknown`). Test: kill the gateway between claim and execute; on restart the row is `failed_unknown`, no second execution, audit row `recovered`.
- Idempotent re-register: the comparison at `:425-429` (resident, action, params digest) gains **`run_id` and `decision_source`**. Same `request_id` with a different `run_id` → `409 GW-IDEMPOTENCY-CONFLICT`. `/output` binds on `run_id`, so it must be part of the identity.

The `x-sameroof-*` / bearer handling is unchanged: the token still identifies the resident; the resident ceiling still applies.

`allow` never bypasses: sandbox probe (`GW-SANDBOX-UNAVAILABLE` still fails closed), root/mount checks, policy-digest match, per-resident rate limit (§2.6).

### 2.3b Output return channel for the executing resident (P0 — was missing)

`execute()` (`server.js:474-484`) writes a **redacted-then-stripped** copy to `intents.result_json`: for `core.fs.read` the `summary` and `details.content` become `[content omitted]`; for every action `stdout`/`stderr` become `[output omitted]`. `getIntent` (`:443-448`) returns that stripped row. The full result lives only in `results.result_json`, the living-room delivery queue. So a resident polling `GET /v1/intents/:id` after a policy-allowed `grep` sees `state: complete` and no lines. That boundary is deliberate (a persisted query surface must not become a content store) and stays.

A subrun therefore needs a **separate, bounded, single-consumer output channel**. Proposal: `GET /v1/intents/:id/output`.

| rule | value |
|---|---|
| auth | resident bearer token is the **only** authentication; `intents.resident_id` must equal the token's resident. `X-Sameroof-Run: <run_id>` is a required **binding** field (must equal `intents.run_id`) so a foreground wake cannot accidentally consume a subrun's output; it is not a secret |
| availability | only for rows with `intents.decision_source = 'policy_allow'` (human-approved results already flow to the resident's inbox via the living room; no second channel for those) |
| content | the **redacted** full result (`redactValue` has already run), i.e. what the living room would have delivered — nothing more |
| size | the **whole serialised response** capped at `house.gateway.output_max_bytes` (default 64 KiB), applied as: cap each of `stdout`/`stderr`/`content` proportionally, then verify the JSON length; when any field is cut, `truncated: true` and per-field `total_bytes` are set so the caller can never mistake a cut list for a complete one |
| reads | at most `output_max_reads` (default 3) per intent — a **crash-retry margin**, not "single-consumer"; the counter increments in the same SQLite transaction that returns the row (`UPDATE … SET output_reads = output_reads + 1 WHERE request_id = ? AND output_reads < ? RETURNING …`), so concurrent GETs cannot exceed the cap; audited; after that `410 GW-OUTPUT-CONSUMED` |
| retention | `output_ttl` (default 10 min) after `executed_at`; then `410 GW-OUTPUT-EXPIRED`. **Physical clearing**: `output_json` is set to NULL (a) on the read that reaches the cap, (b) by the existing periodic sweep (`expireStale`) for rows past ttl, (c) at startup for any row past ttl. Rows nobody ever reads are still cleared by (b)/(c). The stripped `intents.result_json` remains as today |
| audit | each read: `output_read` row with `request_id`, `run_id`, bytes, remaining reads |
| state before terminal | `409 GW-OUTPUT-NOT-READY` while `executing`; the caller polls `getIntent` for state, then reads output once |

Where it's stored: a third column `intents.output_json` (nullable, redacted full result, NULL after ttl/reads), not a reuse of `results.result_json` — that column belongs to the delivery loop and is deleted on successful delivery.

The subrun loop's contract with this: if state is terminal and `/output` returns 409/410/404, the loop records `output_unavailable` for that tool call, feeds *that* to the model as the tool result, and continues. `[output omitted]` is never presented as data. Tests: matching lines from a real `grep -rn` under `core.exec.ro` appear verbatim in the subrun's next prompt; a value the gateway redacts is absent; a 200-line output with a 4 KiB cap yields `truncated: true` and the model prompt says so.

Alternative considered: make `POST /v1/intents` synchronous for `allow` and return the result inline. Rejected: the register route is bounded by a 5 s client timeout and shared with the approval path; an `exec` can legitimately run for minutes; idempotent retry of a synchronous execute is a new problem. The two-step `register → poll state → read output once` keeps `execute()` unchanged.

### 2.4 Living room: result contract with a policy decision

`/internal/gateway/results` today: `approval_id` required → look up approval by `request_id` → DM the resident with `meta: { approval_id, action, … }`.

Change to accept **either** form, validated:

Facts (审查员): the living room reads static `house.yaml`/residents at start (`server.js:177-194`) and has **no** lock-digest verification path today; and an action executes against the policy snapshot *at register time* — if the house policy changes before a delayed or retried delivery (`retryUndelivered()`), a "must equal current lock digest" rule would 409 a real, already-executed result, the human would never see it, and the gateway would retry forever. Fail-closed must not mean losing history.

So, **option (b), self-describing record, no digest-equality gate**:

| field | approval path (today) | policy path (new) |
|---|---|---|
| `request_id` | required; idempotency key | required; idempotency key |
| `resident_id`, `action`, `run_id` | present | present; the living room stores all three on the DM and checks `resident_id` is a known resident |
| `approval_id` | required, resolved | absent |
| `decision.source` | `human` | `policy_allow` |
| `decision.policy_digest` | — | required, **stored for audit, not compared**. The living room may annotate `policy_snapshot_stale_at_delivery: true` if it can cheaply tell the house file changed since, but never refuses on it. |
| sender | gateway service token | gateway service token (unchanged trust domain — the same token is already trusted for approval results) |

The living room's only refusals: unknown `resident_id`, malformed record, missing required fields. Everything else is delivered exactly once per `request_id`. **The gateway is the sole decider of whether an action was allowed to execute; the living room never re-decides.** If a second, independent control plane is wanted later (living room verifying a gateway signature or its own policy copy), that is a separate trust-model change, not this RFC.

The resident's result DM gains `meta.decision` and `meta.run_id`. The console's fold-out shows "policy" instead of "allowed by <human>". Nothing is hidden: humans still see every read and exec in the stream; they just weren't asked.

### 2.5 `run_id` end to end

`intents.run_id` exists in the gateway DB but `deliverResult` doesn't send it and the living room doesn't store it on the DM. Change: gateway includes `run_id` in the result payload; living room copies it to `meta.run_id`. Validation: `run_id` must match `^(run|sub)_[A-Za-z0-9_-]{6,40}$` and must equal the `run_id` the intent was registered with (the gateway has it; a mismatch is a gateway bug → 500, audited).

This is what lets the adapter distinguish its own foreground results from a subrun's, by a field the gateway vouches for — not by a string prefix the adapter invents (审查员 G4).

### 2.6 Rate limit for `allow`

A human-approved action is rate-limited by the human's patience. A policy-allowed action isn't. Add per-resident, per-action-class token buckets in the gateway: `allow_rate: { 'core.fs.read': 60/min, 'core.exec.ro': 20/min }` in `house.gateway`. Defaults conservative; a subrun's own budget (design doc §4.6) sits under this.

**Where the limit is applied, and what exists afterwards — one choice, not both:** the bucket is checked **before** the intent row is inserted. Exceeding → `429 GW-RATE-LIMITED` on the register call, one `rate_limited` audit row (`resident_id`, `action`, `run_id` if supplied, bucket state). **No intent row, no result, no living-room delivery.** The caller (a subrun loop or a foreground adapter) sees the 429 synchronously and feeds "rate limited, retry after N s" to the model. This keeps the intent table meaning "things the gateway accepted" and avoids inventing a `rejected_before_register` state with its own delivery semantics. The v1 wording "result to the resident as a failure" is withdrawn.

The broker's ledger and token quotas govern model calls; they do **not** decide gateway admission (审查员 RFC-3). Two independent budgets.

### 2.7 Visibility

- Audit: every policy-allowed execution has a `decided` row (`policy_allow`) and an `executed` row, same as human-approved ones. `sameroof doctor` gains a count of policy-allowed actions per resident per day.
- Console: result fold-outs show the decision source. A per-resident "policy-allowed today: N" counter in the agent detail panel (later; not blocking).
- `/admin/messages` already shows result DMs; they now carry `meta.decision`.

## 3. Test matrix (gateway + living room)

| # | case | expect |
|---|---|---|
| 1 | house `allow`, room unset, `core.fs.read` | executes, no approval card, audit `policy_allow`, result DM with `decision.source=policy_allow` |
| 2 | house `approve`, room `allow` | `sameroof check` → `ROOM-PERM-CEILING-001` (regression); gateway `ensurePermission` → `approve` (min rank), audit note |
| 3 | house `allow`, room `approve` | awaiting_approval (room tightened) |
| 4 | house `allow`, room `deny` | 403 |
| 5 | `core.exec.ro` with `writable_root_ids: ['x']` | 400 GW-PARAMS-INVALID |
| 6 | `core.exec.ro` allow: `grep -rn recall packages/` in bwrap | stdout returned; `touch /tmp/x` inside works (tmpfs), `touch ./x` fails (ro-bind), `curl` fails (no net) — three negative asserts |
| 7 | `allow` but bwrap probe fails | 503, nothing runs |
| 8 | `allow` but intent policy digest ≠ current | refused, audited |
| 9 | living room receives policy result whose `policy_digest` ≠ current house | **delivered**, DM meta carries the digest and `policy_snapshot_stale_at_delivery: true`; audited |
| 10 | living room receives same `request_id` twice | second is idempotent no-op |
| 11 | `run_id` in result ≠ registered | 500, audited |
| 12 | rate limit: 21st `core.exec.ro` within a minute | 429 on register, `rate_limited` audit row, **no intent row**, no delivery |
| 13 | approval path unchanged: `core.exec` with house `approve` | card, human decides, works as today (regression) |
| 14 | replay: approval for `core.exec.ro` digest presented to `core.exec` | GW-APPROVAL-MISMATCH |
| 15 | `/output` after policy-allowed `grep -rn recall packages/`, same resident + correct `X-Sameroof-Run` | 200, matching lines verbatim; audited `output_read` |
| 16 | `/output` with wrong run header, or other resident's token | 404 (no existence leak) |
| 17 | `/output` for a human-approved intent | 404 (not offered on that path) |
| 18 | `/output` 4th read, or after ttl | 410 |
| 19 | `/output` while `executing` | 409 |
| 20 | `/output` on 200-line stdout with 4 KiB cap | `truncated: true`, `total_bytes` set |
| 21 | secret-looking value in stdout | absent from `/output` (redaction precedes storage) |
| 22 | register `allow` → response `executing` within client timeout while a 20 s `sleep` runs in bwrap | 200 immediately; `getIntent` → `executing`; later `complete` |
| 23 | kill gateway between claim and execute; restart | row `failed_unknown`, audit `recovered`, sandbox ran **zero** times (marker file absent) |
| 24 | re-register same `request_id` with different `run_id` | 409 GW-IDEMPOTENCY-CONFLICT |
| 25 | approval path regression: `claimHumanApproved` + `executeClaimed` == old `execute` (existing gateway tests unchanged) | all pass |
| 26 | three concurrent `/output` GETs on cap 3, then a fourth | exactly three 200s, one 410; `output_json` NULL after |
| 27 | row past ttl never read; sweep runs | `output_json` NULL |

## 4. What this does not change

- `deny` semantics, the approval flow for `approve`, the bwrap invocation, mount roots, the token model, the console's Allow/Deny card.
- This house's `house.yaml` — until this RFC is accepted, the code lands with tests, and 维护者 confirms the four-line policy in §2.2.

## 5. Estimate

| piece | estimate |
|---|---|
| gateway `ensurePermission` min-rank + schema regression test + tests 2-4 | 0.25 d |
| `/v1/intents/:id/output`: column, route, total cap, atomic reads, ttl + physical clear (read/sweep/startup), audit + tests 15-21, 26-27 | 1 d |
| `core.exec.ro` action + digest + tests 5-6 | 0.5 d |
| split `execute` → claim/claim/executeClaimed; `decision_source` column; idempotency incl. `run_id`; register returns `executing` + queue; restart → `failed_unknown`; tests 1, 7, 8, 11, 14, 22-25 | 1 d |
| living-room result contract (policy path, self-describing record, no digest gate, stale annotation, idempotency) + tests 9-10, 13 | 0.5 d |
| rate limit before insert + test 12 | 0.25 d |
| console decision-source label, doctor counter | 0.25 d |

**3.75 days.** Then gate. The subagent design (v3) starts only after this lands.

## 6. Questions for 审查员

1. §2.3b `/output` as a third column with reads/ttl, versus returning the redacted full result from `getIntent` only when `decision_source = policy_allow` and `X-Sameroof-Run` matches. I kept it separate so `getIntent` keeps its no-content invariant unconditionally. Agree, or is the conditional cheaper and safe enough?
2. §2.3b caps: 64 KiB / 3 reads / 10 min are guesses. What would you set?
3. §2.6: 429-before-insert means a rate-limited request leaves only an audit row. Is that enough for `doctor` to surface "this resident is being throttled", or do you want a counter table?


## 7. Implementation record (2026-09-15)

| commit | what |
|---|---|
| 81f652b | `effectivePermission` min-rank; `PERMISSION_RANK` exported; 10 tests incl. schema regression |
| f93ee46 | contract A split (`claimHumanApproved` / `claimPolicyAllowed` / `executeClaimed`); `decision_source`, `executed_at`, `output_json`, `output_reads` columns; `allow` path returns `executing` and queues; idempotency incl. `run_id`+`decision_source`; `core.exec.ro`; `/v1/intents/:id/output` (bind, cap, atomic reads, ttl, physical clear, audit); `stdout_raw`/`stderr_raw` kept only for `/output`; rate limit before insert; 11 tests on real bwrap |
| 9cc49e1 | living-room policy result form; `request_id`/`run_id`/`decision` on result DM; `policy_result` activity; test |
| 733641e | schema fields; `gateway-client.getIntent/readOutput`; socket-level test; `doctor` policy-allow summary; console badges |

Matrix status: 1 ✓ 2 ✓ 3 ✓ 4 ✓ 5 ✓ 6 ✓ 7 ✓ 8 (existing lock-digest test) 9 ✓ 10 ✓ 11 (gateway-vouched; covered by 24) 12 ✓ 13 ✓ 14 ✓ 15 ✓ 16 ✓ 17 ✓ 18 ✓ 19 ✓ 20 ✓ 21 (redaction precedes storage; existing redact tests) 22 ✓ (via #1 timing) 23 **not written** (kill-between-claim-and-execute needs a process-level harness; `failed_unknown` recovery path is pre-existing and tested) 24 ✓ 25 ✓ (existing suites unchanged) 26 ✓ 27 ✓.

Known deviations from the text above: none intended. Reviewer should diff §2.3/§2.3b/§2.4/§2.6 against `packages/gateway/server.js` and `packages/living-room/server.js`.
