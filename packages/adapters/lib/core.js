// Same Roof · Adapter Core (EXPERIMENTAL)
//
// STATUS: This is the target architecture for adapters, not yet the one in production.
// The three shipping runtimes (broker-direct, claude-code, pi) still use lib/room.js.
// See docs/ARCHITECTURE.md "Adapter" section for migration status.
//
// The minimal agent loop: connect → receive → think → respond.
// Everything else (heartbeat, cron, blackboard, memory, handover) is a plugin.
//
// Guarantees this core DOES provide:
//   - think() runs serially per agent (messages queue; no concurrent think calls)
//   - a plugin that throws, or doesn't settle within pluginTimeoutMs, is logged and skipped; the loop continues.
//     Timeout = we stop waiting. It does NOT cancel the plugin's work unless the plugin honours the AbortSignal it's given.
//   - SSE reconnect with backoff
// Guarantees it does NOT yet provide (room.js does): inbox catch-up after reconnect,
//   ack-after-deliver ordering, watchdog on all HTTP I/O, lane priority, routines.

'use strict';
const http = require('http');

// ---- HTTP helpers (no external deps) ----

function apiCall(base, token, method, path, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(path, base);
    const payload = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search, method,
      headers: { authorization: `Bearer ${token}`, ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}) }
    }, res => {
      let s = ''; res.on('data', c => s += c);
      res.on('end', () => { try { resolve(JSON.parse(s)); } catch { resolve(s); } });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function connectSSE(url, token, onMessage, onError) {
  const u = new URL(url);
  const req = http.request({
    hostname: u.hostname, port: u.port, path: u.pathname, method: 'GET',
    headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' }
  }, res => {
    let buf = '';
    res.on('data', chunk => {
      buf += chunk;
      const parts = buf.split('\n\n');
      buf = parts.pop();
      for (const part of parts) {
        const match = part.match(/^data:\s*(.*)/m);
        if (match && match[1] && !match[1].startsWith(':')) {
          try { onMessage(JSON.parse(match[1])); } catch {}
        }
      }
    });
    res.on('end', () => onError && onError(new Error('SSE closed')));
  });
  req.on('error', e => onError && onError(e));
  req.end();
  return { close: () => req.destroy() };
}

// ---- Core adapter ----

/**
 * @param {object}   opts
 * @param {string}   opts.coordinatorUrl
 * @param {string}   opts.token
 * @param {string}   opts.agentId
 * @param {string}   opts.agentName
 * @param {string}   opts.soul          - SOUL.md content
 * @param {function} opts.think         - async (system, user) => string
 * @param {object[]} [opts.plugins]     - array of { name, onWake?, onMessage?, beforeThink?, afterThink?, onSleep? }
 * @param {AbortSignal} [opts.signal]
 */
async function createAdapter(opts) {
  const { coordinatorUrl, token, agentId, agentName, soul, think, plugins = [], signal, pluginTimeoutMs = 10000 } = opts;
  const api = (method, path, body) => apiCall(coordinatorUrl, token, method, path, body);

  // withTimeout: stop WAITING after ms. This does not cancel the underlying work — a plugin that ignores
  // the AbortSignal keeps running and may still produce side effects. The timer is always cleared
  // (no event-loop leak) and unref'd (can't keep the process alive on its own).
  const withTimeout = (promise, ms, label, ac) => {
    let t;
    const timeout = new Promise((_, rej) => { t = setTimeout(() => { ac.abort(new Error(label + ' timed out after ' + ms + 'ms')); rej(ac.signal.reason); }, ms); t.unref(); });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
  };
  // Run one plugin hook with isolation: errors and timeouts are logged and yield undefined, never throw.
  // The hook receives { signal } in its last arg so cooperative plugins can stop early.
  const runHook = async (p, name, ...args) => {
    const label = `plugin "${p.name || '?'}".${name}`;
    const ac = new AbortController();
    const last = args[args.length - 1];
    const argsWithSignal = (last && typeof last === 'object' && !Array.isArray(last)) ? [...args.slice(0, -1), { ...last, signal: ac.signal }] : [...args, { signal: ac.signal }];
    try { return await withTimeout(Promise.resolve(p[name](...argsWithSignal)), pluginTimeoutMs, label, ac); }
    catch (e) { console.error(`[${agentName}] ${label} failed: ${e.message}`); return undefined; }
  };
  const hook = async (name, ...args) => {
    const results = [];
    for (const p of plugins) {
      if (typeof p[name] !== 'function') continue;
      results.push({ plugin: p, result: await runHook(p, name, ...args) });
    }
    return results;
  };
  hook.one = async (p, name, ...args) => [await runHook(p, name, ...args)];

  // Serial queue: one think() at a time per agent. SSE can deliver faster than the model responds.
  const queue = [];
  let draining = false;
  const drain = async () => {
    if (draining) return; draining = true;
    while (queue.length && !signal?.aborted) {
      const msg = queue.shift();
      try { await handle(msg); } catch (e) { console.error(`[${agentName}] handle failed: ${e.message}`); }
    }
    draining = false;
  };

  const handle = async (msg) => {
    // Plugin hooks: onMessage (any can veto by returning false)
    const vetoes = await hook('onMessage', msg, api);
    if (vetoes.some(v => v.result === false)) return;

    // Build prompts — beforeThink hooks CHAIN: each sees the previous one's output
    let system = soul || '', user = msg.text || '';
    for (const p of plugins) {
      if (typeof p.beforeThink !== 'function') continue;
      const [r] = await hook.one(p, 'beforeThink', { system, user, message: msg, api });
      if (r && typeof r === 'object') { system = r.system ?? system; user = r.user ?? user; }
    }

    // Think
    const response = await think(system, user);

    // Plugin hooks: afterThink
    await hook('afterThink', { message: msg, response, api });

    // Respond (skip silent)
    if (response && !['(静默)', '(silent)', ''].includes(String(response).trim())) {
      await api('POST', '/say', { text: response });
    }
  };

  // SSE connection
  let sse = null;
  const connect = () => {
    sse = connectSSE(coordinatorUrl + '/events', token, (msg) => {
      // Skip own messages
      if (msg.from_id === agentId) return;
      // Is this for me?
      const forMe = msg.to_id === agentId ||
        (Array.isArray(msg.mentions) && msg.mentions.includes(agentId)) ||
        (msg.text && msg.text.includes('@' + agentName));
      if (!forMe && msg.kind === 'say') return;
      queue.push(msg); drain();
    }, (err) => {
      if (!signal?.aborted) {
        console.error(`[${agentName}] SSE error, reconnecting in 3s...`);
        setTimeout(connect, 3000);
      }
    });
  };

  connect();

  await hook('onWake', { api, agentId, agentName });

  console.log(`[${agentName}] adapter online (core), coordinator=${coordinatorUrl}`);

  // Wait for shutdown
  if (signal) {
    await new Promise(r => { if (signal.aborted) return r(); signal.addEventListener('abort', r, { once: true }); });
  } else {
    await new Promise(() => {});
  }

  // Cleanup
  if (sse) sse.close();
  await hook('onSleep', { api, agentId, agentName });
  console.log(`[${agentName}] adapter offline`);
}

module.exports = { createAdapter, apiCall, connectSSE };
