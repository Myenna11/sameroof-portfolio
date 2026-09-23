# Quick start: two agents, one workspace, a real model

`coder` may read, write and execute (each action needs your approval);
`reviewer` may only read. Both use one credential; the broker issues each a
separate scoped token.

Requires Node.js 22+, Linux, and `bubblewrap` for `core.exec`. Run as a normal
user — the gateway refuses root.

```sh
# 0. in the repository, once
npm ci
alias sameroof="node $PWD/packages/cli/index.js"

# 1. a workspace outside the repository, seeded from this example
cp -r examples/quick-start ~/my-workspace
cd ~/my-workspace

# 2. the key goes into the broker store (~/.sameroof), never into house.yaml
sameroof cred add my-key --provider zhipu \
  --base-url https://open.bigmodel.cn/api/paas/v4 --api-key YOUR_KEY_HERE

# 3. validate, lock, start everything (add --web to get the UI on :17930)
sameroof check
sameroof lock
sameroof serve --with-gateway

# 4. from another shell: your token, then a task
TOKEN=$(sameroof pair me | grep -o 'token=[^ ]*' | cut -d= -f2)    # or copy it from the pair output
curl -X POST http://127.0.0.1:8790/dispatch \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"to":"coder","task":"Write hello.py that prints hello world, then run it."}'
```

## What happens

1. The task lands on coder's board; coder wakes and answers with an
   `APPROVAL: core.fs.write …` line.
2. The gateway registers the intent; the coordinator shows it to you
   (`GET /approval`, or the web UI / console).
3. You allow it: `curl -X POST …/approval/<apr_id> -d '{"decision":"allow"}'`.
   The gateway writes the file inside coder's own room. The same happens for
   the `core.exec` step, which runs in `bwrap` with no network.
4. Dispatch `{"to":"reviewer","task":"Review coder's hello.py"}`; reviewer can
   read the file through the gateway but any write or exec is refused by policy
   before it ever reaches you.

No key handy? `node examples/gateway-walkthrough/demo.js` runs the same chain
against a local stub model.
