# Jira Tracker Operations

Use curl + Jira REST API for all Jira operations.

```bash
# Setup — normalize JIRA_HOST (remove trailing slash)
JIRA_HOST="${JIRA_HOST%/}"

# NOTE: Do NOT fetch issue fields from Jira. Issue context is already provided in the prompt.
# You MAY fetch issue comments (e.g. to find the existing workpad).

# List all comments on an issue (to find existing workpad)
curl -s -u "$JIRA_EMAIL:$JIRA_API_TOKEN" \
  "$JIRA_HOST/rest/api/3/issue/SYM-42/comment?maxResults=100&orderBy=created"

# Get available transitions for an issue
curl -s -u "$JIRA_EMAIL:$JIRA_API_TOKEN" \
  "$JIRA_HOST/rest/api/3/issue/SYM-42/transitions"

# Transition issue to a new state (requires transition ID from above)
curl -s -u "$JIRA_EMAIL:$JIRA_API_TOKEN" -X POST \
  -H "Content-Type: application/json" \
  "$JIRA_HOST/rest/api/3/issue/SYM-42/transitions" \
  -d '{"transition": {"id": "31"}}'

# Add a comment (plain text — Jira Cloud requires ADF format)
curl -s -u "$JIRA_EMAIL:$JIRA_API_TOKEN" -X POST \
  -H "Content-Type: application/json" \
  "$JIRA_HOST/rest/api/3/issue/SYM-42/comment" \
  -d '{
    "body": {
      "type": "doc",
      "version": 1,
      "content": [{"type": "paragraph", "content": [{"type": "text", "text": "comment text"}]}]
    }
  }'

# Update an existing comment
curl -s -u "$JIRA_EMAIL:$JIRA_API_TOKEN" -X PUT \
  -H "Content-Type: application/json" \
  "$JIRA_HOST/rest/api/3/issue/SYM-42/comment/comment-id" \
  -d '{
    "body": {
      "type": "doc",
      "version": 1,
      "content": [{"type": "paragraph", "content": [{"type": "text", "text": "updated text"}]}]
    }
  }'

# NOTE: Do NOT search or fetch issues from Jira. Issue context is already provided in the prompt.
```

## Notes

- Do NOT fetch issue fields from Jira. All issue context (title, description, status, labels) is provided in the prompt.
- You MAY fetch issue comments to find the existing workpad (`## Agent Workpad`).
- Jira uses transitions (not direct state changes). Always fetch available transitions first.
- Jira Cloud comments require Atlassian Document Format (ADF), not plain text.
- Issue identifiers follow the `PREFIX-NUMBER` format (e.g., `SYM-42`).
- Jira Cloud has stricter rate limits; use longer poll intervals.
- `JIRA_HOST` = full base URL (e.g., `https://your-org.atlassian.net`).
