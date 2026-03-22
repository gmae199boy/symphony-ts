/**
 * Self-review types — multi-agent code review before PR creation.
 */

export interface ReviewContext {
  /** Text results from previous rounds of the *same* agent (exclusion list). */
  previousResults: string[];
  round: number;
  totalRounds: number;
}

export interface ReviewBackend {
  review(diff: string, context: ReviewContext): Promise<string>;
  validate?(diff: string, allResults: string[]): Promise<string>;
}
