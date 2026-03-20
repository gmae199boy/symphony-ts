/**
 * Global concurrency limiter — shared across all Orchestrator instances.
 * Ensures the total number of running agents across all trackers
 * does not exceed the configured maximum.
 */

export class ConcurrencyLimiter {
  private running = 0;

  constructor(private readonly max: number) {}

  tryAcquire(): boolean {
    if (this.running >= this.max) return false;
    this.running++;
    return true;
  }

  release(): void {
    if (this.running > 0) this.running--;
  }

  available(): number {
    return Math.max(0, this.max - this.running);
  }
}
