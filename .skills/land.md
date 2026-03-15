# Land Skill

Merge the current PR cleanly into the main branch and close the tracker issue.

## When to use

Run this skill when the PR is approved by a human reviewer.
Do **not** call `gh pr merge` directly outside this skill.

## Prerequisites

- PR is in `open` state and all checks are green.
- No outstanding review requests or blocking comments.
- Branch is up-to-date with `origin/main` (no conflicts).

## Steps

Refer to the repository-specific skill for exact commands:
- GitHub: `.skills/repo/github.md`
- Bitbucket: `.skills/repo/bitbucket.md`

### 1. Confirm PR status

Check the PR state, mergeability, review status, and check results using the appropriate repository tool.

- State must be open.
- All required checks must pass.
- All review requests must be approved (no changes requested).

### 2. Sync branch with main

```sh
git fetch origin
git merge origin/main
```

- Resolve any conflicts, commit, and push before continuing.
- Re-run checks if new commits were added.

### 3. Merge the PR (squash)

Use the repository-specific merge command with squash strategy.
Delete the feature branch after merge.

### 4. Verify merge

Confirm the PR state is `MERGED` using the repository-specific tool.

### 5. Transition issue to Done

- Move the tracker ticket to `Done` (or equivalent terminal state).
- Update the workpad comment: mark all checklist items as complete, add a `Merged` note with the merge commit SHA.

## Failure handling

- If checks are failing: do **not** merge. Return to `In Progress`, fix the failures, push, and re-enter this skill.
- If conflicts exist: resolve them, push, wait for checks to re-pass, then re-enter this skill.
- If the PR is already merged: skip to step 5 (transition issue to Done).
- If the PR is closed (not merged): move issue to `In Review` with a blocker note explaining the PR was closed without merging.

## Loop

Repeat the land skill until the PR state is merged. On each iteration:
1. Check current PR state.
2. If still open and checks are pending, wait and re-check.
3. If checks fail, exit to `In Progress` for fixes.
4. If merged, finalize and exit.
