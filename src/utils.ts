import type { Issue } from './types.js';

/** Parse a date string, returning null on failure. */
export function parseDate(raw: string | null | undefined): Date | null {
  if (!raw) return null;
  const d = new Date(raw);
  return isNaN(d.getTime()) ? null : d;
}

/** Structured issue context string for log messages. */
export function issueCtx(issue: Issue): string {
  return `issue_id=${issue.id} issue_identifier=${issue.identifier}`;
}
