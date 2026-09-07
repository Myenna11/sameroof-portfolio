// 同屋 · cron 匹配器：零依赖，五段「分 时 日 月 周」，时区交给 Intl（不自己算偏移）。
'use strict';
const FIELDS = [
  { name: '分', min: 0, max: 59 }, { name: '时', min: 0, max: 23 }, { name: '日', min: 1, max: 31 },
  { name: '月', min: 1, max: 12 }, { name: '周', min: 0, max: 7 },           // 周 0 和 7 都是周日
];
const cache = new Map();

function parseField(src, f, expr) {
  const bad = why => new Error(`cron 表达式非法「${expr}」：${f.name}字段 ${why}`);
  const set = new Set();
  for (const part of src.split(',')) {
    const m = part.match(/^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/); if (!m) throw bad(`"${part}" 看不懂`);
    const step = m[2] ? Number(m[2]) : 1; if (!(step >= 1)) throw bad(`"${part}" 步长得 ≥1`);
    let a, b;
    if (m[1] === '*') { a = f.min; b = f.max; }
    else if (m[1].includes('-')) [a, b] = m[1].split('-').map(Number);
    else { a = Number(m[1]); b = m[2] ? f.max : a; }                        // "5/15" 按 5-max/15
    if (a < f.min || b > f.max || a > b) throw bad(`"${part}" 超出 ${f.min}-${f.max}`);
    for (let v = a; v <= b; v += step) set.add(f === FIELDS[4] && v === 7 ? 0 : v);
  }
  return { set, star: src.startsWith('*') };                               // 以 * 开头的日/周字段视作"没限制"（Vixie 语义）
}
// 解析成 { expr, fields:[Set×5], domStar, dowStar }；非法就抛，错误里带原文
function parse(expr) {
  if (cache.has(expr)) return cache.get(expr);
  if (typeof expr !== 'string') throw new Error(`cron 表达式非法「${expr}」：不是字符串`);
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`cron 表达式非法「${expr}」：要 5 段（分 时 日 月 周），给了 ${parts.length} 段`);
  const fs = parts.map((p, i) => parseField(p, FIELDS[i], expr));
  const out = { expr, fields: fs.map(x => x.set), domStar: fs[2].star, dowStar: fs[4].star };
  cache.set(expr, out); return out;
}
// 某时区下这一刻的 分/时/日/月/周（周 0=日）和 'YYYY-MM-DDTHH:MM' 键
const DOW = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
function parts(date, tz) {
  const p = {};
  for (const x of new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short' }).formatToParts(date)) p[x.type] = x.value;
  return { minute: Number(p.minute), hour: Number(p.hour) % 24, day: Number(p.day), month: Number(p.month), dow: DOW[p.weekday], key: `${p.year}-${p.month}-${p.day}T${String(Number(p.hour) % 24).padStart(2, '0')}:${p.minute}` };
}
function matches(expr, date = new Date(), tz = 'UTC') {
  const c = typeof expr === 'string' ? parse(expr) : expr; const t = parts(date, tz); const [mi, h, d, mo, w] = c.fields;
  if (!mi.has(t.minute) || !h.has(t.hour) || !mo.has(t.month)) return false;
  const dayOk = d.has(t.day), dowOk = w.has(t.dow);
  return (!c.domStar && !c.dowStar) ? (dayOk || dowOk) : (dayOk && dowOk);    // 日、周都写了限制时按标准 cron"任一匹配"
}
module.exports = { parse, matches, parts };
