/**
 * Fixed-window counter keyed by string (an IP, usually).
 *
 * Deliberately in-memory and approximate: its job is to make a
 * brute-force run against a 6-character session password uninteresting,
 * not to meter billing. The host agent's own lockout is the real
 * defence — this only keeps the noise off the wire.
 */
export class RateLimiter {
  #windows = new Map();
  #limit;
  #windowMs;

  constructor(limit, windowMs = 60_000) {
    this.#limit = limit;
    this.#windowMs = windowMs;

    const sweep = setInterval(() => this.#sweep(), windowMs);
    sweep.unref?.();
  }

  /** Returns true when the caller is still within budget. */
  take(key) {
    const now = Date.now();
    const entry = this.#windows.get(key);

    if (!entry || now >= entry.resetAt) {
      this.#windows.set(key, { count: 1, resetAt: now + this.#windowMs });
      return true;
    }

    entry.count += 1;
    return entry.count <= this.#limit;
  }

  #sweep() {
    const now = Date.now();
    for (const [key, entry] of this.#windows) {
      if (now >= entry.resetAt) this.#windows.delete(key);
    }
  }
}
