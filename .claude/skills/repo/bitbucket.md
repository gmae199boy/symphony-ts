# Bitbucket Repository Operations

Use curl + Bitbucket REST API for all Bitbucket operations.

## Setup

`BITBUCKET_REPO_SLUG` is not available as an env var (multiple repos may be in use). Always derive it from git remote:

```bash
BITBUCKET_REPO_SLUG=$(git remote get-url origin | sed 's/.*bitbucket\.org\///' | sed 's/\.git$//')
```

## Authentication

Check `$BITBUCKET_EMAIL` first — it determines which auth header to use.

### Case 1: `BITBUCKET_EMAIL` is set → Basic auth (personal API token)

```bash
BB_BASE="https://api.bitbucket.org/2.0/repositories/$BITBUCKET_WORKSPACE/$BITBUCKET_REPO_SLUG"  # BITBUCKET_REPO_SLUG from Setup above
BB_AUTH="Authorization: Basic $(echo -n "$BITBUCKET_EMAIL:$BITBUCKET_API_TOKEN" | base64)"
```

### Case 2: `BITBUCKET_EMAIL` is unset → Bearer auth (workspace/repository access token)

```bash
BB_BASE="https://api.bitbucket.org/2.0/repositories/$BITBUCKET_WORKSPACE/$BITBUCKET_REPO_SLUG"  # BITBUCKET_REPO_SLUG from Setup above
BB_AUTH="Authorization: Bearer $BITBUCKET_API_TOKEN"
```

> If `BITBUCKET_REPO_SLUG` is not set, derive it from git remote:
> ```bash
> git remote get-url origin
> # e.g. https://x-token-auth:TOKEN@bitbucket.org/bkcnc-crypto/test.git → slug is "test"
> ```

## Operations

Use `$BB_AUTH` from whichever case applies above.

```bash
# List open PRs
curl -s -H "$BB_AUTH" -H "Accept: application/json" \
  "$BB_BASE/pullrequests?state=OPEN"

# Create a PR
curl -s -X POST -H "$BB_AUTH" \
  -H "Content-Type: application/json" -H "Accept: application/json" \
  "$BB_BASE/pullrequests" \
  -d '{
    "title": "KAN-4: short description",
    "source": {"branch": {"name": "KAN-4"}},
    "destination": {"branch": {"name": "main"}},
    "description": "PR body"
  }'

# View a PR
curl -s -H "$BB_AUTH" -H "Accept: application/json" \
  "$BB_BASE/pullrequests/42"

# Add a comment to a PR
curl -s -X POST -H "$BB_AUTH" \
  -H "Content-Type: application/json" -H "Accept: application/json" \
  "$BB_BASE/pullrequests/42/comments" \
  -d '{"content": {"raw": "comment text"}}'

# List PR comments
curl -s -H "$BB_AUTH" -H "Accept: application/json" \
  "$BB_BASE/pullrequests/42/comments"

# Merge a PR (squash)
curl -s -X POST -H "$BB_AUTH" \
  -H "Content-Type: application/json" -H "Accept: application/json" \
  "$BB_BASE/pullrequests/42/merge" \
  -d '{"merge_strategy": "squash", "close_source_branch": true}'
```

## Troubleshooting

### 401 "Token is invalid, expired, or not supported"
- Verify auth method matches the token type (Basic vs Bearer).
- Atlassian Account API tokens (used for Jira) are not valid for Bitbucket API.
- Check token expiry and required scopes: Repository read, Pull requests write.

## Notes

- Bitbucket PRs do not have labels; use branch naming conventions for filtering.
- PR merge uses `squash` strategy by default.
- For paginated responses, follow the `next` URL in the response.
- Branch naming: use the issue identifier only (e.g. `KAN-4`).
- PR title format: `KAN-4: <short description>`.
- If a previous PR for the branch is in `DECLINED` state, force-push the branch and create a new PR.
