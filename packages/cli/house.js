// 同屋 CLI · 规划员的子命令：new / check / explain / pair / status。lock 归审查员（lock.js）。
'use strict';
const fs = require('node:fs'), path = require('node:path'), { execSync } = require('node:child_process');
const yaml = require('/root/sameroof/packages/living-room/node_modules/js-yaml');
const HOUSE_DEFAULT = '/root/sameroof';
const h = (opts) => path.resolve(opts.house || process.env.SAMEROOF_HOUSE || HOUSE_DEFAULT);
const loadYaml = f => yaml.load(fs.readFileSync(f, 'utf8'));
const rooms = root => fs.readdirSync(path.join(root, 'rooms')).map(d => path.join(root, 'rooms', d, 'room.yaml')).filter(fs.existsSync).map(f => ({ file: f, dir: path.dirname(f), ...loadYaml(f) }));
const slug = s => 'resident_' + (s.replace(/[^a-z0-9]+/gi, '').toLowerCase() || require('node:crypto').randomBytes(3).toString('hex')) + '_01';

const cmds = {
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
    fs.writeFileSync(path.join(dir, 'room.yaml'), yaml.dump(doc, { lineWidth: 120, noRefs: true, flowLevel: 3 }));
    if (!opts.human) fs.writeFileSync(path.join(dir, 'SOUL.md'), `# ${name}\n\n（谁都还没写。这里放性格、说话方式、底线。运行时只读，改动要经人审批。）\n`);
    console.log(`建好了：rooms/${name}/  id=${id}${doc.model ? `  穿 ${doc.model.provider}/${doc.model.id}，走 ${doc.model.auth.mode}` : '  （人）'}`);
    console.log(`下一步：${doc.model && doc.model.auth.mode === 'broker' ? `确认 house.yaml credentials 里有别名 ${doc.model.auth.credential}，然后 sameroof-broker token issue ${id} ...` : doc.model ? `让 ${doc.runtime} 自己登录（pi /login ${doc.model.provider}）` : '跑 sameroof pair ' + name + ' 拿配对链接'}；写 SOUL.md；sameroof check；sameroof lock`);
  },
  /** sameroof check */
  check(args, opts) {
    const root = h(opts); const { validateHouse } = require('/root/sameroof/packages/schema');
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
    const tokens = require('/root/sameroof/packages/living-room/tokens.js');
    const rec = opts.rotate ? tokens.rotate(r.id) : tokens.issue(r.id);
    const secret = rec.secret || rec.token || rec; const api = opts.api || 'https://house.sameroof.example';
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
