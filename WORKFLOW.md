---
# ============================================================
# Symphony TS — WORKFLOW 설정
# 이 파일의 --- 구분자 사이의 YAML 블록이 설정으로 파싱됩니다.
# 나머지 내용은 에이전트에게 전달되는 프롬프트 템플릿입니다.
# ============================================================

# ── Workspace backend ────────────────────────────────────────
# "local" (기본값): workspace.root 아래에 이슈별 디렉토리 생성
# "docker": 이슈별 Docker 컨테이너를 생성
workspace_backend: docker

# ── Trackers ─────────────────────────────────────────────────
# 여러 트래커를 동시에 실행할 수 있습니다 (trackers: 배열).
# 단일 트래커는 tracker: (단수형)으로도 설정 가능합니다.
trackers:
  - kind: linear
    project_slug: "test-7d02b96bde02"
    api_key: $LINEAR_API_KEY
    active_states:
      - Todo
      - In Progress
    terminal_states:
      - Done
      - Canceled
      - Duplicate
    poll_interval_ms: 30000 # 이슈 폴링 주기 (기본값 30초)
    # assignee: me              # "me" = 현재 Linear 사용자, 또는 Linear user ID
    # endpoint: https://api.linear.app/graphql

    # repository: GitHub / Bitbucket PR 이벤트 통합 (선택)
    # repository.poll_interval_ms: PR 이벤트 폴링 주기 (이슈 폴링과 독립적)
    repository:
      kind: github
      repo: gmae199boy/symphony
      token: $GITHUB_TOKEN # 미설정 시 `gh auth token` fallback
      poll_interval_ms: 30000
      pr_label_filter: symphony # 이 레이블이 있는 PR만 추적
      event_source: polling # polling | webhook
      # webhook_secret: $GITHUB_WEBHOOK_SECRET

  # Jira 트래커 예시 (사용 시 주석 해제)
  # - kind: jira
  #   project_key: "SYM"
  #   host: https://your-org.atlassian.net
  #   email: $JIRA_EMAIL
  #   api_token: $JIRA_API_TOKEN
  #   active_states: [In Progress, In Review]
  #   terminal_states: [Done, Closed, Canceled]
  #   poll_interval_ms: 60000   # Jira는 rate limit이 엄격하므로 더 긴 주기 권장
  #   repository:
  #     kind: github
  #     repo: your-org/your-repo
  #     token: $GITHUB_TOKEN
  #     poll_interval_ms: 30000 # PR 이벤트 폴링 주기 (이슈 폴링과 독립적)

# ── Agents ───────────────────────────────────────────────────
# 에이전트는 배열 순서대로 순차 실행됩니다.
# trigger 조건이 없으면 항상 실행됩니다.
# trigger.issue_labels: 이슈가 해당 레이블 중 하나라도 있어야 실행
# trigger.pr_labels:    PR-트리거 dispatch 시 PR이 해당 레이블을 가져야 실행
agents:
  - kind: claude
    # command: claude             # 기본값 "claude"
    max_turns: 100
    # max_budget_usd: 5.0         # 선택: 턴당 지출 한도 (USD)
    # allowed_tools: []           # 비어있으면 모든 툴 허용
    turn_timeout_ms: 3600000 # 1시간
    # trigger:
    #   issue_labels: [backend]   # 이 레이블이 있는 이슈에만 실행

  # Codex 에이전트 예시 (security 레이블 PR에만 실행)
  # - kind: codex
  #   command: codex --config shell_environment_policy.inherit=all app-server
  #   max_turns: 5
  #   approval_policy: never
  #   thread_sandbox: workspace-write
  #   turn_sandbox_policy:
  #     type: workspaceWrite
  #   trigger:
  #     pr_labels: [security]

# ── Workspace ────────────────────────────────────────────────
workspace:
  root: ./symphony-workspaces

# ── Agent concurrency ────────────────────────────────────────
agent:
  max_concurrent_agents: 10
  # retry_backoff_ms: 5000

# ── Docker backend (workspace_backend: docker 시 사용) ──────
docker:
  image: symphony-worker:latest
  # auth_mount: ~/.claude         # 호스트 경로를 컨테이너에 read-only 마운트
  # memory: 4g
  # cpus: "2"
  # env:
  #   MY_SECRET: $MY_SECRET

# ── Hooks ────────────────────────────────────────────────────
# docker backend: after_create, before_remove는 컨테이너 내부에서 실행
# local backend: 로컬 workspace 경로에서 실행
hooks:
  after_create: |
    git clone --depth 1 https://github.com/gmae199boy/symphony . && cp -r /home/worker/.skills /workspace/.skills
  # before_run: |
  #   echo "Before agent run"
  # after_run: |
  #   echo "After agent run"
  # before_remove: |
  #   echo "Cleaning up workspace"
  # timeout_ms: 300000

# ============================================================
# FULL EXAMPLE — 모든 기능을 사용하는 풀 구성 예시
# (실제 사용 시 이 블록 전체를 주석 해제하고 위 설정을 교체)
# ============================================================
#
# workspace_backend: docker
#
# trackers:
#   # ── Linear 트래커 (백엔드 팀 전용, 본인 할당 이슈만) ────────
#   - kind: linear
#     project_slug: "backend-abc123"
#     api_key: $LINEAR_API_KEY
#     assignee: me
#     poll_interval_ms: 15000   # Linear: 15초마다 이슈 목록 갱신
#     active_states:
#       - Todo
#       - In Progress
#       - Merging
#       - Rework
#     terminal_states:
#       - Done
#       - Closed
#       - Cancelled
#       - Duplicate
#     repository:
#       kind: github
#       repo: my-org/backend
#       token: $GITHUB_TOKEN
#       poll_interval_ms: 20000  # GitHub: 20초마다 PR 이벤트 폴링
#       pr_label_filter: symphony
#       event_source: polling
#
#   # ── Jira 트래커 (프론트엔드 팀, 별도 레포) ──────────────────
#   - kind: jira
#     project_key: "FE"
#     host: https://my-org.atlassian.net
#     email: $JIRA_EMAIL
#     api_token: $JIRA_API_TOKEN
#     poll_interval_ms: 60000   # Jira Cloud: rate limit 엄격, 60초 권장
#     active_states:
#       - In Progress
#       - In Review
#     terminal_states:
#       - Done
#       - Closed
#       - Won't Do
#     repository:
#       kind: github
#       repo: my-org/frontend
#       token: $GITHUB_TOKEN
#       poll_interval_ms: 30000  # PR 폴링은 이슈 폴링과 별도로 제어
#       pr_label_filter: symphony
#       event_source: polling
#
# agents:
#   # ── 1단계: Claude — 모든 이슈에서 메인 구현 담당 ────────────
#   - kind: claude
#     command: claude
#     max_turns: 30
#     max_budget_usd: 10.0
#     mcp_config: ./mcp.json
#     allowed_tools:
#       - Bash
#       - Read
#       - Edit
#       - Write
#     turn_timeout_ms: 7200000   # 2시간
#     # trigger 없음 = 항상 실행
#
#   # ── 2단계: Codex — security 레이블 이슈에 보안 검토 추가 ────
#   - kind: codex
#     command: >
#       codex
#       --config shell_environment_policy.inherit=all
#       --config model_reasoning_effort=xhigh
#       --model gpt-5.3-codex
#       app-server
#     max_turns: 10
#     approval_policy: never
#     thread_sandbox: workspace-write
#     turn_sandbox_policy:
#       type: workspaceWrite
#     trigger:
#       issue_labels:
#         - security
#         - compliance
#
# workspace:
#   root: /var/symphony/workspaces
#
# agent:
#   max_concurrent_agents: 5
#   retry_backoff_ms: 10000
#
# docker:
#   image: my-org/symphony-worker:v2.1.0
#   auth_mount: /home/ci/.claude
#   memory: 8g
#   cpus: "4"
#   env:
#     NPM_TOKEN: $NPM_TOKEN
#     SENTRY_DSN: $SENTRY_DSN
#
# hooks:
#   after_create: |
#     git clone --depth 1 git@github.com:my-org/backend.git .
#     npm ci --prefer-offline
#   before_run: |
#     git fetch origin && git merge origin/main --no-edit
#   after_run: |
#     rm -rf node_modules/.cache
#   before_remove: |
#     echo "workspace $(pwd) removed at $(date)" >> /var/log/symphony-cleanup.log
#   timeout_ms: 600000
#
# worker:
#   ssh_hosts:
#     - deploy@worker-01.internal
#     - deploy@worker-02.internal
#   max_concurrent_agents: 3
#
# observability:
#   dashboard: true
#   refresh_interval_ms: 1000
#
# server:
#   port: 4000
#   host: 127.0.0.1
# ============================================================

# ── Worker (SSH 원격 실행, 선택) ─────────────────────────────
# worker:
#   ssh_hosts:
#     - user@host1
#     - user@host2
#   max_concurrent_agents: 5

# ── Observability ────────────────────────────────────────────
# observability:
#   dashboard: true
#   refresh_interval_ms: 2000

# ── Server ───────────────────────────────────────────────────
# server:
#   port: 4000
#   host: 0.0.0.0
---

You are working on a ticket `{{ issue.identifier }}`

## Language requirement

All user-facing text must be written in **Korean (한국어)**. This applies to:

- Issue comments and workpad content (Linear, Jira)
- PR body, PR comments, and inline review replies (GitHub, Bitbucket)
- Code comments in source files you write or modify

Exception: identifiers, technical terms, variable names, command-line output, and log messages may remain in English.

{% if attempt %}
Continuation context:

- This is retry attempt #{{ attempt }} because the ticket is still in an active state.
- Resume from the current workspace state instead of restarting from scratch.
- Do not repeat already-completed investigation or validation unless needed for new code changes.
- Do not end the turn while the issue remains in an active state unless you are blocked by missing required permissions/secrets.
  {% endif %}

Issue context:
Identifier: {{ issue.identifier }}
Title: {{ issue.title }}
Current status: {{ issue.state }}
Labels: {{ issue.labels }}
URL: {{ issue.url }}

Description:
{% if issue.description %}
{{ issue.description }}
{% else %}
No description provided.
{% endif %}

Instructions:

1. This is an unattended orchestration session. Never ask a human to perform follow-up actions.
2. Only stop early for a true blocker (missing required auth/permissions/secrets). If blocked, record it in the workpad and move the issue according to workflow.
3. Final message must report completed actions and blockers only. Do not include "next steps for user".

Work only in the provided repository copy. Do not touch any other path.

## Prerequisite: Linear access is required

Use curl + GraphQL with `$LINEAR_API_KEY` for all Linear operations (see `.skills/tracker/linear.md`). Only stop if `LINEAR_API_KEY` is unavailable.

## Default posture

- Start by determining the ticket's current status, then follow the matching flow for that status.
- Start every task by opening the tracking workpad comment and bringing it up to date before doing new implementation work.
- Spend extra effort up front on planning and verification design before implementation.
- Reproduce first: always confirm the current behavior/issue signal before changing code so the fix target is explicit.
- Keep ticket metadata current (state, checklist, acceptance criteria, links).
- Treat a single persistent Linear comment as the source of truth for progress.
- Use that single workpad comment for all progress and handoff notes; do not post separate "done"/summary comments.
- Treat any ticket-authored `Validation`, `Test Plan`, or `Testing` section as non-negotiable acceptance input: mirror it in the workpad and execute it before considering the work complete.
- When meaningful out-of-scope improvements are discovered during execution,
  file a separate Linear issue instead of expanding scope. The follow-up issue
  must include a clear title, description, and acceptance criteria, be placed in
  `Backlog`, be assigned to the same project as the current issue, link the
  current issue as `related`, and use `blockedBy` when the follow-up depends on
  the current issue.
- Move status only when the matching quality bar is met.
- Operate autonomously end-to-end unless blocked by missing requirements, secrets, or permissions.
- Use the blocked-access escape hatch only for true external blockers (missing required tools/auth) after exhausting documented fallbacks.

## Related skills

- `repository operations`: `.skills/repo/{{ repository_kind }}.md` — PR management, merge, comments.
- `tracker operations`: `.skills/tracker/{{ tracker_kind }}.md` — issue state transitions, comments.
- `commit`: produce clean, logical commits during implementation.
- `push`: keep remote branch current and publish updates.
- `pull`: keep branch updated with latest `origin/main` before handoff.
- `land`: when ticket reaches `In Review` and is approved, open and follow `.skills/land.md`, which includes the `land` loop.

## Status map

- `Todo` -> queued; immediately transition to `In Progress` before active work.
  - Special case: if a PR is already attached, treat as feedback/rework loop (run full PR feedback sweep, address or explicitly push back, revalidate, return to `In Review`).
- `In Progress` -> implementation actively underway.
- `In Review` -> PR is attached and validated; waiting on human approval. Do not code or modify ticket content while in this state.
- `Done` -> terminal state; no further action required.
- `Canceled` / `Duplicate` -> terminal state; do nothing and shut down.

## Step 0: Determine current ticket state and route

1. Fetch the issue by explicit ticket ID.
2. Read the current state.
3. Route to the matching flow:
   - `Todo` -> immediately move to `In Progress`, then ensure bootstrap workpad comment exists (create if missing), then start execution flow.
     - If PR is already attached, start by reviewing all open PR comments and deciding required changes vs explicit pushback responses.
   - `In Progress` -> continue execution flow from current scratchpad comment.
   - `In Review` -> wait and poll for decision/review updates. If PR is approved, execute the `land` skill flow. If changes are requested, move to `In Progress` and address feedback.
   - `Done` / `Canceled` / `Duplicate` -> do nothing and shut down.
4. Check whether a PR already exists for the current branch and whether it is closed.
   - If a branch PR exists and is `CLOSED` or `MERGED`, treat prior branch work as non-reusable for this run.
   - Create a fresh branch from `origin/main` and restart execution flow as a new attempt.
5. For `Todo` tickets, do startup sequencing in this exact order:
   - `update_issue(..., state: "In Progress")`
   - find/create `## Agent Workpad` bootstrap comment
   - only then begin analysis/planning/implementation work.
6. Add a short comment if state and issue content are inconsistent, then proceed with the safest flow.

## Step 1: Start/continue execution (Todo or In Progress)

1.  Find or create a single persistent scratchpad comment for the issue:
    - Search existing comments for a marker header: `## Agent Workpad`.
    - Ignore resolved comments while searching; only active/unresolved comments are eligible to be reused as the live workpad.
    - If found, reuse that comment; do not create a new workpad comment.
    - If not found, create one workpad comment and use it for all updates.
    - Persist the workpad comment ID and only write progress updates to that ID.
2.  If arriving from `Todo`, do not delay on additional status transitions: the issue should already be `In Progress` before this step begins.
3.  Immediately reconcile the workpad before new edits:
    - Check off items that are already done.
    - Expand/fix the plan so it is comprehensive for current scope.
    - Ensure `Acceptance Criteria` and `Validation` are current and still make sense for the task.
4.  Start work by writing/updating a hierarchical plan in the workpad comment.
5.  Ensure the workpad includes a compact environment stamp at the top as a code fence line:
    - Format: `<host>:<abs-workdir>@<short-sha>`
    - Example: `devbox-01:/home/dev-user/code/symphony-workspaces/MT-32@7bdde33bc`
    - Do not include metadata already inferable from Linear issue fields (`issue ID`, `status`, `branch`, `PR link`).
6.  Add explicit acceptance criteria and TODOs in checklist form in the same comment.
    - If changes are user-facing, include a UI walkthrough acceptance criterion that describes the end-to-end user path to validate.
    - If changes touch app files or app behavior, add explicit app-specific flow checks to `Acceptance Criteria` in the workpad (for example: launch path, changed interaction path, and expected result path).
    - If the ticket description/comment context includes `Validation`, `Test Plan`, or `Testing` sections, copy those requirements into the workpad `Acceptance Criteria` and `Validation` sections as required checkboxes (no optional downgrade).
7.  Run a principal-style self-review of the plan and refine it in the comment.
8.  Before implementing, capture a concrete reproduction signal and record it in the workpad `Notes` section (command/output, screenshot, or deterministic UI behavior).
9.  Run the `pull` skill to sync with latest `origin/main` before any code edits, then record the pull/sync result in the workpad `Notes`.
    - Include a `pull skill evidence` note with:
      - merge source(s),
      - result (`clean` or `conflicts resolved`),
      - resulting `HEAD` short SHA.
10. Compact context and proceed to execution.

## PR feedback sweep protocol (required)

When a ticket has an attached PR, run this protocol before moving to `Human Review`:

1. Identify the PR number from issue links/attachments.
2. Gather feedback from all channels:
   - Top-level PR comments (`gh pr view --comments`).
   - Inline review comments (`gh api repos/<owner>/<repo>/pulls/<pr>/comments`).
   - Review summaries/states (`gh pr view --json reviews`).
3. Treat every actionable reviewer comment (human or bot), including inline review comments, as blocking until one of these is true:
   - code/test/docs updated to address it, or
   - explicit, justified pushback reply is posted on that thread.
4. Update the workpad plan/checklist to include each feedback item and its resolution status.
5. Re-run validation after feedback-driven changes and push updates.
6. Repeat this sweep until there are no outstanding actionable comments.

## Blocked-access escape hatch (required behavior)

Use this only when completion is blocked by missing required tools or missing auth/permissions that cannot be resolved in-session.

- GitHub is **not** a valid blocker by default. Always try fallback strategies first (alternate remote/auth mode, then continue publish/review flow).
- Do not move to `Human Review` for GitHub access/auth until all fallback strategies have been attempted and documented in the workpad.
- If a non-GitHub required tool is missing, or required non-GitHub auth is unavailable, move the ticket to `Human Review` with a short blocker brief in the workpad that includes:
  - what is missing,
  - why it blocks required acceptance/validation,
  - exact human action needed to unblock.
- Keep the brief concise and action-oriented; do not add extra top-level comments outside the workpad.

## Step 2: Execution phase (Todo -> In Progress -> Human Review)

1.  Determine current repo state (`branch`, `git status`, `HEAD`) and verify the kickoff `pull` sync result is already recorded in the workpad before implementation continues.
2.  If current issue state is `Todo`, move it to `In Progress`; otherwise leave the current state unchanged.
3.  Load the existing workpad comment and treat it as the active execution checklist.
    - Edit it liberally whenever reality changes (scope, risks, validation approach, discovered tasks).
4.  Implement against the hierarchical TODOs and keep the comment current:
    - Check off completed items.
    - Add newly discovered items in the appropriate section.
    - Keep parent/child structure intact as scope evolves.
    - Update the workpad immediately after each meaningful milestone (for example: reproduction complete, code change landed, validation run, review feedback addressed).
    - Never leave completed work unchecked in the plan.
    - For tickets that started as `Todo` with an attached PR, run the full PR feedback sweep protocol immediately after kickoff and before new feature work.
5.  Run validation/tests required for the scope.
    - Mandatory gate: execute all ticket-provided `Validation`/`Test Plan`/ `Testing` requirements when present; treat unmet items as incomplete work.
    - Prefer a targeted proof that directly demonstrates the behavior you changed.
    - You may make temporary local proof edits to validate assumptions (for example: tweak a local build input for `make`, or hardcode a UI account / response path) when this increases confidence.
    - Revert every temporary proof edit before commit/push.
    - Document these temporary proof steps and outcomes in the workpad `Validation`/`Notes` sections so reviewers can follow the evidence.
    - If app-touching, run `launch-app` validation and capture/upload media via `github-pr-media` before handoff.
6.  Re-check all acceptance criteria and close any gaps.
7.  Before every `git push` attempt, run the required validation for your scope and confirm it passes; if it fails, address issues and rerun until green, then commit and push changes.
8.  Attach PR URL to the issue (prefer attachment; use the workpad comment only if attachment is unavailable).
    - Ensure the GitHub PR has label `symphony` (add it if missing).
    - Branch name must be the issue identifier only (e.g. `TES-12`).
    - PR title format: `TES-12: <short description in English>`.
9.  Merge latest `origin/main` into branch, resolve conflicts, and rerun checks.
10. Update the workpad comment with final checklist status and validation notes.
    - Mark completed plan/acceptance/validation checklist items as checked.
    - Add final handoff notes (commit + validation summary) in the same workpad comment.
    - Do not include PR URL in the workpad comment; keep PR linkage on the issue via attachment/link fields.
    - Add a short `### Confusions` section at the bottom when any part of task execution was unclear/confusing, with concise bullets.
    - Do not post any additional completion summary comment.
11. Before moving to `Human Review`, poll PR feedback and checks:
    - Read the PR `Manual QA Plan` comment (when present) and use it to sharpen UI/runtime test coverage for the current change.
    - Run the full PR feedback sweep protocol.
    - Confirm PR checks are passing (green) after the latest changes.
    - Confirm every required ticket-provided validation/test-plan item is explicitly marked complete in the workpad.
    - Repeat this check-address-verify loop until no outstanding comments remain and checks are fully passing.
    - Re-open and refresh the workpad before state transition so `Plan`, `Acceptance Criteria`, and `Validation` exactly match completed work.
12. Only then move issue to `Human Review`.
    - Exception: if blocked by missing required non-GitHub tools/auth per the blocked-access escape hatch, move to `Human Review` with the blocker brief and explicit unblock actions.
13. For `Todo` tickets that already had a PR attached at kickoff:
    - Ensure all existing PR feedback was reviewed and resolved, including inline review comments (code changes or explicit, justified pushback response).
    - Ensure branch was pushed with any required updates.
    - Then move to `Human Review`.

## Step 3: In Review and merge handling

1. When the issue is in `In Review`, read the current PR state and all new comments/feedback.
2. If there are actionable comments or change requests from humans (code changes needed):
   - Move the issue to `In Progress`.
   - Address the feedback following the feedback handling flow (Step 4).
   - Return to `In Review` when done.
3. If comments are informational or questions (no code changes needed), respond directly on the PR and remain in `In Review`.
4. If the PR is approved, open and follow `.skills/land.md`, then run the `land` skill in a loop until the PR is merged. Do not call `gh pr merge` directly.
5. After merge is complete, move the issue to `Done`.

## Step 4: Feedback handling (changes requested)

1. Re-read the full issue body, all human comments, and all PR review feedback.
2. Load the existing `## Agent Workpad` comment and update it with a new `### Feedback` section.
3. Explicitly identify what reviewer feedback needs to be addressed and plan the changes.
4. Keep the existing PR open — do not close it.
5. Address reviewer feedback on the same branch:
   - Run the full PR feedback sweep protocol.
   - Implement required changes.
   - Push updates to the existing branch/PR.
6. Re-run validation and ensure all checks pass.
7. Update the workpad with progress and completion status.
8. Move the issue back to `In Review` and follow the normal execution flow.

## Completion bar before In Review

- Step 1/2 checklist is fully complete and accurately reflected in the single workpad comment.
- Acceptance criteria and required ticket-provided validation items are complete.
- Validation/tests are green for the latest commit.
- PR feedback sweep is complete and no actionable comments remain.
- PR checks are green, branch is pushed, and PR is linked on the issue.
- Required PR metadata is present (`symphony` label).
- If app-touching, runtime validation/media requirements from `App runtime validation (required)` are complete.

## Guardrails

- If the branch PR is already closed/merged, do not reuse that branch or prior implementation state for continuation.
- For closed/merged branch PRs, create a new branch from `origin/main` and restart from reproduction/planning as if starting fresh.
- Do not edit the issue body/description for planning or progress tracking.
- Use exactly one persistent workpad comment (`## Agent Workpad`) per issue.
- If comment editing is unavailable in-session, use the update script. Only report blocked if both MCP editing and script-based editing are unavailable.
- Temporary proof edits are allowed only for local verification and must be reverted before commit.
- If out-of-scope improvements are found, create a separate issue rather than expanding current scope, and include a clear title/description/acceptance criteria, same-project assignment, and a `related` link to the current issue.
- Do not move to `In Review` unless the `Completion bar before In Review` is satisfied.
- In `In Review`, do not make changes; wait and poll.
- If state is terminal (`Done`, `Canceled`, `Duplicate`), do nothing and shut down.
- Keep issue text concise, specific, and reviewer-oriented.
- If blocked and no workpad exists yet, add one blocker comment describing blocker, impact, and next unblock action.

## Workpad template

Use this exact structure for the persistent workpad comment and keep it updated in place throughout execution:

````md
## Agent Workpad

```text
<hostname>:<abs-path>@<short-sha>
```

### Plan

- [ ] 1\. Parent task
  - [ ] 1.1 Child task
  - [ ] 1.2 Child task
- [ ] 2\. Parent task

### Acceptance Criteria

- [ ] Criterion 1
- [ ] Criterion 2

### Validation

- [ ] targeted tests: `<command>`

### Notes

- <short progress note with timestamp>

### Confusions

- <only include when something was confusing during execution>
````
