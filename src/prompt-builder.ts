/**
 * Prompt builder — renders the Liquid template from WORKFLOW.md with issue context.
 * Mirrors elixir/lib/symphony_elixir/prompt_builder.ex
 */

import { Liquid } from 'liquidjs';
import type { Issue } from './types.js';

const engine = new Liquid({ strictVariables: false, strictFilters: false });

export interface PromptExtras {
  trackerKind?: string;
  repositoryKind?: string;
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
    tracker_kind: extras?.trackerKind ?? 'linear',
    repository_kind: extras?.repositoryKind ?? 'github',
  };

  return engine.parseAndRender(template, context);
}

/**
 * Returns the standard continuation prompt for turns > 1 when no custom
 * template continuation logic is present.
 */
export function buildContinuationPrompt(turnNumber: number, maxTurns: number): string {
  return `Continuation guidance:

- The previous agent turn completed normally, but the Linear issue is still in an active state.
- This is continuation turn #${turnNumber} of ${maxTurns} for the current agent run.
- Resume from the current workspace and workpad state instead of restarting from scratch.
- The original task instructions and prior turn context are already present in this thread, so do not restate them before acting.
- Focus on the remaining ticket work and do not end the turn while the issue stays active unless you are truly blocked.
`;
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
