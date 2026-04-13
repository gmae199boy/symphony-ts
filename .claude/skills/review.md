---
name: self-review
description: 코드 변경 사항에 대한 셀프리뷰 세부 지침.
---

# Self-review skill

## Severity levels (use ONLY these 3 levels)

- **BLOCKER**: Functional bugs, security vulnerabilities, data loss risks — must be fixed before merge.
- **SUGGESTION**: Improvements to code quality, test coverage, error handling, maintainability — recommended but not blocking.
- **NIT**: Minor style, naming, or formatting observations — no code change required.

## Output format (required)

Use the following table format for all findings:

| # | Severity | File | Description |
|---|----------|------|-------------|

If no issues are found, write: "리뷰 결과 문제가 발견되지 않았습니다."

## Review rules

- Run `git diff origin/main...HEAD` to identify changes.
- Focus on changed/added code, but also check consistency with surrounding code patterns, conventions, and naming.
- Write in Korean.
- Include file names and line numbers.
- Do not wrap output in code blocks or JSON.
- End with "✅ 리액션이나 피드백을 주세요."
