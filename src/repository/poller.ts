/**
 * Repository PR poller — periodically polls GitHub / Bitbucket for PR events
 * and calls the registered handler with normalised RepoEvent objects.
 *
 * Mirrors elixir/lib/symphony_elixir/github/poller.ex
 *
 * First-poll behaviour:
 *   - All existing IDs are seeded as "seen".
 *   - If the last comment is from a non-bot, a new_comments event is emitted.
 */

import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../logger.js';
import { Poller } from '../poller.js';
import { createRepoClient, type RepoClientApi } from './factory.js';
import type { PullRequest, Comment, RepoEvent, RepoEventHandler } from '../types.js';
import type { RepositoryConfig } from '../config/schema.js';

interface PRSeen {
  commentIds: Set<string>; // namespaced: "issue:{id}" | "review:{id}"
}

interface PollerState {
  seen: Map<number, PRSeen>; // pr_number -> seen IDs
  knownOpenPRs: Map<number, PullRequest>; // pr_number -> last-known open PR
  firstPoll: boolean;
}

export class RepoPoller extends Poller {
  private readonly config: RepositoryConfig;
  private readonly repoClient: RepoClientApi;
  private readonly onEvent: RepoEventHandler;
  private readonly stateFilePath: string | null;
  private state: PollerState = { seen: new Map(), knownOpenPRs: new Map(), firstPoll: true };

  constructor(config: RepositoryConfig, onEvent: RepoEventHandler, workspaceRoot?: string) {
    super(config.poll_interval_ms);
    this.config = config;
    this.onEvent = onEvent;
    this.repoClient = createRepoClient(config);

    // Determine state file path for persistence
    if (workspaceRoot) {
      const label = config.kind === 'github' ? config.repo.replace(/\//g, '-') : `${config.workspace}-${config.repo_slug}`;
      this.stateFilePath = path.join(workspaceRoot, `repo-poller-${label}-seen.json`);
    } else {
      this.stateFilePath = null;
    }
  }

  override start(): void {
    this.restoreState();
    logger.info('Repository poller starting', { kind: this.config.kind, restoredPRs: this.state.seen.size });
    super.start();
  }

  // ---------------------------------------------------------------------------
  // Core poll logic
  // ---------------------------------------------------------------------------

  protected override async doPoll(): Promise<void> {
    let prs: PullRequest[];

    try {
      prs = await this.fetchOpenPRs();
    } catch (err) {
      logger.warn('Repository poller: failed to fetch PRs', { error: String(err) });
      return;
    }

    const label = this.config.kind === 'github' ? this.config.repo : `${this.config.workspace}/${this.config.repo_slug}`;
    if (prs.length > 0 || this.state.firstPoll) {
      logger.debug(
        `Repository poller: found ${prs.length} tracked PR(s) in ${label}${this.state.firstPoll ? ' (first poll)' : ''}`,
      );
    }

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
          this.emitEvent({ kind: 'pr_merged', pr: knownPR });
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

  async deleteBranch(branchName: string): Promise<boolean> {
    return this.repoClient.deleteBranch(branchName);
  }

  // ---------------------------------------------------------------------------
  // Per-PR event detection
  // ---------------------------------------------------------------------------

  private async checkPR(pr: PullRequest): Promise<void> {
    const prSeen = this.state.seen.get(pr.number) ?? {
      commentIds: new Set<string>(),
    };

    const updatedSeen = { ...prSeen };

    try {
      const comments = await this.fetchPRComments(pr.number);
      updatedSeen.commentIds = this.processComments(pr, comments, prSeen.commentIds);
    } catch (err) {
      logger.debug('Repository poller: failed to fetch comments', { pr: pr.number, error: String(err) });
    }

    this.state.seen.set(pr.number, updatedSeen);
    this.persistState();
  }

  private async fetchPRComments(prNumber: number): Promise<Comment[]> {
    return this.repoClient.fetchPRComments(prNumber);
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
      this.emitEvent({ kind: 'new_comments', pr, comments: humanNew });
    }

    // Add all new comments (including bot) to seen set
    const updated = new Set(seenIds);
    allNew.forEach((c) => updated.add(c.id));
    return updated;
  }

  private handleFirstPollComments(pr: PullRequest, comments: Comment[]): void {
    // Seed all comments as "seen", but if the most recent comment is from
    // a non-bot user, emit a new_comments event so it gets processed.
    if (comments.length === 0) return;

    const last = comments[comments.length - 1];
    if (last && !last.isBot) {
      this.emitEvent({ kind: 'new_comments', pr, comments: [last] });
    }
  }

  // ---------------------------------------------------------------------------
  // State persistence
  // ---------------------------------------------------------------------------

  private persistState(): void {
    if (!this.stateFilePath) return;
    try {
      const data: Record<string, string[]> = {};
      for (const [prNumber, prSeen] of this.state.seen) {
        data[String(prNumber)] = [...prSeen.commentIds];
      }
      fs.mkdirSync(path.dirname(this.stateFilePath), { recursive: true });
      const tmpPath = this.stateFilePath + '.tmp';
      fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf8');
      fs.renameSync(tmpPath, this.stateFilePath);
    } catch (err) {
      logger.warn('RepoPoller: failed to persist state', { error: String(err) });
    }
  }

  private restoreState(): void {
    if (!this.stateFilePath) return;
    try {
      const raw = fs.readFileSync(this.stateFilePath, 'utf8');
      const data = JSON.parse(raw) as Record<string, string[]>;
      for (const [prNumber, commentIds] of Object.entries(data)) {
        this.state.seen.set(Number(prNumber), { commentIds: new Set(commentIds) });
      }
      // Restored from disk → not a true first poll
      this.state.firstPoll = false;
      logger.info('RepoPoller: restored seen state from disk', { prs: this.state.seen.size });
    } catch {
      // No file or corrupted — start fresh (firstPoll stays true)
    }
  }

  // ---------------------------------------------------------------------------
  // Emit
  // ---------------------------------------------------------------------------

  private emitEvent(event: RepoEvent): void {
    logger.info(`Repository PR event: ${event.kind} pr=#${event.pr.number} issueIdentifier=${event.pr.issueIdentifier ?? 'null'}`);
    try {
      this.onEvent(event);
    } catch (err) {
      logger.error('Repository poller: onEvent handler threw', { error: String(err) });
    }
  }
}
