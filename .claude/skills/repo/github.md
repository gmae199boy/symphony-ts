# GitHub Repository Operations

Use these tools in order of preference:

## 1. GitHub CLI (`gh`)

```sh
# View PR
gh pr view <PR_NUMBER> --json number,state,mergeable,reviews,statusCheckRollup

# Merge PR (always via land skill)
gh pr merge <PR_NUMBER> --squash --auto --delete-branch

# List PRs
gh pr list --state open --label symphony

# Create PR
# IMPORTANT: set BASE_BRANCH before running the command.
# Use the injected base_branch template variable (hotfix → production branch, regular → development branch).
BASE_BRANCH="{{ base_branch }}"
gh pr create --title "Title" --body "Description" --label symphony --base "$BASE_BRANCH"

# Add label
gh pr edit <PR_NUMBER> --add-label symphony

# View PR comments
gh pr view <PR_NUMBER> --comments

# View inline review comments
gh api repos/<owner>/<repo>/pulls/<PR_NUMBER>/comments
```

## 2. GitHub REST API (via `gh api`)

```sh
# Get PR reviews
gh api repos/<owner>/<repo>/pulls/<PR_NUMBER>/reviews

# Post a comment
gh api repos/<owner>/<repo>/issues/<PR_NUMBER>/comments -f body="comment text"

# Get check runs
gh api repos/<owner>/<repo>/commits/<SHA>/check-runs
```

## Notes

- Always add the `symphony` label to PRs created by Symphony agents.
- Use `--squash` merge strategy by default.
- Never call `gh pr merge` directly outside the `land` skill.
- Branch naming: use the issue identifier only (e.g. `TES-12`).
- PR title format: `TES-12: <short description>` (identifier followed by colon and description).
