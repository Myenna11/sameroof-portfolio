#!/usr/bin/env node
// 同屋 · 能力网关控制面：只管 adapter token（签发 / 吊销 / 列出）。路径和服务进程用同一组环境变量。
// 只开 State（sqlite），不构造 Gateway——构造会把 executing 的 intent 标成 failed_unknown，控制面不能有这种副作用。
// service token（客厅 ↔ 网关）由 root 用 deploy/gateway-service-token.sh 写两处，不在这里。
'use strict';
const path = require('path');
const { State, GatewayError, issueAdapterToken, revokeAdapterToken } = require('./server');

function usage() {
  console.log(`用法：
sameroof-gateway token issue <resident_id>    签发（或轮换）住户的 adapter token，写到 tokens 目录，只回显路径
sameroof-gateway token revoke <resident_id>   吊销并删文件
sameroof-gateway token list                   列出（只有 hash 前 8 位）`);
}
function run(argv = process.argv.slice(2)) {
  const runDir = path.resolve(process.env.SAMEROOF_GATEWAY_RUN_DIR || '/run/sameroof-gateway');
  const stateDir = path.resolve(process.env.SAMEROOF_GATEWAY_STATE_DIR || '/var/lib/sameroof-gateway');
  const tokensDir = path.resolve(process.env.SAMEROOF_GATEWAY_TOKENS_DIR || path.join(runDir, 'tokens'));
  const [group, verb, arg] = argv;
  if (group !== 'token' || !['issue', 'revoke', 'list'].includes(verb)) { usage(); process.exitCode = argv.length ? 2 : 0; return; }
  const state = new State(path.join(stateDir, 'gateway.db'));
  try {
    if (verb === 'list') { console.log(JSON.stringify(state.db.prepare('SELECT resident_id, substr(token_hash,1,8) AS hash8, status, created_at FROM adapter_tokens ORDER BY resident_id').all(), null, 2)); return; }
    if (!arg) throw new GatewayError(400, 'GW-CLI-USAGE', '缺 resident_id。');
    if (verb === 'issue') { const r = issueAdapterToken(state, tokensDir, arg); console.log(JSON.stringify({ resident_id: r.resident_id, file: r.file }, null, 2)); return; }   // 不回显 token 本身，文件就是投递
    console.log(JSON.stringify(revokeAdapterToken(state, tokensDir, arg), null, 2));
  } finally { state.close(); }
}
if (require.main === module) { try { run(); } catch (error) { console.error((error.code || 'GW-CLI-ERROR') + ': ' + error.message); process.exit(1); } }
module.exports = { run };
