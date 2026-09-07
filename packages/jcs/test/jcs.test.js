'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const { canonicalize, digest, parseStrict, JcsError, MAX_DEPTH } = require('..');

const codeOf = fn => { try { fn(); } catch (e) { assert.ok(e instanceof JcsError, '应抛 JcsError，实际：' + e); return e.code; } assert.fail('应当抛错'); };

test('RFC 8785 §3.2.2.3 数字：1E30 → 1e+30、4.50 → 4.5、1e-27', () => {
  assert.equal(canonicalize({ numbers: [333333333.33333329, 1E30, 4.50, 2e-3, 0.000000000000000000000000001] }),
    '{"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27]}');
  assert.equal(canonicalize(-0), '0');
  assert.equal(canonicalize({ literals: [null, true, false] }), '{"literals":[null,true,false]}');
});

test('RFC 8785 §3.2.3 Unicode 键按 UTF-16 code unit 排序', () => {
  const input = parseStrict('{"\\u20ac":"Euro Sign","\\r":"Carriage Return","\\u000a":"Newline","1":"One","\\u0080":"Control\\u007f","\\ud83d\\ude02":"Smiley Face","\\u00f6":"Latin Small Letter O With Diaeresis","\\ufb33":"Hebrew Letter Dalet With Dagesh"}');
  const out = canonicalize(input);
  assert.equal(out, '{"\\n":"Newline","\\r":"Carriage Return","1":"One","\u0080":"Control\u007f","\u00f6":"Latin Small Letter O With Diaeresis","\u20ac":"Euro Sign","\ud83d\ude02":"Smiley Face","\ufb33":"Hebrew Letter Dalet With Dagesh"}');
  // 代理对（😂 = D83D DE02）排在 FB33 之前：按 code unit 而不是 code point
  assert.ok(out.indexOf('\ud83d\ude02') < out.indexOf('\ufb33'));
});

test('RFC 8785 Appendix B 嵌套示例（键排序递归、56.0 → 56、空对象）', () => {
  const text = '{"1":{"f":{"f":"hi","F":5},"\\n":56.0},"10":{},"":"empty","a":{},"111":[{"e":"yes","E":"no"}],"A":{}}';
  const expected = '{"":"empty","1":{"\\n":56,"f":{"F":5,"f":"hi"}},"10":{},"111":[{"E":"no","e":"yes"}],"A":{},"a":{}}';
  assert.equal(canonicalize(parseStrict(text)), expected);
  assert.equal(canonicalize(JSON.parse(text)), expected);           // 从对象来的与从文本来的一致
  assert.equal(canonicalize(parseStrict(expected)), expected);      // 幂等
});

test('digest = sha256(UTF-8(JCS))，小写 hex，与键顺序无关', () => {
  assert.equal(digest({}), '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a');
  const a = { path: 'notes/今天.md', root_id: 'own-room', mode: 'replace', content: 'héllo\n' };
  const b = { content: 'héllo\n', mode: 'replace', root_id: 'own-room', path: 'notes/今天.md' };
  assert.equal(digest(a), digest(b));
  assert.equal(digest(a), crypto.createHash('sha256').update(Buffer.from(canonicalize(a), 'utf8')).digest('hex'));
  assert.match(digest(a), /^[0-9a-f]{64}$/);
});

test('拒绝：NaN / Infinity / undefined / 函数 / BigInt / symbol / Date', () => {
  assert.equal(codeOf(() => canonicalize({ a: NaN })), 'JCS-NUMBER-INVALID');
  assert.equal(codeOf(() => canonicalize([Infinity])), 'JCS-NUMBER-INVALID');
  assert.equal(codeOf(() => canonicalize(-Infinity)), 'JCS-NUMBER-INVALID');
  assert.equal(codeOf(() => canonicalize({ a: undefined })), 'JCS-TYPE-INVALID');
  assert.equal(codeOf(() => canonicalize([undefined])), 'JCS-TYPE-INVALID');
  assert.equal(codeOf(() => canonicalize({ a: () => 1 })), 'JCS-TYPE-INVALID');
  assert.equal(codeOf(() => canonicalize({ a: 10n })), 'JCS-TYPE-INVALID');
  assert.equal(codeOf(() => canonicalize({ a: Symbol('x') })), 'JCS-TYPE-INVALID');
  assert.equal(codeOf(() => canonicalize({ a: new Date(0) })), 'JCS-TYPE-INVALID');
});

test('拒绝：循环引用', () => {
  const a = { b: {} }; a.b.a = a;
  assert.equal(codeOf(() => canonicalize(a)), 'JCS-CYCLE');
  const shared = { x: 1 };                                          // 同一对象出现两次但不成环，允许
  assert.equal(canonicalize({ p: shared, q: shared }), '{"p":{"x":1},"q":{"x":1}}');
});

test('拒绝：深度 > 64（64 层容器可以，65 层不行；解析与序列化同一口径）', () => {
  const nest = k => { let v = 1; for (let i = 0; i < k; i++) v = [v]; return v; };
  assert.doesNotThrow(() => canonicalize(nest(MAX_DEPTH)));
  assert.equal(codeOf(() => canonicalize(nest(MAX_DEPTH + 1))), 'JCS-DEPTH-EXCEEDED');
  assert.doesNotThrow(() => parseStrict('['.repeat(MAX_DEPTH) + '1' + ']'.repeat(MAX_DEPTH)));
  assert.equal(codeOf(() => parseStrict('['.repeat(MAX_DEPTH + 1) + '1' + ']'.repeat(MAX_DEPTH + 1))), 'JCS-DEPTH-EXCEEDED');
});

test('拒绝：字符串 > 1 MiB（序列化与解析）', () => {
  const big = 'x'.repeat(1024 * 1024 + 1);
  assert.equal(codeOf(() => canonicalize({ s: big })), 'JCS-STRING-TOO-LONG');
  assert.equal(codeOf(() => parseStrict('"' + big + '"')), 'JCS-STRING-TOO-LONG');
  assert.doesNotThrow(() => canonicalize({ s: 'x'.repeat(1024 * 1024) }));
});

test('parseStrict：拒绝重复键（顶层与嵌套），JSON.parse 拦不住', () => {
  assert.equal(JSON.parse('{"a":1,"a":2}').a, 2);
  assert.equal(codeOf(() => parseStrict('{"a":1,"a":2}')), 'JCS-DUPLICATE-KEY');
  assert.equal(codeOf(() => parseStrict('{"x":{"a":1,"b":2,"a":3}}')), 'JCS-DUPLICATE-KEY');
  assert.equal(codeOf(() => parseStrict('{"a":1,"\\u0061":2}')), 'JCS-DUPLICATE-KEY');   // 转义后相同也算重复
});

test('parseStrict：标准 JSON 都能读，扩展语法与尾随内容都拒，__proto__ 只是普通键', () => {
  assert.deepEqual(parseStrict(' {"a":[1,-2.5e3,"s\\"q\\u00e9",true,false,null,{}],"b":""} '), { a: [1, -2500, 's"qé', true, false, null, {}], b: '' });
  for (const bad of ['{"a":1,}', '[1,]', "{'a':1}", '{a:1}', '{"a":NaN}', '{"a":Infinity}', '{"a":01}', '{"a":1} x', '', '{"a":"\t"}', '{"a":undefined}', '// c\n{}']) {
    assert.equal(codeOf(() => parseStrict(bad)), 'JCS-PARSE', bad);
  }
  assert.equal(codeOf(() => parseStrict('{"a":1e999}')), 'JCS-NUMBER-INVALID');
  const o = parseStrict('{"__proto__":{"polluted":true}}');
  assert.equal(Object.getPrototypeOf(o), Object.prototype);
  assert.equal(({}).polluted, undefined);
  assert.equal(canonicalize(o), '{"__proto__":{"polluted":true}}');
});
