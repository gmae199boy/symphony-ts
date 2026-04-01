/**
 * Jira Cloud REST API v3 tracker client.
 *
 * All external API responses are validated with Zod at the network boundary.
 * No type assertions (`as`) are used inside this file.
 */

import { z } from 'zod';
import { logger } from '../logger.js';
import { fetchWithRetry } from '../fetch-retry.js';
import { parseDate } from '../utils.js';
import type { BlockerRef, Issue, TrackerClient, TrackerComment } from '../types.js';
import type { JiraTrackerConfig } from '../config/schema.js';

const MAX_RESULTS = 50;
const MAX_ERROR_LOG_BYTES = 1_000;

// ---------------------------------------------------------------------------
// Zod schemas for Jira REST API v3 responses
// ---------------------------------------------------------------------------

const JiraStatusSchema = z.object({
  name: z.string(),
});

const JiraIssueLinkTypeSchema = z.object({
  name: z.string(),
  inward: z.string(),
  outward: z.string(),
});

const JiraLinkedIssueSchema = z.object({
  id: z.string(),
  key: z.string(),
  fields: z.object({ status: JiraStatusSchema }),
});

const JiraIssueLinkSchema = z.object({
  type: JiraIssueLinkTypeSchema,
  inwardIssue: JiraLinkedIssueSchema.optional(),
  outwardIssue: JiraLinkedIssueSchema.optional(),
});

const JiraIssueFieldsSchema = z.object({
  summary: z.string(),
  description: z.unknown().nullable().optional(), // ADF format, not used directly
  priority: z.object({ id: z.string().optional(), name: z.string().optional() }).nullable().optional(),
  status: JiraStatusSchema,
  assignee: z.object({
    accountId: z.string(),
    emailAddress: z.string().optional(),
  }).nullable().optional(),
  labels: z.array(z.string()).optional(),
  issuelinks: z.array(JiraIssueLinkSchema).optional(),
  created: z.string().nullable().optional(),
  updated: z.string().nullable().optional(),
});

const JiraIssueSchema = z.object({
  id: z.string(),
  key: z.string(),
  self: z.string(),
  fields: JiraIssueFieldsSchema,
});

/** Response from GET /rest/api/3/search/jql (JQL enhanced search). */
const JiraSearchResponseSchema = z.object({
  issues: z.array(JiraIssueSchema),
  isLast: z.boolean(),
  nextPageToken: z.string().optional(),
});

const JiraMyselfSchema = z.object({
  accountId: z.string(),
});

const JiraCommentBodySchema = z.unknown();

const JiraCommentAuthorSchema = z.object({
  accountId: z.string(),
  emailAddress: z.string().optional(),
});

const JiraCommentSchema = z.object({
  id: z.string(),
  body: JiraCommentBodySchema,
  author: JiraCommentAuthorSchema,
  created: z.string(),
});

const JiraCommentsResponseSchema = z.object({
  comments: z.array(JiraCommentSchema),
});

const JiraTransitionSchema = z.object({
  id: z.string(),
  name: z.string(),
});

const JiraTransitionsResponseSchema = z.object({
  transitions: z.array(JiraTransitionSchema),
});

// ---------------------------------------------------------------------------
// Types derived from schemas
// ---------------------------------------------------------------------------

type JiraIssue = z.infer<typeof JiraIssueSchema>;

// ---------------------------------------------------------------------------
// JQL escaping helpers
// ---------------------------------------------------------------------------

/** Escape a value for use inside a JQL double-quoted string. */
function jqlEscape(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** Wrap a value as a safely-escaped JQL string literal. */
function jqlString(value: string): string {
  return `"${jqlEscape(value)}"`;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class JiraClient implements TrackerClient {
  private readonly config: JiraTrackerConfig;
  private readonly baseUrl: string;
  /** undefined = not yet resolved; null = no filter */
  private myAccountId: string | null | undefined = undefined;

  constructor(config: JiraTrackerConfig) {
    const email = config.email ?? process.env['JIRA_EMAIL'];
    const apiToken = config.api_token ?? process.env['JIRA_API_TOKEN'];
    if (!email || !apiToken) {
      throw new Error('Jira email and api_token must be configured');
    }
    this.config = config;
    // Remove trailing slash from host
    this.baseUrl = config.host.replace(/\/+$/, '');
  }

  // ---------------------------------------------------------------------------
  // TrackerClient impl
  // ---------------------------------------------------------------------------

  async fetchCandidateIssues(): Promise<Issue[]> {
    const statesJql = this.config.active_states
      .map((s) => jqlString(s))
      .join(', ');

    let jql = `project = ${jqlString(this.config.project_key)} AND status IN (${statesJql})`;

    // Handle assignee filter
    const assignee = this.config.assignee?.trim();
    if (assignee === 'me') {
      const accountId = await this.resolveMyAccountId();
      if (accountId) {
        jql += ` AND assignee = ${jqlString(accountId)}`;
      }
    } else if (assignee && assignee !== '') {
      jql += ` AND assignee = ${jqlString(assignee)}`;
    }

    jql += ' ORDER BY priority ASC, updated DESC';

    return this.searchIssues(jql);
  }

  async fetchIssuesByIds(ids: string[]): Promise<Issue[]> {
    if (ids.length === 0) return [];

    const idList = ids.map((id) => jqlString(id)).join(', ');
    const jql = `id IN (${idList})`;

    const issues = await this.searchIssues(jql);

    // Preserve requested order
    const orderIndex = new Map(ids.map((id, idx) => [id, idx]));
    return issues.sort(
      (a, b) => (orderIndex.get(a.id) ?? 0) - (orderIndex.get(b.id) ?? 0),
    );
  }

  async fetchIssueByIdentifier(identifier: string): Promise<Issue | null> {
    try {
      const rawText = await this.request('GET', `/rest/api/3/issue/${identifier}`);
      const data = JiraIssueSchema.parse(JSON.parse(rawText));
      return normalizeJiraIssue(data, this.baseUrl);
    } catch (err) {
      const msg = String(err);
      if (msg.includes('404')) return null;
      throw err;
    }
  }

  async transitionIssue(id: string, toState: string): Promise<void> {
    // Step 1: get available transitions for the issue
    const transRaw = await this.request('GET', `/rest/api/3/issue/${id}/transitions`);
    const transData = JiraTransitionsResponseSchema.parse(JSON.parse(transRaw));

    const target = transData.transitions.find(
      (t) => t.name.toLowerCase().trim() === toState.toLowerCase().trim(),
    );

    if (!target) {
      const available = transData.transitions.map((t) => t.name).join(', ');
      throw new Error(
        `Jira: no transition named "${toState}" available for issue ${id}. Available: [${available}]`,
      );
    }

    // Step 2: execute the transition
    await this.request('POST', `/rest/api/3/issue/${id}/transitions`, {
      transition: { id: target.id },
    });

    logger.info(`Jira: transitioned issue ${id} to "${toState}"`);
  }

  async fetchComments(issueId: string, since?: Date): Promise<TrackerComment[]> {
    const rawText = await this.request('GET', `/rest/api/3/issue/${issueId}/comment?expand=renderedBody&maxResults=100`);
    const data = JiraCommentsResponseSchema.parse(JSON.parse(rawText));
    const myAccountId = await this.resolveMyAccountId();

    return data.comments
      .filter((c) => {
        if (!since) return true;
        const createdAt = parseDate(c.created);
        return createdAt !== null && createdAt > since;
      })
      .map((c) => ({
        id: c.id,
        body: adfToText(c.body).trim(),
        authorId: c.author.accountId,
        authorEmail: c.author.emailAddress,
        isBot: myAccountId !== null && c.author.accountId === myAccountId,
        createdAt: parseDate(c.created),
      }));
  }

  async getBotIdentity(): Promise<string | null> {
    return this.resolveMyAccountId();
  }

  async createComment(id: string, body: string): Promise<void> {
    // Jira v3 requires Atlassian Document Format (ADF)
    const adfBody = {
      body: {
        type: 'doc',
        version: 1,
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: body }],
          },
        ],
      },
    };

    await this.request('POST', `/rest/api/3/issue/${id}/comment`, adfBody);
  }

  // ---------------------------------------------------------------------------
  // HTTP
  // ---------------------------------------------------------------------------

  private async request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<string> {
    const email = this.config.email ?? process.env['JIRA_EMAIL'];
    const apiToken = this.config.api_token ?? process.env['JIRA_API_TOKEN'];

    if (!email || !apiToken) {
      throw new Error('Jira email and api_token must be configured');
    }

    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Basic ${Buffer.from(`${email}:${apiToken}`).toString('base64')}`,
    };

    const response = await fetchWithRetry(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      const rawText = await response.text().catch(() => '');
      const preview = rawText.slice(0, MAX_ERROR_LOG_BYTES);
      logger.error('Jira API request failed', { status: response.status, preview });
      throw new Error(`Jira API error: ${response.status}`);
    }

    // Some Jira endpoints return 204 with no body
    if (response.status === 204) return '{}';
    return response.text();
  }

  // ---------------------------------------------------------------------------
  // Search with pagination
  // ---------------------------------------------------------------------------

  private async searchIssues(jql: string): Promise<Issue[]> {
    const results: Issue[] = [];
    let nextPageToken: string | undefined;

    while (true) {
      const params = new URLSearchParams({
        jql,
        maxResults: String(MAX_RESULTS),
        fields: 'summary,description,priority,status,assignee,labels,issuelinks,created,updated',
      });
      if (nextPageToken) params.set('nextPageToken', nextPageToken);

      const rawText = await this.request('GET', `/rest/api/3/search/jql?${params.toString()}`);
      const data = JiraSearchResponseSchema.parse(JSON.parse(rawText));

      for (const issue of data.issues) {
        results.push(normalizeJiraIssue(issue, this.baseUrl));
      }

      if (data.isLast || !data.nextPageToken || data.issues.length === 0) break;
      nextPageToken = data.nextPageToken;
    }

    return results;
  }

  // ---------------------------------------------------------------------------
  // Account ID resolution
  // ---------------------------------------------------------------------------

  private async resolveMyAccountId(): Promise<string | null> {
    if (this.myAccountId !== undefined) return this.myAccountId;

    try {
      const rawText = await this.request('GET', '/rest/api/3/myself');
      const data = JiraMyselfSchema.parse(JSON.parse(rawText));
      this.myAccountId = data.accountId;
    } catch (err) {
      logger.warn('Failed to resolve Jira account ID', { error: String(err) });
      this.myAccountId = null;
    }

    return this.myAccountId;
  }
}

// ---------------------------------------------------------------------------
// ADF → plain text
// ---------------------------------------------------------------------------

function adfToText(node: unknown): string {
  if (!node || typeof node !== 'object') return '';
  const n = node as Record<string, unknown>;

  if (n['type'] === 'text') return typeof n['text'] === 'string' ? n['text'] : '';

  const children = Array.isArray(n['content']) ? (n['content'] as unknown[]) : [];
  const childText = children.map(adfToText).join('');

  switch (n['type']) {
    case 'paragraph': return childText + '\n';
    case 'heading': return childText + '\n';
    case 'bulletList':
    case 'orderedList': return childText;
    case 'listItem': return '- ' + childText.trimEnd() + '\n';
    case 'blockquote': return '> ' + childText.trimEnd() + '\n';
    case 'codeBlock': return '```\n' + childText + '```\n';
    case 'rule': return '---\n';
    case 'hardBreak': return '\n';
    default: return childText;
  }
}

// ---------------------------------------------------------------------------
// Blocking
// ---------------------------------------------------------------------------

function extractBlockers(issuelinks: z.infer<typeof JiraIssueLinkSchema>[]): BlockerRef[] {
  return issuelinks.flatMap((link) => {
    // "is blocked by" inwardIssue → inwardIssue is our blocker
    if (!link.inwardIssue) return [];
    if (!link.type.inward.toLowerCase().includes('blocked by')) return [];
    return [{
      id: link.inwardIssue.id,
      identifier: link.inwardIssue.key,
      state: link.inwardIssue.fields.status.name,
    }];
  });
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

function normalizeJiraIssue(data: JiraIssue, baseUrl: string): Issue {
  const priorityNum = data.fields.priority?.id
    ? parseInt(data.fields.priority.id, 10)
    : null;

  const rawDesc = data.fields.description;
  const description = rawDesc ? adfToText(rawDesc).trim() || null : null;

  return {
    id: data.id,
    identifier: data.key,
    title: data.fields.summary,
    description,
    priority: isNaN(priorityNum ?? NaN) ? null : priorityNum,
    state: data.fields.status.name,
    branchName: null,
    url: `${baseUrl}/browse/${data.key}`,
    assigneeId: data.fields.assignee?.accountId ?? null,
    assigneeEmail: data.fields.assignee?.emailAddress ?? null,
    labels: data.fields.labels ?? [],
    blockedBy: extractBlockers(data.fields.issuelinks ?? []),
    assignedToWorker: true,
    createdAt: parseDate(data.fields.created ?? null),
    updatedAt: parseDate(data.fields.updated ?? null),
  };
}

