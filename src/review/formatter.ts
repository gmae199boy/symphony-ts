/**
 * Format review findings for Slack display.
 *
 * Uses '---' separator between findings to enable chunked splitting
 * when the total message exceeds Slack's 40,000-character limit.
 */

import type { ReviewFinding } from './types.js';

const SEVERITY_LABEL: Record<string, string> = {
  high: '상',
  medium: '중',
  low: '하',
};

export function formatReviewMessage(
  findings: ReviewFinding[],
  agentSummary: string,
): string {
  const highCount = findings.filter((f) => f.severity === 'high').length;
  const medCount = findings.filter((f) => f.severity === 'medium').length;
  const lowCount = findings.filter((f) => f.severity === 'low').length;

  const header = [
    `📋 코드 리뷰 결과 (${agentSummary})`,
    `${findings.length}건 발견 (상 ${highCount} / 중 ${medCount} / 하 ${lowCount})`,
  ].join('\n');

  const body = findings.map((f, i) => {
    const sev = SEVERITY_LABEL[f.severity] ?? f.severity;
    const lines = f.lineStart === f.lineEnd
      ? `${f.lineStart}`
      : `${f.lineStart}-${f.lineEnd}`;

    const parts: string[] = [
      `[${sev}] #${i + 1} ${f.file}:${lines} — ${f.category} (${f.agent})`,
      '',
      f.description,
    ];

    if (f.suggestedFix) {
      parts.push('', `제안: ${f.suggestedFix}`);
    }

    return parts.join('\n');
  }).join('\n---\n');

  const footer = '\n✅ 리액션이나 피드백을 주세요.';

  return [header, '', body, footer].join('\n');
}

/**
 * Build a summary string describing which agents and rounds were used.
 * e.g. "claude 2R + codex 2R → claude 검증"
 */
export function buildAgentSummary(
  agents: string[],
  rounds: number,
  validator: string,
): string {
  const parts = agents.map((a) => `${a} ${rounds}R`);
  return `${parts.join(' + ')} → ${validator} 검증`;
}
