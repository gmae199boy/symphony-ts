/**
 * Linear GraphQL tracker client.
 * Mirrors elixir/lib/symphony_elixir/linear/client.ex
 *
 * All external API responses are validated with Zod at the network boundary.
 * No type assertions (`as`) are used inside this file.
 */

import { z } from 'zod';
import { logger } from '../logger.js';
import type { Issue, BlockerRef, TrackerClient } from '../types.js';
import type { LinearTrackerConfig } from '../config/schema.js';

const ISSUE_PAGE_SIZE = 50;
const MAX_ERROR_LOG_BYTES = 1_000;

// ---------------------------------------------------------------------------
// GraphQL queries
// ---------------------------------------------------------------------------

const POLL_QUERY = `
query SymphonyLinearPoll($projectSlug: String!, $stateNames: [String!]!, $first: Int!, $relationFirst: Int!, $after: String) {
  issues(filter: {project: {slugId: {eq: $projectSlug}}, state: {name: {in: $stateNames}}}, first: $first, after: $after) {
    nodes {
      id identifier title description priority
      state { name }
      branchName url
      assignee { id }
      labels { nodes { name } }
      inverseRelations(first: $relationFirst) {
        nodes {
          type
          issue { id identifier state { name } }
        }
      }
      createdAt updatedAt
    }
    pageInfo { hasNextPage endCursor }
  }
}`;

const BY_IDS_QUERY = `
query SymphonyLinearIssuesById($ids: [ID!]!, $first: Int!, $relationFirst: Int!) {
  issues(filter: {id: {in: $ids}}, first: $first) {
    nodes {
      id identifier title description priority
      state { name }
      branchName url
      assignee { id }
      labels { nodes { name } }
      inverseRelations(first: $relationFirst) {
        nodes {
          type
          issue { id identifier state { name } }
        }
      }
      createdAt updatedAt
    }
  }
}`;

const BY_IDENTIFIER_QUERY = `
query SymphonyLinearIssueByIdentifier($identifier: String!, $relationFirst: Int!) {
  issue(id: $identifier) {
    id identifier title description priority
    state { name }
    branchName url
    assignee { id }
    labels { nodes { name } }
    inverseRelations(first: $relationFirst) {
      nodes {
        type
        issue { id identifier state { name } }
      }
    }
    createdAt updatedAt
  }
}`;

const RESOLVE_STATE_ID_QUERY = `
query SymphonyLinearResolveStateId($issueId: String!, $stateName: String!) {
  issue(id: $issueId) {
    team {
      states(filter: {name: {eq: $stateName}}, first: 1) {
        nodes { id }
      }
    }
  }
}`;

const UPDATE_ISSUE_STATE_MUTATION = `
mutation SymphonyLinearUpdateIssueState($issueId: String!, $stateId: String!) {
  issueUpdate(id: $issueId, input: {stateId: $stateId}) {
    success
  }
}`;

const VIEWER_QUERY = `
query SymphonyLinearViewer {
  viewer { id }
}`;

// ---------------------------------------------------------------------------
// Zod schemas for API responses
// ---------------------------------------------------------------------------

const RelationIssueSchema = z.object({
  id: z.string(),
  identifier: z.string(),
  state: z.object({ name: z.string() }).nullable().optional(),
});

const InverseRelationNodeSchema = z.object({
  type: z.string(),
  issue: RelationIssueSchema.nullable().optional(),
});

const IssueNodeSchema = z.object({
  id: z.string(),
  identifier: z.string(),
  title: z.string(),
  description: z.string().nullable().optional(),
  priority: z.number().nullable().optional(),
  state: z.object({ name: z.string() }).nullable().optional(),
  branchName: z.string().nullable().optional(),
  url: z.string(),
  assignee: z.object({ id: z.string() }).nullable().optional(),
  labels: z.object({
    nodes: z.array(z.object({ name: z.string() })),
  }).optional(),
  inverseRelations: z.object({
    nodes: z.array(InverseRelationNodeSchema),
  }).optional(),
  createdAt: z.string().nullable().optional(),
  updatedAt: z.string().nullable().optional(),
});

const PageInfoSchema = z.object({
  hasNextPage: z.boolean(),
  endCursor: z.string().nullable().optional(),
});

const IssueConnectionSchema = z.object({
  nodes: z.array(IssueNodeSchema),
  pageInfo: PageInfoSchema.optional(),
});

const PollResponseSchema = z.object({
  issues: IssueConnectionSchema,
});

const ByIdsResponseSchema = z.object({
  issues: z.object({
    nodes: z.array(IssueNodeSchema),
  }),
});

const ByIdentifierResponseSchema = z.object({
  issue: IssueNodeSchema.nullable(),
});

const ViewerResponseSchema = z.object({
  viewer: z.object({ id: z.string() }).nullable(),
});

const ResolveStateIdResponseSchema = z.object({
  issue: z.object({
    team: z.object({
      states: z.object({
        nodes: z.array(z.object({ id: z.string() })),
      }),
    }),
  }).nullable(),
});

const UpdateIssueStateResponseSchema = z.object({
  issueUpdate: z.object({
    success: z.boolean(),
  }),
});

const GraphQLEnvelopeSchema = z.object({
  data: z.unknown().optional(),
  errors: z.array(z.unknown()).optional(),
});

// ---------------------------------------------------------------------------
// Types derived from schemas
// ---------------------------------------------------------------------------

type IssueNode = z.infer<typeof IssueNodeSchema>;

interface AssigneeFilter {
  configuredAssignee: string;
  matchValues: Set<string>;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class LinearClient implements TrackerClient {
  private readonly config: LinearTrackerConfig;
  private readonly endpoint: string;
  /** undefined = not yet resolved; null = no filter */
  private assigneeFilter: AssigneeFilter | null | undefined = undefined;

  constructor(config: LinearTrackerConfig) {
    this.config = config;
    this.endpoint = config.endpoint ?? 'https://api.linear.app/graphql';
  }

  // ---------------------------------------------------------------------------
  // TrackerClient impl
  // ---------------------------------------------------------------------------

  async fetchCandidateIssues(): Promise<Issue[]> {
    const filter = await this.resolveAssigneeFilter();
    return this.fetchByStates(this.config.active_states, filter);
  }

  async fetchIssuesByIds(ids: string[]): Promise<Issue[]> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return [];
    const filter = await this.resolveAssigneeFilter();
    return this.doFetchIssueStates(unique, filter);
  }

  async fetchIssueByIdentifier(identifier: string): Promise<Issue | null> {
    const filter = await this.resolveAssigneeFilter();
    const raw = await this.rawGraphql(BY_IDENTIFIER_QUERY, {
      identifier,
      relationFirst: ISSUE_PAGE_SIZE,
    });
    const data = ByIdentifierResponseSchema.parse(raw);
    if (!data.issue) return null;
    return normalizeIssue(data.issue, filter);
  }

  async transitionIssue(id: string, toState: string): Promise<void> {
    // Step 1: resolve state name → state ID via the issue's team workflow states
    const stateRaw = await this.rawGraphql(RESOLVE_STATE_ID_QUERY, {
      issueId: id,
      stateName: toState,
    });
    const stateData = ResolveStateIdResponseSchema.parse(stateRaw);

    const stateNodes = stateData.issue?.team.states.nodes ?? [];
    if (stateNodes.length === 0) {
      throw new Error(`Linear: no workflow state named "${toState}" found for issue ${id}`);
    }
    const stateId = stateNodes[0].id;

    // Step 2: update issue state
    const updateRaw = await this.rawGraphql(UPDATE_ISSUE_STATE_MUTATION, {
      issueId: id,
      stateId,
    });
    const updateData = UpdateIssueStateResponseSchema.parse(updateRaw);

    if (!updateData.issueUpdate.success) {
      throw new Error(`Linear: issueUpdate failed for issue ${id} → state "${toState}"`);
    }

    logger.info(`Linear: transitioned issue ${id} to "${toState}"`);
  }

  async createComment(id: string, body: string): Promise<void> {
    await this.rawGraphql(
      `mutation CreateComment($issueId: String!, $body: String!) {
         commentCreate(input: { issueId: $issueId, body: $body }) { success }
       }`,
      { issueId: id, body },
    );
  }

  // ---------------------------------------------------------------------------
  // GraphQL
  // ---------------------------------------------------------------------------

  /** Execute a raw GraphQL request and return the `data` field as `unknown`. */
  private async rawGraphql(
    query: string,
    variables: Record<string, unknown> = {},
  ): Promise<unknown> {
    const apiKey = this.config.api_key;
    if (!apiKey) throw new Error('LINEAR_API_KEY not configured');

    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers: {
        Authorization: apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(30_000),
    });

    const rawText = await response.text();

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      throw new Error(`Linear returned non-JSON response (status ${response.status})`);
    }

    const envelope = GraphQLEnvelopeSchema.parse(parsed);

    if (!response.ok) {
      const preview = rawText.slice(0, MAX_ERROR_LOG_BYTES);
      logger.error('Linear GraphQL request failed', { status: response.status, preview });
      throw new Error(`Linear API error: ${response.status}`);
    }

    if (envelope.errors && envelope.errors.length > 0) {
      logger.error('Linear GraphQL errors', { errors: envelope.errors });
      throw new Error(`Linear GraphQL errors: ${JSON.stringify(envelope.errors)}`);
    }

    return envelope.data;
  }

  // ---------------------------------------------------------------------------
  // Fetching
  // ---------------------------------------------------------------------------

  private async fetchByStates(
    stateNames: string[],
    filter: AssigneeFilter | null,
  ): Promise<Issue[]> {
    const pages: Issue[][] = [];
    let after: string | null = null;

    while (true) {
      const raw = await this.rawGraphql(POLL_QUERY, {
        projectSlug: this.config.project_slug,
        stateNames,
        first: ISSUE_PAGE_SIZE,
        relationFirst: ISSUE_PAGE_SIZE,
        after,
      });

      const data = PollResponseSchema.parse(raw);

      const issues = data.issues.nodes
        .map((n) => normalizeIssue(n, filter))
        .filter((i): i is Issue => i !== null);

      pages.push(issues);

      const pageInfo = data.issues.pageInfo;
      if (pageInfo?.hasNextPage && pageInfo.endCursor) {
        after = pageInfo.endCursor;
      } else {
        break;
      }
    }

    return pages.flat();
  }

  private async doFetchIssueStates(
    ids: string[],
    filter: AssigneeFilter | null,
  ): Promise<Issue[]> {
    const results: Issue[] = [];
    let remaining = [...ids];

    while (remaining.length > 0) {
      const batch = remaining.splice(0, ISSUE_PAGE_SIZE);

      const raw = await this.rawGraphql(BY_IDS_QUERY, {
        ids: batch,
        first: batch.length,
        relationFirst: ISSUE_PAGE_SIZE,
      });

      const data = ByIdsResponseSchema.parse(raw);

      const issues = data.issues.nodes
        .map((n) => normalizeIssue(n, filter))
        .filter((i): i is Issue => i !== null);

      results.push(...issues);
    }

    const orderIndex = new Map(ids.map((id, idx) => [id, idx]));
    return results.sort(
      (a, b) => (orderIndex.get(a.id) ?? 0) - (orderIndex.get(b.id) ?? 0),
    );
  }

  // ---------------------------------------------------------------------------
  // Assignee filter
  // ---------------------------------------------------------------------------

  private async resolveAssigneeFilter(): Promise<AssigneeFilter | null> {
    if (this.assigneeFilter !== undefined) return this.assigneeFilter;

    const assignee = this.config.assignee;
    if (!assignee || assignee.trim() === '') {
      this.assigneeFilter = null;
      return null;
    }

    const trimmed = assignee.trim();

    if (trimmed === 'me') {
      const raw = await this.rawGraphql(VIEWER_QUERY, {});
      const data = ViewerResponseSchema.parse(raw);

      if (!data.viewer?.id) throw new Error('Could not resolve Linear viewer identity');

      this.assigneeFilter = {
        configuredAssignee: 'me',
        matchValues: new Set([data.viewer.id]),
      };
    } else {
      this.assigneeFilter = {
        configuredAssignee: trimmed,
        matchValues: new Set([trimmed]),
      };
    }

    return this.assigneeFilter;
  }
}

// ---------------------------------------------------------------------------
// Normalization (pure functions, no `as`)
// ---------------------------------------------------------------------------

function normalizeIssue(node: IssueNode, filter: AssigneeFilter | null): Issue | null {
  if (!assignedToWorker(node.assignee?.id ?? null, filter)) return null;

  return {
    id: node.id,
    identifier: node.identifier,
    title: node.title,
    description: node.description ?? null,
    priority: node.priority ?? null,
    state: node.state?.name ?? '',
    branchName: node.branchName ?? null,
    url: node.url,
    assigneeId: node.assignee?.id ?? null,
    labels: extractLabels(node),
    blockedBy: extractBlockers(node),
    assignedToWorker: true,
    createdAt: parseDate(node.createdAt ?? null),
    updatedAt: parseDate(node.updatedAt ?? null),
  };
}

function assignedToWorker(
  assigneeId: string | null,
  filter: AssigneeFilter | null,
): boolean {
  if (!filter) return true;
  if (!assigneeId) return false;
  return filter.matchValues.has(assigneeId);
}

function extractLabels(node: IssueNode): string[] {
  return (node.labels?.nodes ?? [])
    .map((n) => n.name)
    .filter((name): name is string => typeof name === 'string')
    .map((s) => s.toLowerCase());
}

function extractBlockers(node: IssueNode): BlockerRef[] {
  return (node.inverseRelations?.nodes ?? []).flatMap((rel) => {
    if (rel.type.toLowerCase().trim() !== 'blocks') return [];
    if (!rel.issue) return [];

    return [
      {
        id: rel.issue.id,
        identifier: rel.issue.identifier,
        state: rel.issue.state?.name ?? null,
      } satisfies BlockerRef,
    ];
  });
}

function parseDate(raw: string | null | undefined): Date | null {
  if (!raw) return null;
  const d = new Date(raw);
  return isNaN(d.getTime()) ? null : d;
}
