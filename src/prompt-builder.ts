/**
 * Prompt builder — renders the Liquid template from WORKFLOW.md with issue context.
 * Mirrors elixir/lib/symphony_elixir/prompt_builder.ex
 */

import { Liquid } from 'liquidjs';
import type { Issue, DispatchReason } from './types.js';
import type { StatesConfig } from './config/schema.js';

const engine = new Liquid({ strictVariables: false, strictFilters: false });

export interface PromptExtras {
  trackerKind?: string;
  repositoryKind?: string;
  states?: StatesConfig;
}

/**
 * Render the Liquid prompt template with issue data.
 *
 * @param template  The Liquid template string from WORKFLOW.md
 * @param issue     The issue to render for
 * @param attempt   Turn number (1 = first turn, >1 = continuation)
 * @param extras    Additional template variables (tracker_kind, repository_kind)
 */
export async function buildPrompt(
  template: string,
  issue: Issue,
  attempt: number = 1,
  extras?: PromptExtras,
): Promise<string> {
  const context = {
    issue: issueToTemplateContext(issue),
    attempt: attempt > 1 ? attempt : null,
    tracker_kind: extras?.trackerKind ?? 'tracker',
    repository_kind: extras?.repositoryKind ?? 'github',
    states: extras?.states ?? {},
  };

  return engine.parseAndRender(template, context);
}

/**
 * Returns the standard continuation prompt for turns > 1 when no custom
 * template continuation logic is present.
 */
export function buildContinuationPrompt(turnNumber: number, maxTurns: number, trackerKind?: string): string {
  const tracker = trackerKind ?? 'tracker';
  return `Continuation guidance:

- The previous agent turn completed normally, but the ${tracker} issue is still in an active state.
- This is continuation turn #${turnNumber} of ${maxTurns} for the current agent run.
- Resume from the current workspace and workpad state instead of restarting from scratch.
- The original task instructions and prior turn context are already present in this thread, so do not restate them before acting.
- Focus on the remaining ticket work and do not end the turn while the issue stays active unless you are truly blocked.
`;
}

/**
 * Returns a resume prompt tailored to the dispatch reason.
 */
export function buildResumePrompt(
  reason: DispatchReason | undefined,
  turnNumber: number,
  maxTurns: number,
  trackerKind?: string,
): string {
  const tracker = trackerKind ?? 'tracker';

  if (reason === 'pr_feedback') {
    return `Resume guidance:

- New PR feedback has arrived. Check .symphony/pr_feedback.json for the latest review comments.
- Address the feedback, update the code, and push the changes.
- This is continuation turn #${turnNumber} of ${maxTurns}.
`;
  }

  if (reason === 'slack_response') {
    return `Resume guidance:

- A Slack response has been received. Check .symphony/slack_response.json for the user's message.
- Follow the user's instructions or answer their question, then continue working on the ${tracker} issue.
- This is continuation turn #${turnNumber} of ${maxTurns}.
`;
  }

  return buildContinuationPrompt(turnNumber, maxTurns, trackerKind);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function issueToTemplateContext(issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description ?? '',
    priority: issue.priority,
    state: issue.state,
    branch_name: issue.branchName,
    url: issue.url,
    assignee_id: issue.assigneeId,
    labels: issue.labels.join(', '),
    created_at: issue.createdAt?.toISOString() ?? null,
    updated_at: issue.updatedAt?.toISOString() ?? null,
  };
}
