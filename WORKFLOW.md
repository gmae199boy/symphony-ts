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
  - kind: jira
    project_key: "KAN"
    host: https://kim88594544.atlassian.net/
    email: $JIRA_EMAIL
    api_token: $JIRA_API_TOKEN
    states:
      planning: 진행 예정
      plan_review: 검토 중
      in_progress: 진행 중
      in_review: 리뷰 중
      done: 완료
      canceled: 취소
    poll_interval_ms: 60000   # Jira는 rate limit이 엄격하므로 더 긴 주기 권장
    repositories:
      - kind: bitbucket
        workspace: bkcnc-crypto          # 또는 $BITBUCKET_WORKSPACE
        repo_slug: test                  # 저장소 slug
        email: $BITBUCKET_EMAIL          # 개인 API 토큰 사용 시 필요 (Basic 인증). 워크스페이스 토큰은 불필요
        api_token: $BITBUCKET_API_TOKEN
        poll_interval_ms: 30000
        event_source: polling
        default: true                    # 멀티레포 시 라벨 매칭 없으면 이 레포로 폴백

# ── Agents ───────────────────────────────────────────────────
agents:
  max_concurrent: 2
  review:
    rounds: 2          # 에이전트당 리뷰 라운드 수
    kinds:             # 병렬로 실행할 리뷰 에이전트 (복수 가능, backends[].kind 참조)
      - claude
  backends:
    - kind: claude
      primary: true
      models:
        planning: opus             # 계획 수립 시 (new_issue, feedback, pr_feedback)
        implementation: sonnet     # 구현 시 (approval ✅ 후)
      turn_timeout_ms: 3600000     # 1시간

# ── Workspace ────────────────────────────────────────────────
# workspace:
#   root: ./symphony-workspaces

# ── Docker backend (workspace_backend: docker 시 사용) ──────
docker:
  image: symphony-worker:latest
  memory: 1g
  cpus: "1"

# ── Slack (계획 승인 워크플로우) ──────────────────────────────
slack:
  bot_token: $SLACK_BOT_TOKEN
  app_token: $SLACK_APP_TOKEN
  channel: $SLACK_CHANNEL_ID


# 모든 기능을 사용하는 풀 구성 예시 → WORKFLOW.example.yml 참조
---

You are working on a ticket `{{ issue.identifier }}`

## Language requirement

All user-facing text must be written in **Korean (한국어)**. This applies to:

- Issue comments and workpad content (Linear, Jira)
- PR body, PR comments, and inline review replies (GitHub, Bitbucket)
- Code comments in source files you write or modify

Exception: identifiers, technical terms, variable names, command-line output, and log messages may remain in English.

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
2. Follow the Status map strictly. Each state has a defined exit point — stopping at that point is normal behavior, not an early exit. Only treat missing auth/permissions/secrets as true blockers.
3. Final message must report completed actions and blockers only. Do not include "next steps for user".

Work only in the provided repository copy. Do not touch any other path.

{% if tracker_kind == 'linear' %}

## Prerequisite: Linear access is required

Use curl + GraphQL with `$LINEAR_API_KEY` for Linear operations: comments, workpad updates (see `.claude/skills/tracker/linear.md`). Do NOT fetch issue fields from Linear — identifier, title, status, description, and labels are already provided above. You MAY fetch issue comments to find the existing workpad. Only stop if `LINEAR_API_KEY` is unavailable.
{% elsif tracker_kind == 'jira' %}

## Prerequisite: Jira access is required

Use curl + REST API with `$JIRA_EMAIL` + `$JIRA_API_TOKEN` for Jira operations: comments, workpad updates (see `.claude/skills/tracker/jira.md`). Do NOT fetch issue fields from Jira — identifier, title, status, description, and labels are already provided above. You MAY fetch issue comments to find the existing workpad. Only stop if credentials are unavailable.
{% endif %}

**Important: Issue state transitions are handled automatically by the orchestrator.** Do NOT call the tracker API to change issue states. Focus on writing output files (`pending_plan.md`, `pr_created.json`, `question.md`) and the orchestrator will detect them and transition states accordingly.

## Default posture

- Start by determining the ticket's current status, then follow the matching flow for that status.
- When in `{{ states.in_progress }}`, start by opening the tracking workpad comment and bringing it up to date before doing new implementation work. Do NOT create the workpad during `{{ states.planning }}` — the workpad is created after plan approval.
- Spend extra effort up front on planning and verification design before implementation.
- Reproduce first: always confirm the current behavior/issue signal before changing code so the fix target is explicit.
- Keep ticket metadata current (state, checklist, acceptance criteria, links).
- Treat a single persistent comment as the source of truth for progress.
- Use that single workpad comment for all progress and handoff notes; do not post separate "done"/summary comments.
- Treat any ticket-authored `Validation`, `Test Plan`, or `Testing` section as non-negotiable acceptance input: mirror it in the workpad and execute it before considering the work complete.
- When meaningful out-of-scope improvements are discovered during execution,
  file a separate issue instead of expanding scope. The follow-up issue
  must include a clear title, description, and acceptance criteria, be placed in
  `Backlog`, be assigned to the same project as the current issue, link the
  current issue as `related`, and use `blockedBy` when the follow-up depends on
  the current issue.
- Move status only when the matching quality bar is met.
- Operate autonomously within each phase defined by the Status map. When the Status map says "exit", stop immediately — the orchestrator handles the next phase.
- When a decision requires human judgement (ambiguous requirements, multiple valid approaches), use the question protocol instead of guessing.
- Use the blocked-access escape hatch only for true external blockers (missing required tools/auth) after exhausting documented fallbacks.
- For complex tasks, decompose work into independent sub-tasks and delegate them in parallel using the `Task` tool. Use sub-agents for: independent file/module changes, parallel research, test writing alongside implementation, and any work that can proceed concurrently. Prefer parallel delegation over sequential execution whenever tasks have no data dependency on each other.

## Sub-agent delegation

Available sub-agents are defined in `.claude/agents/`. Use the Agent tool to delegate specialized work when the task benefits from domain expertise. You may run multiple sub-agents in parallel when tasks are independent. Integrate their results before committing.

## Related skills

- `repository operations`: `.claude/skills/repo/{{ repository_kind }}.md` — PR management, merge, comments.
- `tracker operations`: `.claude/skills/tracker/{{ tracker_kind }}.md` — issue state transitions, comments.
- `commit`: produce clean, logical commits during implementation.
- `push`: keep remote branch current and publish updates.
- `pull`: keep branch updated with latest `origin/main` before handoff.
- `land`: (reserved) PR merge is handled by humans; the orchestrator detects the merge and cleans up automatically.

## Status map

- `{{ states.planning }}` → Based on the issue context provided above, analyze the requirements and write **3 alternative implementation plans**. Each plan must use `## Plan 1`, `## Plan 2`, `## Plan 3` headings and include: approach summary, pros/cons, and estimated scope. Save to `/workspace/.symphony/pending_plan.md` and exit.
  (The orchestrator reads `pending_plan.md`, sends it to Slack, and the user selects a plan by number or gives feedback.)
  - Special case: if the issue is in `{{ states.planning }}` AND a PR is already attached (e.g. issue was moved back to planning after PR rejection), treat as feedback/rework loop — run full PR feedback sweep, address or explicitly push back, revalidate, return to `{{ states.in_review }}`.
- `{{ states.plan_review }}` → The user's message is delivered directly via `--continue -p`.
  If the message indicates plan selection (e.g. "Plan 2가 승인됨") → use the selected plan as the basis, write the Agent Workpad, transition to `{{ states.in_progress }}`, and start implementation.
  If the message selects a specific plan AND requests modifications (e.g. "1번으로 하겠다. 그런데 X를 Y로 바꿔줘") → apply the modifications to that plan only, save the single revised plan to `pending_plan.md`, and exit. Do NOT present 3 plans again.
  Otherwise (general feedback, no plan selected) → revise the plan(s), save to `pending_plan.md`, and exit. Do NOT implement.
- `{{ states.in_progress }}` → Implement and commit. Do NOT push or create a PR — the orchestrator pushes the branch, runs self-review, and handles PR creation after review approval.
- `{{ states.in_review }}` (PR code review, waiting for human) → Exit and wait. The orchestrator monitors for:
  - **New comments/change requests** → re-dispatched with `pr_feedback.json` → read feedback, write 3 alternative plans to `pending_plan.md`, transition to `{{ states.plan_review }}`, exit.
  - **PR merged** → orchestrator transitions to `{{ states.done }}`, deletes branch, cleans up workspace (no agent action).
- `{{ states.done }}`{% if states.canceled %} / `{{ states.canceled }}`{% endif %} → Terminal state. Do nothing and exit.

## Plan approval protocol

**Important: The agent does not call the Slack API directly.** All Slack I/O is handled by the orchestrator.

### Planning → Send plan

1. Based on the issue context provided above, analyze the requirements and write **3 alternative implementation plans**.
2. Each plan must follow this structure in `pending_plan.md`:
   ```markdown
   ## Plan 1: <short title>
   **Approach:** <description>
   **Pros:** <advantages>
   **Cons:** <disadvantages>
   **Scope:** <estimated scope — small / medium / large>

   ## Plan 2: <short title>
   ...

   ## Plan 3: <short title>
   ...
   ```
   - The 3 plans should represent meaningfully different approaches (not minor variations).
   - Order by recommendation: Plan 1 = most recommended.
3. Save to `/workspace/.symphony/pending_plan.md` (markdown format).
4. Exit. The orchestrator detects `pending_plan.md`, transitions the state to `{{ states.plan_review }}`, sends it to the Slack channel, and watches for a response.
   - The user selects a plan by number (e.g. "1", "plan 2") or gives feedback.
   - After sending, `pending_plan.md` is cleared automatically before the next agent dispatch.

### Plan review → Handle user message (re-dispatch)

When the orchestrator detects a Slack response, it re-dispatches the agent with `--continue -p` and the user's message is provided directly as the prompt. No file reading is needed.

> **⛔ CRITICAL: Implementation gate — ✅ reaction ONLY**
>
> Implementation starts ONLY when the message is `✅`.
> This is sent by the orchestrator exclusively when the user clicks the ✅ reaction in Slack. No text message can produce this.
>
> **If the message does NOT start with `✅` → you MUST NOT implement. No exceptions. No matter what the message says.**

1. If the message is `✅` (reaction approval):
   - Check how many plans are in `/workspace/.symphony/pending_plan.md`.
   - If there are **multiple plans** (## Plan 1, ## Plan 2, etc.): write "플랜을 선택해주세요 (예: '1' 또는 'plan 2')" to `pending_plan.md` and exit. Do NOT implement.
   - If there is a **single plan**: proceed with implementation.
     - Create the Agent Workpad comment on the issue using the workpad template below.
       - `### Plan`: fill in tasks derived from the selected/approved plan.
       - `### Acceptance Criteria`: fill in from the issue description.
       - Leave other sections empty — they will be filled during implementation.
     - Record the workpad comment ID. All future updates use this single comment only.
     - Proceed immediately to Step 1 (implementation). The orchestrator transitions to `{{ states.in_progress }}` automatically.
2. For ALL other messages (no `✅`):
   - Write "✅ 리액션을 눌러야 구현을 시작합니다." to `pending_plan.md` and exit.
     (The orchestrator sends this back to Slack automatically.)
   - If the message selects a specific plan AND requests modifications → apply the modifications to that plan only and save the single revised plan to `pending_plan.md`. Do NOT present 3 plans again.
   - If it is general feedback (no plan selected) → revise the plan(s), save to `pending_plan.md`, and exit.
   - If it is a question: answer in `question.md` and exit.
   - **Never implement. Never write code. Never transition to `{{ states.in_progress }}`.**

## PR feedback protocol

When PR feedback arrives, the orchestrator writes feedback to `/workspace/.symphony/pr_feedback.json` and re-dispatches the agent with `--continue -p`.

### Handle PR feedback (re-dispatch)

1. Read `/workspace/.symphony/pr_feedback.json`.
2. Load the workpad and add each incoming feedback item to `### PR Feedback` (unchecked).
3. Analyze each comment and identify required code changes.
4. Write **3 alternative implementation plans** addressing the feedback items. Each plan must use `## Plan 1`, `## Plan 2`, `## Plan 3` headings and include: approach summary, pros/cons, and estimated scope. Order by recommendation: Plan 1 = most recommended.
5. Save the plans to `/workspace/.symphony/pending_plan.md`.
6. Exit immediately. Do NOT implement changes, push code, or create a PR. The orchestrator detects `pending_plan.md` and transitions the state automatically.
   - The orchestrator sends the plans to Slack for approval (same flow as initial plan).
   - The user selects a plan by number, or selects a plan with modifications → apply modifications to that plan only and save the single revised plan. Do NOT present 3 plans again.

## Question protocol

During implementation, if you encounter a decision that requires human judgement (ambiguous requirements, multiple valid approaches, unclear scope), do **not** guess and continue.

1. Write the question to `/workspace/.symphony/question.md` (markdown format).
   - Be specific: describe the context, the options you see, and what you need to decide.
2. Stop all work immediately and exit.
   - The orchestrator reads `question.md`, sends it to the Slack thread, and watches for a reply.
   - After sending, `question.md` is cleared automatically.
3. When re-dispatched, the user's answer is provided directly as the prompt via `--continue -p`.
   - Continue implementation based on the answer.

**Do not** use this for blockers (missing auth/permissions) — use the blocked-access escape hatch instead.
**Do not** use this for trivial decisions — only for choices that meaningfully affect the outcome.
**Do not** write `question.md` in the same turn as `pending_plan.md` — only one at a time. The plan takes priority.

## Self-review protocol

After the agent completes implementation and commits, the orchestrator runs self-review. Each agent listed in `agents.review.kinds` runs `agents.review.rounds` serial rounds in parallel (`claude -p --no-session-persistence`), then the orchestrator sends the collected results to the primary (implementation) agent via `--continue -p`, which consolidates them and writes the result to `pending_review.md`. The review agents use `@code-reviewer` and `@security-engineer` sub-agents, following `.claude/skills/review.md`. The agent does **not** call the review directly — the orchestrator handles it.

### Consolidation rules

Because consolidation uses `--continue`, the agent has full implementation context. Apply these rules when writing `pending_review.md`:

1. **Merge duplicates** — consolidate issues pointing to the same file, location, and root cause into one.
2. **Context-based rejection** — issues that are false positives given the implementation context (approved plan, ticket requirements, user agreements) may be rejected.
3. **Rejection reason required** — rejected issues must be listed in the "Rejected Issues" table with the issue name and reason.
4. **No new issues** — do not introduce new issues that did not appear in the review rounds.

The orchestrator sends the review results to Slack **regardless of whether issues were found**. The user must approve or provide feedback before the agent proceeds.

### Review results → Handle user message (re-dispatch)

When the orchestrator sends review results to Slack and receives a user response, it re-dispatches the agent with `--continue -p` and the user's message is provided directly as the prompt.

> **File ownership**: `pending_review.md` is written by the agent during consolidation (`--continue`) and when revising on feedback. The orchestrator reads it for Slack delivery and clears it automatically before the next agent dispatch.

> **⛔ CRITICAL: Implementation gate — ✅ reaction ONLY (same rule as plan approval)**
>
> The ✅ reaction gate applies here too. If the message is NOT `✅`, you MUST NOT push, create a PR, or execute fixes.

1. Check if `/workspace/.symphony/pending_review.md` exists.
   - If it exists but **no user message was provided** (e.g. dispatched by poller, not by human response): do NOT push or create a PR. Exit immediately and wait for user approval.
2. If it exists and the message is `✅` (reaction approval):
     1. Read `/workspace/.symphony/pending_review.md` for review context.
     2. Delete `/workspace/.symphony/pending_review.md`.
     3. If the review contains issues that need code changes:
        - Update the workpad `### Notes` section with a summary of the review findings.
        - Build a concrete fix plan based on the findings.
        - Write the plan to `/workspace/.symphony/pending_plan.md`.
        - Exit. The orchestrator sends the plan to Slack for approval.
     4. If no issues (or only style/minor notes):
        - Update the workpad `### Notes` section with "셀프리뷰 통과 — 이슈 없음".
        - Push the branch and create a PR.
        - PR title format: `{{ issue.identifier }}: <short description in English>`.
        {% if repository_kind == 'github' %}
        - Ensure the GitHub PR has label `symphony` (add it if missing).
        {% endif %}
        - Write the PR body (in Korean) summarizing what was implemented and key decisions made. Do NOT leave a separate PR comment — put the summary in the PR description/body.
        - After creating the PR, write the PR info to `/workspace/.symphony/pr_created.json`:
          ```json
          {"pr_url": "<PR URL>", "pr_number": <PR number>, "base_commit": "<git rev-parse HEAD before any changes>"}
          ```
          Capture `base_commit` by running `git rev-parse HEAD` **before** making any code changes in this session.
        - Attach PR URL to the issue. The orchestrator detects `pr_created.json` and transitions to `{{ states.in_review }}` automatically.
3. For ALL other messages (no `✅`):
   - Write "✅ 리액션을 눌러야 구현을 시작합니다." to `pending_plan.md` and exit.
   - If it is feedback: revise the review instead, rewrite `pending_review.md`, and exit.
   - **Never push, create PR, or execute fixes.**

### Fix plan approved → Execute fixes (re-dispatch)

When the fix plan is approved, the orchestrator re-dispatches the agent.

1. Execute all fixes described in the approved plan.
2. Commit all changes.
3. Push the branch. If a PR already exists for this branch, update it; otherwise create a new PR.
   - PR title format: `{{ issue.identifier }}: <short description in English>`.
   {% if repository_kind == 'github' %}
   - Ensure the GitHub PR has label `symphony` (add it if missing).
   {% endif %}
   - After pushing, **always** write the PR info to `/workspace/.symphony/pr_created.json` (even if the PR already existed):
     ```json
     {"pr_url": "<PR URL>", "pr_number": <PR number>, "base_commit": "<git rev-parse HEAD before any changes>"}
     ```
     Capture `base_commit` by running `git rev-parse HEAD` **before** making any code changes in this session.
   - Attach PR URL to the issue. The orchestrator detects `pr_created.json` and transitions to `{{ states.in_review }}` automatically.
   - Leave a PR comment (in Korean) summarizing what was changed and why.

**Do not** create `pending_review.md` from scratch during implementation — the orchestrator triggers consolidation via `--continue` and you write it then.
You may rewrite it when handling review feedback (see above).

### pr_feedback.json format

```json
{
  "comments": [
    {
      "id": "",
      "body": "",
      "author": "",
      "path": null,
      "line": null,
      "created_at": ""
    }
  ],
  "received_at": ""
}
```

## Step 0: Determine current ticket state and route

1. Use the issue context provided above (identifier, title, status, description, labels). Do NOT fetch the issue from the tracker API — it is already provided.
2. Read the current state from the provided `Current status` field.
3. Route to the matching flow:
   - `{{ states.planning }}` → write 3 alternative plans, save to `pending_plan.md`, exit. The orchestrator handles state transitions.
   - `{{ states.plan_review }}` → user message is delivered directly. If approval, start implementation; if feedback, revise the plan and exit.
   - `{{ states.in_progress }}`:
     - If `pending_review.md` exists → handle review feedback (self-review protocol) based on user message.
     - Otherwise → continue from Step 2 execution.
   - `{{ states.in_review }}` → if `pr_feedback.json` exists: read feedback, write plan to `pending_plan.md`, exit. The orchestrator handles state transitions. Otherwise: exit and wait.
   - `{{ states.done }}`{% if states.canceled %} / `{{ states.canceled }}`{% endif %} → do nothing and shut down.
4. Check whether a PR already exists for the current branch and whether it is closed.
   - If a branch PR exists and is `CLOSED` or `MERGED`, treat prior branch work as non-reusable for this run.
   - Create a fresh branch from `origin/main` and restart execution flow as a new attempt.
5. Points 4-6 apply only to `{{ states.in_progress }}` state (after plan approval).
   Do NOT skip the planning phase for `{{ states.planning }}` tickets — follow Step 0.3 routing.
6. Add a short comment if state and issue content are inconsistent, then proceed with the safest flow.

## Step 1: Start/continue execution ({{ states.in_progress }} only)

This step runs ONLY after plan approval (issue is in `{{ states.in_progress }}`).
If the issue is in `{{ states.planning }}`, follow the Status map: write 3 alternative plans, save to `pending_plan.md`, transition to `{{ states.plan_review }}`, exit.

- Before implementation, create a feature branch named after the issue identifier (e.g. `KAN-12`) from `origin/main`.
  Do NOT work directly on `main`.

1.  Load the workpad comment (created during plan approval):
    - Fetch issue comments and find the one with `## Agent Workpad` header.
    - There must be exactly one workpad per issue. Reuse it — do not create a new one.
    - Recovery only: if no workpad exists (e.g. process restart before creation), create one using the workpad template and fill `### Plan` and `### Acceptance Criteria` from context.
    - Persist the workpad comment ID for all subsequent updates.
2.  Reconcile the workpad before starting new work:
    - Check off items that are already done based on current branch state.
    - Expand/fix the plan so it is comprehensive for current scope.
    - Ensure `Acceptance Criteria` and `Validation` are current.
3.  Update the environment stamp at the top as a code fence line:
    - Format: `<host>:<abs-workdir>@<short-sha>`
    - Example: `devbox-01:/home/dev-user/code/symphony-workspaces/MT-32@7bdde33bc`
4.  If the ticket description/comment context includes `Validation`, `Test Plan`, or `Testing` sections, copy those requirements into `### Acceptance Criteria` and `### Validation` as required checkboxes (no optional downgrade).
5.  Before implementing, capture a concrete reproduction signal and record it in `### Notes`.
    - All `Notes` entries must use the format: `` `YYYY-MM-DD HH:mm:ss` <description> — [`<short-sha>`](<commit-url>) ``
6.  Run the `pull` skill to sync with latest `origin/main` before any code edits, then record the pull/sync result in `### Notes`.
7.  Proceed to execution.

## PR feedback sweep protocol (required)

When a ticket has an attached PR, run this protocol before moving to `{{ states.in_review }}`:

1. Identify the PR number from issue links/attachments.
2. Gather feedback from all channels:
   {% if repository_kind == 'github' %}
   - Top-level PR comments (`gh pr view --comments`).
   - Inline review comments (`gh api repos/<owner>/<repo>/pulls/<pr>/comments`).
   - Review summaries/states (`gh pr view --json reviews`).
     {% elsif repository_kind == 'bitbucket' %}
   - Read `/workspace/.symphony/pr_feedback.json` for the latest PR comments.
   - Use Bitbucket REST API for additional PR operations (see `.claude/skills/repo/bitbucket.md`).
     {% endif %}
3. Treat every actionable reviewer comment (human or bot), including inline review comments, as blocking until one of these is true:
   - code/test/docs updated to address it, or
   - explicit, justified pushback reply is posted on that thread.
4. Update the workpad plan/checklist to include each feedback item and its resolution status.
5. Re-run validation after feedback-driven changes and push updates.
6. Repeat this sweep until there are no outstanding actionable comments.

## Blocked-access escape hatch (required behavior)

Use this only when completion is blocked by missing required tools or missing auth/permissions that cannot be resolved in-session.

- GitHub is **not** a valid blocker by default. Always try fallback strategies first (alternate remote/auth mode, then continue publish/review flow).
- Do not move to `{{ states.in_review }}` for access/auth issues until all fallback strategies have been attempted and documented in the workpad.
- If a required tool is missing or required auth is unavailable, move the ticket to `{{ states.in_review }}` with a short blocker brief in the workpad that includes:
  - what is missing,
  - why it blocks required acceptance/validation,
  - exact human action needed to unblock.
- Keep the brief concise and action-oriented; do not add extra top-level comments outside the workpad.

{% if tracker_kind == 'jira' %}

## Step 2: Execution phase ({{ states.in_progress }} → {{ states.in_review }})

{% elsif tracker_kind == 'linear' %}

## Step 2: Execution phase (In Progress → In Review)

{% else %}

## Step 2: Execution phase

{% endif %}

1.  Determine current repo state (`branch`, `git status`, `HEAD`) and verify the kickoff `pull` sync result is already recorded in the workpad before implementation continues.
2.  The issue should already be in `{{ states.in_progress }}` before this step begins (set during plan approval). Do not transition from `{{ states.planning }}` here.
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
7.  Before every commit, run the required validation for your scope and confirm it passes; if it fails, address issues and rerun until green, then commit changes.
    - Branch name must be the issue identifier only (e.g. `{{ issue.identifier }}`).
8.  Merge latest `origin/main` into branch, resolve conflicts, and rerun checks.
9.  Before committing, do a final workpad review:
    - Read the workpad and go through every checklist item.
    - Check off completed items; leave uncompleted items unchecked.
    - If any required acceptance criteria or validation item is unchecked, address it before proceeding.
    - Update `### Notes` with a completion summary entry.
    - Add a short `### Confusions` section when any part of execution was unclear/confusing.
    - Do not post any additional completion summary comment outside the workpad.
10. Commit all changes and **exit**. Do NOT push, create a PR, or change the issue state.
    - The orchestrator will push the branch, run self-review, send results to Slack, and handle all subsequent steps.
    - Exception: if blocked by missing required tools/auth per the blocked-access escape hatch, move to `{{ states.in_review }}` with the blocker brief and explicit unblock actions.

## Step 3: In Review — waiting for human review

PR approval and merge are performed by humans. The agent does **not** merge PRs.

1. When the issue is in `{{ states.in_review }}`, the agent should **exit and wait**.
   - The orchestrator monitors the PR for new comments, review decisions, and merge events.
2. If there are actionable comments or change requests (dispatched by orchestrator via `pr_feedback.json`):
   - Read `/workspace/.symphony/pr_feedback.json` and address the feedback (Step 4).
   - Return to `{{ states.in_review }}` when done.
3. If comments are informational or questions (no code changes needed), respond directly on the PR and remain in `{{ states.in_review }}`.
4. When the PR is merged, the orchestrator handles post-merge cleanup automatically:
   - Transitions the issue to `{{ states.done }}`.
   - Deletes the feature branch.
   - Cleans up the workspace.
   - No agent action is needed for merge/post-merge.

## Step 4: Feedback handling (approved fix plan)

This step runs when a fix plan (from PR feedback or self-review) is approved.

1. Read the approved plan context from the workpad.
2. Load the existing `## Agent Workpad` comment and update it.
3. Record each feedback item in the workpad `### PR Feedback` section.
4. Implement the approved changes on the same branch.
5. Re-run validation and ensure all checks pass.
6. Update the workpad with progress and completion status.
7. Commit all changes.
8. Push the branch. If a PR already exists for this branch, update it; otherwise create a new PR.
   - PR title format: `{{ issue.identifier }}: <short description in English>`.
   {% if repository_kind == 'github' %}
   - Ensure the GitHub PR has label `symphony` (add it if missing).
   {% endif %}
   - After pushing, **always** write the PR info to `/workspace/.symphony/pr_created.json` (even if the PR already existed):
     ```json
     {"pr_url": "<PR URL>", "pr_number": <PR number>, "base_commit": "<value from pr_feedback.json base_commit field>"}
     ```
     Read `base_commit` from `/workspace/.symphony/pr_feedback.json` — the orchestrator captured it before this session started. Do NOT run `git rev-parse HEAD` for `base_commit` in this case.
   - Attach PR URL to the issue. The orchestrator detects `pr_created.json` and transitions to `{{ states.in_review }}` automatically.
   - Leave a PR comment (in Korean) summarizing what was changed and why.

## Completion bar before {{ states.in_review }}

- Step 1/2 checklist is fully complete and accurately reflected in the single workpad comment.
- Acceptance criteria and required ticket-provided validation items are complete.
- Validation/tests are green for the latest commit.
- All changes are committed to the feature branch.
- If app-touching, runtime validation/media requirements from `App runtime validation (required)` are complete.

> Note: Push and PR creation happen after self-review approval — either via the review approval flow (no issues found) or via the fix plan approval flow (after fixes are committed).

## Guardrails

- If the branch PR is already closed/merged, do not reuse that branch or prior implementation state for continuation.
- For closed/merged branch PRs, create a new branch from `origin/main` and restart from reproduction/planning as if starting fresh.
- Do not edit the issue body/description for planning or progress tracking.
- Use exactly one persistent workpad comment (`## Agent Workpad`) per issue.
- If comment editing is unavailable in-session, use the update script. Only report blocked if both MCP editing and script-based editing are unavailable.
- Temporary proof edits are allowed only for local verification and must be reverted before commit.
- If out-of-scope improvements are found, create a separate issue rather than expanding current scope, and include a clear title/description/acceptance criteria, same-project assignment, and a `related` link to the current issue.
- Do not move to `{{ states.in_review }}` unless the completion bar is satisfied.
- In `{{ states.in_review }}`, do not make changes; wait and poll.
- If state is terminal (`{{ states.done }}`{% if states.canceled %}, `{{ states.canceled }}`{% endif %}), do nothing and shut down.
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

- `YYYY-MM-DD HH:mm:ss` <description> — [`<short-sha>`](commit-url)

### PR Feedback

- [ ] [comment](pr-comment-url): <summary> → [`<short-sha>`](commit-url) | [reply](pr-reply-url)

### Confusions

- <only include when something was confusing during execution>
````
