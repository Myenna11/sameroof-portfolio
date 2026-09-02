'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const webpush = require('web-push');
const { BrokerError } = require('./store');

const PUSH_HOSTS = new Set(['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'web.push.apple.com']);

function atomicWrite(file, value, mode = 0o600) {
  const temporary = file + '.tmp-' + process.pid + '-' + crypto.randomBytes(4).toString('hex');
  try {
    fs.writeFileSync(temporary, value, { mode, flag: 'wx' });
    fs.chmodSync(temporary, mode);
    fs.renameSync(temporary, file);
    fs.chmodSync(file, mode);
  } finally {
    try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch {}
  }
}

function validSubscription(value) {
  if (!value || typeof value !== 'object' || typeof value.endpoint !== 'string' || !value.keys) return false;
  let endpoint;
  try { endpoint = new URL(value.endpoint); } catch { return false; }
  if (endpoint.protocol !== 'https:' || !PUSH_HOSTS.has(endpoint.hostname) || value.endpoint.length > 2048) return false;
  const p256dh = value.keys.p256dh;
  const auth = value.keys.auth;
  return typeof p256dh === 'string' && p256dh.length >= 80 && p256dh.length <= 200 && typeof auth === 'string' && auth.length >= 16 && auth.length <= 100;
}

class PushCredentialStore {
  constructor(options = {}) {
    this.stateDir = path.resolve(options.stateDir);
    this.vapidFile = path.join(this.stateDir, 'web-push-vapid.json');
    this.clientTokenFile = path.join(this.stateDir, 'web-push-client.token');
  }

  initialize(subject, rotate = false) {
    if (!/^mailto:[^\s@]+@[^\s@]+$/.test(subject) && !/^https:\/\/[^\s]+$/.test(subject)) {
      throw new BrokerError(400, 'PUSH-SUBJECT-INVALID', 'VAPID subject 必须是 mailto: 或 HTTPS URL。');
    }
    if (!rotate && (fs.existsSync(this.vapidFile) || fs.existsSync(this.clientTokenFile))) {
      throw new BrokerError(409, 'PUSH-CREDENTIAL-EXISTS', 'Web Push 凭证已存在；轮换必须显式加 --rotate。');
    }
    const keys = webpush.generateVAPIDKeys();
    const createdAt = new Date().toISOString();
    const clientToken = 'srp_' + crypto.randomBytes(32).toString('base64url');
    atomicWrite(this.vapidFile, JSON.stringify({ subject, public_key: keys.publicKey, private_key: keys.privateKey, created_at: createdAt }, null, 2) + '\n');
    atomicWrite(this.clientTokenFile, clientToken + '\n');
    return { subject, public_key: keys.publicKey, created_at: createdAt, rotated: rotate };
  }

  load() {
    if (!fs.existsSync(this.vapidFile) || !fs.existsSync(this.clientTokenFile)) throw new BrokerError(503, 'PUSH-NOT-CONFIGURED', 'Web Push 凭证尚未初始化。');
    let vapid;
    try { vapid = JSON.parse(fs.readFileSync(this.vapidFile, 'utf8')); }
    catch { throw new BrokerError(500, 'PUSH-CREDENTIAL-INVALID', 'Web Push 凭证文件损坏。'); }
    const clientToken = fs.readFileSync(this.clientTokenFile, 'utf8').trim();
    if (!vapid.subject || !vapid.public_key || !vapid.private_key || clientToken.length < 32) throw new BrokerError(500, 'PUSH-CREDENTIAL-INVALID', 'Web Push 凭证字段不完整。');
    return { vapid, clientToken };
  }

  authorize(secret) {
    const value = this.load();
    if (typeof secret !== 'string') throw new BrokerError(401, 'PUSH-CLIENT-INVALID', '推送调用凭证无效。');
    const actual = Buffer.from(value.clientToken);
    const supplied = Buffer.from(secret);
    if (actual.length !== supplied.length || !crypto.timingSafeEqual(actual, supplied)) throw new BrokerError(401, 'PUSH-CLIENT-INVALID', '推送调用凭证无效。');
    return value.vapid;
  }

  publicKey(secret) {
    const vapid = this.authorize(secret);
    return { public_key: vapid.public_key };
  }

  status() {
    const { vapid } = this.load();
    return { configured: true, subject: vapid.subject, public_key: vapid.public_key, created_at: vapid.created_at };
  }

  async send(secret, input) {
    const vapid = this.authorize(secret);
    if (!validSubscription(input?.subscription)) throw new BrokerError(400, 'PUSH-SUBSCRIPTION-INVALID', '推送订阅格式或服务端点不合法。');
    const payload = input?.payload;
    if (!payload || typeof payload !== 'object' || typeof payload.title !== 'string' || typeof payload.body !== 'string') throw new BrokerError(400, 'PUSH-PAYLOAD-INVALID', '推送内容不完整。');
    if (payload.title.length > 80 || payload.body.length > 240 || (payload.url && (typeof payload.url !== 'string' || !/^\/[A-Za-z0-9_/?&=.#%-]*$/.test(payload.url)))) {
      throw new BrokerError(400, 'PUSH-PAYLOAD-INVALID', '推送标题、正文或站内路径超出限制。');
    }
    webpush.setVapidDetails(vapid.subject, vapid.public_key, vapid.private_key);
    try {
      const response = await webpush.sendNotification(input.subscription, JSON.stringify({ title: payload.title, body: payload.body, url: payload.url || '/' }), { TTL: 300, urgency: 'normal' });
      return { delivered: true, status: response.statusCode };
    } catch (error) {
      if (error.statusCode === 404 || error.statusCode === 410) throw new BrokerError(410, 'PUSH-SUBSCRIPTION-GONE', '推送订阅已失效。');
      throw new BrokerError(502, 'PUSH-UPSTREAM-FAILED', '推送服务暂时不可用。');
    }
  }
}

module.exports = { PushCredentialStore, validSubscription };
