# Bitbucket Repository Operations

Use curl + Bitbucket REST API for all Bitbucket operations.

```bash
# Bearer 인증 (토큰만 사용, 이메일 불필요)
BB_BASE="https://api.bitbucket.org/2.0/repositories/$BITBUCKET_WORKSPACE/$BITBUCKET_REPO_SLUG"

# List open PRs
curl -s -H "Authorization: Bearer $BITBUCKET_API_TOKEN" \
  -H "Accept: application/json" \
  "$BB_BASE/pullrequests?state=OPEN"

# Create a PR
curl -s -X POST -H "Authorization: Bearer $BITBUCKET_API_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  "$BB_BASE/pullrequests" \
  -d '{
    "title": "TES-12: short description",
    "source": {"branch": {"name": "TES-12"}},
    "destination": {"branch": {"name": "main"}},
    "description": "PR body"
  }'

# View PR
curl -s -H "Authorization: Bearer $BITBUCKET_API_TOKEN" \
  -H "Accept: application/json" \
  "$BB_BASE/pullrequests/42"

# Add a comment to a PR
curl -s -X POST -H "Authorization: Bearer $BITBUCKET_API_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  "$BB_BASE/pullrequests/42/comments" \
  -d '{"content": {"raw": "comment text"}}'

# List PR comments
curl -s -H "Authorization: Bearer $BITBUCKET_API_TOKEN" \
  -H "Accept: application/json" \
  "$BB_BASE/pullrequests/42/comments"

# Merge a PR (squash)
curl -s -X POST -H "Authorization: Bearer $BITBUCKET_API_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  "$BB_BASE/pullrequests/42/merge" \
  -d '{"merge_strategy": "squash", "close_source_branch": true}'
```

## Authentication

- **Bitbucket API 토큰(개인)**: Basic 인증. `BITBUCKET_EMAIL`(Atlassian 계정 이메일) + `BITBUCKET_API_TOKEN` → `Authorization: Basic base64(email:token)`.
- **워크스페이스 토큰**: Bearer 인증. `Authorization: Bearer $BITBUCKET_API_TOKEN`. 이 경우 `BITBUCKET_EMAIL` 불필요.
- `BITBUCKET_API_TOKEN` — Bitbucket Personal settings → API tokens에서 발급, 또는 워크스페이스 Access tokens. 권한: Repository read, Pull requests 등.

### 401 "Token is invalid, expired, or not supported" 시

- **API 토큰 사용 시**: `BITBUCKET_EMAIL`(Atlassian 계정 이메일)을 반드시 설정했는지 확인. 이 토큰은 Bearer가 아니라 Basic(이메일:토큰)만 지원함.
- **토큰**: Bitbucket에서 발급한 토큰인지 확인 (Jira/Atlassian Account API 토큰은 Bitbucket API에서 사용 불가).
- **만료·권한**: 토큰 만료일, Repository read / Pull requests 등 필요한 권한 부여 여부 확인.

## Notes

- Bitbucket PRs don't have labels; use branch naming conventions for filtering.
- PR merge uses `squash` strategy by default.
- Use paginated responses (`next` URL) for lists.
- Branch naming: use the issue identifier only (e.g., `TES-12`).
- PR title format: `TES-12: <short description>`.
