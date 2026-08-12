/**
 * Rate limiter for NationBuilder API
 * NB rate limit: 250 requests per 10 seconds per IP
 */

export class RateLimiter {
  private requestTimestamps: number[] = [];
  private backoffMs = 1000;
  private readonly maxBackoffMs = 30000;
  private readonly maxRequests: number;
  private readonly windowMs: number;

  constructor(maxRequests = 200, windowMs = 10000) {
    // Use 200 instead of 250 to leave headroom
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
  }

  async acquire(): Promise<void> {
    this.pruneOldTimestamps();

    if (this.requestTimestamps.length >= this.maxRequests) {
      const oldestTimestamp = this.requestTimestamps[0]!;
      const waitTime = oldestTimestamp + this.windowMs - Date.now();
      if (waitTime > 0) {
        console.error(
          `Rate limit approaching. Waiting ${Math.ceil(waitTime / 1000)}s...`
        );
        await this.sleep(waitTime);
        this.pruneOldTimestamps();
      }
    }

    this.requestTimestamps.push(Date.now());
    this.backoffMs = 1000;
  }

  /**
   * @param retryAfterMs Parsed `Retry-After` from the response, if
   *   NationBuilder sent one. Preferred over our own doubling backoff when
   *   present, but still capped at `maxBackoffMs` so a single tool call can't
   *   be told to wait an extreme amount of time.
   */
  async handleError(statusCode?: number, retryAfterMs?: number): Promise<void> {
    if (statusCode === 429) {
      const waitMs = Math.min(retryAfterMs ?? this.backoffMs, this.maxBackoffMs);
      console.error(`Rate limited (429). Backing off ${waitMs}ms...`);
      await this.sleep(waitMs);
      this.backoffMs = Math.min(this.backoffMs * 2, this.maxBackoffMs);
    }
  }

  private pruneOldTimestamps(): void {
    const cutoff = Date.now() - this.windowMs;
    while (
      this.requestTimestamps.length > 0 &&
      this.requestTimestamps[0]! < cutoff
    ) {
      this.requestTimestamps.shift();
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

/**
 * NationBuilder's rate limit is per-IP, not per-token or per-session — every
 * caller on this container shares one 250-req/10s budget with every other
 * caller. A `RateLimiter` created per client/session (the old pattern) gives
 * each one its own private 200/10s allowance, so a handful of concurrent
 * sessions can collectively blow well past NationBuilder's real ceiling
 * without any single one of them seeing a 429 first. One singleton per nation
 * slug is the correct model; a Map (not a bare singleton) is future-proofing
 * in case this server ever serves more than one nation.
 */
const limiters = new Map<string, RateLimiter>();

export function getRateLimiter(slug: string): RateLimiter {
  let limiter = limiters.get(slug);
  if (!limiter) {
    limiter = new RateLimiter();
    limiters.set(slug, limiter);
  }
  return limiter;
}
