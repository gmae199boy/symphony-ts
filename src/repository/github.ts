/**
 * GitHub REST API client for PR polling.
 * Mirrors elixir/lib/symphony_elixir/github/client.ex
 *
 * All external API responses are validated with Zod at the network boundary.
 * No type assertions (`as`) are used inside this file.
 */

import { execFileSync } from 'node:child_process';
import { z } from 'zod';
import { logger } from '../logger.js';
import { fetchWithRetry, type FetchRetryOptions } from '../fetch-retry.js';
import { extractIssueIdentifier, isBotLogin, parseDate } from './utils.js';
import type { PullRequest, Review, Comment } from '../types.js';
import type { GitHubRepositoryConfig } from '../config/schema.js';

const GITHUB_API = 'https://api.github.com';

/** GitHub uses 403 (not 429) for rate limits, with x-ratelimit-remaining header. */
const GITHUB_RETRY_OPTS: FetchRetryOptions = {
  shouldRetry: (resp) => {
    if (resp.status === 429 || resp.status >= 500) return true;
    if (resp.status === 403 && resp.headers.get('x-ratelimit-remaining') === '0') return true;
    return false;
  },
  resolveDelayMs: (resp, attempt) => {
    const reset = resp.headers.get('x-ratelimit-reset');
    if (reset) {
      const waitMs = Number(reset) * 1000 - Date.now();
      if (waitMs > 0 && waitMs < 60_000) return waitMs;
    }
    return 1000 * Math.pow(2, attempt);
  },
};

// ---------------------------------------------------------------------------
// Zod schemas for GitHub REST API responses
// ---------------------------------------------------------------------------

const GitHubUserSchema = z.object({
  login: z.string(),
});

const GitHubLabelSchema = z.object({
  name: z.string(),
});

const GitHubRefSchema = z.object({
  ref: z.string(),
  sha: z.string().optional(),
});

const GitHubPRSchema = z.object({
  number: z.number(),
  title: z.string(),
  html_url: z.string(),
  state: z.string(),
  draft: z.boolean().optional(),
  body: z.string().nullable().optional(),
  labels: z.array(GitHubLabelSchema).optional(),
  head: GitHubRefSchema,
});

const GitHubReviewSchema = z.object({
  id: z.number(),
  state: z.string(),
  submitted_at: z.string().nullable().optional(),
  user: GitHubUserSchema.nullable().optional(),
});

const GitHubCommentSchema = z.object({
  id: z.number(),
  body: z.string().nullable().optional(),
  created_at: z.string().nullable().optional(),
  user: GitHubUserSchema.nullable().optional(),
});

// ---------------------------------------------------------------------------
// Types derived from schemas
// ---------------------------------------------------------------------------

type GitHubPR = z.infer<typeof GitHubPRSchema>;
type GitHubReview = z.infer<typeof GitHubReviewSchema>;
type GitHubComment = z.infer<typeof GitHubCommentSchema>;

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class GitHubClient {
  private readonly config: GitHubRepositoryConfig;
  /** undefined = not yet resolved; null = no token */
  private cachedToken: string | null | undefined = undefined;

  constructor(config: GitHubRepositoryConfig) {
    this.config = config;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  async fetchOpenPRs(): Promise<PullRequest[]> {
    const rawList = await this.fetchAllPages(
      `/repos/${this.config.repo}/pulls`,
      { state: 'open', per_page: '100' },
      z.array(GitHubPRSchema),
    );
    return rawList.map(parsePR).filter((pr) => this.isPRTracked(pr));
  }

  async fetchPRReviews(prNumber: number): Promise<Review[]> {
    const rawList = await this.fetchAllPages(
      `/repos/${this.config.repo}/pulls/${prNumber}/reviews`,
      { per_page: '100' },
      z.array(GitHubReviewSchema),
    );
    return rawList.map(parseReview);
  }

  async fetchPR(prNumber: number): Promise<PullRequest | null> {
    try {
      const rawText = await this.getText(
        `/repos/${this.config.repo}/pulls/${prNumber}`,
        {},
      );
      const pr = GitHubPRSchema.parse(JSON.parse(rawText));
      return parsePR(pr);
    } catch {
      return null;
    }
  }

  async deleteBranch(branchName: string): Promise<boolean> {
    const url = `${GITHUB_API}/repos/${this.config.repo}/git/refs/heads/${encodeURIComponent(branchName)}`;
    const token = await this.resolveToken();
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const response = await fetchWithRetry(url, {
      method: 'DELETE',
      headers,
      signal: AbortSignal.timeout(30_000),
    }, GITHUB_RETRY_OPTS);

    if (response.status === 404 || response.status === 422) return false;
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      logger.warn(`GitHub deleteBranch failed: ${response.status} ${body.slice(0, 300)}`);
      return false;
    }
    return true;
  }

  async fetchPRComments(prNumber: number): Promise<Comment[]> {
    // Fetch both top-level PR conversation comments (issue comments) and
    // inline review comments (#discussion_r... URLs) in parallel.
    const [issueRawList, reviewRawList] = await Promise.all([
      this.fetchAllPages(
        `/repos/${this.config.repo}/issues/${prNumber}/comments`,
        { per_page: '100' },
        z.array(GitHubCommentSchema),
      ),
      this.fetchAllPages(
        `/repos/${this.config.repo}/pulls/${prNumber}/comments`,
        { per_page: '100' },
        z.array(GitHubCommentSchema),
      ),
    ]);

    const issueComments = issueRawList.map((c) => parseComment(c, 'issue'));
    const reviewComments = reviewRawList.map((c) => parseComment(c, 'review'));

    // Merge and sort by createdAt ascending so "last comment" logic is correct
    return [...issueComments, ...reviewComments].sort((a, b) => {
      const ta = a.createdAt?.getTime() ?? 0;
      const tb = b.createdAt?.getTime() ?? 0;
      return ta - tb;
    });
  }

  // ---------------------------------------------------------------------------
  // HTTP — returns raw text so callers own parsing
  // ---------------------------------------------------------------------------

  private async fetchAllPages<T>(
    path: string,
    params: Record<string, string>,
    schema: z.ZodType<T[]>,
  ): Promise<T[]> {
    const results: T[] = [];
    const url = new URL(GITHUB_API + path);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

    let nextUrl: string | null = url.toString();
    while (nextUrl) {
      const { text, linkNext } = await this.getTextWithLink(nextUrl);
      const items = schema.parse(JSON.parse(text));
      results.push(...items);
      nextUrl = linkNext;
    }
    return results;
  }

  private async getTextWithLink(url: string): Promise<{ text: string; linkNext: string | null }> {
    const token = await this.resolveToken();
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const response = await fetchWithRetry(url, {
      headers,
      signal: AbortSignal.timeout(30_000),
    }, GITHUB_RETRY_OPTS);

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`GitHub API ${response.status}: ${body.slice(0, 500)}`);
    }

    const linkHeader = response.headers.get('Link') ?? '';
    const nextMatch = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
    return { text: await response.text(), linkNext: nextMatch?.[1] ?? null };
  }

  private async getText(path: string, params: Record<string, string>): Promise<string> {
    const url = new URL(GITHUB_API + path);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

    const token = await this.resolveToken();
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const response = await fetchWithRetry(url.toString(), {
      headers,
      signal: AbortSignal.timeout(30_000),
    }, GITHUB_RETRY_OPTS);

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`GitHub API ${response.status}: ${body.slice(0, 500)}`);
    }

    return response.text();
  }

  private async resolveToken(): Promise<string | null> {
    if (this.cachedToken !== undefined) return this.cachedToken;

    const raw = this.config.token;
    if (raw && raw.trim() !== '') {
      this.cachedToken = raw.trim();
      return this.cachedToken;
    }

    // Fallback: `gh auth token`
    try {
      const token = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();
      if (!token) {
        throw new Error('empty token');
      }
      this.cachedToken = token;
    } catch {
      throw new Error(
        'GitHub token is required: configure token in WORKFLOW.md or run `gh auth login`',
      );
    }

    return this.cachedToken;
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private isPRTracked(pr: PullRequest): boolean {
    const filter = this.config.pr_label_filter;
    if (!filter || filter === '') return true;
    return pr.labels.includes(filter);
  }
}

// ---------------------------------------------------------------------------
// Parsing — input types are inferred from Zod schemas, no `as` needed
// ---------------------------------------------------------------------------

function parsePR(data: GitHubPR): PullRequest {
  const branchName = data.head.ref;
  return {
    number: data.number,
    title: data.title,
    url: data.html_url,
    branchName,
    labels: (data.labels ?? []).map((l) => l.name),
    issueIdentifier: extractIssueIdentifier(branchName, data.body ?? null),
    state: data.state,
  };
}

function parseReview(data: GitHubReview): Review {
  return {
    id: data.id,
    state: data.state,
    authorLogin: data.user?.login ?? '',
    submittedAt: parseDate(data.submitted_at ?? null),
  };
}

function parseComment(data: GitHubComment, kind: 'issue' | 'review'): Comment {
  const login = data.user?.login ?? '';
  return {
    id: `${kind}:${data.id}`,
    body: data.body ?? '',
    authorLogin: login,
    isBot: isBotLogin(login),
    createdAt: parseDate(data.created_at ?? null),
  };
}
