// src/middleware/rateLimiter.js
// Token bucket rate limiter for MCP sendMessage (2 req/min sustained, 10 burst).

class RateLimiter {
  constructor({ capacity = 10, refillRate = 2, refillIntervalMs = 60000 } = {}) {
    this.capacity = capacity;
    this.tokens = capacity;
    this.refillRate = refillRate;
    this.refillIntervalMs = refillIntervalMs;
    this.queue = [];
    this.lastRefill = Date.now();

    // Refill tokens periodically
    this._interval = setInterval(() => this._refill(), this.refillIntervalMs);
  }

  _refill() {
    this.tokens = Math.min(this.capacity, this.tokens + this.refillRate);
    this.lastRefill = Date.now();
    this._drain();
  }

  _drain() {
    while (this.queue.length > 0 && this.tokens > 0) {
      this.tokens--;
      const resolve = this.queue.shift();
      resolve();
    }
  }

  // Returns a promise that resolves when a token is available.
  // If tokens are available, resolves immediately.
  async acquire() {
    if (this.tokens > 0) {
      this.tokens--;
      return;
    }
    return new Promise((resolve) => {
      this.queue.push(resolve);
    });
  }

  get queueLength() {
    return this.queue.length;
  }

  get estimatedWaitMs() {
    if (this.tokens > 0) return 0;
    const tokensNeeded = this.queue.length + 1;
    const refillsNeeded = Math.ceil(tokensNeeded / this.refillRate);
    return refillsNeeded * this.refillIntervalMs;
  }

  destroy() {
    clearInterval(this._interval);
  }
}

module.exports = { RateLimiter };
