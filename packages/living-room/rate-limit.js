'use strict';

class SlidingWindowLimiter {
  constructor(options = {}) {
    this.limit = Math.max(1, Number(options.limit || 10));
    this.windowMs = Math.max(1000, Number(options.windowMs || 60000));
    this.maxKeys = Math.max(100, Number(options.maxKeys || 10000));
    this.clock = options.clock || Date.now;
    this.entries = new Map();
  }

  take(key) {
    const now = this.clock();
    const floor = now - this.windowMs;
    let hits = this.entries.get(key) || [];
    hits = hits.filter(ts => ts > floor);
    if (hits.length >= this.limit) {
      this.entries.delete(key);
      this.entries.set(key, hits);
      return { allowed: false, retryAfterMs: Math.max(1, hits[0] + this.windowMs - now) };
    }
    hits.push(now);
    this.entries.delete(key);
    this.entries.set(key, hits);
    this.trim();
    return { allowed: true, remaining: this.limit - hits.length };
  }

  clear(key) {
    this.entries.delete(key);
  }

  trim() {
    while (this.entries.size > this.maxKeys) this.entries.delete(this.entries.keys().next().value);
  }
}

class AuthFailureLimiter {
  constructor(options = {}) {
    this.limit = Math.max(1, Number(options.limit || 10));
    this.windowMs = Math.max(1000, Number(options.windowMs || 60000));
    this.blockMs = Math.max(1000, Number(options.blockMs || 900000));
    this.maxKeys = Math.max(100, Number(options.maxKeys || 10000));
    this.clock = options.clock || Date.now;
    this.entries = new Map();
  }

  check(key) {
    const now = this.clock();
    const entry = this.entries.get(key);
    if (!entry) return { allowed: true };
    if (entry.blockedUntil > now) return { allowed: false, retryAfterMs: entry.blockedUntil - now };
    if (entry.blockedUntil) this.entries.delete(key);
    return { allowed: true };
  }

  fail(key) {
    const now = this.clock();
    const floor = now - this.windowMs;
    const entry = this.entries.get(key) || { hits: [], blockedUntil: 0 };
    entry.hits = entry.hits.filter(ts => ts > floor);
    entry.hits.push(now);
    if (entry.hits.length >= this.limit) entry.blockedUntil = now + this.blockMs;
    this.entries.delete(key);
    this.entries.set(key, entry);
    while (this.entries.size > this.maxKeys) this.entries.delete(this.entries.keys().next().value);
    return entry.blockedUntil > now
      ? { allowed: false, retryAfterMs: entry.blockedUntil - now }
      : { allowed: true, remaining: this.limit - entry.hits.length };
  }

  success(key) {
    this.entries.delete(key);
  }
}

module.exports = { SlidingWindowLimiter, AuthFailureLimiter };
