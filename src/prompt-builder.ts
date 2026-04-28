/**
 * 프롬프트 빌더 — WORKFLOW.md의 Liquid 템플릿을 이슈 컨텍스트와 함께 렌더링합니다.
 * elixir/lib/symphony_elixir/prompt_builder.ex 를 미러링합니다.
 */

import { Liquid } from 'liquidjs';
import type { Issue } from './types.js';
import type { StatesConfig } from './config/schema.js';

const engine = new Liquid({ strictVariables: false, strictFilters: false });

export interface PromptExtras {
  trackerKind?: string;
  repositoryKind?: string;
  states?: StatesConfig;
  /** 이슈 작업의 base 브랜치 (hotfix → prod_branch, 일반 → dev_branch). */
  baseBranch?: string;
}

/**
 * 이슈 데이터와 함께 Liquid 프롬프트 템플릿을 렌더링합니다.
 *
 * @param template  WORKFLOW.md에서 가져온 Liquid 템플릿 문자열
 * @param issue     렌더링할 이슈
 * @param attempt   턴 번호 (1 = 첫 번째 턴, >1 = 이어서 실행)
 * @param extras    추가 템플릿 변수 (tracker_kind, repository_kind, base_branch)
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
    base_branch: extras?.baseBranch ?? 'main',
  };

  return engine.parseAndRender(template, context);
}

// ---------------------------------------------------------------------------
// 헬퍼
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
    assignee_email: issue.assigneeEmail,
    labels: issue.labels.join(', '),
    created_at: issue.createdAt?.toISOString() ?? null,
    updated_at: issue.updatedAt?.toISOString() ?? null,
  };
}
