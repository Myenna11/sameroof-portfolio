"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "public/app.js"), "utf8");
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((r, j) => {
    resolve = r;
    reject = j;
  });
  return { promise, resolve, reject };
};
function ui() {
  const input = { value: "", focus() {} },
    button = { disabled: false };
  const form = { querySelector: () => button };
  const elements = {
    "#compose": input,
    "#compose-form button": button,
    "#overlay": { innerHTML: "" },
  };
  const context = vm.createContext({
    makeDemo: () => ({
      members: [{ id: "A", name: "Alpha", species: "agent" }],
      messages: [],
      tasks: [],
      runs: [],
      activity: [],
      approvals: [],
      memory: [],
      me: { id: "human" },
    }),
    sessionStorage: { getItem: () => "", removeItem() {}, setItem() {} },
    document: {
      querySelector: (q) => elements[q] || null,
      activeElement: null,
    },
    setTimeout,
    clearTimeout,
    AbortController,
    AbortSignal,
    URL,
    console,
    location: { href: "https://example.test/sameroof/", hash: "" },
  });
  // Execute the shipping functions, without registering DOM/timer startup hooks.
  vm.runInContext(
    source
      .replace(/^import .*;\r?\n/gm, "")
      .split('document.addEventListener("keydown"')[0],
    context,
  );
  vm.runInContext("render = () => {}; toast = () => {};", context);
  const app = vm.runInContext(
    "({state,send,loadDM,loadMemory,refresh,connect,enterDemo})",
    context,
  );
  app.state.demo = false;
  app.state.token = "fixture";
  app.state.room = "A";
  app.state.dm = [];
  return {
    ...app,
    input,
    button,
    form,
    setApi(fn) {
      context.fakeApi = fn;
      vm.runInContext("api = fakeApi", context);
    },
  };
}
test("delayed send never inserts A response into B or clears B draft", async () => {
  const a = ui(),
    d = deferred();
  a.setApi(() => d.promise);
  a.input.value = "for A";
  const p = a.send(a.form);
  a.state.drafts.A = "for A";
  a.state.room = "B";
  a.state.dm = [];
  a.input.value = "unfinished B";
  d.resolve({ id: "m1", to_id: "A", text: "for A" });
  await p;
  assert.equal(a.state.dm.length, 0);
  assert.equal(a.input.value, "unfinished B");
  assert.equal(a.state.drafts.B, "unfinished B");
  assert.equal(a.state.drafts.A, "");
});
test("disconnect discards late real send response and errors", async () => {
  for (const fail of [false, true]) {
    const a = ui(),
      d = deferred();
    a.setApi(() => d.promise);
    a.input.value = "private";
    const p = a.send(a.form);
    a.enterDemo();
    fail
      ? d.reject(new Error("private failure"))
      : d.resolve({ id: "m1", text: "private" });
    await p;
    assert.equal(a.state.demo, true);
    assert.equal(a.state.dm.length, 0);
    assert.equal(a.state.messages.length, 0);
  }
});
test("duplicate submit is blocked; newer typing survives successful send", async () => {
  const a = ui(),
    d = deferred();
  let calls = 0;
  a.setApi(() => {
    calls++;
    return d.promise;
  });
  a.input.value = "first";
  const p = a.send(a.form);
  await a.send(a.form);
  a.input.value = "next draft";
  d.resolve({ id: "m1", text: "first" });
  await p;
  assert.equal(calls, 1);
  assert.equal(a.state.dm.length, 1);
  assert.equal(a.state.drafts.A, "next draft");
  assert.equal(a.button.disabled, false);
});
test("SSE/history containing the confirmed send is not duplicated", async () => {
  const a = ui(),
    d = deferred();
  a.setApi(() => d.promise);
  a.input.value = "first";
  const p = a.send(a.form);
  a.state.dm = [{ id: "m1", text: "first" }];
  d.resolve({ id: "m1", text: "first" });
  await p;
  assert.equal(a.state.dm.length, 1);
});
test("older memory failure cannot erase newly selected memory", async () => {
  const a = ui(),
    d = deferred();
  a.state.memoryResident = "A";
  a.setApi(() => d.promise);
  const p = a.loadMemory();
  a.state.memoryResident = "B";
  a.state.memory = [{ content: "B" }];
  d.reject(new Error("A failed"));
  await p;
  assert.equal(a.state.memory[0].content, "B");
  assert.equal(a.state.errors.memory, undefined);
});
test("out-of-order DM requests keep the newest snapshot", async () => {
  const a = ui(),
    old = deferred(),
    fresh = deferred();
  let calls = 0;
  a.setApi(() => (++calls === 1 ? old.promise : fresh.promise));
  const p = a.loadDM(),
    q = a.loadDM();
  fresh.resolve([{ id: "new" }]);
  await q;
  old.resolve([{ id: "old" }]);
  await p;
  assert.equal(a.state.dm[0].id, "new");
});
test("polling refresh includes selected DM without SSE", async () => {
  const a = ui(),
    calls = [];
  a.setApi(async (route) => {
    calls.push(route);
    return route.startsWith("/dm/history") ? [{ id: "new" }] : [];
  });
  await a.refresh();
  assert.ok(calls.some((x) => x.startsWith("/dm/history?with=A")));
  assert.equal(a.state.dm[0].id, "new");
});
test("disconnect while connecting cannot restore a real session", async () => {
  const a = ui(),
    d = deferred();
  a.setApi(() => d.promise);
  const p = a.connect("candidate");
  a.enterDemo();
  d.resolve({ id: "human", species: "human" });
  await p;
  assert.equal(a.state.demo, true);
  assert.equal(a.state.token, "");
});

test("obsolete connection failure cannot trigger fallback over a newer session", async () => {
  const a = ui(),
    d = deferred();
  a.setApi(() => d.promise);
  const p = a.connect("obsolete");
  a.state.generation++;
  a.state.token = "newer";
  d.reject(new Error("old request failed"));
  await p;
  assert.equal(a.state.token, "newer");
});
