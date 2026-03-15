# Jira Tracker Operations

Use curl + Jira REST API for all Jira operations.

```bash
# Auth header helper (base64 encode email:token)
JIRA_AUTH=$(echo -n "$JIRA_EMAIL:$JIRA_API_TOKEN" | base64)

# Fetch issue
curl -s -H "Authorization: Basic $JIRA_AUTH" \
  -H "Content-Type: application/json" \
  "$JIRA_HOST/rest/api/3/issue/SYM-42"

# Get available transitions for an issue
curl -s -H "Authorization: Basic $JIRA_AUTH" \
  "$JIRA_HOST/rest/api/3/issue/SYM-42/transitions"

# Transition issue to a new state (requires transition ID from above)
curl -s -X POST -H "Authorization: Basic $JIRA_AUTH" \
  -H "Content-Type: application/json" \
  "$JIRA_HOST/rest/api/3/issue/SYM-42/transitions" \
  -d '{"transition": {"id": "31"}}'

# Add a comment (plain text — Jira Cloud requires ADF format)
curl -s -X POST -H "Authorization: Basic $JIRA_AUTH" \
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
curl -s -X PUT -H "Authorization: Basic $JIRA_AUTH" \
  -H "Content-Type: application/json" \
  "$JIRA_HOST/rest/api/3/issue/SYM-42/comment/comment-id" \
  -d '{
    "body": {
      "type": "doc",
      "version": 1,
      "content": [{"type": "paragraph", "content": [{"type": "text", "text": "updated text"}]}]
    }
  }'
```

## Notes

- Jira uses transitions (not direct state changes). Always fetch available transitions first.
- Jira Cloud comments require Atlassian Document Format (ADF), not plain text.
- Issue identifiers follow the `PREFIX-NUMBER` format (e.g., `SYM-42`).
- Jira Cloud has stricter rate limits; use longer poll intervals.
- `JIRA_HOST` = full base URL (e.g., `https://your-org.atlassian.net`).
