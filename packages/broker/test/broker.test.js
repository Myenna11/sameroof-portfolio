'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { BrokerStore, BrokerError } = require('../store');
const { createBroker, buildUpstreamUrl } = require('../server');

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sameroof-broker-'));
}

function listenTcp(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address()));
  });
}

function closeServer(server) {
  return new Promise(resolve => server.close(resolve));
}

function requestSocket(socketPath, options = {}) {
  return new Promise((resolve, reject) => {
    const body = options.body === undefined ? null : Buffer.from(JSON.stringify(options.body));
    const req = http.request({
      socketPath,
      path: options.path || '/',
      method: options.method || 'GET',
      headers: {
        ...(body ? { 'content-type': 'application/json', 'content-length': body.length } : {}),
        ...(options.token ? { authorization: 'Bearer ' + options.token } : {}),
        ...(options.headers || {})
      }
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

test('上游 path style 正确处理智谱 v4 与标准 OpenAI 路径', () => {
  assert.equal(
    buildUpstreamUrl('https://open.bigmodel.cn/api/paas/v4', '/v1/chat/completions', 'auto').pathname,
    '/api/paas/v4/chat/completions'
  );
  assert.equal(
    buildUpstreamUrl('https://open.bigmodel.cn/api/paas/v4', '/v1/chat/completions', 'bare').pathname,
    '/api/paas/v4/chat/completions'
  );
  assert.equal(
    buildUpstreamUrl('https://api.openai.com', '/v1/chat/completions', 'openai').pathname,
    '/v1/chat/completions'
  );
});

test('凭证列表绝不返回 api_key，数据库和 token 文件为 0600', () => {
  const home = tempHome();
  const store = new BrokerStore({ home });
  store.addCredential({ alias: 'shared-cheap', provider: 'zhipu', baseUrl: 'http://127.0.0.1:9999/v1', apiKey: 'top-secret' });
  const listed = store.listCredentials();
  assert.equal(listed.length, 1);
  assert.equal(Object.hasOwn(listed[0], 'api_key'), false);
  assert.equal(listed[0].path_style, 'auto');
  store.setCredentialPathStyle('shared-cheap', 'bare');
  assert.equal(store.listCredentials()[0].path_style, 'bare');
  assert.equal(fs.statSync(store.dbPath).mode & 0o777, 0o600);
  const token = store.issueToken({ residentId: 'resident_researcher_01', credentials: ['shared-cheap'], models: ['glm-test'] });
  assert.equal(fs.readFileSync(token.token_file, 'utf8').trim(), token.secret);
  assert.equal(fs.statSync(token.token_file).mode & 0o777, 0o600);
  assert.throws(
    () => store.issueToken({ residentId: 'resident_researcher_01', credentials: ['shared-cheap'], models: ['glm-test'] }),
    error => error instanceof BrokerError && error.code === 'TOKEN-FILE-EXISTS'
  );
  assert.equal(store.listTokens().length, 1);
  const replacement = store.issueToken({ residentId: 'resident_researcher_01', credentials: ['shared-cheap'], models: ['glm-test'], replaceFile: true });
  assert.equal(replacement.replaced_token_id, token.id);
  assert.throws(() => store.authenticate(token.secret), error => error instanceof BrokerError && error.code === 'TOKEN-INVALID');
  assert.equal(store.authenticate(replacement.secret).resident_id, 'resident_researcher_01');
  assert.equal(fs.readFileSync(replacement.token_file, 'utf8').trim(), replacement.secret);
  store.close();
});

test('旧 broker 数据库自动补 path_style=auto，不要求重建真凭证', () => {
  const home = tempHome();
  const state = path.join(home, 'state');
  fs.mkdirSync(state, { recursive: true });
  const legacy = new Database(path.join(state, 'broker.db'));
  legacy.exec(`CREATE TABLE credentials(
    alias TEXT PRIMARY KEY, provider TEXT NOT NULL, base_url TEXT NOT NULL, api_key TEXT NOT NULL,
    auth_header TEXT NOT NULL DEFAULT 'authorization', auth_scheme TEXT NOT NULL DEFAULT 'Bearer',
    active INTEGER NOT NULL DEFAULT 1, version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, rotated_at TEXT
  )`);
  legacy.close();
  const store = new BrokerStore({ home });
  const column = store.db.prepare('PRAGMA table_info(credentials)').all().find(row => row.name === 'path_style');
  assert.ok(column);
  assert.equal(column.dflt_value, "'auto'");
  store.close();
});

test('数据面只认住户 token、限制 model/purpose，并逐请求结算', async () => {
  let seenAuth = null;
  let seenBody = null;
  let seenPath = null;
  const upstream = http.createServer((req, res) => {
    seenAuth = req.headers.authorization;
    seenPath = req.url;
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      seenBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const response = JSON.stringify({
        id: 'chatcmpl-test',
        object: 'chat.completion',
        choices: [{ index: 0, message: { role: 'assistant', content: '我在。' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 }
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(response);
    });
  });
  const address = await listenTcp(upstream);

  const home = tempHome();
  const store = new BrokerStore({ home });
  store.addCredential({
    alias: 'shared-cheap',
    provider: 'zhipu',
    baseUrl: 'http://127.0.0.1:' + address.port + '/api/paas/v4',
    apiKey: 'upstream-real-key',
    pathStyle: 'bare'
  });
  const issued = store.issueToken({
    residentId: 'resident_researcher_01',
    credentials: ['shared-cheap'],
    models: ['glm-test'],
    purposes: ['interactive'],
    maxRequests: 1,
    maxTokens: 10000
  });

  const broker = createBroker({ store, socketPath: path.join(store.runDir, 'broker.sock') });
  await broker.listen();
  try {
    const noToken = await requestSocket(broker.socketPath, { path: '/v1/models' });
    assert.equal(noToken.status, 401);
    assert.equal(noToken.json.error.code, 'TOKEN-INVALID');

    const models = await requestSocket(broker.socketPath, { path: '/v1/models', token: issued.secret });
    assert.equal(models.status, 200);
    assert.deepEqual(models.json.data.map(x => x.id), ['glm-test']);

    const deniedPurpose = await requestSocket(broker.socketPath, {
      path: '/v1/chat/completions',
      method: 'POST',
      token: issued.secret,
      headers: { 'x-sameroof-purpose': 'heartbeat' },
      body: { model: 'glm-test', messages: [{ role: 'user', content: '在吗' }], max_tokens: 8 }
    });
    assert.equal(deniedPurpose.status, 403);
    assert.equal(deniedPurpose.json.error.code, 'PURPOSE-NOT-ALLOWED');

    const ok = await requestSocket(broker.socketPath, {
      path: '/v1/chat/completions',
      method: 'POST',
      token: issued.secret,
      body: { model: 'glm-test', messages: [{ role: 'user', content: '在吗' }], max_tokens: 8 }
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.choices[0].message.content, '我在。');
    assert.equal(ok.headers['x-sameroof-request-id'].startsWith('req_'), true);
    assert.equal(seenAuth, 'Bearer upstream-real-key');
    assert.equal(seenPath, '/api/paas/v4/chat/completions');
    assert.equal(seenBody.model, 'glm-test');

    const over = await requestSocket(broker.socketPath, {
      path: '/v1/chat/completions',
      method: 'POST',
      token: issued.secret,
      body: { model: 'glm-test', messages: [{ role: 'user', content: '再说一次' }], max_tokens: 8 }
    });
    assert.equal(over.status, 429);
    assert.equal(over.json.error.code, 'BUDGET-REQUESTS-EXCEEDED');

    const ledger = store.listLedger();
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0].resident_id, 'resident_researcher_01');
    assert.equal(ledger[0].credential_alias, 'shared-cheap');
    assert.equal(ledger[0].actual_tokens, 7);
    assert.equal(ledger[0].estimated, 0);
    assert.equal(ledger[0].status, 'complete');
  } finally {
    await broker.close();
    store.close();
    await closeServer(upstream);
  }
});

test('旧 broker 退出不会删除新进程已经绑定的同名 socket', async () => {
  const store = new BrokerStore({ home: tempHome() });
  const socketPath = path.join(store.runDir, 'broker.sock');
  const oldBroker = createBroker({ store, socketPath });
  const newBroker = createBroker({ store, socketPath });
  await oldBroker.listen();
  await newBroker.listen();
  try {
    await oldBroker.close();
    assert.equal(fs.existsSync(socketPath), true);
    const health = await requestSocket(socketPath, { path: '/health' });
    assert.equal(health.status, 200);
  } finally {
    await newBroker.close();
    store.close();
  }
  assert.equal(fs.existsSync(socketPath), false);
});

test('吊销和 quarantine 都 fail closed', () => {
  const store = new BrokerStore({ home: tempHome() });
  store.addCredential({ alias: 'one', provider: 'test', baseUrl: 'http://127.0.0.1:9999/v1', apiKey: 'secret' });
  const one = store.issueToken({ residentId: 'resident_agent_01', credentials: ['one'], models: ['m'] });
  store.setTokenStatus(one.id, 'quarantined');
  assert.throws(() => store.authenticate(one.secret), error => error instanceof BrokerError && error.code === 'TOKEN-QUARANTINED');
  store.setTokenStatus(one.id, 'active');
  assert.equal(store.authenticate(one.secret).resident_id, 'resident_agent_01');
  store.revokeToken(one.id);
  assert.throws(() => store.authenticate(one.secret), error => error instanceof BrokerError && error.code === 'TOKEN-INVALID');
  store.close();
});

test('拒绝把真凭证放在不安全的远程 HTTP 上游', () => {
  const store = new BrokerStore({ home: tempHome() });
  assert.throws(
    () => store.addCredential({ alias: 'bad', provider: 'test', baseUrl: 'http://example.com/v1', apiKey: 'secret' }),
    error => error instanceof BrokerError && error.code === 'CRED-URL-INSECURE'
  );
  store.close();
});
