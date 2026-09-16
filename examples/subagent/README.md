# Subagent V0 — what it is, what it isn't, how to turn it on

A resident on the `broker-direct` runtime can hand a scoped, read-only job to a **subrun**: a nested model→tool loop inside its own adapter process, using its own credentials, that reports a conclusion back through a local mailbox. No new identity, no new token, no coordinator involvement. Design and the three-harness comparison (Claude Code / Codex / Kimi Code, read from source): [`docs/design/subagents.md`](../../docs/design/subagents.md).

## What a real run looks like

[`transcript-2026-09-16-researcher.txt`](transcript-2026-09-16-researcher.txt) is a subrun from this house, 2026-09-16, resident 检索员 (glm-5.3-flash through the broker), zero human clicks:

```
规划员 --DM--> 检索员: "查 packages 里哪些文件写了 readOutput( ？要文件名和行号，私信我。"
检索员 replies (public part): "重派，出了清单私信你"
                (stripped): SUB: 递归搜索 … | 带上: … | 工具: core.exec.ro,core.fs.read
   subrun: grep -rn (exit 2: one fixture unreadable) → retry with rc capture → succeeded, 5340 bytes → summary
   34 s · 4 model calls · 3 tool calls · policy_allow on every intent
检索员 wakes on the mailbox item, DMs 规划员: 29 matches in 6 files (ground truth: 29) —
   and flags the one unreadable file as "technically unverified", not as "no match".
```

The first attempt of the same task, before the gateway had the new schema, was refused six times (`503 GW-POLICY-DENIED`, fail-closed). 检索员's report then read: *"交不了活，先交实话：不是没匹配，是搜索压根没跑成。"* That is the behaviour we want under failure.

## Turn it on

1. The gateway RFC must be deployed: `core.fs.read: allow` and `core.exec.ro: allow` in `house.yaml`, a read-only mount for the code (`exclude: [rooms]`), and — if residents may look at each other's rooms with approval — a second mount with `gate: approve`. See `docs/rfc/2026-09-15-gateway-allow.md` and this house's `house.yaml`.
2. In the resident's `room.yaml` (or `house.yaml → defaults`):
   ```yaml
   subagent: {enabled: true, max_parallel: 2, tools: [core.fs.read, core.exec.ro], budget: {model_calls: 15, tool_calls: 20, minutes: 10}}
   ```
3. The resident's **broker token must carry purpose `subagent`**. `sameroof serve` does this when it issues tokens; for a systemd deployment re-issue explicitly:
   ```
   sameroof-broker token issue <resident_id> --credential <alias> --models <id> --purposes interactive,heartbeat,subagent --ttl 168h --replace
   ```
   (run it with the broker service's `SAMEROOF_STATE_DIR`, or you'll write to the wrong DB — see `deploy/`.)
4. Restart the adapter (`sameroof-room@<resident_id>`). The system prompt now tells the model about `SUB:`.

## The directive

```
SUB: <task in one line> | 带上: <everything the subrun needs to know> | 引用: msg_id,path | 工具: core.exec.ro,core.fs.read | 预算: 15/20/10 | 继承: N
```

- `带上:` is **required** unless `继承: N` (inherit the parent's last N rendered lines). Zero context is the default — the same choice as Claude Code, Codex v1 and Kimi Code.
- Tools available to a subrun: only `core.fs.read` and `core.exec.ro`, and only where the house policy is `allow`. Anything that would need a human (`approve`) is refused immediately with a reason; the parent can ask for it itself with `APPROVAL:`.
- The `SUB:` line is stripped from the public reply. Humans see the subrun's gateway calls as `policy` / `subrun` badges in the console and the full transcript at `rooms/<name>/state/subruns/<sub_id>.jsonl`.

## What it does not do (V0)

- Only `broker-direct` residents. `claude-code` and `pi` residents get a note that `SUB:` isn't supported by their adapter.
- No nesting (a subrun can't `SUB:`). No writes. No waiting for approvals. No cross-resident delegation (that's `PIN:`).
- The mailbox guarantees **at-least-once presentation**: after a crash the parent may see a result twice, marked `（上一轮已尝试处理：…）`. It never guarantees the parent spoke exactly once.

## Tests that prove it

- `packages/adapters/test/subagent-e2e.test.js` — real coordinator, real gateway with bwrap, real `run()`, scripted model. Asserts: no approval card, human message answered mid-subrun, subrun's result DM never reaches the parent prompt, mailbox consumed on `say`, gateway audit `policy_allow` with `run_id = sub_id`.
- `packages/adapters/test/subagent.test.js` (9), `subrun-manager.test.js` (4), `mailbox.test.js` (3).
