'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { SlidingWindowLimiter, AuthFailureLimiter } = require('../rate-limit');

test('sliding window rejects excess calls and recovers', () => {
  let now = 10000;
  const limiter = new SlidingWindowLimiter({ limit: 2, windowMs: 1000, clock: () => now });
  assert.equal(limiter.take('resident').allowed, true);
  assert.equal(limiter.take('resident').allowed, true);
  assert.equal(limiter.take('resident').allowed, false);
  now += 1001;
  assert.equal(limiter.take('resident').allowed, true);
});

test('auth failure limiter blocks only the failing key', () => {
  let now = 10000;
  const limiter = new AuthFailureLimiter({ limit: 2, windowMs: 1000, blockMs: 5000, clock: () => now });
  assert.equal(limiter.fail('1.1.1.1').allowed, true);
  assert.equal(limiter.fail('1.1.1.1').allowed, false);
  assert.equal(limiter.check('2.2.2.2').allowed, true);
  now += 5001;
  assert.equal(limiter.check('1.1.1.1').allowed, true);
});
