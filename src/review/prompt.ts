/**
 * Prompt builders for self-review and validation agents.
 */

// ---------------------------------------------------------------------------
// Review prompt (per-agent, per-round)
// ---------------------------------------------------------------------------

export function buildReviewPrompt(
  diff: string,
  previousResults: string[],
  round: number,
  totalRounds: number,
): string {
  const parts: string[] = [];

  parts.push(`You are a code reviewer. Analyze the following diff and find bugs, dangerous code, edge cases, and potential issues.

Focus ONLY on the changed/added code in the diff. Do not review unchanged code.

<diff>
${diff}
</diff>
`);

  if (previousResults.length > 0) {
    parts.push(`The following issues have already been found in previous rounds. DO NOT repeat these — find NEW issues in DIFFERENT areas:

<previous_findings>
${previousResults.join('\n---\n')}
</previous_findings>
`);
  }

  parts.push(`This is round ${round} of ${totalRounds}.

Write your review in Korean. Be specific: cite file names and line numbers.
If no issues are found, explicitly state "리뷰 결과 문제가 발견되지 않았습니다."
Do not wrap your response in code blocks or JSON.`);

  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Validation prompt (merge + dedup + false-positive filter)
// ---------------------------------------------------------------------------

export function buildValidationPrompt(
  diff: string,
  allResults: string[],
): string {
  return `You are a senior code reviewer. Multiple review rounds produced the following findings. Merge duplicates, remove false positives, and produce a single consolidated review.

<diff>
${diff}
</diff>

<reviews>
${allResults.map((r, i) => `--- Round ${i + 1} ---\n${r}`).join('\n\n')}
</reviews>

Output a single consolidated review in Korean. Be specific: cite file names and line numbers.
If all findings are false positives, state "리뷰 결과 문제가 발견되지 않았습니다."
Do not wrap your response in code blocks or JSON.

End with: "✅ 리액션이나 피드백을 주세요."`;
}
