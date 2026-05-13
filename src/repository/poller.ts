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

// Allowed characters in repo/workspace/repo_slug used to build the state file name.
const SAFE_LABEL_RE = /^[a-zA-Z0-9_./-]+$/;

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

    if (workspaceRoot) {
      const label = this.makeStateLabel(config);
      this.stateFilePath = label ? path.join(workspaceRoot, `repo-poller-${label}-seen.json`) : null;
    } else {
      this.stateFilePath = null;
    }
  }

  private makeStateLabel(config: RepositoryConfig): string | null {
    if (config.kind === 'github') {
      if (!SAFE_LABEL_RE.test(config.repo)) {
        logger.warn('RepoPoller: unsafe repo name, disabling state persistence', { repo: config.repo });
        return null;
      }
      return config.repo.replace(/\//g, '-');
    } else {
      if (!SAFE_LABEL_RE.test(config.workspace) || !SAFE_LABEL_RE.test(config.repo_slug)) {
        logger.warn('RepoPoller: unsafe workspace or repo_slug, disabling state persistence');
        return null;
      }
      return `${config.workspace}-${config.repo_slug}`;
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

    const currentOpenNumbers = new Set(prs.map((pr) => pr.number));

    // Detect PRs that disappeared from the open list (potentially merged)
    if (!this.state.firstPoll) {
      await this.detectMergedPRs(currentOpenNumbers);
    }

    // On every poll, but only effective on the first poll after restart (knownOpenPRs is empty then).
    // Verifies each candidate with fetchPR to avoid deleting entries for transiently-missing PRs.
    await this.cleanupOrphanedSeen(currentOpenNumbers);

    for (const pr of prs) {
      await this.checkPR(pr);
    }

    // Update known open PRs
    this.state.knownOpenPRs = new Map(prs.map((pr) => [pr.number, pr]));

    this.state.firstPoll = false;

    // Single persist point for the entire poll cycle.
    this.persistState();
  }

  private async fetchOpenPRs(): Promise<PullRequest[]> {
    return this.repoClient.fetchOpenPRs();
  }

  /**
   * 이슈 identifier 로 매칭되는 오픈 PR 을 찾는다. 복구 경로에서 사용.
   * - 캐시(knownOpenPRs)가 채워져 있으면 캐시 우선.
   * - 캐시가 비어있으면 (부팅 직후 첫 폴 전) 1회 fetch 후 캐시 시드.
   * - fetch 실패 시 호출자가 폴백할 수 있도록 throw 한다.
   */
  async findOpenPRByIssue(identifier: string): Promise<PullRequest | null> {
    for (const pr of this.state.knownOpenPRs.values()) {
      if (pr.issueIdentifier === identifier) return pr;
    }
    if (this.state.knownOpenPRs.size > 0) return null;

    const prs = await this.repoClient.fetchOpenPRs();
    this.state.knownOpenPRs = new Map(prs.map((p) => [p.number, p]));
    return prs.find((p) => p.issueIdentifier === identifier) ?? null;
  }

  // ---------------------------------------------------------------------------
  // Merged PR detection
  // ---------------------------------------------------------------------------

  private async detectMergedPRs(currentOpenNumbers: Set<number>): Promise<void> {
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

  private async cleanupOrphanedSeen(currentOpenNumbers: Set<number>): Promise<void> {
    const candidates: number[] = [];
    for (const prNumber of this.state.seen.keys()) {
      if (currentOpenNumbers.has(prNumber)) continue;
      if (this.state.knownOpenPRs.has(prNumber)) continue; // handled by detectMergedPRs
      candidates.push(prNumber);
    }
    if (candidates.length === 0) return;

    const toDelete: number[] = [];
    for (const prNumber of candidates) {
      try {
        const pr = await this.fetchPR(prNumber);
        if (pr?.state === 'open') {
          // PR is still open (e.g., label temporarily removed) — preserve seen entry
          logger.debug(`RepoPoller: orphan PR #${prNumber} is still open, preserving seen entry`);
          continue;
        }
        toDelete.push(prNumber);
      } catch (err) {
        // Network error — keep entry conservatively to avoid false-positive wipe
        logger.debug('RepoPoller: failed to verify orphan PR state, preserving entry', { pr: prNumber, error: String(err) });
      }
    }

    if (toDelete.length === 0) return;

    const seenSizeBefore = this.state.seen.size;
    for (const prNumber of toDelete) {
      this.state.seen.delete(prNumber);
    }

    if (toDelete.length >= Math.max(3, seenSizeBefore * 0.5)) {
      logger.warn('RepoPoller: large number of orphaned seen entries cleaned up', {
        count: toDelete.length,
        total: seenSizeBefore,
      });
    } else {
      logger.info('RepoPoller: cleaned up orphaned seen entries', { count: toDelete.length });
    }
    logger.debug('RepoPoller: orphaned seen entry details', { prNumbers: toDelete });
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
    // State is persisted once at the end of doPoll.
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
      fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
      try {
        fs.renameSync(tmpPath, this.stateFilePath);
      } catch (renameErr) {
        // Cross-filesystem rename can fail — clean up the temp file and rethrow
        try {
          fs.unlinkSync(tmpPath);
        } catch {
          // ignore cleanup failure
        }
        throw renameErr;
      }
    } catch (err) {
      logger.warn('RepoPoller: failed to persist state', { error: String(err) });
    }
  }

  private restoreState(): void {
    if (!this.stateFilePath) return;
    try {
      const raw = fs.readFileSync(this.stateFilePath, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        logger.warn('RepoPoller: state file has unexpected format, starting fresh');
        return;
      }
      const data = parsed as Record<string, unknown>;
      for (const [key, val] of Object.entries(data)) {
        if (!/^\d+$/.test(key)) {
          logger.warn('RepoPoller: skipping invalid state key', { key });
          continue;
        }
        if (!Array.isArray(val) || !val.every((v) => typeof v === 'string')) {
          logger.warn('RepoPoller: skipping invalid state entry', { pr: Number(key) });
          continue;
        }
        this.state.seen.set(Number(key), { commentIds: new Set(val) });
      }
      // Restored from disk → not a true first poll
      this.state.firstPoll = false;
      logger.info('RepoPoller: restored seen state from disk', { prs: this.state.seen.size });
    } catch {
      // No file or parse error — start fresh (firstPoll stays true)
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
