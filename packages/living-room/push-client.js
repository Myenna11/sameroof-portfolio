'use strict';

const fs = require('node:fs');
const http = require('node:http');

class PushClientError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

class PushClient {
  constructor(options = {}) {
    this.socketPath = options.socketPath || process.env.SAMEROOF_BROKER_SOCKET || '/run/sameroof-broker/broker.sock';
    this.tokenFile = options.tokenFile || process.env.SAMEROOF_PUSH_CLIENT_TOKEN || '/var/lib/sameroof-broker/web-push-client.token';
  }

  secret() {
    try { return fs.readFileSync(this.tokenFile, 'utf8').trim(); }
    catch { throw new PushClientError(503, 'PUSH-NOT-CONFIGURED', '通知凭证尚未配置。'); }
  }

  request(method, pathname, body) {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
      const req = http.request({ socketPath: this.socketPath, path: pathname, method, headers: {
        authorization: 'Bearer ' + this.secret(),
        ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {})
      } }, res => {
        const chunks = [];
        let size = 0;
        res.on('data', chunk => {
          size += chunk.length;
          if (size <= 64 * 1024) chunks.push(chunk);
        });
        res.on('end', () => {
          let value = {};
          try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {}
          if (res.statusCode < 200 || res.statusCode >= 300) return reject(new PushClientError(res.statusCode, value.error?.code || 'PUSH-BROKER-ERROR', value.error?.message || '通知发送失败。'));
          resolve(value);
        });
      });
      req.on('error', error => reject(new PushClientError(503, 'PUSH-BROKER-UNAVAILABLE', '通知凭证层暂时不可用：' + error.message)));
      if (payload) req.write(payload);
      req.end();
    });
  }

  publicKey() { return this.request('GET', '/internal/web-push/public-key'); }
  send(subscription, payload) { return this.request('POST', '/internal/web-push/send', { subscription, payload }); }
}

module.exports = { PushClient, PushClientError };
