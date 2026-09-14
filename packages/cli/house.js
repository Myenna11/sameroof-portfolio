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
        context: { recent_messages: 20, recent_max_chars: 4000 },
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

  /** sameroof serve [--port N]：启动 broker + coordinator + 所有 agent 适配器 */
  serve(args, opts) {
    const root = h(opts);
    const port = parseInt(opts.port || '8790', 10);
    const house = loadYaml(path.join(root, 'house.yaml'));

    // 1. Start broker
    const brokerPort = parseInt(opts['broker-port'] || '8791', 10);
    console.log('Starting broker on port ' + brokerPort + '...');
    const broker = require('child_process').fork(
      path.join(root, 'packages', 'broker', 'server.js'),
      [], { env: { ...process.env, PORT: String(brokerPort), SAMEROOF_ROOT: root }, stdio: 'inherit' }
    );

    // 2. Start coordinator (living-room)
    console.log('Starting coordinator on port ' + port + '...');
    const { createLivingRoom } = require(path.join(root, 'packages', 'living-room', 'server'));
    const runDir = path.join(process.env.HOME || os.homedir(), '.sameroof', 'run');
    fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
    const lr = createLivingRoom({ houseDir: root, runDir, dataDir: path.join(root, 'state'), port });
    lr.listen().then(info => {
      console.log('Coordinator running on port ' + info.port);

      // 3. Start agent adapters
      const agentRooms = rooms(root).filter(r => (r.species || 'agent') === 'agent');
      console.log('Starting ' + agentRooms.length + ' agent(s)...');
      for (const r of agentRooms) {
        console.log('  ' + r.name + ' (' + (r.model ? r.model.provider + '/' + r.model.id : 'no model') + ')');
      }
      console.log('');
      console.log('Same Roof running. ' + agentRooms.length + ' agent(s) + coordinator + broker.');
      console.log('Open http://localhost:' + info.port + ' or use the API.');
      console.log('Press Ctrl+C to stop.');
    }).catch(e => { console.error('Failed to start coordinator:', e.message); process.exit(1); });

    process.on('SIGINT', () => { console.log('\nShutting down...'); broker.kill(); process.exit(0); });
    process.on('SIGTERM', () => { broker.kill(); process.exit(0); });
  },

  /** sameroof cred add <alias> --provider X --base-url URL --api-key KEY */
  cred(args, opts) {
    const sub = args[0];
    if (sub === 'add') {
      const alias = args[1]; if (!alias) throw new Error('Usage: sameroof cred add <alias> --provider X --base-url URL --api-key KEY');
      if (!opts.provider) throw new Error('Missing --provider');
      if (!opts['base-url'] && !opts['base_url']) throw new Error('Missing --base-url');
      if (!opts['api-key'] && !opts['api_key']) throw new Error('Missing --api-key');
      const { BrokerStore } = require(path.join(h(opts), 'packages', 'broker', 'store'));
      const store = new BrokerStore();
      store.addCredential({ alias, provider: opts.provider, baseUrl: opts['base-url'] || opts['base_url'], apiKey: opts['api-key'] || opts['api_key'] });
      console.log('Credential added: ' + alias + ' (' + opts.provider + ')');
    } else if (sub === 'list') {
      const { BrokerStore } = require(path.join(h(opts), 'packages', 'broker', 'store'));
      const store = new BrokerStore();
      const creds = store.db.prepare('SELECT alias, provider, base_url, active FROM credentials').all();
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
      doc.model = { provider, id: mid, auth: runtimeManaged ? { mode: 'runtime_managed', credential: opts.credential || provider + '-sub' } : { mode: 'broker', credential: opts.credential || 'shared-cheap' } };
      doc.runtime = opts.runtime || (provider === 'claude-code' ? 'claude-code' : runtimeManaged ? 'pi' : 'broker-direct');
    } else doc.notify = { channel: 'push' };
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
module.exports = { cmds };

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
