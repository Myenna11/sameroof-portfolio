"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
let server, upstream, base, root, mod;
const listen = (s) =>
  new Promise((r) => s.listen(0, "127.0.0.1", () => r(s.address().port)));
before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "roof-test-"));
  await fs.mkdir(path.join(root, "state"));
  await fs.mkdir(path.join(root, "rooms", "Test", "state", "subruns"), {
    recursive: true,
  });
  await fs.writeFile(
    path.join(root, "state", "shift-resident_test_01.jsonl"),
    JSON.stringify({ role: "system", content: "private system prompt" }) +
      "\n" +
      JSON.stringify({
        op: "msg",
        role: "assistant",
        content: "Bearer secret-value token=abcd",
      }) +
      "\n",
  );
  await fs.writeFile(
    path.join(root, "rooms", "Test", "state", "subruns", "sub_test.jsonl"),
    JSON.stringify({
      ev: "tool_register",
      params: { api_key: "private-key", path: "src/example.js" },
    }) + "\n",
  );
  upstream = http.createServer((req, res) => {
    const auth = req.headers.authorization;
    res.setHeader("content-type", "application/json");
    if (!["Bearer human", "Bearer agent"].includes(auth)) {
      res.writeHead(401);
      res.end(JSON.stringify({ error: { message: "Unauthorized" } }));
      return;
    }
    if (req.url === "/me")
      return res.end(
        JSON.stringify({
          id: "resident_test_01",
          species: auth.endsWith("human") ? "human" : "agent",
        }),
      );
    if (req.url === "/members")
      return res.end(
        JSON.stringify([
          { id: "resident_test_01", name: "Test", species: "agent" },
        ]),
      );
    if (req.url === "/say") {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () =>
        res.end(JSON.stringify({ received: JSON.parse(data), auth })),
      );
      return;
    }
    res.writeHead(404);
    res.end("{}");
  });
  const port = await listen(upstream);
  process.env.ROOF_UPSTREAM = `http://127.0.0.1:${port}`;
  process.env.SAMEROOF_ROOT = root;
  mod = require("./server.cjs");
  server = mod.createServer();
  base = `http://127.0.0.1:${await listen(server)}`;
});
after(async () => {
  await Promise.all([
    new Promise((r) => server.close(r)),
    new Promise((r) => upstream.close(r)),
  ]);
  await fs.rm(root, { recursive: true, force: true });
});
test("public shell works, private data requires bearer and ignores query credentials", async () => {
  const r = await fetch(base + "/");
  assert.equal(r.status, 200);
  assert.match(await r.text(), /Same Roof/);
  assert.match(
    r.headers.get("content-security-policy"),
    /frame-ancestors 'none'/,
  );
  for (const url of [
    "/api/members",
    "/api/work?resident=resident_test_01",
    "/api/members?token=human",
  ])
    assert.equal((await fetch(base + url)).status, 401);
});
test("internal APIs and filesystem paths are not forwarded", async () => {
  for (const url of [
    "/api/internal/gateway/decisions",
    "/api/admin/messages",
    "/server.cjs",
    "/../server.cjs",
  ])
    assert.equal(
      (await fetch(base + url, { headers: { authorization: "Bearer human" } }))
        .status,
      404,
    );
});
test("work endpoints require freshly validated human identity", async () => {
  for (const [token, status] of [
    ["wrong", 401],
    ["agent", 403],
  ])
    assert.equal(
      (
        await fetch(base + "/api/work?resident=resident_test_01", {
          headers: { authorization: "Bearer " + token },
        })
      ).status,
      status,
    );
});
test("session records omit system prompts and redact known credential syntax", async () => {
  const r = await fetch(base + "/api/work?resident=resident_test_01", {
    headers: { authorization: "Bearer human" },
  });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.events.length, 1);
  assert.doesNotMatch(
    JSON.stringify(body),
    /secret-value|private system prompt|abcd/,
  );
  assert.match(JSON.stringify(body), /redacted/);
});
test("resident selection cannot become a path or a journalctl argument", async () => {
  for (const rid of ["../test", "resident_test_01;id", "--system"])
    assert.equal(
      (
        await fetch(base + "/api/work?resident=" + encodeURIComponent(rid), {
          headers: { authorization: "Bearer human" },
        })
      ).status,
      400,
    );
});
test("subrun records are bounded, source-labelled, and recursively redacted", async () => {
  const r = await fetch(
    base + "/api/work?resident=resident_test_01&kind=subruns",
    { headers: { authorization: "Bearer human" } },
  );
  const body = await r.json();
  assert.equal(body.items.length, 1);
  assert.equal(body.items[0].events[0].params.api_key, "[redacted]");
  assert.equal(body.items[0].events[0].params.path, "src/example.js");
});
test("message proxy preserves request body and original authorization", async () => {
  const r = await fetch(base + "/api/say", {
    method: "POST",
    headers: {
      authorization: "Bearer human",
      "content-type": "application/json",
    },
    body: JSON.stringify({ text: "Hello <script> nope" }),
  });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), {
    received: { text: "Hello <script> nope" },
    auth: "Bearer human",
  });
});
test("raw work surface cannot accept commands", async () => {
  assert.equal(
    (
      await fetch(base + "/api/work?resident=resident_test_01", {
        method: "POST",
        headers: { authorization: "Bearer human" },
        body: "whoami",
      })
    ).status,
    404,
  );
});
test("large files are explicitly marked partial", async () => {
  const file = path.join(root, "state", "large.jsonl");
  await fs.writeFile(file, "0123456789\n".repeat(60000));
  const result = await mod.boundedFile(file, path.join(root, "state"));
  assert.equal(result.truncated, true);
  assert.ok(result.text.length <= 512 * 1024);
});
test("redactor does not remove ordinary task IDs or text", () => {
  const source = {
    request_id: "req_abc123",
    text: "ordinary text",
    authorization: "sensitive",
    nested: [{ password: "sensitive" }],
  };
  const r = mod.redact(source);
  assert.equal(r.request_id, source.request_id);
  assert.equal(r.text, source.text);
  assert.equal(r.authorization, "[redacted]");
  assert.equal(r.nested[0].password, "[redacted]");
});
