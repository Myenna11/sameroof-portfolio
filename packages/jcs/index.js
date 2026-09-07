// 同屋 · RFC 8785 JSON Canonicalization Scheme（JCS）
// 客厅与能力网关两边算 params_digest 都用这里：digest(value) = sha256(UTF-8(canonicalize(value)))，小写 hex。
// 零依赖。拒绝：NaN/±Infinity、undefined、函数、symbol、BigInt、循环引用、深度 > 64、单个字符串 > 1 MiB、（parseStrict）重复键。
'use strict';
const crypto = require('crypto');

const MAX_DEPTH = 64;
const MAX_STRING = 1024 * 1024;

class JcsError extends Error {
  constructor(code, message) { super(message); this.name = 'JcsError'; this.code = code; }
}

// 深度：顶层标量 depth=0；对象/数组的孩子 depth+1。第 65 层容器即拒。
function serialize(value, depth, stack) {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean': return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new JcsError('JCS-NUMBER-INVALID', 'JCS 不接受 NaN / Infinity。');
      return JSON.stringify(value);                       // ES Number.prototype.toString，即 RFC 8785 要求的数字形状（-0 → 0）
    case 'string':
      if (value.length > MAX_STRING) throw new JcsError('JCS-STRING-TOO-LONG', '字符串超过 1 MiB。');
      return JSON.stringify(value);                       // 转义规则与 RFC 8785 §3.2.2.2 一致
    case 'undefined': throw new JcsError('JCS-TYPE-INVALID', 'JCS 不接受 undefined。');
    case 'function': throw new JcsError('JCS-TYPE-INVALID', 'JCS 不接受函数。');
    case 'symbol': throw new JcsError('JCS-TYPE-INVALID', 'JCS 不接受 symbol。');
    case 'bigint': throw new JcsError('JCS-TYPE-INVALID', 'JCS 不接受 BigInt。');
    case 'object': break;
    default: throw new JcsError('JCS-TYPE-INVALID', '不认识的值类型：' + typeof value);
  }
  if (depth >= MAX_DEPTH) throw new JcsError('JCS-DEPTH-EXCEEDED', '嵌套深度超过 ' + MAX_DEPTH + '。');
  if (stack.includes(value)) throw new JcsError('JCS-CYCLE', '有循环引用。');
  stack.push(value);
  let out;
  if (Array.isArray(value)) {
    const parts = new Array(value.length);
    for (let i = 0; i < value.length; i++) parts[i] = serialize(value[i], depth + 1, stack);
    out = '[' + parts.join(',') + ']';
  } else {
    if (typeof value.toJSON === 'function' || Object.prototype.toString.call(value) !== '[object Object]') {
      throw new JcsError('JCS-TYPE-INVALID', '只接受普通对象（不接受 Date/Map/Buffer 等）。');
    }
    const keys = Object.keys(value).sort();               // 默认 sort 按 UTF-16 code unit 比较，正是 RFC 8785 §3.2.3
    const parts = [];
    for (const key of keys) {
      if (key.length > MAX_STRING) throw new JcsError('JCS-STRING-TOO-LONG', '键超过 1 MiB。');
      parts.push(JSON.stringify(key) + ':' + serialize(value[key], depth + 1, stack));
    }
    out = '{' + parts.join(',') + '}';
  }
  stack.pop();
  return out;
}

function canonicalize(value) { return serialize(value, 0, []); }

function digest(value) {
  return crypto.createHash('sha256').update(canonicalize(value), 'utf8').digest('hex');
}

// ---- parseStrict：小递归下降 JSON 解析器。JSON.parse 挡不住重复键（后者覆盖前者），这里对象内键重复直接拒。
// 同样施加深度/字符串上限；数字必须是有限 double；不接受尾随内容、注释、单引号等任何扩展。
const WS = new Set([0x20, 0x09, 0x0a, 0x0d]);
function parseStrict(text) {
  if (typeof text !== 'string') throw new JcsError('JCS-PARSE', '要解析的得是字符串。');
  let i = 0;
  const n = text.length;
  const skip = () => { while (i < n && WS.has(text.charCodeAt(i))) i++; };
  const fail = msg => { throw new JcsError('JCS-PARSE', msg + '（位置 ' + i + '）'); };
  const define = (obj, key, val) => Object.defineProperty(obj, key, { value: val, enumerable: true, writable: true, configurable: true });

  function parseString() {
    // 进来时 text[i] === '"'
    const start = ++i;
    let out = '';
    let segStart = i;
    while (true) {
      if (i >= n) fail('字符串没有结尾');
      const c = text.charCodeAt(i);
      if (c === 0x22) { out += text.slice(segStart, i); i++; break; }
      if (c < 0x20) fail('字符串里有未转义的控制字符');
      if (c === 0x5c) {
        out += text.slice(segStart, i);
        i++;
        if (i >= n) fail('转义没写完');
        const e = text[i];
        switch (e) {
          case '"': out += '"'; break;
          case '\\': out += '\\'; break;
          case '/': out += '/'; break;
          case 'b': out += '\b'; break;
          case 'f': out += '\f'; break;
          case 'n': out += '\n'; break;
          case 'r': out += '\r'; break;
          case 't': out += '\t'; break;
          case 'u': {
            const hex = text.slice(i + 1, i + 5);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail('\\u 转义不合法');
            out += String.fromCharCode(parseInt(hex, 16));
            i += 4;
            break;
          }
          default: fail('不认识的转义 \\' + e);
        }
        i++;
        segStart = i;
        continue;
      }
      i++;
      if (i - start > MAX_STRING) throw new JcsError('JCS-STRING-TOO-LONG', '字符串超过 1 MiB。');
    }
    if (out.length > MAX_STRING) throw new JcsError('JCS-STRING-TOO-LONG', '字符串超过 1 MiB。');
    return out;
  }

  function parseNumber() {
    const m = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(text.slice(i, i + 400));
    if (!m) fail('数字不合法');
    i += m[0].length;
    const v = Number(m[0]);
    if (!Number.isFinite(v)) throw new JcsError('JCS-NUMBER-INVALID', '数字超出 double 范围。');
    return v;
  }

  function parseValue(depth) {
    skip();
    if (i >= n) fail('意外结束');
    const ch = text[i];
    if (ch === '{') {
      if (depth >= MAX_DEPTH) throw new JcsError('JCS-DEPTH-EXCEEDED', '嵌套深度超过 ' + MAX_DEPTH + '。');
      i++;
      const obj = {};
      const seen = new Set();
      skip();
      if (text[i] === '}') { i++; return obj; }
      while (true) {
        skip();
        if (text[i] !== '"') fail('对象的键得是字符串');
        const key = parseString();
        if (seen.has(key)) throw new JcsError('JCS-DUPLICATE-KEY', '对象里键重复：' + JSON.stringify(key));
        seen.add(key);
        skip();
        if (text[i] !== ':') fail('键后面要有冒号');
        i++;
        const val = parseValue(depth + 1);
        define(obj, key, val);
        skip();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === '}') { i++; return obj; }
        fail('对象里要么逗号要么右花括号');
      }
    }
    if (ch === '[') {
      if (depth >= MAX_DEPTH) throw new JcsError('JCS-DEPTH-EXCEEDED', '嵌套深度超过 ' + MAX_DEPTH + '。');
      i++;
      const arr = [];
      skip();
      if (text[i] === ']') { i++; return arr; }
      while (true) {
        arr.push(parseValue(depth + 1));
        skip();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === ']') { i++; return arr; }
        fail('数组里要么逗号要么右方括号');
      }
    }
    if (ch === '"') return parseString();
    if (ch === '-' || (ch >= '0' && ch <= '9')) return parseNumber();
    if (text.startsWith('true', i)) { i += 4; return true; }
    if (text.startsWith('false', i)) { i += 5; return false; }
    if (text.startsWith('null', i)) { i += 4; return null; }
    fail('不认识的 token');
  }

  const value = parseValue(0);
  skip();
  if (i < n) fail('JSON 后面还有多余内容');
  return value;
}

module.exports = { canonicalize, digest, parseStrict, JcsError, MAX_DEPTH, MAX_STRING };
