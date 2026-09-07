'use strict';

const fs = require('fs');
const path = require('path');
const YAML = require('yaml');
const Ajv2020 = require('ajv/dist/2020');
const roomSchema = require('./room.schema.json');
const houseSchema = require('./house.schema.json');

const ajv = new Ajv2020({ allErrors: true, strict: false, messages: true });
ajv.addSchema(roomSchema);
const validateRoomShape = ajv.getSchema(roomSchema.$id);
const validateHouseShape = ajv.compile(houseSchema);

const RESERVED_NAMES = new Set(['system', 'all', 'everyone', 'house']);
const PERMISSION_RANK = { deny: 0, approve: 1, allow: 2 };
const ROUTINE_ID_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const CRON_FIELDS = [
  { name: '分', min: 0, max: 59 }, { name: '时', min: 0, max: 23 }, { name: '日', min: 1, max: 31 },
  { name: '月', min: 1, max: 12 }, { name: '周', min: 0, max: 7 },
];

function normalizeName(value) {
  return String(value).normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

function issue(file, line, code, message_zh, severity = 'error') {
  return { file: path.resolve(file), line: line || 1, code, message_zh, severity };
}

function validateCronExpression(expr) {
  if (typeof expr !== 'string') return '不是字符串';
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return `要 5 段（分 时 日 月 周），给了 ${parts.length} 段`;
  for (let index = 0; index < parts.length; index++) {
    const field = CRON_FIELDS[index];
    for (const part of parts[index].split(',')) {
      const match = part.match(/^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/);
      if (!match) return `${field.name}字段“${part}”看不懂`;
      const step = match[2] ? Number(match[2]) : 1;
      if (step < 1) return `${field.name}字段“${part}”步长得 ≥1`;
      let start, end;
      if (match[1] === '*') { start = field.min; end = field.max; }
      else if (match[1].includes('-')) [start, end] = match[1].split('-').map(Number);
      else { start = Number(match[1]); end = match[2] ? field.max : start; }
      if (start < field.min || end > field.max || start > end) return `${field.name}字段“${part}”超出 ${field.min}-${field.max}`;
    }
  }
  return null;
}

const legacyConfig = (value, key) => value?.extensions?.['dev.sameroof.' + key];
const preferredConfig = (value, key) => Object.hasOwn(value || {}, key) ? value[key] : legacyConfig(value, key);

function resolveExecutionConfig(house, room) {
  const houseDeliver = preferredConfig(house?.defaults, 'deliver') || legacyConfig(house, 'deliver') || {};
  const roomDeliver = preferredConfig(room, 'deliver') || {};
  const deliver = {
    human: roomDeliver.human || houseDeliver.human || 'after_turn',
    agent: roomDeliver.agent || houseDeliver.agent || 'after_turn',
    from: Object.fromEntries(Object.entries({ ...(houseDeliver.from || {}), ...(roomDeliver.from || {}) }).sort(([a], [b]) => a.localeCompare(b)))
  };
  const houseLimits = preferredConfig(house?.defaults, 'limits') || legacyConfig(house, 'limits') || {};
  const roomLimits = preferredConfig(room, 'limits') || {};
  const limits = {
    run_timeout_ms: roomLimits.run_timeout_ms ?? houseLimits.run_timeout_ms ?? 180000,
    agent_hops: roomLimits.agent_hops ?? houseLimits.agent_hops ?? 6
  };
  const routines = new Map();
  for (const item of [...(preferredConfig(house, 'routines') || []), ...(preferredConfig(room, 'routines') || [])]) routines.set(item.id, {
    id: item.id,
    cron: item.cron,
    prompt: item.prompt.trim(),
    enabled: item.enabled !== false,
    quiet_hours: item.quiet_hours === 'respect' ? 'respect' : 'ignore'
  });
  return { deliver, limits, routines: [...routines.values()] };
}

function pointerParts(pointer) {
  if (!pointer) return [];
  return pointer.slice(1).split('/').map(x => x.replace(/~1/g, '/').replace(/~0/g, '~')).map(x => /^\d+$/.test(x) ? Number(x) : x);
}

function lineFor(parsed, pointer, fallbackKey) {
  let parts = pointerParts(pointer);
  if (fallbackKey) parts = [...parts, fallbackKey];
  try {
    const node = parsed.doc.getIn(parts, true);
    if (node && node.range) return parsed.lineCounter.linePos(node.range[0]).line;
  } catch {}
  if (fallbackKey) {
    const lines = parsed.text.split('\n');
    const index = lines.findIndex(line => line.trimStart().startsWith(String(fallbackKey) + ':'));
    if (index >= 0) return index + 1;
  }
  return 1;
}

function parseYaml(file, kind) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    return { errors: [issue(file, 1, kind + '-FILE-001', '读不到文件：' + error.message)] };
  }
  const lineCounter = new YAML.LineCounter();
  const doc = YAML.parseDocument(text, { lineCounter, maxAliasCount: 50, prettyErrors: false, uniqueKeys: true });
  if (doc.errors.length) {
    return { errors: doc.errors.map(error => issue(file, error.linePos?.[0]?.line || 1, kind + '-YAML-001', 'YAML 看不懂：' + error.message)) };
  }
  let value;
  try {
    value = doc.toJS({ maxAliasCount: 50 });
  } catch (error) {
    return { errors: [issue(file, 1, kind + '-YAML-001', 'YAML 展开失败：' + error.message)] };
  }
  return { file, text, lineCounter, doc, value, errors: [] };
}

function ajvIssue(kind, parsed, error) {
  const missing = error.params?.missingProperty;
  const extra = error.params?.additionalProperty;
  const line = lineFor(parsed, error.instancePath, missing || extra);
  if (error.keyword === 'additionalProperties') {
    return issue(parsed.file, line, kind + '-UNKNOWN-001', '不认识字段“' + extra + '”。核心字段拼错时不会静默忽略。');
  }
  const leaf = pointerParts(error.instancePath).at(-1);
  if (kind === 'ROOM' && parsed.value?.species === 'human' && ['model', 'heartbeat', 'plugins'].includes(leaf)) {
    return issue(parsed.file, line, 'ROOM-HUMAN-001', 'human 房间不能配置 model、heartbeat 或 plugins。');
  }
  if (kind === 'ROOM' && error.keyword === 'required' && missing === 'model') {
    return issue(parsed.file, line, 'ROOM-AGENT-001', 'agent 房间必须配置 model。');
  }
  if (error.keyword === 'required') {
    return issue(parsed.file, line, kind + '-REQUIRED-001', '缺少必填字段“' + missing + '”。');
  }
  if (error.keyword === 'propertyNames') {
    return issue(parsed.file, line, kind + '-NAMESPACE-001', '字段名或命名空间格式不合法。');
  }
  return issue(parsed.file, line, kind + '-SCHEMA-001', '字段 ' + (error.instancePath || '<root>') + ' ' + (error.message || '不符合规范') + '。');
}

function shapeIssues(kind, parsed, validator) {
  if (validator(parsed.value)) return [];
  const seen = new Set();
  const out = [];
  for (const error of validator.errors || []) {
    if (error.keyword === 'if' || error.keyword === 'oneOf' || error.keyword === 'not') continue;
    const item = ajvIssue(kind, parsed, error);
    const key = item.code + '|' + item.line + '|' + item.message_zh;
    if (!seen.has(key)) { seen.add(key); out.push(item); }
  }
  return out;
}

function localRoomIssues(parsed, options = {}) {
  const room = parsed.value || {};
  const out = [];
  if (room.species === 'human') {
    for (const key of ['model', 'heartbeat', 'plugins', 'routines']) if (Object.hasOwn(room, key)) {
      out.push(issue(parsed.file, lineFor(parsed, '', key), 'ROOM-HUMAN-001', '“' + room.name + '”是 human，不能配置 ' + key + '。'));
    }
  }
  for (const raw of [room.name, ...(room.aliases || [])].filter(Boolean)) {
    if (RESERVED_NAMES.has(normalizeName(raw))) {
      out.push(issue(parsed.file, lineFor(parsed, '', raw === room.name ? 'name' : 'aliases'), 'ROOM-NAME-RESERVED-001', '名字“' + raw + '”是房子的保留名。'));
    }
  }
  if (room.extensions && options.knownExtensions) {
    const known = new Set(options.knownExtensions);
    for (const namespace of Object.keys(room.extensions)) if (!known.has(namespace)) {
      out.push(issue(parsed.file, lineFor(parsed, '/extensions', namespace), 'ROOM-EXT-001', '扩展“' + namespace + '”没有已安装插件声明，启动拒绝。'));
    }
  }
  if (room.avatar?.image) {
    const roomDir = path.dirname(parsed.file);
    const image = path.resolve(roomDir, room.avatar.image);
    if (!image.startsWith(roomDir + path.sep) || !fs.existsSync(image) || !fs.lstatSync(image).isFile()) {
      out.push(issue(parsed.file, lineFor(parsed, '/avatar', 'image'), 'ROOM-AVATAR-IMAGE-001', '头像 image 必须指向本房间内已存在的文件。'));
    }
  }
  out.push(...routineIssues('ROOM', parsed, room));
  return out;
}

function effectiveRoutines(value) {
  if (Object.hasOwn(value || {}, 'routines')) return { list: value.routines, pointer: '/routines' };
  const legacy = value?.extensions?.['dev.sameroof.routines'];
  return legacy === undefined ? { list: [], pointer: '/routines' } : { list: legacy, pointer: '/extensions/dev.sameroof.routines' };
}

function routineIssues(kind, parsed, value) {
  const { list, pointer } = effectiveRoutines(value);
  if (!Array.isArray(list)) return [issue(parsed.file, lineFor(parsed, pointer), kind + '-ROUTINES-001', 'routines 必须是数组。')];
  const out = [], ids = new Set();
  for (let index = 0; index < list.length; index++) {
    const routine = list[index];
    if (!routine || typeof routine !== 'object' || Array.isArray(routine)) continue;
    const base = pointer + '/' + index;
    if (typeof routine.id !== 'string' || !ROUTINE_ID_RE.test(routine.id)) {
      out.push(issue(parsed.file, lineFor(parsed, base, 'id'), kind + '-ROUTINE-ID-001', 'routine id 必须以小写字母开头，只含小写字母、数字、_ 或 -，最长 64 字符。'));
    } else if (ids.has(routine.id)) {
      out.push(issue(parsed.file, lineFor(parsed, base, 'id'), kind + '-ROUTINE-ID-DUP-001', '同一处 routines 里的 id“' + routine.id + '”重复。'));
    } else ids.add(routine.id);
    if (typeof routine.prompt !== 'string' || !routine.prompt.trim()) {
      out.push(issue(parsed.file, lineFor(parsed, base, 'prompt'), kind + '-ROUTINE-PROMPT-001', 'routine“' + (routine.id || index + 1) + '”的 prompt 不能为空。'));
    }
    const cronError = validateCronExpression(routine.cron);
    if (cronError) out.push(issue(parsed.file, lineFor(parsed, base, 'cron'), kind + '-ROUTINE-CRON-001', 'routine“' + (routine.id || index + 1) + '”的 cron 非法：' + cronError + '。'));
  }
  return out;
}

function validateRoom(file, options = {}) {
  const parsed = parseYaml(file, 'ROOM');
  if (parsed.errors.length) return parsed.errors;
  return [...shapeIssues('ROOM', parsed, validateRoomShape), ...localRoomIssues(parsed, options)]
    .sort((a, b) => a.line - b.line || a.code.localeCompare(b.code));
}

function modelRefs(room) {
  if (!room?.model) return [];
  return [room.model, ...(room.model.fallback || [])];
}

function validateHouse(dir, options = {}) {
  const houseFile = path.join(dir, 'house.yaml');
  const houseParsed = parseYaml(houseFile, 'HOUSE');
  const out = [...houseParsed.errors];
  if (houseParsed.errors.length) return out;

  const house = houseParsed.value || {};
  let houseShape = shapeIssues('HOUSE', houseParsed, validateHouseShape);
  const misplacedExceeded = house.defaults?.heartbeat?.on_exceeded !== undefined && house.defaults?.heartbeat?.budget?.on_exceeded === undefined;
  if (misplacedExceeded) {
    houseShape = houseShape.filter(item => !item.message_zh.includes('on_exceeded'));
    out.push(issue(houseFile, lineFor(houseParsed, '/defaults/heartbeat', 'on_exceeded'), 'HOUSE-HEARTBEAT-001', 'on_exceeded 应放在 defaults.heartbeat.budget 里面，与 per_day 同级。'));
  }
  out.push(...houseShape);
  out.push(...routineIssues('HOUSE', houseParsed, house));
  const aliases = new Map();
  for (const cred of house.credentials || []) {
    if (aliases.has(cred.alias)) {
      out.push(issue(houseFile, lineFor(houseParsed, '', 'credentials'), 'CRED-ALIAS-DUP-001', '凭证公开别名“' + cred.alias + '”重复。'));
    }
    aliases.set(cred.alias, cred);
  }

  const roomsDir = path.join(dir, 'rooms');
  const parsedRooms = [];
  if (!fs.existsSync(roomsDir)) {
    out.push(issue(roomsDir, 1, 'HOUSE-ROOMS-001', '找不到 rooms/，房子里还没有房间目录。'));
    return out;
  }
  for (const entry of fs.readdirSync(roomsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = path.join(roomsDir, entry.name, 'room.yaml');
    if (!fs.existsSync(file)) continue;
    const parsed = parseYaml(file, 'ROOM');
    if (parsed.errors.length) { out.push(...parsed.errors); continue; }
    out.push(...shapeIssues('ROOM', parsed, validateRoomShape), ...localRoomIssues(parsed, options));
    parsedRooms.push(parsed);
  }

  const ids = new Map();
  const names = [];
  for (const parsed of parsedRooms) {
    const room = parsed.value;
    if (room.id) {
      if (ids.has(room.id)) out.push(issue(parsed.file, lineFor(parsed, '', 'id'), 'ROOM-ID-DUP-001', '住户 id“' + room.id + '”与 ' + ids.get(room.id) + ' 重复。id 必须永久唯一。'));
      else ids.set(room.id, parsed.file);
    }
    for (const raw of [room.name, ...(room.aliases || [])].filter(Boolean)) {
      const normalized = normalizeName(raw);
      for (const prev of names) {
        if (normalized === prev.normalized) {
          out.push(issue(parsed.file, lineFor(parsed, '', raw === room.name ? 'name' : 'aliases'), 'ROOM-NAME-DUP-001', '名字“' + raw + '”与 ' + prev.raw + ' 规范化后相同。'));
        } else if (normalized.startsWith(prev.normalized) || prev.normalized.startsWith(normalized)) {
          out.push(issue(parsed.file, lineFor(parsed, '', raw === room.name ? 'name' : 'aliases'), 'ROOM-NAME-PREFIX-001', '名字“' + raw + '”与 ' + prev.raw + ' 互为前缀。'));
        }
      }
      names.push({ normalized, raw, file: parsed.file });
    }

    for (const ref of modelRefs(room)) {
      const credential = ref.auth?.credential;
      const authMode = ref.auth?.mode;
      const declared = credential ? aliases.get(credential) : null;
      if (credential && !declared) {
        out.push(issue(parsed.file, lineFor(parsed, '/model/auth', 'credential'), 'CRED-ALIAS-001', '凭证别名“' + credential + '”不在 house.yaml 的公开名录中。'));
      }
      if (declared) {
        const declaredMode = declared.mode || 'broker';
        if (authMode !== declaredMode) out.push(issue(parsed.file, lineFor(parsed, '/model/auth', 'mode'), 'CRED-MODE-001', '凭证“' + credential + '”在 house.yaml 中是 ' + declaredMode + '，房间不能写成 ' + authMode + '。'));
        if (ref.provider !== declared.provider) out.push(issue(parsed.file, lineFor(parsed, '/model', 'provider'), 'CRED-PROVIDER-001', '凭证“' + credential + '”属于 provider ' + declared.provider + '，不能用于 ' + ref.provider + '。'));
      }
    }

    for (const [permission, value] of Object.entries(room.permissions || {})) {
      const ceiling = house.defaults?.permissions?.[permission];
      if (ceiling === undefined) {
        out.push(issue(parsed.file, lineFor(parsed, '/permissions', permission), 'ROOM-PERM-UNKNOWN-001', '权限“' + permission + '”不在 house.yaml 权限上限中。'));
      } else if (PERMISSION_RANK[value] > PERMISSION_RANK[ceiling]) {
        out.push(issue(parsed.file, lineFor(parsed, '/permissions', permission), 'ROOM-PERM-CEILING-001', '权限“' + permission + '”不能比全屋上限 ' + ceiling + ' 更宽。'));
      }
    }
  }

  const mountIds = new Set();
  for (const mount of house.gateway?.mounts || []) {
    if (!mount || typeof mount !== 'object' || Array.isArray(mount)) continue;
    if (mount.id === 'own-room') {
      out.push(issue(houseFile, lineFor(houseParsed, '/gateway/mounts', 'id'), 'HOUSE-GATEWAY-MOUNT-RESERVED-001', 'gateway mount id“own-room”是保留名，由系统指向住户自己的房间。'));
    } else if (mountIds.has(mount.id)) {
      out.push(issue(houseFile, lineFor(houseParsed, '/gateway/mounts', 'id'), 'HOUSE-GATEWAY-MOUNT-DUP-001', 'gateway mount id“' + mount.id + '”重复。'));
    } else mountIds.add(mount.id);
    for (const residentId of Object.keys(mount.residents || {})) if (!ids.has(residentId)) {
      out.push(issue(houseFile, lineFor(houseParsed, '/gateway/mounts', 'residents'), 'HOUSE-GATEWAY-RESIDENT-001', 'gateway mount 引用了不存在的住户 id“' + residentId + '”。'));
    }
  }

  if (house.extensions && options.knownExtensions) {
    const known = new Set(options.knownExtensions);
    for (const namespace of Object.keys(house.extensions)) if (!known.has(namespace)) {
      out.push(issue(houseFile, lineFor(houseParsed, '/extensions', namespace), 'HOUSE-EXT-001', '扩展“' + namespace + '”没有已安装插件声明，启动拒绝。'));
    }
  }

  const deduped = [];
  const seen = new Set();
  for (const item of out) {
    const key = item.file + '|' + item.line + '|' + item.code + '|' + item.message_zh;
    if (!seen.has(key)) { seen.add(key); deduped.push(item); }
  }
  return deduped.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.code.localeCompare(b.code));
}

module.exports = { normalizeName, validateCronExpression, resolveExecutionConfig, validateRoom, validateHouse, schemas: { room: roomSchema, house: houseSchema } };
