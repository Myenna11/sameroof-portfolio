// Same Roof · Adapter Core
// The minimal agent loop: connect → receive → think → respond.
// Everything else (heartbeat, cron, blackboard, memory, handover) is a plugin.
//
// Design principle: this file should stay under 120 lines.
// If you're adding something here, ask: "Is this the message loop, or is it a plugin?"

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
  const { coordinatorUrl, token, agentId, agentName, soul, think, plugins = [], signal } = opts;
  const api = (method, path, body) => apiCall(coordinatorUrl, token, method, path, body);

  // SSE connection
  let sse = null;
  const connect = () => {
    sse = connectSSE(coordinatorUrl + '/events', token, async (msg) => {
      // Skip own messages
      if (msg.from_id === agentId) return;

      // Is this for me?
      const forMe = msg.to_id === agentId ||
        (Array.isArray(msg.mentions) && msg.mentions.includes(agentId)) ||
        (msg.text && msg.text.includes('@' + agentName));
      if (!forMe && msg.kind === 'say') return;

      // Plugin hooks: onMessage (any can skip by returning false)
      for (const p of plugins) {
        if (p.onMessage && (await p.onMessage(msg, api)) === false) return;
      }

      // Build prompts
      let system = soul || '', user = msg.text || '';
      for (const p of plugins) {
        if (p.beforeThink) {
          const m = await p.beforeThink({ system, user, message: msg, api });
          if (m) { system = m.system ?? system; user = m.user ?? user; }
        }
      }

      // Think
      const response = await think(system, user);

      // Plugin hooks: afterThink
      for (const p of plugins) {
        if (p.afterThink) await p.afterThink({ message: msg, response, api });
      }

      // Respond (skip silent)
      if (response && !['(静默)', '(silent)', ''].includes(response.trim())) {
        await api('POST', '/say', { text: response });
      }
    }, (err) => {
      if (!signal?.aborted) {
        console.error(`[${agentName}] SSE error, reconnecting in 3s...`);
        setTimeout(connect, 3000);
      }
    });
  };

  connect();

  // Plugin hooks: onWake
  for (const p of plugins) {
    if (p.onWake) await p.onWake({ api, agentId, agentName });
  }

  console.log(`[${agentName}] adapter online (core), coordinator=${coordinatorUrl}`);

  // Wait for shutdown
  if (signal) {
    await new Promise(r => { if (signal.aborted) return r(); signal.addEventListener('abort', r, { once: true }); });
  } else {
    await new Promise(() => {});
  }

  // Cleanup
  if (sse) sse.close();
  for (const p of plugins) {
    if (p.onSleep) await p.onSleep({ api, agentId, agentName }).catch(() => {});
  }
  console.log(`[${agentName}] adapter offline`);
}

module.exports = { createAdapter, apiCall, connectSSE };
