"use strict";
// Independent UI gateway. Existing house authorization remains authoritative.
const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const exec = promisify(execFile);
const ROOT = process.env.SAMEROOF_ROOT || "/root/sameroof";
const UPSTREAM = process.env.ROOF_UPSTREAM || "http://127.0.0.1:8790";
const STATIC = path.join(__dirname, "public");
const assets = {
  "/": ["index.html", "text/html"],
  "/app.js": ["app.js", "text/javascript"],
  "/style.css": ["style.css", "text/css"],
  "/demo.js": ["demo.js", "text/javascript"],
  "/icon.svg": ["icon.svg", "image/svg+xml"],
  "/manifest.webmanifest": [
    "manifest.webmanifest",
    "application/manifest+json",
  ],
};
const routes = [
  /^\/(me|members|history|dm\/history|activity|quota|runs|search|events)$/,
  /^\/(say|dm|dispatch|tasks|approval)$/,
  /^\/tasks\/task_[a-z0-9]+$/,
  /^\/approval\/apr_[a-f0-9]{24}$/,
  /^\/rooms\/[^/]+(?:\/(memory|handover|concerns|notes|runs|budget))?$/,
];
const headers = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
  "content-security-policy":
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};
function redact(value) {
  if (typeof value === "string")
    return value
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
      .replace(/\b(Bearer\s+)[^\s"'<>]+/gi, "$1[redacted]")
      .replace(
        /\b(?:sk-[a-zA-Z0-9_-]{12,}|gh[pousr]_[a-zA-Z0-9_]{12,}|ghs_[a-zA-Z0-9_]{12,})/g,
        "[redacted]",
      )
      .replace(
        /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|authorization|token)\s*["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi,
        "$1[redacted]",
      );
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        /^(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|authorization|token)$/i.test(
          k,
        )
          ? "[redacted]"
          : redact(v),
      ]),
    );
  return value;
}
function json(res, status, body) {
  res.writeHead(status, {
    ...headers,
    "content-type": "application/json; charset=utf-8",
  });
  res.end(JSON.stringify(body));
}
async function upstream(url, auth) {
  const r = await fetch(UPSTREAM + url, {
    headers: { authorization: auth },
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok)
    throw Object.assign(
      new Error(
        r.status === 401 ? "请使用房子的配对令牌连接。" : "无法读取房子数据。",
      ),
      { status: r.status },
    );
  return r.json();
}
async function boundedFile(file, base) {
  const real = await fs.realpath(file),
    root = await fs.realpath(base);
  if (!real.startsWith(root + path.sep)) throw new Error("Invalid file path");
  const handle = await fs.open(real, "r");
  try {
    const st = await handle.stat();
    if (!st.isFile()) throw new Error("Not a file");
    const count = Math.min(st.size, 512 * 1024);
    const buf = Buffer.alloc(count);
    const { bytesRead } = await handle.read(buf, 0, count, st.size - count);
    let text = buf.subarray(0, bytesRead).toString("utf8");
    if (st.size > count) text = text.slice(text.indexOf("\n") + 1);
    return { text, truncated: st.size > count };
  } finally {
    await handle.close();
  }
}
async function work(url, auth) {
  const me = await upstream("/me", auth);
  if (me.species !== "human")
    throw Object.assign(new Error("工作记录仅供家人查看。"), { status: 403 });
  const members = await upstream("/members", auth);
  const resident = members.find(
    (m) => m.id === url.searchParams.get("resident"),
  );
  if (
    !resident ||
    !/^resident_[a-zA-Z0-9_-]+$/.test(resident.id) ||
    !resident.name ||
    /[/\\]/.test(resident.name) ||
    resident.name === ".."
  )
    throw Object.assign(new Error("请选择一个住户。"), { status: 400 });
  const kind = url.searchParams.get("kind") || "session";
  if (kind === "terminal") {
    try {
      const { stdout } = await exec(
        "journalctl",
        [
          "--no-pager",
          "--output=short-iso",
          "--lines=1000",
          "-u",
          `sameroof-room@${resident.id}.service`,
          "-u",
          `sameroof-room-pi@${resident.id}.service`,
        ],
        {
          timeout: 6000,
          maxBuffer: 1024 * 1024,
          env: { PATH: process.env.PATH, LANG: "C.UTF-8" },
        },
      );
      return {
        source: "systemd journal · adapter stdout/stderr",
        raw: redact(stdout),
        limit: 1000,
        note: "最近 1000 行；敏感字段脱敏。只读日志，不向进程发送按键。",
      };
    } catch {
      return {
        source: "systemd journal",
        raw: "",
        unavailable: true,
        note: "此运行环境没有可读的终端日志。",
      };
    }
  }
  const stateDir = path.join(ROOT, "state");
  const roomState = path.join(ROOT, "rooms", resident.name, "state");
  if (kind === "subruns") {
    let files = [];
    try {
      files = await fs.readdir(path.join(roomState, "subruns"));
    } catch {}
    const items = [];
    for (const file of files
      .filter((f) => /^sub_[a-zA-Z0-9_-]+\.jsonl$/.test(f))
      .sort()
      .reverse()
      .slice(0, 30)) {
      try {
        const data = await boundedFile(
          path.join(roomState, "subruns", file),
          roomState,
        );
        const events = data.text
          .split("\n")
          .filter(Boolean)
          .flatMap((l) => {
            try {
              return [redact(JSON.parse(l))];
            } catch {
              return [];
            }
          });
        items.push({
          id: file.slice(0, -6),
          events,
          truncated: data.truncated,
        });
      } catch {}
    }
    return {
      source: "resident state/subruns/*.jsonl",
      items,
      note: "历史 transcript 只保存部分模型回复和工具元数据；缺失的 stdout 不会补造。",
    };
  }
  try {
    const data = await boundedFile(
      path.join(stateDir, `shift-${resident.id}.jsonl`),
      stateDir,
    );
    const events = data.text
      .split("\n")
      .filter(Boolean)
      .flatMap((l) => {
        try {
          const row = JSON.parse(l);
          return row.role === "system" ? [] : [redact(row)];
        } catch {
          return [];
        }
      });
    return {
      source: "active shift JSONL",
      events,
      truncated: data.truncated,
      note: "当前班次已持久化记录；system 提示词省略，敏感字段脱敏。CLI 运行时可能没有此类记录。",
    };
  } catch {
    return {
      source: "active shift JSONL",
      events: [],
      unavailable: true,
      note: "当前运行时没有可读取的班次记录，可切换到终端日志。",
    };
  }
}
function createServer() {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      if (url.pathname === "/health")
        return json(res, 200, { ok: true, app: "sameroof-roof" });
      if (url.pathname.startsWith("/api/")) {
        const target = url.pathname.slice(4);
        const auth = req.headers.authorization || "";
        if (!/^Bearer \S+$/.test(auth))
          return json(res, 401, {
            error: { message: "连接房子后才能读取私人数据。" },
          });
        if (target === "/work" && req.method === "GET")
          return json(res, 200, await work(url, auth));
        if (!routes.some((r) => r.test(target)))
          return json(res, 404, { error: { message: "没有这个接口。" } });
        const chunks = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 128 * 1024)
            return json(res, 413, { error: { message: "内容太长。" } });
          chunks.push(chunk);
        }
        const proxy = http.request(
          new URL(target + url.search, UPSTREAM),
          {
            method: req.method,
            headers: {
              authorization: auth,
              "content-type": "application/json",
              ...(size ? { "content-length": size } : {}),
            },
          },
          (remote) => {
            res.writeHead(remote.statusCode, {
              ...headers,
              "content-type":
                remote.headers["content-type"] || "application/json",
              "x-accel-buffering": "no",
            });
            remote.pipe(res);
          },
        );
        proxy.on("error", () => {
          if (!res.headersSent)
            json(res, 502, {
              error: { message: "房子暂时没有回应，请稍后重试。" },
            });
          else res.end();
        });
        proxy.setTimeout(target === "/events" ? 90000 : 25000, () =>
          proxy.destroy(),
        );
        res.on("close", () => proxy.destroy());
        proxy.end(Buffer.concat(chunks));
        return;
      }
      const asset = assets[url.pathname];
      if (!asset || req.method !== "GET")
        return json(res, 404, { error: { message: "Not found" } });
      res.writeHead(200, {
        ...headers,
        "content-type": asset[1] + "; charset=utf-8",
      });
      res.end(await fs.readFile(path.join(STATIC, asset[0])));
    } catch (e) {
      if (!res.headersSent)
        json(res, e.status || 500, {
          error: {
            message: e.status ? e.message : "暂时无法读取，请稍后重试。",
          },
        });
      else res.end();
    }
  });
}
if (require.main === module)
  createServer().listen(Number(process.env.PORT || 17930), "127.0.0.1", () =>
    console.log("Same Roof web listening on loopback"),
  );
module.exports = { createServer, redact, boundedFile };
