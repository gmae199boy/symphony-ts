/**
 * Abstract base class for pollers — encapsulates the poll-schedule-retry loop.
 */

import { logger } from './logger.js';

export abstract class Poller {
  private readonly pollIntervalMs: number;
  private timer: NodeJS.Timeout | null = null;

  constructor(pollIntervalMs: number) {
    this.pollIntervalMs = pollIntervalMs;
  }

  start(): void {
    if (this.timer) return;
    this.scheduleNext(0);
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  protected scheduleNext(delayMs: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.poll(), delayMs);
  }

  private async poll(): Promise<void> {
    try {
      await this.doPoll();
    } catch (err) {
      logger.warn('Poller: poll failed', { error: String(err) });
    } finally {
      this.scheduleNext(this.pollIntervalMs);
    }
  }

  protected abstract doPoll(): Promise<void>;
}
