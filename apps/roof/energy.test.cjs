const { test } = require("node:test");
const assert = require("node:assert/strict");
const model = import("./public/energy.mjs");
const resident = { id: "resident_test_01", name: "Test" };
const now = Date.parse("2026-09-21T01:00:00Z");
const base = { resident, now, timezone: "Asia/Singapore" };

test("quota affiliation is explicit; never infer accounts from a provider name", async () => {
  const { buildEnergy } = await model;
  const result = buildEnergy({
    ...base,
    quota: {
      providers: [
        {
          label: "Unrelated",
          provider: "same-model",
          residents: ["Another"],
          windows: [{ usedPercent: 99 }],
        },
        {
          label: "Associated",
          residents: ["Test", "Shared candidate"],
          status: "ok",
          fetchedAt: new Date(now).toISOString(),
          windows: [{ usedPercent: 12 }],
        },
      ],
    },
  });
  assert.equal(result.accounts.length, 1);
  assert.match(result.accounts[0].scope, /未核实/);
  assert.deepEqual(result.accounts[0].peers, ["Shared candidate"]);
  assert.equal(result.personal.today.tokens, null);
});
test("null, invalid and missing readings never become zero; genuine zero survives", async () => {
  const { buildEnergy } = await model;
  const result = buildEnergy({
    ...base,
    quota: {
      providers: [
        {
          residents: ["Test"],
          windows: [null, "", -1, 101, 0, 35].map((usedPercent) => ({
            usedPercent,
          })),
        },
      ],
    },
  });
  assert.deepEqual(
    result.accounts[0].windows.map((w) => w.usedPercent),
    [null, null, null, null, 0, 35],
  );
  assert.equal(result.context.status, "unavailable");
});
test("stale data uses last successful timestamp, not the failed fetch time", async () => {
  const { buildEnergy } = await model;
  const result = buildEnergy({
    ...base,
    quota: {
      providers: [
        {
          residents: ["Test"],
          status: "error",
          stale: true,
          staleSince: "2026-09-20T20:00:00Z",
          fetchedAt: new Date(now).toISOString(),
          windows: [{ usedPercent: 25 }],
        },
      ],
    },
  });
  assert.equal(result.accounts[0].asOf, "2026-09-20T20:00:00Z");
  assert.equal(result.accounts[0].expired, true);
  assert.equal(result.accounts[0].windows[0].usedPercent, 25);
});
test("personal log aggregation respects resident, timezone and missing data without double-counting cache", async () => {
  const { buildEnergy } = await model;
  const rows = [
    {
      resident_id: resident.id,
      ts: "2026-09-20T17:00:00Z",
      usage: { input_tokens: 100, output_tokens: 20, cached_tokens: 80 },
    },
    { resident_id: resident.id, ts: "2026-09-20T17:01:00Z" },
    {
      resident_id: "other",
      ts: "2026-09-20T17:00:00Z",
      usage: { total_tokens: 999 },
    },
    { ts: "2026-09-20T17:00:00Z", usage: { total_tokens: 999 } },
    { resident_id: resident.id, ts: "bad", usage: { total_tokens: 999 } },
  ];
  const result = buildEnergy({ ...base, runs: rows, limit: 5 });
  assert.equal(result.personal.today.day, "2026-09-21");
  assert.equal(result.personal.today.tokens, 120);
  assert.equal(result.personal.today.input, 100);
  assert.equal(result.personal.today.runs, 2);
  assert.equal(result.personal.today.incomplete, 1);
  assert.equal(result.personal.capped, true);
  assert.equal(result.personal.days[0].tokens, null);
  assert.equal(result.context.status, "unavailable");
});
test("context is a separate explicit measurement, never derived from cumulative usage", async () => {
  const { buildEnergy } = await model;
  for (const c of [
    { usedTokens: 10 },
    { usedTokens: 10, limitTokens: 0 },
    { usedTokens: 101, limitTokens: 100 },
  ])
    assert.equal(
      buildEnergy({ ...base, context: c }).context.status,
      "unavailable",
    );
  assert.equal(
    buildEnergy({ ...base, context: { usedTokens: 20, limitTokens: 100 } })
      .context.usedPercent,
    20,
  );
});
test("each fictional resident has their own account and attributed demo readings", async () => {
  const fs = require("node:fs/promises");
  const path = require("node:path");
  const src = await fs.readFile(
    path.join(__dirname, "public", "demo.js"),
    "utf8",
  );
  const { makeDemo, demoEnergyInput } = await import(
    "data:text/javascript;base64," + Buffer.from(src).toString("base64")
  );
  const { buildEnergy } = await model;
  const demo = makeDemo();
  const panels = demo.members
    .filter((m) => m.species !== "human")
    .map((m) => buildEnergy(demoEnergyInput(m, demo.quota)));
  assert.equal(new Set(panels.map((p) => p.accounts[0].label)).size, 3);
  assert.equal(new Set(panels.map((p) => p.personal.today.tokens)).size, 3);
  for (const p of panels) {
    assert.equal(p.accounts.length, 1);
    assert.equal(p.accounts[0].peers.length, 0);
    assert.equal(p.demo, true);
  }
});
