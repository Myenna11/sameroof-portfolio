// 同屋 · 客厅 → broker 只读报表客户端（V2-LEDGER）。跟 push-client 同形：凭 report-client.token 走 socket 调 /internal/report/daily。
// 客厅不开 broker 的库（DECISIONS #11）；broker 不在、没签凭证、凭证错，都只让 /cost 少一段 ledger，不炸。
'use strict';
const fs = require('node:fs');
const http = require('node:http');

class ReportClientError extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code; } }

class ReportClient {
  constructor(options = {}) {
    this.socketPath = options.socketPath || process.env.SAMEROOF_BROKER_SOCKET || '/run/sameroof-broker/broker.sock';
    this.tokenFile = options.tokenFile || process.env.SAMEROOF_REPORT_CLIENT_TOKEN || '/var/lib/sameroof-broker/report-client.token';
    this.timeoutMs = options.timeoutMs || 4000;
  }
  secret() { try { return fs.readFileSync(this.tokenFile, 'utf8').trim(); } catch { throw new ReportClientError(503, 'REPORT-NOT-CONFIGURED', '报表凭证尚未配置（sameroof-broker report init）。'); } }
  daily({ days = 7, tz = 'UTC' } = {}) {
    const secret = this.secret();
    return new Promise((resolve, reject) => {
      const req = http.request({ socketPath: this.socketPath, path: `/internal/report/daily?days=${encodeURIComponent(days)}&tz=${encodeURIComponent(tz)}`, method: 'GET', timeout: this.timeoutMs, headers: { authorization: 'Bearer ' + secret } }, res => {
        const chunks = []; let size = 0;
        res.on('data', c => { size += c.length; if (size <= 512 * 1024) chunks.push(c); });
        res.on('end', () => { let v = {}; try { v = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {}
          if (res.statusCode < 200 || res.statusCode >= 300) return reject(new ReportClientError(res.statusCode, v.error?.code || 'REPORT-BROKER-ERROR', v.error?.message || '报表拉取失败。'));
          resolve(v); });
      });
      req.on('timeout', () => { req.destroy(new Error('timeout')); reject(new ReportClientError(503, 'REPORT-TIMEOUT', 'broker 报表超时。')); });
      req.on('error', e => reject(new ReportClientError(503, 'REPORT-BROKER-UNAVAILABLE', 'broker 暂时不可用：' + e.message)));
      req.end();
    });
  }
}
module.exports = { ReportClient, ReportClientError };
