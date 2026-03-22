/**
 * TrackerPoller — polls a tracker for candidate issues and delegates
 * handling to the provided callback.
 */

import { Poller } from '../poller.js';
import type { TrackerClient, Issue } from '../types.js';

export class TrackerPoller extends Poller {
  private readonly tracker: TrackerClient;
  private readonly onPoll: (candidates: Issue[]) => Promise<void>;

  constructor(
    tracker: TrackerClient,
    pollIntervalMs: number,
    onPoll: (candidates: Issue[]) => Promise<void>,
  ) {
    super(pollIntervalMs);
    this.tracker = tracker;
    this.onPoll = onPoll;
  }

  protected async doPoll(): Promise<void> {
    const candidates = await this.tracker.fetchCandidateIssues();
    await this.onPoll(candidates);
  }
}
