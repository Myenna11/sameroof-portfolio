"use strict";
// Real coordinator behind the shipping web proxy, synthetic identities only.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path");
const { createLivingRoom } = require("../../packages/living-room/server");
let root, room, web, base, options, human, agent, lrPort;
before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "roof-contract-"));
  for (const [name, species] of [
    ["Human", "human"],
    ["Agent", "agent"],
  ]) {
    const dir = path.join(root, "rooms", name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "room.yaml"),
      `id: resident_${name.toLowerCase()}_01\nname: ${name}\nspecies: ${species}\n`,
    );
  }
  fs.copyFileSync(
    path.join(__dirname, "../../packages/living-room/test/fixtures/house.yaml"),
    path.join(root, "house.yaml"),
  );
  options = {
    houseDir: root,
    runDir: path.join(root, "run"),
    dataDir: path.join(root, "state"),
    port: 0,
    authFailureLimit: 2,
    authBlockMs: 60000,
    sayLimit: 100,
  };
  room = createLivingRoom(options);
  lrPort = (await room.listen()).port;
  human = room.tokenStore.issue("resident_human_01").token;
  agent = room.tokenStore.issue("resident_agent_01").token;
  process.env.ROOF_UPSTREAM = "http://127.0.0.1:" + lrPort;
  process.env.SAMEROOF_ROOT = root;
  web = require("./server.cjs").createServer();
  await new Promise((r) => web.listen(0, "127.0.0.1", r));
  base = "http://127.0.0.1:" + web.address().port;
});
after(async () => {
  if (web) await new Promise((r) => web.close(r));
  if (room) await room.close();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});
async function request(
  route,
  { token = human, ip = "203.0.113.10", method = "GET", body } = {},
) {
  const r = await fetch(base + "/api" + route, {
    method,
    headers: {
      authorization: "Bearer " + token,
      "cf-connecting-ip": ip,
      "content-type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return {
    status: r.status,
    body: await r.json(),
    retry: r.headers.get("retry-after"),
  };
}
test("real auth limiter survives the web proxy and aggregate endpoints", async () => {
  for (const [i, route] of [
    "/me",
    "/work?resident=resident_agent_01",
    "/energy?resident=resident_agent_01",
  ].entries()) {
    const o = { token: "synthetic-invalid", ip: "203.0.113." + (30 + i) };
    assert.equal((await request(route, o)).status, 401);
    assert.equal((await request(route, o)).status, 429);
    assert.equal((await request("/me", { ...o, token: human })).status, 429);
  }
  assert.equal((await request("/me")).status, 200);
  assert.equal(
    (await request("/work?resident=resident_agent_01", { token: agent }))
      .status,
    403,
  );
});
test("real message retry is idempotent, payload-bound and resident-scoped, including restart", async () => {
  const key = "send_" + "a".repeat(32),
    body = { text: "one publication", client_request_id: key };
  const first = await request("/say", { method: "POST", body });
  assert.equal(first.status, 200);
  const again = await request("/say", { method: "POST", body });
  assert.equal(again.body.id, first.body.id);
  assert.equal(
    (
      await request("/say", {
        method: "POST",
        body: { ...body, text: "different" },
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await request("/dm", {
        method: "POST",
        body: { ...body, to: "resident_agent_01" },
      })
    ).status,
    409,
  );
  const other = await request("/say", { method: "POST", token: agent, body });
  assert.equal(other.status, 200);
  assert.notEqual(other.body.id, first.body.id);
  await room.close();
  room = createLivingRoom({ ...options, port: lrPort });
  await room.listen();
  assert.equal(
    (await request("/say", { method: "POST", body })).body.id,
    first.body.id,
  );
  const history = (await request("/history?limit=100")).body;
  assert.equal(
    history.filter(
      (m) => m.from_id === "resident_human_01" && m.text === body.text,
    ).length,
    1,
  );
});
test("real tasks and DM use the same frontend request/response contract", async () => {
  const task = await request("/tasks", {
    method: "POST",
    body: {
      title: "Contract task",
      owner: "resident_agent_01",
      notes: "fixture",
      accept: "done",
    },
  });
  assert.equal(task.status, 200);
  assert.equal(task.body.owner_id, "resident_agent_01");
  assert.equal(
    (
      await request("/tasks/" + task.body.id, {
        method: "PATCH",
        body: { state: "done", result: "verified" },
      })
    ).body.state,
    "done",
  );
  const dm = await request("/dm", {
    method: "POST",
    body: { to: "resident_agent_01", text: "direct fixture" },
  });
  assert.equal(dm.status, 200);
  assert.equal(dm.body.to_id, "resident_agent_01");
  assert.ok(
    (await request("/dm/history?with=resident_agent_01")).body.some(
      (m) => m.id === dm.body.id,
    ),
  );
  assert.ok(
    !(await request("/history?limit=100")).body.some(
      (m) => m.id === dm.body.id,
    ),
  );
});
