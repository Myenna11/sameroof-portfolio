// 同屋 CLI · 规划员的子命令：new / check / explain / pair / status。lock 归审查员（lock.js）。
'use strict';
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), { execSync } = require('node:child_process');
const YAML = require('yaml');
const { resolveHouseRoot } = require('@sameroof/house-root');
const h = opts => opts.house
  ? resolveHouseRoot(path.resolve(opts.house), { ...process.env, SAMEROOF_ROOT: path.resolve(opts.house) })
  : resolveHouseRoot();
const loadYaml = f => YAML.parse(fs.readFileSync(f, 'utf8'), { maxAliasCount: 50, uniqueKeys: true });
const rooms = root => fs.readdirSync(path.join(root, 'rooms')).map(d => path.join(root, 'rooms', d, 'room.yaml')).filter(fs.existsSync).map(f => ({ file: f, dir: path.dirname(f), ...loadYaml(f) }));
const slug = s => 'resident_' + (s.replace(/[^a-z0-9]+/gi, '').toLowerCase() || require('node:crypto').randomBytes(3).toString('hex')) + '_01';


/**
 * Stop child processes: SIGTERM, wait up to graceMs for real exit, SIGKILL survivors, confirm.
 * Liveness is exitCode/signalCode (child.killed only records that kill() was called).
 * Adapters are spawned detached:false so they share our process group; runtimes that fork their own
 * children (claude/pi CLIs) are expected to forward signals — we do not tree-kill here.
 */
async function stopChildren(children, { graceMs = 5000, confirmMs = 1000 } = {}) {
  const alive = c => c.exitCode === null && c.signalCode === null;
  const waitExit = (c, ms) => new Promise(res => {
    if (!alive(c)) return res(true);
    const t = setTimeout(() => { c.off('exit', done); res(false); }, ms);
    const done = () => { clearTimeout(t); res(true); };
    c.once('exit', done);
  });
  for (const c of children) if (alive(c)) { try { c.kill('SIGTERM'); } catch {} }
  await Promise.all(children.map(c => waitExit(c, graceMs)));
  const killed = [];
  for (const c of children) if (alive(c)) { killed.push(c.pid); try { c.kill('SIGKILL'); } catch {} }
  await Promise.all(children.map(c => waitExit(c, confirmMs)));
  const stillAlive = children.filter(alive).map(c => c.pid);
  return { killed, stillAlive };
}

/**
 * Dev-mode gateway for `sameroof serve --with-gateway`: one gateway child process per serve, wired to this coordinator.
 * Layout (all per workspace / per user, nothing under /run or /var):
 *   <runDir>/gateway/gateway.sock, <runDir>/gateway/tokens/<resident_id>   (adapter tokens, rotated on every serve)
 *   <runDir>/gateway-service.token                                        (coordinator ↔ gateway; the coordinator reads exactly this path)
 *   <root>/state/gateway/gateway.db                                       (intents, audit, adapter token hashes)
 * Same code path as the systemd deployment; only the paths and the process user differ. The gateway refuses root unless
 * allowRoot is set, and that flag only exists for single-user dev boxes.
 */
async function assertSocketAvailable(socketPath) {
  if (!fs.existsSync(socketPath)) return;
  if (!fs.lstatSync(socketPath).isSocket()) throw new Error('Refusing to replace a non-socket: ' + socketPath);
  await new Promise((resolve, reject) => {
    const socket = require('node:net').createConnection(socketPath);
    const finish = error => { socket.destroy(); error ? reject(error) : resolve(); };
    socket.setTimeout(1000, () => finish(new Error('Cannot establish ownership of socket: ' + socketPath)));
    socket.once('connect', () => finish(new Error('Another service already owns socket: ' + socketPath)));
    socket.once('error', e => finish(['ENOENT', 'ECONNREFUSED'].includes(e.code) ? null : e));
  });
}

async function startGateway({ root, runDir, port, allowRoot, agentIds, log, track }) {
  const crypto = require('node:crypto'), http = require('node:http');
  const { spawn } = require('node:child_process');
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (uid === 0 && !allowRoot) throw new Error('the gateway refuses to run as root. Run `sameroof serve` as an unprivileged user, or add --gateway-allow-root on a single-user dev box (never in production).');
  let entry;
  try { entry = require.resolve('@sameroof/gateway/server.js'); } catch { throw new Error('@sameroof/gateway is not installed (run `npm ci` in the repository root).'); }
  const { State, issueAdapterToken } = require(entry);
  const gwRun = path.join(runDir, 'gateway'), tokensDir = path.join(gwRun, 'tokens'), stateDir = path.join(root, 'state', 'gateway');
  const sock = path.join(gwRun, 'gateway.sock');
  await assertSocketAvailable(sock);
  fs.mkdirSync(tokensDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const serviceTokenFile = path.join(runDir, 'gateway-service.token');
  if (!fs.existsSync(serviceTokenFile)) {
    const tmp = serviceTokenFile + '.tmp';
    fs.writeFileSync(tmp, 'srv_' + crypto.randomBytes(32).toString('base64url') + '\n', { mode: 0o600 });
    fs.renameSync(tmp, serviceTokenFile);
  }
  fs.chmodSync(serviceTokenFile, 0o600);
  const state = new State(path.join(stateDir, 'gateway.db'));
  try { for (const id of agentIds) issueAdapterToken(state, tokensDir, id); } finally { state.close(); }
  const env = { ...process.env, SAMEROOF_ROOT: root, SAMEROOF_GATEWAY_RUN_DIR: gwRun, SAMEROOF_GATEWAY_STATE_DIR: stateDir, SAMEROOF_GATEWAY_SOCKET: sock, SAMEROOF_GATEWAY_SERVICE_TOKEN: serviceTokenFile, SAMEROOF_LIVING_ROOM_PORT: String(port) };
  if (allowRoot) env.SAMEROOF_GATEWAY_ALLOW_ROOT = '1';
  const child = spawn(process.execPath, [entry], { cwd: path.dirname(entry), stdio: ['ignore', 'inherit', 'inherit'], env });
  track('gateway', child, true);
  const health = () => new Promise(resolve => {
    const req = http.request({ socketPath: sock, path: '/health', method: 'GET', timeout: 1000 }, res => { let b = ''; res.on('data', c => b += c); res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } }); });
    req.on('error', () => resolve(null)); req.on('timeout', () => { req.destroy(); resolve(null); }); req.end();
  });
  const deadline = Date.now() + 15000;
  for (;;) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`gateway exited during startup (${child.exitCode ?? child.signalCode})`);
    const h = await health(); if (h && h.ok) { if (allowRoot && uid === 0) log('gateway', 'WARNING: running as root (--gateway-allow-root). Fine for a dev box, not for anything shared.'); return { child, sock, tokensDir, sandbox: !!h.sandbox }; }
    if (Date.now() > deadline) { try { child.kill('SIGKILL'); } catch {} throw new Error('gateway did not become healthy within 15s'); }
    await new Promise(r => setTimeout(r, 150));
  }
}

const cmds = {
  /** sameroof init [目录]：初始化一个新工作区 */
  init(args, opts) {
    const dir = path.resolve(args[0] || '.');
    if (fs.existsSync(path.join(dir, 'house.yaml'))) throw new Error('这个目录已经有 house.yaml 了');
    fs.mkdirSync(path.join(dir, 'rooms'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
    const house = {
      schema_version: 1,
      name: opts.name || path.basename(dir),
      timezone: opts.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      defaults: {
        runtime: 'broker-direct',
        plugins: ['memory'],
        heartbeat: { enabled: false },
        context: { recent_messages: 20, recent_max_chars: 4000, memory_hits: 4, memory_recent: 3 },
        approve_timeout: '30m',
        permissions: {
          'core.exec': 'approve',
          'core.fs.read': 'approve',
          'core.fs.write': 'approve'
        }
      },
      credentials: [],
      notify: { admin: 'me' }
    };
    fs.writeFileSync(path.join(dir, 'house.yaml'), YAML.stringify(house, { lineWidth: 120 }));
    console.log('Workspace initialized: ' + dir);
    console.log('');
    console.log('Next steps:');
    console.log('  1. Add a credential:');
    console.log('     sameroof cred add my-key --provider zhipu --base-url https://open.bigmodel.cn/api/paas/v4 --api-key YOUR_KEY');
    console.log('  2. Create an agent:');
    console.log('     sameroof new my-agent --model zhipu/glm-4-flash --credential my-key');
    console.log('  3. Create yourself:');
    console.log('     sameroof new me --human');
    console.log('  4. Start:');
    console.log('     sameroof serve');
  },

  /** sameroof serve [--port N] [--no-agents] [--with-gateway [--gateway-allow-root]] [--web [PORT]]：启动 broker + coordinator + 所有 agent 适配器（可选：网关、网页） */
  serve(args, opts) {
    const root = h(opts);
    const parsePort = (value, label) => {
      if (!/^\d+$/.test(String(value)) || Number(value) > 65535) throw new Error('Invalid ' + label + ' port');
      return Number(value);
    };
    const port = parsePort(opts.port ?? 8790, 'coordinator');
    let webPort = opts.web ? parsePort(opts.web === true ? 17930 : opts.web, 'web') : null;
    if (opts['with-gateway'] && typeof process.getuid === 'function' && process.getuid() === 0 && !opts['gateway-allow-root']) {
      throw new Error('the gateway refuses to run as root; use an unprivileged user or explicitly --gateway-allow-root for a single-user dev box');
    }
    const houseDoc = loadYaml(path.join(root, 'house.yaml'));
    const { spawn } = require('node:child_process');
    const home = process.env.HOME || os.homedir();
    const runDir = path.join(home, '.sameroof', 'run');
    fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(runDir, 'tokens'), { recursive: true, mode: 0o700 });
    // One serve per user runtime directory. Never replace another live service's sockets/tokens.
    const leaseFile = path.join(runDir, 'serve.lock');
    let lease;
    try { lease = fs.openSync(leaseFile, 'wx', 0o600); }
    catch (e) { if (e.code === 'EEXIST') throw new Error('serve.lock exists: another serve may be running. Remove a stale lock only after checking its recorded PID.'); throw e; }
    fs.writeFileSync(lease, JSON.stringify({ pid: process.pid, workspace: root }));
    const leaseIdentity = fs.fstatSync(lease);
    const children = [];
    const log = (who, msg) => console.log(`[${who}] ${msg}`);
    let store, broker, lr, shuttingDown = false, shutdownPromise;
    const shutdown = (code = 0) => shutdownPromise || (shutdownPromise = (async () => {
      shuttingDown = true;
      const watchdog = setTimeout(() => process.exit(1), 20000); watchdog.unref();
      console.log('\nShutting down...');
      // Keep gateway/coordinator alive until adapter handover has finished.
      for (const batch of [children.filter(c => !c.infrastructure), children.filter(c => c.infrastructure)]) {
        const result = await stopChildren(batch.map(c => c.child));
        if (result.stillAlive.length) code = 1;
      }
      if (lr) await lr.close().catch(() => {});
      if (broker) await broker.close().catch(() => {});
      if (store) { try { store.close(); } catch {} }
      try { const st = fs.statSync(leaseFile); if (st.dev === leaseIdentity.dev && st.ino === leaseIdentity.ino) fs.unlinkSync(leaseFile); } catch {}
      fs.closeSync(lease); clearTimeout(watchdog); process.exit(code);
    })());
    const track = (name, child, infrastructure = false) => {
      children.push({ name, child, infrastructure });
      child.on('error', error => { log(name, error.message); void shutdown(1); });
      child.on('exit', code => { if (!shuttingDown) { log(name, `process exited (${code})`); if (infrastructure) void shutdown(1); } });
      if (shuttingDown) child.kill('SIGTERM');
    };
    const ensureStarting = () => { if (shuttingDown) throw new Error('serve startup interrupted'); };
    process.on('SIGINT', () => { void shutdown(); });
    process.on('SIGTERM', () => { void shutdown(); });

    (async () => {
      // 1. Broker (in-process, Unix socket)
      const { BrokerStore } = require('@sameroof/broker/store');
      const { createBroker } = require('@sameroof/broker/server');
      store = new BrokerStore();
      broker = createBroker({ store });
      await assertSocketAvailable(broker.socketPath);
      ensureStarting();
      await broker.listen();
      ensureStarting();
      log('broker', 'listening on ' + path.basename(broker.socketPath));
      const creds = store.listCredentials().filter(c => c.active).map(c => c.alias);   // includes built-in mock-cheap when SAMEROOF_ENABLE_MOCK=1
      if (!creds.length) log('broker', 'warning: no credentials. Add one: sameroof cred add <alias> --provider X --base-url URL --api-key KEY');

      // 2. Coordinator (in-process)
      const { createLivingRoom } = require('@sameroof/living-room/server');
      lr = createLivingRoom({ houseDir: root, runDir, dataDir: path.join(root, 'state'), port });
      const info = await lr.listen();
      ensureStarting();
      log('coordinator', 'http://127.0.0.1:' + info.port + '  (console: /console)');

      const agentRooms = rooms(root).filter(r => (r.species || 'agent') === 'agent');
      const humanRooms = rooms(root).filter(r => r.species === 'human');

      // 2b. Gateway (optional child process). Without it, APPROVAL: actions fail closed — there is no unsandboxed fallback.
      let gateway = null;
      if (opts['with-gateway']) {
        gateway = await startGateway({ root, runDir, port: info.port, allowRoot: !!opts['gateway-allow-root'], agentIds: agentRooms.map(r => r.id), log, track });
        ensureStarting();
        log('gateway', `listening on ${path.basename(gateway.sock)} (pid ${gateway.child.pid}); sandbox: ${gateway.sandbox ? 'bwrap ok — core.exec allowed after approval' : 'bwrap unavailable — core.exec is refused, core.fs.* still works'}`);
      } else log('gateway', 'not started (add --with-gateway to enable approved core.exec / core.fs.* actions)');

      // 3. Tokens + adapters
      for (const r of humanRooms) {
        const t = lr.tokenStore.issue(r.id);
        log('token', `${r.name} (human): ${t.created ? 'issued' : 'exists'} — sameroof pair ${r.name} to get it`);
      }
      if (opts['no-agents']) { log('serve', 'skipping agents (--no-agents)'); }
      else for (const r of agentRooms) {
        lr.tokenStore.issue(r.id);   // coordinator token
        const brokerTokenFile = path.join(runDir, 'tokens', r.id);
        const credAlias = r.model && r.model.auth && r.model.auth.credential;
        const modelId = r.model && r.model.id;
        if (r.model && r.model.auth && r.model.auth.mode === 'broker') {
          if (!creds.includes(credAlias)) { log(r.name, `skip: credential "${credAlias}" not in broker`); continue; }
          if (!fs.existsSync(brokerTokenFile)) {
            const subEnabled = (r.subagent && r.subagent.enabled !== undefined) ? !!r.subagent.enabled : !!(((houseDoc.defaults || {}).subagent || {}).enabled);   // room ?? house：房间可收紧，token capability 不多签（审查员 P1-3）
            store.issueToken({ residentId: r.id, credentials: [credAlias], models: [modelId], ttlSeconds: 604800, purposes: subEnabled ? ['interactive', 'heartbeat', 'subagent'] : ['interactive', 'heartbeat'] });   // subagent V0: purpose is explicit at issuance (design v5 §4.2)
            log(r.name, `broker token issued → ${credAlias} / ${modelId}`);
          }
        }
        const runtime = r.runtime || 'broker-direct';
        // Resolve adapter from the installed @sameroof/adapters package (works from any workspace, not just the source tree)
        let adapterDir, adapterFile;
        try {
          const pkgRoot = path.dirname(require.resolve('@sameroof/adapters/package.json'));
          adapterDir = path.join(pkgRoot, runtime);
          adapterFile = path.join(adapterDir, 'adapter.js');
        } catch { log(r.name, 'skip: @sameroof/adapters not installed'); continue; }
        if (!fs.existsSync(adapterFile)) { log(r.name, `skip: no adapter for runtime "${runtime}" (available: ${fs.readdirSync(path.dirname(adapterDir)).filter(d => fs.existsSync(path.join(path.dirname(adapterDir), d, 'adapter.js'))).join(', ')})`); continue; }
        const child = spawn(process.execPath, [adapterFile, r.name], {
          cwd: adapterDir, stdio: ['ignore', 'inherit', 'inherit'],
          env: { ...process.env, HOME: home, SAMEROOF_ROOT: root, SAMEROOF_LR: 'http://127.0.0.1:' + info.port,
            ...(gateway ? { SAMEROOF_GATEWAY_SOCK: gateway.sock, SAMEROOF_GATEWAY_TOKEN_FILE: path.join(gateway.tokensDir, r.id) } : {}) }
        });
        track(r.name, child);
        log(r.name, `adapter started (${runtime}, pid ${child.pid})`);
      }

      // 4. Web UI (optional): apps/roof from the source tree, proxying to this coordinator.
      if (opts.web) {
        const roof = path.resolve(__dirname, '..', '..', 'apps', 'roof', 'server.cjs');
        if (!fs.existsSync(roof)) throw new Error('apps/roof/server.cjs not found (only available from the source tree)');
        else {
          const child = spawn(process.execPath, [roof], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'], env: { ...process.env, PORT: String(webPort), SAMEROOF_ROOT: root, ROOF_UPSTREAM: 'http://127.0.0.1:' + info.port } });
          track('web', child, true);
          webPort = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('web startup timed out')), 15000);
            child.once('exit', () => { clearTimeout(timer); reject(new Error('web exited before readiness')); });
            child.once('error', error => { clearTimeout(timer); reject(error); });
            child.once('message', message => { clearTimeout(timer); if (message?.type === 'ready') resolve(message.port); else reject(new Error('Invalid web readiness message')); });
          });
          ensureStarting();
          log('web', `http://127.0.0.1:${webPort}/  (pid ${child.pid}; sign in with the token from: sameroof pair <your-name>)`);
        }
      }

      console.log('');
      const agentCount = children.filter(c => !c.infrastructure).length;
      console.log(`Same Roof running: ${agentCount} agent(s), coordinator on :${info.port}, broker on socket${gateway ? ', gateway on socket' : ''}${opts.web ? ', web on :' + webPort : ''}.`);
      console.log('Ctrl+C to stop.');
    })().catch(async e => { console.error('serve failed:', e.message); await shutdown(1); });
  },

  /** sameroof cred add <alias> --provider X --base-url URL --api-key KEY */
  cred(args, opts) {
    const sub = args[0];
    if (sub === 'add') {
      const alias = args[1]; if (!alias) throw new Error('Usage: sameroof cred add <alias> --provider X --base-url URL --api-key KEY');
      if (!opts.provider) throw new Error('Missing --provider');
      if (!opts['base-url'] && !opts['base_url']) throw new Error('Missing --base-url');
      if (!opts['api-key'] && !opts['api_key']) throw new Error('Missing --api-key');
      const { BrokerStore } = require('@sameroof/broker/store');
      const store = new BrokerStore();
      store.addCredential({ alias, provider: opts.provider, baseUrl: opts['base-url'] || opts['base_url'], apiKey: opts['api-key'] || opts['api_key'] });
      console.log('Credential added: ' + alias + ' (' + opts.provider + ')');
    } else if (sub === 'list') {
      const { BrokerStore } = require('@sameroof/broker/store');
      const store = new BrokerStore();
      const creds = store.listCredentials();
      if (!creds.length) { console.log('No credentials. Add one: sameroof cred add <alias> --provider X --base-url URL --api-key KEY'); return; }
      for (const c of creds) console.log((c.active ? '●' : '○') + ' ' + c.alias.padEnd(20) + ' ' + c.provider.padEnd(16) + ' ' + c.base_url);
    } else {
      console.log('Usage: sameroof cred add|list');
    }
  },

  /** sameroof new <名字> [--model provider/id] [--runtime pi|broker-direct|claude-code] [--human] */
  new(args, opts) {
    const name = args[0]; if (!name) throw new Error('用法：sameroof new <名字> [--model provider/id] [--runtime ...] [--human]');
    const root = h(opts); const dir = path.join(root, 'rooms', name);
    if (fs.existsSync(dir)) throw new Error(`已经有 ${name} 这间屋了`);
    const existing = rooms(root); let id = slug(opts.id || name); let n = 1;
    while (existing.some(r => r.id === id)) id = id.replace(/_\d+$/, '_' + String(++n).padStart(2, '0'));
    const doc = { schema_version: 1, id, name, species: opts.human ? 'human' : 'agent' };
    if (!opts.human) {
      const [provider, mid] = String(opts.model || 'zhipu/glm-5.3-flash').split('/');
      const runtimeManaged = ['kimi-coding', 'claude-code', 'openai-codex'].includes(provider);
      doc.model = { provider, id: mid, auth: runtimeManaged ? { mode: 'runtime_managed', credential: opts.credential || provider + '-sub' } : { mode: 'broker', credential: opts.credential || provider + '-key' } };
      doc.runtime = opts.runtime || (provider === 'claude-code' ? 'claude-code' : runtimeManaged ? 'pi' : 'broker-direct');
    } else doc.notify = { channel: 'push' };
    // Register credential alias in house.yaml if the agent uses broker mode and alias isn't listed yet
    if (doc.model && doc.model.auth.mode === 'broker') {
      const houseFile = path.join(root, 'house.yaml');
      const houseDoc = loadYaml(houseFile);
      houseDoc.credentials = houseDoc.credentials || [];
      const alias = doc.model.auth.credential;
      if (!houseDoc.credentials.some(c => c && c.alias === alias)) {
        houseDoc.credentials.push({ alias, provider: doc.model.provider, purpose: name });
        fs.writeFileSync(houseFile, YAML.stringify(houseDoc, { lineWidth: 120 }));
        console.log(`Registered credential alias "${alias}" in house.yaml (add the real key: sameroof cred add ${alias} --provider ${doc.model.provider} --base-url URL --api-key KEY)`);
      }
    }
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'room.yaml'), YAML.stringify(doc, { lineWidth: 120 }));
    if (!opts.human) fs.writeFileSync(path.join(dir, 'SOUL.md'), `# ${name}\n\n（谁都还没写。这里放性格、说话方式、底线。运行时只读，改动要经人审批。）\n`);
    console.log(`建好了：rooms/${name}/  id=${id}${doc.model ? `  穿 ${doc.model.provider}/${doc.model.id}，走 ${doc.model.auth.mode}` : '  （人）'}`);
    console.log(`下一步：${doc.model && doc.model.auth.mode === 'broker' ? `确认 house.yaml credentials 里有别名 ${doc.model.auth.credential}，然后 sameroof-broker token issue ${id} ...` : doc.model ? `让 ${doc.runtime} 自己登录（pi /login ${doc.model.provider}）` : '跑 sameroof pair ' + name + ' 拿配对链接'}；写 SOUL.md；sameroof check；sameroof lock`);
  },
  /** sameroof check */
  check(args, opts) {
    const root = h(opts); const { validateHouse } = require('@sameroof/schema');
    const errs = validateHouse(root);
    if (!errs.length) { console.log('全屋校验通过。'); return; }
    for (const e of errs) console.log(`${e.severity === 'error' ? '✗' : '!'} ${path.relative(root, e.file)}:${e.line || '?'} — ${e.message_zh} [${e.code}]`);
    process.exitCode = errs.some(e => e.severity === 'error') ? 1 : 0;
  },
  /** sameroof explain <名字>：每个生效值来自哪 */
  explain(args, opts) {
    const root = h(opts); const name = args[0]; if (!name) throw new Error('用法：sameroof explain <名字>');
    const house = loadYaml(path.join(root, 'house.yaml')); const r = rooms(root).find(x => x.name === name || x.id === name); if (!r) throw new Error('没这间屋：' + name);
    const d = house.defaults || {};
    const line = (k, v, src) => console.log(`${k.padEnd(18)} ${JSON.stringify(v)}   ← ${src}`);
    console.log(`${r.name}（${r.id}）  ${path.relative(root, r.file)}`);
    line('species', r.species || 'agent', r.species ? '房间' : '默认');
    if (r.model) line('model', `${r.model.provider}/${r.model.id} (${r.model.auth && r.model.auth.mode})`, '房间');
    line('runtime', r.runtime || d.runtime, r.runtime ? '房间' : 'house.defaults');
    line('plugins', r.plugins || d.plugins, r.plugins ? '房间' : 'house.defaults');
    const hb = r.heartbeat || d.heartbeat; line('heartbeat', hb, r.heartbeat ? '房间' : 'house.defaults');
    line('quiet_hours', (r.heartbeat && r.heartbeat.quiet_hours) || (r.schedule && r.schedule.quiet_hours) || (house.schedule || {}).quiet_hours, (r.heartbeat && r.heartbeat.quiet_hours) || (r.schedule && r.schedule.quiet_hours) ? '房间' : 'house.schedule');
    line('timezone', (r.schedule && r.schedule.timezone && r.schedule.timezone !== 'inherit') ? r.schedule.timezone : house.timezone, '账务时区不可覆盖');
    const ctx = Object.assign({ recent_messages: 20, recent_max_chars: 4000, memory_hits: 4, memory_recent: 3 }, (house.extensions || {})['dev.sameroof.context'] || {}, (r.extensions || {})['dev.sameroof.context'] || {});
    line('context', ctx, (r.extensions || {})['dev.sameroof.context'] ? '房间' : (house.extensions || {})['dev.sameroof.context'] ? 'house.extensions' : '内置默认');
    const perms = Object.assign({}, d.permissions || {}, r.permissions || {});
    console.log('permissions'); for (const [k, v] of Object.entries(perms)) console.log(`  ${k.padEnd(22)} ${v}   ← ${(r.permissions || {})[k] ? '房间' : 'house.defaults（上限）'}`);
    const st = path.join(root, 'state', `adapter-${r.id}.json`); if (fs.existsSync(st)) { const s = JSON.parse(fs.readFileSync(st, 'utf8')); console.log(`今天醒来 ${s.wakes_today} 次（${s.day}），上次睡 ${s.last_sleep || '从未'}`); }
  },
  /** sameroof pair <名字> [--api https://...] [--rotate]：配对链接（客厅 token） */
  pair(args, opts) {
    const root = h(opts); const name = args[0]; if (!name) throw new Error('用法：sameroof pair <名字> [--api 地址] [--rotate]');
    const r = rooms(root).find(x => x.name === name || x.id === name); if (!r) throw new Error('没这间屋：' + name);
    const tokens = require('@sameroof/living-room/tokens.js');
    const rec = opts.rotate ? tokens.rotate(r.id) : tokens.issue(r.id);
    const secret = rec.secret || rec.token || rec; const api = opts.api || process.env.SAMEROOF_API || 'http://127.0.0.1:8790';
    console.log(`sameroof://pair?api=${api}&token=${secret}`);
    console.error(`（${r.name} 的客厅 token${opts.rotate ? '已轮换，旧的作废' : ''}。别贴聊天里，走剪贴板。）`);
  },
  /** sameroof status */
  status(args, opts) {
    const root = h(opts);
    const units = ['sameroof-broker', 'sameroof-living-room', ...rooms(root).filter(r => (r.species || 'agent') === 'agent').map(r => (r.runtime === 'pi' ? 'sameroof-room-pi@' : 'sameroof-room@') + r.id)];
    for (const u of units) { let s; try { s = execSync(`systemctl is-active ${u}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch (e) { s = (e.stdout || '').toString().trim() || 'unknown'; } console.log(`${s === 'active' ? '●' : '○'} ${u.padEnd(44)} ${s}`); }
    try { const lock = require('./lock').verifyLock(root); console.log(`● house.lock 一致 ${lock.source.digest.slice(0, 12)}`); } catch (e) { console.log(`○ house.lock ${e.message}`); }
  },
};
module.exports = { cmds, stopChildren };

// ---- 备份与迁移（行李随迁）----
Object.assign(cmds, {
  /** sameroof backup [--out 目录] [--plain]：rooms/ + state/ + 客厅 token 打包；默认 gpg 对称加密（口令从 stdin 读） */
  backup(args, opts) {
    const root = h(opts); const out = path.resolve(opts.out || path.join(root, 'backups')); fs.mkdirSync(out, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
    const tar = path.join(out, `sameroof-${stamp}.tar`);
    const items = ['rooms', 'house.yaml', 'house.lock', 'state'].filter(x => fs.existsSync(path.join(root, x)));
    execSync(`tar -cf "${tar}" -C "${root}" ${items.map(x => `"${x}"`).join(' ')}`, { stdio: 'inherit' });
    const tk = path.join(process.env.HOME || os.homedir(), '.sameroof', 'run', 'living-room-tokens.json');
    if (fs.existsSync(tk)) execSync(`tar -rf "${tar}" -C "${path.dirname(tk)}" living-room-tokens.json`);
    if (opts.plain) { console.log(`明文备份：${tar}（高敏感！只在你自己的盘上）`); return; }
    try { execSync(`gpg --batch --yes --symmetric --cipher-algo AES256 --passphrase-fd 0 -o "${tar}.gpg" "${tar}"`, { stdio: ['inherit', 'inherit', 'inherit'] }); }
    catch (e) { fs.unlinkSync(tar); throw new Error('gpg 加密失败（没装 gpg？或口令没给）。想要明文加 --plain'); }
    fs.unlinkSync(tar); console.log(`加密备份：${tar}.gpg（口令别丢，丢了全家行李打不开）`);
  },
  /** sameroof restore <文件.tar|.tar.gpg> [--into 目录]：解回一个空目录，不覆盖正在住的家 */
  restore(args, opts) {
    const src = args[0]; if (!src || !fs.existsSync(src)) throw new Error('用法：sameroof restore <备份文件> [--into 目录]');
    const into = path.resolve(opts.into || path.join(process.cwd(), 'sameroof-restored')); if (fs.existsSync(into) && fs.readdirSync(into).length) throw new Error(`${into} 不是空目录，不往住着人的家里倒行李`);
    fs.mkdirSync(into, { recursive: true }); let tar = src;
    if (src.endsWith('.gpg')) { tar = path.join(into, 'restore.tar'); execSync(`gpg --batch --yes --passphrase-fd 0 -o "${tar}" -d "${src}"`, { stdio: ['inherit', 'inherit', 'inherit'] }); }
    execSync(`tar -xf "${tar}" -C "${into}"`, { stdio: 'inherit' }); if (tar !== src) fs.unlinkSync(tar);
    console.log(`已解到 ${into}。接着：把 rooms/ 挪进新家、living-room-tokens.json 放回 ~/.sameroof/run/、sameroof check、sameroof lock。`);
  },
});
