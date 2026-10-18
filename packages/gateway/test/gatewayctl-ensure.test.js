'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { State, issueAdapterToken, revokeAdapterToken } = require('../server');
const { ensureAdapterTokens } = require('../gatewayctl');

test('token ensure：只补签文件丢了的 active 住户，不动还在的，不复活吊销的', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-ensure-'));
  const tokens = path.join(dir, 'tokens');
  const state = new State(path.join(dir, 'gateway.db'));
  try {
    issueAdapterToken(state, tokens, 'resident_alpha_01');
    issueAdapterToken(state, tokens, 'resident_beta_01');
    issueAdapterToken(state, tokens, 'resident_gamma_01');
    revokeAdapterToken(state, tokens, 'resident_gamma_01');
    const keep = fs.readFileSync(path.join(tokens, 'resident_alpha_01'), 'utf8');
    fs.unlinkSync(path.join(tokens, 'resident_beta_01'));   // 模拟重启清空了 /run

    assert.deepEqual(ensureAdapterTokens(state, tokens), { checked: 2, reissued: ['resident_beta_01'] });
    assert.equal(fs.readFileSync(path.join(tokens, 'resident_alpha_01'), 'utf8'), keep);
    assert.ok(fs.existsSync(path.join(tokens, 'resident_beta_01')));
    assert.ok(!fs.existsSync(path.join(tokens, 'resident_gamma_01')));
    assert.deepEqual(ensureAdapterTokens(state, tokens), { checked: 2, reissued: [] });
  } finally { state.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
