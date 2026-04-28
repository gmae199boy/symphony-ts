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

/**
 * Slack 사용자향 헤더 전용 — 로그/파일명/브랜치명에는 사용 금지.
 * title이 비어있으면 identifier만 반환한다.
 */
export function formatIssueLabel(issue: Pick<Issue, 'identifier' | 'title'>): string {
  const raw = issue.title.trim();
  if (!raw) return issue.identifier;

  const sanitized = raw
    // control characters → space
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    // Slack mention tokens
    .replace(/<!(?:channel|here|everyone)>/g, '')
    // emoji shortcodes :word:
    .replace(/:[a-z0-9_+\-]+:/g, '')
    // unicode emoji (main blocks: misc symbols, emoticons, pictographs)
    .replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{2300}-\u{23FF}]/gu, '')
    // mrkdwn metacharacters + bracket boundary chars
    .replace(/[*_~`[\]]/g, '')
    // HTML-escape to prevent Slack link injection (&amp; must precede < >)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .trim();

  return sanitized ? `${issue.identifier} (${sanitized})` : issue.identifier;
}
