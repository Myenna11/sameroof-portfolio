'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { TokenStore } = require('../tokens');

test('issue is stable, rotate changes, revoke disables, and peers hot-reload', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sameroof-token-'));
  const file = path.join(dir, 'tokens.json');
  try {
    const first = new TokenStore({ file });
    const issued = first.issue('resident_test_01');
    assert.equal(issued.created, true);
    assert.equal(first.issue('resident_test_01').token, issued.token);
    const peer = new TokenStore({ file });
    assert.equal(peer.authenticate(issued.token), 'resident_test_01');
    const rotated = first.rotate('resident_test_01');
    assert.notEqual(rotated.token, issued.token);
    assert.equal(peer.authenticate(issued.token), null);
    assert.equal(peer.authenticate(rotated.token), 'resident_test_01');
    assert.equal(first.revoke('resident_test_01').revoked, true);
    assert.equal(peer.authenticate(rotated.token), null);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ensure never overwrites an existing or revoked resident', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sameroof-token-'));
  try {
    const store = new TokenStore({ file: path.join(dir, 'tokens.json') });
    const [created] = store.ensure(['resident_test_02']);
    store.revoke('resident_test_02');
    assert.deepEqual(store.ensure(['resident_test_02']), []);
    assert.equal(store.authenticate(created.token), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
