/**
 * Self-review types — multi-agent code review before PR creation.
 */

export interface ReviewFinding {
  /** Relative file path from workspace root. */
  file: string;
  lineStart: number;
  lineEnd: number;
  severity: 'high' | 'medium' | 'low';
  /** e.g. "race-condition", "resource-leak", "logic-error" */
  category: string;
  /** Detailed description including code context. */
  description: string;
  suggestedFix?: string;
  /** Which agent discovered this finding. */
  agent: string;
  /** Which round within that agent. */
  round: number;
}

export interface ReviewContext {
  /** Findings from previous rounds of the *same* agent (exclusion list). */
  previousFindings: ReviewFinding[];
  round: number;
  totalRounds: number;
}

export interface ReviewBackend {
  review(diff: string, context: ReviewContext): Promise<ReviewFinding[]>;
}
