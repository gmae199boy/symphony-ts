/**
 * Bitbucket Cloud REST API v2 client for PR polling.
 *
 * All external API responses are validated with Zod at the network boundary.
 * No type assertions (`as`) are used inside this file.
 */

import { z } from 'zod';
import { logger } from '../logger.js';
import { extractIssueIdentifier, isBotLogin, parseDate } from './utils.js';
import type { PullRequest, Review, Comment } from '../types.js';
import type { BitbucketRepositoryConfig } from '../config/schema.js';

const BITBUCKET_API = 'https://api.bitbucket.org';

// ---------------------------------------------------------------------------
// Zod schemas for Bitbucket REST API v2 responses
// ---------------------------------------------------------------------------

const BitbucketUserSchema = z.object({
  display_name: z.string().optional(),
  nickname: z.string().optional(),
  type: z.string().optional(),
});

const BitbucketBranchSchema = z.object({
  name: z.string(),
});

const BitbucketParticipantSchema = z.object({
  user: BitbucketUserSchema,
  role: z.string(), // "PARTICIPANT" | "REVIEWER" | "AUTHOR"
  state: z.string().nullable().optional(), // "approved" | "changes_requested" | null
  approved: z.boolean().optional(),
});

const BitbucketPRSchema = z.object({
  id: z.number(),
  title: z.string(),
  state: z.string(), // "OPEN" | "MERGED" | "DECLINED" | "SUPERSEDED"
  description: z.string().nullable().optional(),
  source: z.object({ branch: BitbucketBranchSchema }),
  links: z.object({
    html: z.object({ href: z.string() }),
  }),
  participants: z.array(BitbucketParticipantSchema).optional(),
});

const BitbucketCommentSchema = z.object({
  id: z.number(),
  content: z.object({
    raw: z.string().nullable().optional(),
  }),
  user: BitbucketUserSchema,
  created_on: z.string().nullable().optional(),
});

const BitbucketPageSchema = <T extends z.ZodTypeAny>(itemSchema: T) =>
  z.object({
    values: z.array(itemSchema),
    next: z.string().optional(),
    size: z.number().optional(),
  });

// ---------------------------------------------------------------------------
// Types derived from schemas
// ---------------------------------------------------------------------------

type BitbucketPR = z.infer<typeof BitbucketPRSchema>;
type BitbucketParticipant = z.infer<typeof BitbucketParticipantSchema>;
type BitbucketComment = z.infer<typeof BitbucketCommentSchema>;

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class BitbucketClient {
  private readonly config: BitbucketRepositoryConfig;

  constructor(config: BitbucketRepositoryConfig) {
    this.config = config;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  async fetchOpenPRs(): Promise<PullRequest[]> {
    const path = `/2.0/repositories/${this.config.workspace}/${this.config.repo_slug}/pullrequests`;
    const allPRs: BitbucketPR[] = [];
    let url: string | null = `${BITBUCKET_API}${path}?state=OPEN`;

    while (url) {
      const rawText = await this.getText(url);
      const page = BitbucketPageSchema(BitbucketPRSchema).parse(JSON.parse(rawText));
      allPRs.push(...page.values);
      url = page.next ?? null;
    }

    return allPRs.map((pr) => parseBitbucketPR(pr)).filter((pr) => this.isPRTracked(pr));
  }

  async fetchPRReviews(prNumber: number): Promise<Review[]> {
    // Bitbucket embeds review state in the PR's participants array
    const path = `/2.0/repositories/${this.config.workspace}/${this.config.repo_slug}/pullrequests/${prNumber}`;
    const rawText = await this.getText(`${BITBUCKET_API}${path}`);
    const pr = BitbucketPRSchema.parse(JSON.parse(rawText));

    return (pr.participants ?? [])
      .filter((p) => p.role === 'REVIEWER')
      .map((p, idx) => parseParticipantAsReview(p, idx));
  }

  async fetchPRComments(prNumber: number): Promise<Comment[]> {
    const path = `/2.0/repositories/${this.config.workspace}/${this.config.repo_slug}/pullrequests/${prNumber}/comments`;
    const allComments: BitbucketComment[] = [];
    let url: string | null = `${BITBUCKET_API}${path}`;

    while (url) {
      const rawText = await this.getText(url);
      const page = BitbucketPageSchema(BitbucketCommentSchema).parse(JSON.parse(rawText));
      allComments.push(...page.values);
      url = page.next ?? null;
    }

    return allComments
      .map(parseBitbucketComment)
      .sort((a, b) => {
        const ta = a.createdAt?.getTime() ?? 0;
        const tb = b.createdAt?.getTime() ?? 0;
        return ta - tb;
      });
  }

  // ---------------------------------------------------------------------------
  // HTTP
  // ---------------------------------------------------------------------------

  private async getText(url: string): Promise<string> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
    };

    const email = this.config.email ?? process.env['BITBUCKET_EMAIL'];
    const apiToken = this.config.api_token ?? process.env['BITBUCKET_API_TOKEN'];

    if (email && apiToken) {
      headers['Authorization'] = `Basic ${Buffer.from(`${email}:${apiToken}`).toString('base64')}`;
    }

    const response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Bitbucket API ${response.status}: ${body.slice(0, 500)}`);
    }

    return response.text();
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private isPRTracked(pr: PullRequest): boolean {
    const filter = this.config.pr_label_filter;
    if (!filter || filter === '') return true;
    // Bitbucket PRs don't have labels — match against branch name pattern
    return pr.branchName.includes(filter);
  }
}

// ---------------------------------------------------------------------------
// Parsing — input types inferred from Zod, no `as`
// ---------------------------------------------------------------------------

function parseBitbucketPR(data: BitbucketPR): PullRequest {
  const branchName = data.source.branch.name;
  return {
    number: data.id,
    title: data.title,
    url: data.links.html.href,
    branchName,
    labels: [], // Bitbucket PRs don't have labels
    linearIssueId: extractIssueIdentifier(branchName, data.description ?? null),
    state: data.state.toLowerCase(),
  };
}

function parseParticipantAsReview(data: BitbucketParticipant, index: number): Review {
  const nickname = data.user.nickname ?? data.user.display_name ?? '';
  // Use a stable numeric ID derived from the participant index
  const id = index + 1;

  let state = 'COMMENTED';
  if (data.approved) {
    state = 'APPROVED';
  } else if (data.state === 'changes_requested') {
    state = 'CHANGES_REQUESTED';
  }

  return {
    id,
    state,
    authorLogin: nickname,
    submittedAt: null,
  };
}

function parseBitbucketComment(data: BitbucketComment): Comment {
  const login = data.user.nickname ?? data.user.display_name ?? '';
  return {
    id: `bb:${data.id}`,
    body: data.content.raw ?? '',
    authorLogin: login,
    isBot: isBotLogin(login),
    createdAt: parseDate(data.created_on ?? null),
  };
}
