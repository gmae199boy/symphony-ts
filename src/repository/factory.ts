/**
 * Repository client factory — creates the appropriate repo client
 * based on the repository config kind.
 */

import { GitHubClient } from './github.js';
import { BitbucketClient } from './bitbucket.js';
import type { PullRequest, Review, Comment } from '../types.js';
import type { RepositoryConfig } from '../config/schema.js';

export interface RepoClientApi {
  fetchOpenPRs(): Promise<PullRequest[]>;
  fetchPR(prNumber: number): Promise<PullRequest | null>;
  deleteBranch(branchName: string): Promise<boolean>;
  fetchPRReviews(prNumber: number): Promise<Review[]>;
  fetchPRComments(prNumber: number): Promise<Comment[]>;
}

export function createRepoClient(config: RepositoryConfig): RepoClientApi {
  switch (config.kind) {
    case 'github':
      return new GitHubClient(config);
    case 'bitbucket':
      return new BitbucketClient(config);
    default:
      throw new Error(`Unknown repository kind: ${(config as { kind: string }).kind}`);
  }
}
