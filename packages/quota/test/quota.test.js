// 配额气象台：各家解析（错误夹具是本机真拿到的，成功夹具按参考实现的形状）、分组、并发容错、stale 缓存。
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const quota = require('..');
const claude = require('../providers/claude'), codex = require('../providers/codex'), kimi = require('../providers/kimi'), glm = require('../providers/glm'), deepseek = require('../providers/deepseek');

test('claude：five_hour / seven_day / seven_day_<model> → 窗口；utilization 就是 usedPercent', () => {
  const w = claude.parse({ five_hour: { utilization: 22.4, resets_at: '2026-09-08T03:00:00Z' }, seven_day: { utilization: 5, resets_at: '2026-09-14T00:00:00Z' }, seven_day_opus: { utilization: 1 }, extra_usage: { enabled: false } });
  assert.deepEqual(w, [{ label: '5 小时窗', usedPercent: 22.4, resetAt: '2026-09-08T03:00:00.000Z' }, { label: '7 天窗', usedPercent: 5, resetAt: '2026-09-14T00:00:00.000Z' }, { label: '7 天窗 · opus', usedPercent: 1 }]);
  assert.throws(() => claude.parse({ ok: true }), /没有认得的窗口/);
});
test('codex：rate_limit.primary/secondary_window，窗口长度算标签，epoch 秒和 ISO 都认', () => {
  const p = codex.parse({ plan_type: 'pro', rate_limit: { primary_window: { used_percent: 37, limit_window_seconds: 18000, resets_at: 1757300000 }, secondary_window: { used_percent: 12.5, limit_window_seconds: 604800, resets_at: '2026-09-14T00:00:00Z' } } });
  assert.equal(p.plan, 'pro');
  assert.deepEqual(p.windows, [{ label: '5 小时窗', usedPercent: 37, resetAt: '2025-09-08T02:53:20.000Z' }, { label: '7 天窗', usedPercent: 12.5, resetAt: '2026-09-14T00:00:00.000Z' }]);
  assert.throws(() => codex.parse({ rate_limit: {} }), /没有认得的窗口/);
});
test('kimi：顶层 usage 是周额度，limits[] 里 300 MINUTE 是 5 小时窗；used/limit 或 limit-remaining 都能算', () => {
  const w = kimi.parse({ usage: { limit: 1000, remaining: 800, used: 200, resetTime: '2026-09-14T00:00:00Z' }, limits: [{ window: { duration: 300, timeUnit: 'MINUTE' }, detail: { limit: 100, remaining: 90 } }, { window: { duration: 1, timeUnit: 'TIME_UNIT_DAY' }, detail: {} }] });
  assert.deepEqual(w, [{ label: '周额度', usedPercent: 20, resetAt: '2026-09-14T00:00:00.000Z', detail: '200 / 1000' }, { label: '5 小时窗', usedPercent: 10 }]);   // 空 detail 的窗口不出
  assert.throws(() => kimi.parse({ usage: {}, limits: [] }), /没有认得的窗口/);
});
test('glm：真机的"没有 coding plan"回包 → QUOTA-NO-PLAN；有 plan 时 TOKENS/CREDIT 出窗口，TIME_LIMIT 不出；broker 预算 → 窗口', () => {
  assert.throws(() => glm.parse({ code: 500, msg: '当前用户不存在coding plan', success: false }), e => e.code === 'QUOTA-NO-PLAN');
  assert.throws(() => glm.parse({ code: 401, msg: 'bad', success: false }), e => e.code === 'QUOTA-REJECTED');
  const w = glm.parse({ code: 200, success: true, data: { limits: [{ type: 'TOKENS_LIMIT', percentage: 42, nextResetTime: 1757300000000 }, { type: 'TIME_LIMIT' }, { type: 'CREDIT_LIMIT', percentage: '7' }] } });
  assert.deepEqual(w, [{ label: 'Coding Plan 额度窗（tokens）', usedPercent: 42, resetAt: '2025-09-08T02:53:20.000Z' }, { label: 'Coding Plan 月额度', usedPercent: 7 }]);
  const b = glm.budgetWindows([{ resident_id: 'r1', tokens: [{ max_tokens: 300000, used_tokens: 45000, max_requests: null, used_requests: 3, expires_at: '2026-09-08T00:00:00.000Z' }, { max_tokens: null, used_tokens: 0, max_requests: 60, used_requests: 15, expires_at: null }] }], () => '检索员');
  assert.deepEqual(b, [{ label: '检索员 · broker token 预算', usedPercent: 15, resetAt: '2026-09-08T00:00:00.000Z', detail: '45000 / 300000 tokens' }, { label: '检索员 · broker 请求预算', usedPercent: 25, detail: '15 / 60 次' }]);
});
test('deepseek：余额只出文案，不伪造百分比', () => {
  assert.deepEqual(deepseek.parse({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '12.34', granted_balance: '0.00' }] }), { available: true, text: '余额 12.34 CNY' });
  assert.throws(() => deepseek.parse({ balance_infos: [] }), /balance_infos/);
});
test('分组：room.model.provider → 适配器；human 和没 model 的不算', () => {
  const g = quota.groupResidents([{ id: 'a', name: '规划员', model: { provider: 'claude-code' } }, { id: 'b', name: '检索员', model: { provider: 'zhipu' } }, { id: 'c', name: '实现员', model: { provider: 'kimi-coding' } }, { id: 'd', name: '审查员', model: { provider: 'openai-codex' } }, { id: 'e', name: '维护者', species: 'human' }, { id: 'f', name: '样板' }]);
  assert.deepEqual(Object.fromEntries(Object.entries(g).map(([k, v]) => [k, v.map(r => r.name)])), { claude: ['规划员'], glm: ['检索员'], kimi: ['实现员'], codex: ['审查员'] });
});
test('fetchAll：一家抛错不拖垮别家；超时也只是那一家 error；没适配器的 provider 也是一张 error 卡', async () => {
  const providers = {
    kimi: { label: 'Kimi', fetch: async () => ({ status: 'ok', windows: [{ label: '5 小时窗', usedPercent: 10 }] }) },
    glm: { label: 'GLM', fetch: async () => { throw Object.assign(new Error('key 没了'), { code: 'QUOTA-NOT-CONFIGURED' }); } },
    codex: { label: 'Codex', fetch: () => new Promise(() => {}) },
  };
  const residents = [{ id: 'c', name: '实现员', model: { provider: 'kimi-coding' } }, { id: 'b', name: '检索员', model: { provider: 'zhipu' } }, { id: 'd', name: '审查员', model: { provider: 'openai-codex' } }, { id: 'a', name: '规划员', model: { provider: 'claude-code' } }];
  const cards = await quota.fetchAll({ residents, providers, timeoutMs: 50 });
  const by = Object.fromEntries(cards.map(c => [c.provider, c]));
  assert.equal(by.kimi.status, 'ok'); assert.deepEqual(by.kimi.residents, ['实现员']); assert.equal(by.kimi.windows[0].usedPercent, 10);
  assert.equal(by.glm.status, 'error'); assert.equal(by.glm.code, 'QUOTA-NOT-CONFIGURED'); assert.match(by.glm.message, /key 没了/);
  assert.equal(by.codex.status, 'error'); assert.match(by.codex.message, /没回/);
  assert.equal(by.claude.status, 'error'); assert.match(by.claude.message, /还没写/);
});
test('snapshot：上次好数据留着，这次错了就带 stale 标记', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sameroof-quota-')); const cachePath = path.join(dir, 'quota-cache.json');
  let fail = false;
  const providers = { kimi: { label: 'Kimi', fetch: async () => { if (fail) throw new Error('过期'); return { status: 'ok', windows: [{ label: '周额度', usedPercent: 33 }] }; } } };
  const residents = [{ id: 'c', name: '实现员', model: { provider: 'kimi-coding' } }];
  const first = await quota.snapshot({ residents, providers, cachePath, tz: 'Asia/Shanghai' });
  assert.equal(first.providers[0].status, 'ok'); assert.equal(first.providers[0].stale, undefined);
  fail = true;
  const second = await quota.snapshot({ residents, providers, cachePath, tz: 'Asia/Shanghai' });
  const c = second.providers[0];
  assert.equal(c.status, 'error'); assert.equal(c.stale, true); assert.equal(c.staleSince, first.providers[0].fetchedAt); assert.equal(c.staleExpired, false); assert.deepEqual(c.windows, [{ label: '周额度', usedPercent: 33 }]);
  fs.rmSync(dir, { recursive: true, force: true });
});
test('dayStartIso：房子时区的今天 00:00', () => {
  assert.equal(quota.dayStartIso('Asia/Shanghai', new Date('2026-09-07T18:30:00Z')), '2026-09-07T16:00:00.000Z');   // 上海 9/8 00:00
  assert.equal(quota.dayStartIso('UTC', new Date('2026-09-07T18:30:00Z')), '2026-09-07T00:00:00.000Z');
});
