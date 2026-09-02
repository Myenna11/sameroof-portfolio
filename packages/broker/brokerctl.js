#!/usr/bin/env node
'use strict';

const fs = require('fs');
const { BrokerStore, BrokerError } = require('./store');
const { createBroker } = require('./server');

function parse(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const item = argv[i];
    if (!item.startsWith('--')) { positional.push(item); continue; }
    const key = item.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) flags[key] = true;
    else { flags[key] = next; i++; }
  }
  return { positional, flags };
}

function required(value, message) {
  if (value === undefined || value === null || value === '') throw new BrokerError(400, 'CLI-ARG-REQUIRED', message);
  return value;
}

function readSecret(flags) {
  const keyFile = flags['key-file'];
  if (keyFile === '-') return fs.readFileSync(0, 'utf8').trim();
  if (keyFile) return fs.readFileSync(keyFile, 'utf8').trim();
  throw new BrokerError(400, 'CLI-KEY-REQUIRED', '真凭证请通过 --key-file <0600文件> 或 --key-file - 从 stdin 提供，不能放命令行。');
}

function seconds(value) {
  const match = /^(\d+)(s|m|h|d)$/.exec(String(value || '12h'));
  if (!match) throw new BrokerError(400, 'CLI-TTL-INVALID', 'ttl 请写成 30m、12h 或 2d。');
  return Number(match[1]) * ({ s: 1, m: 60, h: 3600, d: 86400 })[match[2]];
}

function print(value) {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

function usage() {
  console.log(`sameroof-broker serve
sameroof-broker cred add <alias> --provider <id> --base-url <url> --key-file <path|->
sameroof-broker cred list
sameroof-broker cred rotate <alias> --key-file <path|->
sameroof-broker cred revoke <alias>
sameroof-broker token issue <resident_id> --credential <alias[,alias]> --models <id[,id]> [--purposes interactive,heartbeat] [--ttl 12h] [--max-requests 100] [--max-tokens 200000]
sameroof-broker token list
sameroof-broker token revoke|quarantine|activate <token_id>
sameroof-broker ledger [--limit 50]

真凭证永远不接受 --api-key，避免进入 shell history。token secret 只在签发时显示一次，并写入 0600 token 文件。`);
}

async function run(argv = process.argv.slice(2)) {
  const { positional: p, flags: f } = parse(argv);
  if (p[0] === 'serve') {
    const broker = createBroker();
    const result = await broker.listen();
    console.log('同屋·凭证 broker 已监听 ' + result.socketPath);
    return new Promise(() => {});
  }

  const store = new BrokerStore();
  try {
    if (p[0] === 'cred' && p[1] === 'add') return print(store.addCredential({
      alias: required(p[2], '缺凭证别名。'),
      provider: required(f.provider, '缺 --provider。'),
      baseUrl: required(f['base-url'], '缺 --base-url。'),
      apiKey: readSecret(f),
      authHeader: f['auth-header'],
      authScheme: f['auth-scheme']
    }));
    if (p[0] === 'cred' && p[1] === 'list') return print(store.listCredentials());
    if (p[0] === 'cred' && p[1] === 'rotate') return print(store.rotateCredential(required(p[2], '缺凭证别名。'), readSecret(f)));
    if (p[0] === 'cred' && p[1] === 'revoke') return print(store.revokeCredential(required(p[2], '缺凭证别名。')));

    if (p[0] === 'token' && p[1] === 'issue') return print(store.issueToken({
      residentId: required(p[2], '缺 resident id。'),
      credentials: required(f.credential, '缺 --credential。'),
      models: required(f.models, '缺 --models。'),
      purposes: f.purposes || 'interactive',
      ttlSeconds: seconds(f.ttl),
      maxRequests: f['max-requests'] === undefined ? null : Number(f['max-requests']),
      maxTokens: f['max-tokens'] === undefined ? null : Number(f['max-tokens']),
      reason: f.reason || null
    }));
    if (p[0] === 'token' && p[1] === 'list') return print(store.listTokens());
    if (p[0] === 'token' && p[1] === 'revoke') return print(store.revokeToken(required(p[2], '缺 token id。')));
    if (p[0] === 'token' && p[1] === 'quarantine') return print(store.setTokenStatus(required(p[2], '缺 token id。'), 'quarantined'));
    if (p[0] === 'token' && p[1] === 'activate') return print(store.setTokenStatus(required(p[2], '缺 token id。'), 'active'));
    if (p[0] === 'ledger') return print(store.listLedger(f.limit || 50));

    usage();
    if (p.length) process.exitCode = 2;
  } finally {
    store.close();
  }
}

if (require.main === module) run().catch(error => {
  const code = error instanceof BrokerError ? error.code : 'BROKER-CLI-ERROR';
  console.error(code + ': ' + error.message);
  process.exit(1);
});

module.exports = { run, parse, seconds };
