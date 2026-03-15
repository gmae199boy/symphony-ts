# Bitbucket Repository Operations

Use curl + Bitbucket REST API for all Bitbucket operations.

```bash
# Auth header helper (base64 encode email:token)
BB_AUTH=$(echo -n "$BITBUCKET_EMAIL:$BITBUCKET_API_TOKEN" | base64)
BB_BASE="https://api.bitbucket.org/2.0/repositories/$BITBUCKET_WORKSPACE/$BITBUCKET_REPO_SLUG"

# List open PRs
curl -s -H "Authorization: Basic $BB_AUTH" \
  "$BB_BASE/pullrequests?state=OPEN"

# Create a PR
curl -s -X POST -H "Authorization: Basic $BB_AUTH" \
  -H "Content-Type: application/json" \
  "$BB_BASE/pullrequests" \
  -d '{
    "title": "TES-12: short description",
    "source": {"branch": {"name": "TES-12"}},
    "destination": {"branch": {"name": "main"}},
    "description": "PR body"
  }'

# View PR
curl -s -H "Authorization: Basic $BB_AUTH" \
  "$BB_BASE/pullrequests/42"

# Add a comment to a PR
curl -s -X POST -H "Authorization: Basic $BB_AUTH" \
  -H "Content-Type: application/json" \
  "$BB_BASE/pullrequests/42/comments" \
  -d '{"content": {"raw": "comment text"}}'

# List PR comments
curl -s -H "Authorization: Basic $BB_AUTH" \
  "$BB_BASE/pullrequests/42/comments"

# Merge a PR (squash)
curl -s -X POST -H "Authorization: Basic $BB_AUTH" \
  -H "Content-Type: application/json" \
  "$BB_BASE/pullrequests/42/merge" \
  -d '{"merge_strategy": "squash", "close_source_branch": true}'
```

## Authentication

- `BITBUCKET_EMAIL` — Atlassian 계정 이메일
- `BITBUCKET_API_TOKEN` — Bitbucket API Token (https://bitbucket.org/account/settings/api-tokens/)

> **Note:** App Password 방식은 2025년 9월부터 신규 생성 불가, 2026년 6월 완전 차단 예정.

## Notes

- Bitbucket PRs don't have labels; use branch naming conventions for filtering.
- PR merge uses `squash` strategy by default.
- Use paginated responses (`next` URL) for lists.
- Branch naming: use the issue identifier only (e.g., `TES-12`).
- PR title format: `TES-12: <short description>`.
