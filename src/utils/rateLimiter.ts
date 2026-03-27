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

  async handleError(statusCode?: number): Promise<void> {
    if (statusCode === 429) {
      console.error(
        `Rate limited (429). Backing off ${this.backoffMs}ms...`
      );
      await this.sleep(this.backoffMs);
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
