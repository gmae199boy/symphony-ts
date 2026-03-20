/**
 * Prompt builders for self-review and validation agents.
 */

import type { ReviewFinding } from './types.js';

// ---------------------------------------------------------------------------
// Review prompt (per-agent, per-round)
// ---------------------------------------------------------------------------

export function buildReviewPrompt(
  diff: string,
  previousFindings: ReviewFinding[],
  round: number,
  totalRounds: number,
): string {
  const parts: string[] = [];

  parts.push(`You are a code reviewer. Analyze the following diff and find bugs, dangerous code, edge cases, and potential issues.

<diff>
${diff}
</diff>
`);

  if (previousFindings.length > 0) {
    parts.push(`The following issues have already been found in previous rounds. DO NOT repeat these — find NEW issues in DIFFERENT categories:

<previous_findings>
${JSON.stringify(previousFindings.map(f => ({
  file: f.file,
  lineStart: f.lineStart,
  lineEnd: f.lineEnd,
  category: f.category,
  description: f.description,
})), null, 2)}
</previous_findings>
`);
  }

  parts.push(`This is round ${round} of ${totalRounds}.

Output ONLY a JSON array of findings. Each finding must have this exact structure:
[
  {
    "file": "relative/path/to/file.ts",
    "lineStart": 10,
    "lineEnd": 15,
    "severity": "high" | "medium" | "low",
    "category": "string (e.g. race-condition, resource-leak, logic-error, error-handling, security)",
    "description": "Detailed description of the issue, including the problematic code and why it is a problem.",
    "suggestedFix": "Optional: suggested code change or approach to fix."
  }
]

If no issues are found, output an empty array: []
Do not include any text outside the JSON array.`);

  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Validation prompt (merge + dedup + false-positive filter)
// ---------------------------------------------------------------------------

export function buildValidationPrompt(
  diff: string,
  allFindings: ReviewFinding[],
): string {
  return `You are a senior code reviewer validating findings from multiple review agents.

<diff>
${diff}
</diff>

<raw_findings>
${JSON.stringify(allFindings.map(f => ({
  id: `${f.agent}-R${f.round}-${allFindings.indexOf(f) + 1}`,
  file: f.file,
  lineStart: f.lineStart,
  lineEnd: f.lineEnd,
  severity: f.severity,
  category: f.category,
  description: f.description,
  suggestedFix: f.suggestedFix,
  agent: f.agent,
  round: f.round,
})), null, 2)}
</raw_findings>

Your tasks:
1. **Merge duplicates**: Different agents may describe the same issue differently. Merge them into one finding, noting all agents that found it.
2. **Remove false positives**: If a finding is not actually a bug (e.g. intentional design, context-dependent), remove it.
3. **Re-evaluate severity**: Standardize severity across agents.
4. **Preserve detail**: Keep the most detailed description among merged duplicates.

When merging, set the "agent" field to a comma-separated list (e.g. "claude, codex").

Output ONLY a JSON array with the same structure as the input findings.
If all findings are false positives, output an empty array: []
Do not include any text outside the JSON array.`;
}

