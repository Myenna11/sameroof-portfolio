'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { PushCredentialStore, validSubscription } = require('../push');

test('VAPID private key stays in 0600 credential state and client sees only public material', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sameroof-push-'));
  try {
    const store = new PushCredentialStore({ stateDir });
    const initialized = store.initialize('https://house.sameroof.example');
    const secret = fs.readFileSync(store.clientTokenFile, 'utf8').trim();
    assert.equal(store.publicKey(secret).public_key, initialized.public_key);
    assert.equal(Object.hasOwn(store.status(), 'private_key'), false);
    assert.equal(fs.statSync(store.vapidFile).mode & 0o777, 0o600);
    assert.equal(fs.statSync(store.clientTokenFile).mode & 0o777, 0o600);
    assert.throws(() => store.publicKey('wrong-secret-value'), error => error.code === 'PUSH-CLIENT-INVALID');
    assert.throws(() => store.initialize('https://house.sameroof.example'), error => error.code === 'PUSH-CREDENTIAL-EXISTS');
  } finally { fs.rmSync(stateDir, { recursive: true, force: true }); }
});

test('push subscription endpoints are HTTPS and restricted to known Web Push services', () => {
  const keys = { p256dh: 'a'.repeat(87), auth: 'b'.repeat(22) };
  assert.equal(validSubscription({ endpoint: 'https://fcm.googleapis.com/fcm/send/example', keys }), true);
  assert.equal(validSubscription({ endpoint: 'https://updates.push.services.mozilla.com/wpush/v2/example', keys }), true);
  assert.equal(validSubscription({ endpoint: 'https://evil.example/push', keys }), false);
  assert.equal(validSubscription({ endpoint: 'http://fcm.googleapis.com/fcm/send/example', keys }), false);
});
