# RFC: gateway `allow` — policy-decided execution without a human click

- Author: 规划员
- Date: 2026-09-15
- Status: **proposed** — prerequisite for `docs/design/subagents.md` v3, but ships and is useful on its own
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

Also enforced at `sameroof check` / `lock` time: a room value ranked above the house ceiling is a validation error, not a silent clamp. Both places, so a stale lock can't hide it.

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

### 2.3 Gateway: the `allow` path

In `registerIntent`, after the existing validation (params, roots, digests, policy snapshot):

1. `effective === 'allow'` → insert the intent with `status: executing` directly (skip `awaiting_approval`), write an **audit row of kind `decided`** with:
   ```
   decision_source: 'policy_allow'
   approval_id:     null
   decided_by:      'policy'
   policy_digest:   <the snapshot digest already stored on the intent>
   ```
   then run the existing `execute()` body.
2. Everything downstream (`deliverResult`, result JSON, coverage, truncation) is unchanged **except** the payload now carries `decision: { source: 'policy_allow', policy_digest }` instead of `approval_id`, and always carries `run_id` (§2.5).
3. The `x-sameroof-*` / bearer handling is unchanged: the token still identifies the resident; the resident ceiling still applies.

`allow` never bypasses: sandbox probe (`GW-SANDBOX-UNAVAILABLE` still fails closed), root/mount checks, policy-digest match, per-resident rate limit (§2.6).

### 2.4 Living room: result contract with a policy decision

`/internal/gateway/results` today: `approval_id` required → look up approval by `request_id` → DM the resident with `meta: { approval_id, action, … }`.

Change to accept **either** form, validated:

| field | approval path (today) | policy path (new) |
|---|---|---|
| `request_id` | required, must match a known intent the living room saw at `/approval` time | required, but the living room has **never seen** this intent — so the gateway must have told it. See below. |
| `approval_id` | required, must resolve | absent |
| `decision.source` | `human` (implied) | `policy_allow` |
| `decision.policy_digest` | — | required; the living room checks it equals the house's **current lock digest** (it has it — `house.lock` is what the coordinator validates residents against). Mismatch → 409, result not delivered, audit `GW-RESULT-POLICY-STALE`. |

"The living room has never seen this intent": today the gateway posts approvals to the living room *before* execution (that's how the human gets the card). For the policy path there is no card. Two options; **I propose (b)**:

- (a) gateway posts a lightweight `intent_registered` notice to the living room first, then the result. Two round-trips, one more failure window.
- (b) the result POST is self-describing and **signed by the gateway service token** (it already is — the endpoint is internal and bearer-authenticated). The living room trusts the gateway's assertion `decision.source = policy_allow` because the gateway is the policy enforcer; it verifies `policy_digest` against the lock so a gateway running stale policy can't deliver. Idempotency key = `request_id` (already unique per intent).

The resident's result DM gains `meta.decision` and `meta.run_id`. The console's fold-out shows "policy" instead of "allowed by <human>". Nothing is hidden: humans still see every read and exec in the stream; they just weren't asked.

### 2.5 `run_id` end to end

`intents.run_id` exists in the gateway DB but `deliverResult` doesn't send it and the living room doesn't store it on the DM. Change: gateway includes `run_id` in the result payload; living room copies it to `meta.run_id`. Validation: `run_id` must match `^(run|sub)_[A-Za-z0-9_-]{6,40}$` and must equal the `run_id` the intent was registered with (the gateway has it; a mismatch is a gateway bug → 500, audited).

This is what lets the adapter distinguish its own foreground results from a subrun's, by a field the gateway vouches for — not by a string prefix the adapter invents (审查员 G4).

### 2.6 Rate limit for `allow`

A human-approved action is rate-limited by the human's patience. A policy-allowed action isn't. Add per-resident, per-action-class token buckets in the gateway: `allow_rate: { 'core.fs.read': 60/min, 'core.exec.ro': 20/min }` in `house.gateway`. Exceeding → `429 GW-RATE-LIMITED`, audited, result to the resident as a failure. Defaults conservative; a subrun's own budget (design doc §4.6) sits under this.

### 2.7 Visibility

- Audit: every policy-allowed execution has a `decided` row (`policy_allow`) and an `executed` row, same as human-approved ones. `sameroof doctor` gains a count of policy-allowed actions per resident per day.
- Console: result fold-outs show the decision source. A per-resident "policy-allowed today: N" counter in the agent detail panel (later; not blocking).
- `/admin/messages` already shows result DMs; they now carry `meta.decision`.

## 3. Test matrix (gateway + living room)

| # | case | expect |
|---|---|---|
| 1 | house `allow`, room unset, `core.fs.read` | executes, no approval card, audit `policy_allow`, result DM with `decision.source=policy_allow` |
| 2 | house `approve`, room `allow` | `sameroof check` error; gateway (if lock somehow passed) clamps to `approve` and audits `GW-POLICY-ROOM-EXCEEDS-CEILING` |
| 3 | house `allow`, room `approve` | awaiting_approval (room tightened) |
| 4 | house `allow`, room `deny` | 403 |
| 5 | `core.exec.ro` with `writable_root_ids: ['x']` | 400 GW-PARAMS-INVALID |
| 6 | `core.exec.ro` allow: `grep -rn recall packages/` in bwrap | stdout returned; `touch /tmp/x` inside works (tmpfs), `touch ./x` fails (ro-bind), `curl` fails (no net) — three negative asserts |
| 7 | `allow` but bwrap probe fails | 503, nothing runs |
| 8 | `allow` but intent policy digest ≠ current | refused, audited |
| 9 | living room receives policy result with stale `policy_digest` | 409, not delivered, audited |
| 10 | living room receives same `request_id` twice | second is idempotent no-op |
| 11 | `run_id` in result ≠ registered | 500, audited |
| 12 | rate limit: 21st `core.exec.ro` within a minute | 429, audited, resident gets failure result |
| 13 | approval path unchanged: `core.exec` with house `approve` | card, human decides, works as today (regression) |
| 14 | replay: approval for `core.exec.ro` digest presented to `core.exec` | GW-APPROVAL-MISMATCH |

## 4. What this does not change

- `deny` semantics, the approval flow for `approve`, the bwrap invocation, mount roots, the token model, the console's Allow/Deny card.
- This house's `house.yaml` — until this RFC is accepted, the code lands with tests, and 维护者 confirms the four-line policy in §2.2.

## 5. Estimate

| piece | estimate |
|---|---|
| ceiling algebra in gateway + `check`/`lock` validation + tests 2-4 | 0.5 d |
| `core.exec.ro` action + digest + tests 5-6 | 0.5 d |
| gateway `allow` path + audit + `run_id` in payload + tests 1, 7, 8, 11, 14 | 0.5 d |
| living-room result contract (policy path, digest check, idempotency) + tests 9-10, 13 | 0.5 d |
| rate limit + test 12 | 0.25 d |
| console decision-source label, doctor counter | 0.25 d |

**2.5 days.** Then gate. The subagent design (v3) starts only after this lands.

## 6. Questions for 审查员

1. §2.4 option (b) — trusting the gateway's self-asserted `policy_allow` with a lock-digest check, versus a two-phase notice. The gateway is already the single policy enforcer and the endpoint is service-token-authenticated; is the digest check enough, or do you want the living room to independently evaluate the ceiling from its own lock copy before accepting?
2. §2.2 — `core.exec.ro` as a distinct action name vs a conditional on `core.exec`. Distinct keeps the policy map flat; conditional would let `core.exec: {ro: allow, rw: approve}` and generalise to future `core.fs.write.own-room`-style scopes. Your call.
3. §2.6 rate limits — should the budget live in the gateway (this RFC), the broker-style ledger, or both?
