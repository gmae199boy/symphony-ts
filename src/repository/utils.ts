/**
 * Shared repository utilities — used by both GitHub and Bitbucket clients.
 */

/** Extract issue identifier (e.g. "TES-7", "SYM-42") from branch name or PR body. */
export function extractIssueIdentifier(branchName: string, body: string | null): string | null {
  const pattern = /\b([A-Za-z]+-\d+)\b/;
  for (const source of [branchName, body ?? '']) {
    const m = pattern.exec(source);
    if (m?.[1]) return m[1].toUpperCase();
  }
  return null;
}

/** Detect common bot logins. */
export function isBotLogin(login: string): boolean {
  return (
    login.endsWith('[bot]') ||
    ['github-actions', 'dependabot', 'renovate', 'codecov'].includes(login)
  );
}

/** Parse a date string, returning null on failure. */
export function parseDate(raw: string | null | undefined): Date | null {
  if (!raw) return null;
  const d = new Date(raw);
  return isNaN(d.getTime()) ? null : d;
}
