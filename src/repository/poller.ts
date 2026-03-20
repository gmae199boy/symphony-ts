/**
 * Repository PR poller — periodically polls GitHub / Bitbucket for PR events
 * and calls the registered handler with normalised RepoEvent objects.
 *
 * Mirrors elixir/lib/symphony_elixir/github/poller.ex
 *
 * First-poll behaviour:
 *   - All existing IDs are seeded as "seen".
 *   - If the last actionable review is CHANGES_REQUESTED, a changes_requested
 *     event is emitted.
 *   - If the last comment is from a non-bot, a new_comments event is emitted.
 */

import { logger } from '../logger.js';
import { GitHubClient } from './github.js';
import { BitbucketClient } from './bitbucket.js';
import type { PullRequest, Review, Comment, RepoEvent, RepoEventHandler } from '../types.js';
import type { RepositoryConfig } from '../config/schema.js';

interface PRSeen {
  reviewIds: Set<number>;
  commentIds: Set<string>; // namespaced: "issue:{id}" | "review:{id}"
}

interface PollerState {
  seen: Map<number, PRSeen>; // pr_number -> seen IDs
  knownOpenPRs: Map<number, PullRequest>; // pr_number -> last-known open PR
  firstPoll: boolean;
}

interface RepoClientApi {
  fetchOpenPRs(): Promise<PullRequest[]>;
  fetchPR(prNumber: number): Promise<PullRequest | null>;
  deleteBranch(branchName: string): Promise<void>;
  fetchPRReviews(prNumber: number): Promise<Review[]>;
  fetchPRComments(prNumber: number): Promise<Comment[]>;
}

export class RepoPoller {
  private readonly config: RepositoryConfig;
  private readonly repoClient: RepoClientApi;
  private readonly onEvent: RepoEventHandler;
  private state: PollerState = { seen: new Map(), knownOpenPRs: new Map(), firstPoll: true };
  private timer: NodeJS.Timeout | null = null;

  constructor(config: RepositoryConfig, onEvent: RepoEventHandler) {
    this.config = config;
    this.onEvent = onEvent;

    if (config.kind === 'github') {
      this.repoClient = new GitHubClient(config);
    } else {
      this.repoClient = new BitbucketClient(config);
    }
  }

  start(): void {
    if (this.timer) return;
    logger.info('Repository poller starting', { kind: this.config.kind });
    this.scheduleNext(0);
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Scheduling
  // ---------------------------------------------------------------------------

  private scheduleNext(delayMs: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.poll(), delayMs);
  }

  private async poll(): Promise<void> {
    try {
      await this.doPoll();
    } catch (err) {
      logger.warn('Repository poller: poll failed', { error: String(err) });
    } finally {
      this.scheduleNext(this.config.poll_interval_ms);
    }
  }

  // ---------------------------------------------------------------------------
  // Core poll logic
  // ---------------------------------------------------------------------------

  private async doPoll(): Promise<void> {
    let prs: PullRequest[];

    try {
      prs = await this.fetchOpenPRs();
    } catch (err) {
      logger.warn('Repository poller: failed to fetch PRs', { error: String(err) });
      return;
    }

    const label = this.config.kind === 'github' ? this.config.repo : `${this.config.workspace}/${this.config.repo_slug}`;
    logger.info(
      `Repository poller: found ${prs.length} tracked PR(s) in ${label}${this.state.firstPoll ? ' (first poll)' : ''}`,
    );

    // Detect PRs that disappeared from the open list (potentially merged)
    if (!this.state.firstPoll) {
      await this.detectMergedPRs(prs);
    }

    for (const pr of prs) {
      await this.checkPR(pr);
    }

    // Update known open PRs
    this.state.knownOpenPRs = new Map(prs.map((pr) => [pr.number, pr]));

    this.state.firstPoll = false;
  }

  private async fetchOpenPRs(): Promise<PullRequest[]> {
    return this.repoClient.fetchOpenPRs();
  }

  // ---------------------------------------------------------------------------
  // Merged PR detection
  // ---------------------------------------------------------------------------

  private async detectMergedPRs(currentOpenPRs: PullRequest[]): Promise<void> {
    const currentOpenNumbers = new Set(currentOpenPRs.map((pr) => pr.number));

    for (const [prNumber, knownPR] of this.state.knownOpenPRs) {
      if (currentOpenNumbers.has(prNumber)) continue;

      // PR disappeared from open list — fetch its current state
      try {
        const pr = await this.fetchPR(prNumber);
        if (pr && pr.state === 'merged') {
          logger.info(`Repository poller: PR #${prNumber} has been merged`);
          this.emit({ kind: 'pr_merged', pr: knownPR });
        } else {
          logger.debug(`Repository poller: PR #${prNumber} disappeared but state=${pr?.state ?? 'unknown'}, ignoring`);
        }
      } catch (err) {
        logger.debug('Repository poller: failed to check disappeared PR', { pr: prNumber, error: String(err) });
      }

      // Clean up seen data for this PR
      this.state.seen.delete(prNumber);
    }
  }

  private async fetchPR(prNumber: number): Promise<PullRequest | null> {
    return this.repoClient.fetchPR(prNumber);
  }

  async deleteBranch(branchName: string): Promise<void> {
    return this.repoClient.deleteBranch(branchName);
  }

  // ---------------------------------------------------------------------------
  // Per-PR event detection
  // ---------------------------------------------------------------------------

  private async checkPR(pr: PullRequest): Promise<void> {
    const prSeen = this.state.seen.get(pr.number) ?? {
      reviewIds: new Set<number>(),
      commentIds: new Set<string>(),
    };

    const updatedSeen = { ...prSeen };

    try {
      const reviews = await this.fetchPRReviews(pr.number);
      updatedSeen.reviewIds = this.processReviews(pr, reviews, prSeen.reviewIds);
    } catch (err) {
      logger.debug('Repository poller: failed to fetch reviews', { pr: pr.number, error: String(err) });
    }

    try {
      const comments = await this.fetchPRComments(pr.number);
      updatedSeen.commentIds = this.processComments(pr, comments, prSeen.commentIds);
    } catch (err) {
      logger.debug('Repository poller: failed to fetch comments', { pr: pr.number, error: String(err) });
    }

    this.state.seen.set(pr.number, updatedSeen);
  }

  private async fetchPRReviews(prNumber: number): Promise<Review[]> {
    return this.repoClient.fetchPRReviews(prNumber);
  }

  private async fetchPRComments(prNumber: number): Promise<Comment[]> {
    return this.repoClient.fetchPRComments(prNumber);
  }

  // ---------------------------------------------------------------------------
  // Reviews
  // ---------------------------------------------------------------------------

  private processReviews(pr: PullRequest, reviews: Review[], seenIds: Set<number>): Set<number> {
    const allIds = new Set(reviews.map((r) => r.id));

    if (this.state.firstPoll) {
      this.handleFirstPollReviews(pr, reviews);
      return allIds;
    }

    const newReviews = reviews.filter((r) => !seenIds.has(r.id));
    for (const review of newReviews) {
      this.emitReviewEvent(pr, review);
    }

    const updated = new Set(seenIds);
    newReviews.forEach((r) => updated.add(r.id));
    return updated;
  }

  private handleFirstPollReviews(pr: PullRequest, reviews: Review[]): void {
    const actionable = reviews.filter((r) =>
      ['APPROVED', 'CHANGES_REQUESTED'].includes(r.state.toUpperCase()),
    );
    const last = actionable[actionable.length - 1];

    if (last && last.state.toUpperCase() === 'CHANGES_REQUESTED') {
      logger.info(`Repository poller: first poll detected pending changes_requested on PR #${pr.number}`);
      this.emitReviewEvent(pr, last);
    }
  }

  private emitReviewEvent(pr: PullRequest, review: Review): void {
    const state = review.state.toUpperCase();

    if (state === 'APPROVED') {
      this.emit({ kind: 'review_approved', pr, review });
    } else if (state === 'CHANGES_REQUESTED') {
      this.emit({ kind: 'changes_requested', pr, review });
    }
  }

  // ---------------------------------------------------------------------------
  // Comments
  // ---------------------------------------------------------------------------

  private processComments(pr: PullRequest, comments: Comment[], seenIds: Set<string>): Set<string> {
    const allIds = new Set(comments.map((c) => c.id));

    if (this.state.firstPoll) {
      this.handleFirstPollComments(pr, comments);
      return allIds;
    }

    const allNew = comments.filter((c) => !seenIds.has(c.id));
    const humanNew = allNew.filter((c) => !c.isBot);
    if (humanNew.length > 0) {
      this.emit({ kind: 'new_comments', pr, comments: humanNew });
    }

    // Add all new comments (including bot) to seen set
    const updated = new Set(seenIds);
    allNew.forEach((c) => updated.add(c.id));
    return updated;
  }

  private handleFirstPollComments(pr: PullRequest, comments: Comment[]): void {
    const last = comments[comments.length - 1];
    if (!last || last.isBot) return;

    logger.info(
      `Repository poller: first poll detected unanswered comment by ${last.authorLogin} on PR #${pr.number}`,
    );
    this.emit({ kind: 'new_comments', pr, comments: [last] });
  }

  // ---------------------------------------------------------------------------
  // Emit
  // ---------------------------------------------------------------------------

  private emit(event: RepoEvent): void {
    logger.info(`Repository PR event: ${event.kind} pr=#${event.pr.number} issueIdentifier=${event.pr.issueIdentifier ?? 'null'}`);
    try {
      this.onEvent(event);
    } catch (err) {
      logger.error('Repository poller: onEvent handler threw', { error: String(err) });
    }
  }
}
