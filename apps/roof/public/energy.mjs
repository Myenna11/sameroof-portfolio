// Pure presentation model: never infer an account or a context limit from a model name.
export const reading = (value) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
export function dayKey(value, timezone) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  return ["year", "month", "day"]
    .map((k) => parts.find((p) => p.type === k).value)
    .join("-");
}
export function buildEnergy({
  resident,
  quota,
  runs = [],
  timezone = "UTC",
  now = Date.now(),
  limit = 500,
  errors = {},
  context = null,
  demo = false,
}) {
  try {
    dayKey(now, timezone);
  } catch {
    timezone = "UTC";
  }
  const today = dayKey(now, timezone);
  const dates = Array.from({ length: 7 }, (_, i) =>
    new Date(Date.parse(today + "T12:00:00Z") - (6 - i) * 86400000)
      .toISOString()
      .slice(0, 10),
  );
  const days = dates.map((day) => ({
    day,
    runs: 0,
    measured: 0,
    tokens: null,
    input: null,
    output: null,
    incomplete: 0,
  }));
  const add = (row, key, value) => {
    if (value !== null) row[key] = (row[key] ?? 0) + value;
  };
  for (const run of runs) {
    // Older records without an owner cannot be assigned safely.
    if (run.resident_id !== resident.id) continue;
    const d = days.find((d) => d.day === dayKey(run.ts, timezone));
    if (!d) continue;
    d.runs++;
    const u = run.usage || {};
    const input = reading(u.prompt_tokens ?? u.input_tokens);
    const output = reading(u.completion_tokens ?? u.output_tokens);
    const total =
      reading(u.total_tokens) ??
      (input !== null && output !== null ? input + output : null);
    // Cached tokens are already part of input, not an extra charge.
    if (total !== null) d.measured++;
    else d.incomplete++;
    add(d, "tokens", total);
    add(d, "input", input);
    add(d, "output", output);
  }
  const accounts = (quota?.providers || [])
    .filter(
      (p) => Array.isArray(p.residents) && p.residents.includes(resident.name),
    )
    .map((p) => {
      const asOf = p.stale ? p.staleSince : p.fetchedAt || quota.fetched_at;
      const age = now - Date.parse(asOf);
      const stale = !!(p.stale || p.staleExpired || age > 20 * 60000);
      return {
        label: p.label || p.provider,
        status: p.status === "ok" ? "ok" : "error",
        stale,
        expired: !!p.staleExpired || age > 20 * 60000,
        asOf: Number.isFinite(Date.parse(asOf)) ? asOf : null,
        message: p.message || null,
        // Existing API identifies provider associations, not credential/account pools.
        scope: demo ? "演示专属账户" : "供应商额度 · 账户归属未核实",
        peers: p.residents.filter((n) => n !== resident.name),
        windows: (p.windows || []).map((w) => ({
          label: w.label || "用量窗口",
          usedPercent:
            reading(w.usedPercent) !== null && w.usedPercent <= 100
              ? w.usedPercent
              : null,
          resetAt: Number.isFinite(Date.parse(w.resetAt)) ? w.resetAt : null,
          resetHint: w.resetHint || null,
        })),
      };
    });
  const used = reading(context?.usedTokens),
    capacity = reading(context?.limitTokens);
  return {
    resident: { id: resident.id, name: resident.name },
    demo,
    accounts,
    errors,
    personal: {
      days,
      today: days.at(-1),
      timezone,
      limit,
      capped: runs.length >= limit,
      source: "住户运行日志 · 已记录部分，不等于账户总用量",
    },
    context:
      used !== null && capacity !== null && capacity > 0 && used <= capacity
        ? {
            status: "ok",
            usedTokens: used,
            limitTokens: capacity,
            usedPercent: (used / capacity) * 100,
            source: context.source,
            asOf: context.asOf,
          }
        : {
            status: "unavailable",
            message:
              "当前运行时未提供可核对的会话上下文读数；不以累计 token 或模型宣传窗口代替。",
          },
  };
}
