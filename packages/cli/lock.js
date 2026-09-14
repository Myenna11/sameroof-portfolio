'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');
const { validateHouse, resolveExecutionConfig } = require('../schema');

class LockError extends Error {
  constructor(code, message, details = []) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const relative = (root, file) => path.relative(root, file).split(path.sep).join('/');

function sourceFiles(root) {
  const files = [path.join(root, 'house.yaml')];
  const rooms = path.join(root, 'rooms');
  for (const entry of fs.readdirSync(rooms, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = path.join(rooms, entry.name, 'room.yaml');
    if (fs.existsSync(file)) files.push(file);
  }
  return files.sort((a, b) => relative(root, a).localeCompare(relative(root, b)));
}

function digestFiles(root, files) {
  const records = files.map(file => [relative(root, file), sha256(fs.readFileSync(file))]);
  return {
    algorithm: 'sha256',
    digest: sha256(records.map(([name, digest]) => name + '\0' + digest + '\n').join('')),
    files: Object.fromEntries(records)
  };
}

function treeFiles(dir) {
  const out = [];
  function walk(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const file = path.join(current, entry.name);
      if (entry.isSymbolicLink()) throw new LockError('LOCK-SYMLINK-001', '部署组件中不允许 symlink：' + file);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile()) out.push(file);
    }
  }
  walk(dir);
  return out;
}

// Component source resolution. A workspace is usually NOT the monorepo: framework code lives in the
// installed @sameroof/* packages. Prefer root/packages/* when it exists (root is a source tree); else the installed package.
// `source` in the lock stays a stable label (packages/adapters/pi etc.), the digest is what --check compares.
function pkgDir(pkg) {
  try { return path.dirname(require.resolve('@sameroof/' + pkg + '/package.json')); } catch { return null; }
}
function resolveSource(root, source) {
  const local = path.join(root, source);
  if (fs.existsSync(local)) return local;                       // root is a source tree (monorepo dev / tests): it wins
  const m = /^packages\/([^/]+)(?:\/(.*))?$/.exec(source);       // otherwise: the installed @sameroof/<pkg>
  if (m) { const d = pkgDir(m[1]); if (d) { const full = m[2] ? path.join(d, m[2]) : d; if (fs.existsSync(full)) return full; } }
  return local;
}
function component(root, id, source) {
  const dir = resolveSource(root, source);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new LockError('LOCK-COMPONENT-MISSING-001', '找不到组件“' + id + '”：' + source + '（@sameroof/* 未安装，且 ' + root + ' 不是源码树）');
  let version = 'workspace';
  const manifest = path.join(dir, 'package.json');
  if (fs.existsSync(manifest)) version = String(JSON.parse(fs.readFileSync(manifest, 'utf8')).version || version);
  const digest = digestFiles(dir, treeFiles(dir)).digest;
  return { id, version, source, digest: { algorithm: 'sha256', value: digest }, interface_version: 1 };
}

function pluginSource(root, id) {
  const direct = 'packages/plugin-' + id;
  if (fs.existsSync(resolveSource(root, direct))) return direct;
  if (id === 'living-room') return 'packages/living-room';
  if (id === 'handover') return 'packages/adapters/lib';
  throw new LockError('LOCK-PLUGIN-MISSING-001', '找不到插件“' + id + '”的实现。');
}

function parse(file) {
  return YAML.parse(fs.readFileSync(file, 'utf8'), { maxAliasCount: 50, uniqueKeys: true });
}

function generateLock(rootInput) {
  const root = path.resolve(rootInput);
  const issues = validateHouse(root);
  if (issues.some(item => item.severity === 'error')) throw new LockError('LOCK-CONFIG-INVALID-001', '配置校验未通过，不生成 house.lock。', issues);
  const house = parse(path.join(root, 'house.yaml'));
  const configs = sourceFiles(root);
  const rooms = configs.slice(1).map(file => ({ file, value: parse(file) })).sort((a, b) => a.value.id.localeCompare(b.value.id));
  const runtimeIds = new Set();
  const pluginIds = new Set();
  const resolvedRooms = [];
  for (const room of rooms) {
    if (room.value.species === 'human') {
      resolvedRooms.push({ id: room.value.id, config: relative(root, room.file), config_digest: sha256(fs.readFileSync(room.file)), species: 'human' });
      continue;
    }
    const runtime = room.value.runtime || house.defaults?.runtime;
    const plugins = room.value.plugins || house.defaults?.plugins || [];
    const execution = resolveExecutionConfig(house, room.value);
    if (!runtime) throw new LockError('LOCK-RUNTIME-MISSING-001', '住户“' + room.value.id + '”没有可解析的 runtime。');
    runtimeIds.add(runtime);
    for (const id of plugins) pluginIds.add(id);
    resolvedRooms.push({
      id: room.value.id,
      config: relative(root, room.file),
      config_digest: sha256(fs.readFileSync(room.file)),
      species: room.value.species,
      runtime,
      plugins: [...plugins].sort(),
      deliver: execution.deliver,
      limits: execution.limits,
      routines: execution.routines
    });
  }
  const runtimes = [...runtimeIds].sort().map(id => component(root, id, 'packages/adapters/' + id));
  const plugins = [...pluginIds].sort().map(id => component(root, id, pluginSource(root, id)));
  const schemaDir = resolveSource(root, 'packages/schema');
  const schema = name => {
    const file = path.join(schemaDir, name + '.schema.json');
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { id: value.$id, digest: { algorithm: 'sha256', value: sha256(fs.readFileSync(file)) } };
  };
  return {
    lock_version: 1,
    source: digestFiles(root, configs),
    schemas: { house: schema('house'), room: schema('room') },
    components: { runtimes, plugins },
    rooms: resolvedRooms,
    credentials: (house.credentials || []).map(item => ({ alias: item.alias, provider: item.provider, mode: item.mode || 'broker' })).sort((a, b) => a.alias.localeCompare(b.alias))
  };
}

function renderLock(lock) {
  return JSON.stringify(lock, null, 2) + '\n';
}

function writeLock(rootInput) {
  const root = path.resolve(rootInput);
  const file = path.join(root, 'house.lock');
  const temporary = file + '.tmp-' + process.pid + '-' + crypto.randomBytes(4).toString('hex');
  const lock = generateLock(root);
  try {
    fs.writeFileSync(temporary, renderLock(lock), { mode: 0o644, flag: 'wx' });
    fs.renameSync(temporary, file);
  } finally {
    try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch {}
  }
  return lock;
}

function verifyLock(rootInput) {
  const root = path.resolve(rootInput);
  const file = path.join(root, 'house.lock');
  if (!fs.existsSync(file)) throw new LockError('LOCK-FILE-MISSING-001', '找不到 house.lock，请运行 sameroof lock。');
  let stored;
  try { stored = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { throw new LockError('LOCK-FILE-INVALID-001', 'house.lock 不是合法 JSON：' + error.message); }
  const current = generateLock(root);
  if (renderLock(stored) !== renderLock(current)) throw new LockError('LOCK-STALE-001', 'house.yaml、room.yaml 或已锁组件发生变化，请审阅后运行 sameroof lock。');
  return stored;
}

module.exports = { LockError, generateLock, renderLock, writeLock, verifyLock };
