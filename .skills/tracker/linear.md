# Linear Tracker Operations

Use curl + GraphQL for all Linear operations.

```bash
# Fetch issue by identifier
curl -s -X POST https://api.linear.app/graphql \
  -H "Content-Type: application/json" \
  -H "Authorization: $LINEAR_API_KEY" \
  -d '{"query": "{ issue(id: \"TES-7\") { id identifier title state { id name } team { states { nodes { id name } } } } }"}'

# Update issue state (requires state UUID)
# Step 1: get state ID from the issue's team
curl -s -X POST https://api.linear.app/graphql \
  -H "Content-Type: application/json" \
  -H "Authorization: $LINEAR_API_KEY" \
  -d '{"query": "{ issue(id: \"issue-uuid\") { team { states { nodes { id name } } } } }"}'

# Step 2: update state
curl -s -X POST https://api.linear.app/graphql \
  -H "Content-Type: application/json" \
  -H "Authorization: $LINEAR_API_KEY" \
  -d '{"query": "mutation { issueUpdate(id: \"issue-uuid\", input: { stateId: \"state-uuid\" }) { success } }"}'

# Create a comment
curl -s -X POST https://api.linear.app/graphql \
  -H "Content-Type: application/json" \
  -H "Authorization: $LINEAR_API_KEY" \
  -d '{"query": "mutation { commentCreate(input: { issueId: \"issue-uuid\", body: \"text\" }) { success } }"}'

# Update an existing comment
curl -s -X POST https://api.linear.app/graphql \
  -H "Content-Type: application/json" \
  -H "Authorization: $LINEAR_API_KEY" \
  -d '{"query": "mutation { commentUpdate(id: \"comment-uuid\", input: { body: \"updated text\" }) { success } }"}'

# Attach PR URL to issue
curl -s -X POST https://api.linear.app/graphql \
  -H "Content-Type: application/json" \
  -H "Authorization: $LINEAR_API_KEY" \
  -d '{"query": "mutation { attachmentLinkGitHubPR(issueId: \"issue-uuid\", url: \"https://github.com/...\") { success } }"}'
```

## Notes

- Linear uses workflow state IDs (UUIDs), not state names, for mutations.
- To transition an issue, first resolve the state name → state ID via the issue's team.
- Use the `branchName` field from issues for Git operations.
- Issue identifiers follow the `PREFIX-NUMBER` format (e.g., `TES-7`).
