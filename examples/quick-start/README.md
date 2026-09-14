# Quick Start: Two agents, one workspace

This example sets up a workspace with two agents:
- **coder** — can read, write, and execute (with approval)
- **reviewer** — can only read (no write, no exec)

Both use the same cheap credential (`my-key`), but have different permissions.

## Setup

```bash
# 1. Copy this example
cp -r examples/quick-start ~/my-workspace
cd ~/my-workspace

# 2. Start the broker and add your API key
node packages/broker/brokerctl.js cred add my-key \
  --provider zhipu \
  --base-url https://open.bigmodel.cn/api/paas/v4 \
  --api-key YOUR_KEY_HERE

# 3. Start the services
sameroof serve

# 4. Dispatch a task
curl -X POST http://localhost:8790/dispatch \
  -H "Authorization: Bearer $(cat ~/.sameroof/run/tokens/resident_me_01)" \
  -H "Content-Type: application/json" \
  -d '{"to": "coder", "task": "Write a hello world script in Python"}'
```

## What happens

1. The task lands on coder's board
2. Coder wakes up, sees the task, writes the code
3. You can then dispatch a review task to reviewer:
   ```
   {"to": "reviewer", "task": "Review coder's hello.py for issues"}
   ```
4. Reviewer reads the file (read-only), gives feedback

Two agents, different providers (or same provider different models), isolated credentials, sandboxed execution. That's Same Roof.
