# Changelog

## [Unreleased]

### 계획 중
- ai-rules 주입 방법 고려
- 보안 체크 외부 툴 연동 (PR 후 claude code, codex 또는 외부 툴 활용) -> 지금은 보안 페르소나로 PR 전에 하는 것 뿐
- Claude 실행 중 인터랙티브 유저 제어 -> 로그인 세션 갈아끼기
- 지라, 슬랙 MCP 도입 검토? (빗버킷은 없음) -> 지금 지라 이슈 변경 및 슬랙은 에이전트가 아니라 오케스트레이터가 하게 되어 있기 때문에 도입한다면 구조적 변경이 많이 일어남
- claude code 사용량 초과시 감지 및 알림?
- claude code 인증 세션이 만료되었거나 갑자기 로그인 하라고 할 때? -> 일단 수동으로 로그인
- 스테이트 머신이 굉장히 복잡함. 다른 머신이나 관리 체계를 변경해야 함
- 셀프 리뷰 시 로그 실시간 화(안해도 됨)
- 로그 수집 개선
- 셀프 리뷰 너무 느림
- decline(PR 닫기) 시 처리 필요

### Bug

---

## [v1.0.0] - unreleased

### 추가된 기능

#### 1. Jira 이슈 블로킹
Jira 이슈 간 `blocks / is blocked by` 링크를 감지하여, 블로커가 완료되기 전까지 해당 이슈의 dispatch를 차단합니다. (Linear은 기존에 이미 지원)

**동작 방식**
- Jira REST API에서 이슈 조회 시 `issuelinks` 필드를 함께 반환
- `type.inward`에 "blocked by"가 포함된 링크의 `inwardIssue`를 `BlockerRef`로 변환
- Orchestrator의 기존 `isBlocked()` 로직이 blocker 상태를 확인하여 dispatch 차단

**주의사항**
- Jira의 "Blocks" 링크 타입만 감지 (`relates to`, `duplicates` 등은 무시)
- 링크 타입 이름이 다국어(예: 한글)인 경우 "blocked by" 문자열 포함 여부로 판단하므로 Jira 설정에 따라 동작하지 않을 수 있음

---

#### 2. 개발자별 에이전트 선택 (`trigger.assignees`)
이슈 담당자의 이메일에 따라 다른 에이전트 설정(모델, 도구 등)을 적용할 수 있습니다.

**동작 방식**
1. 이슈 조회 시 담당자 이메일을 함께 가져옴 (Jira: `emailAddress`, Linear: `email`)
2. 에이전트의 `trigger.assignees`에 이메일 목록이 있으면 이슈 담당자 이메일과 비교
3. 매칭되는 에이전트만 실행. trigger가 없는 에이전트는 항상 실행 (기본 에이전트)

**주의사항**
- Jira Cloud에서 `emailAddress`는 "Manage profile visibility" 설정에 따라 null일 수 있음
- 이메일 비교는 대소문자 무시
- `trigger`의 모든 조건 (`issue_labels`, `pr_labels`, `assignees`)은 AND 관계

---

#### 3. 개발자별 Claude 인증 (`claude_auth_dir`)
에이전트 설정에 `claude_auth_dir`을 지정하면, 해당 개발자의 Claude Code 인증 파일을 컨테이너에 주입합니다.

**동작 방식**
1. 컨테이너 생성 시 기본 인증이 먼저 주입됨 (기존 동작)
2. `claude_auth_dir`이 설정된 에이전트가 선택되면, 기본 인증을 **덮어쓰기**
3. 지정된 디렉토리의 `.credentials.json`을 읽어서 컨테이너에 재주입

**디렉토리 구조 예시**
```
/shared/claude-auths/
├── john/.claude/.credentials.json
├── jane/.claude/.credentials.json
└── shared/.claude/.credentials.json
```

**주의사항**
- `claude_auth_dir`은 `.credentials.json` 파일이 있는 `.claude` 디렉토리를 가리켜야 함
- `~` 경로 지원 (`~/.claude` → `/home/user/.claude`)
- 파일이 없으면 경고 로그만 남기고 기본 인증 유지

---

#### 4. 멀티 레포
하나의 Jira/Linear 트래커에 여러 레포지토리를 연결할 수 있습니다. 이슈 라벨로 대상 레포를 결정합니다.

**매칭 우선순위**
1. `issue_labels` 매칭 (대소문자 무시)
2. `default: true` 레포
3. `repositories[0]` (첫 번째 레포)

**주의사항**
- PR merge 시 브랜치 삭제는 모든 폴러에 순차적으로 시도 (해당 레포에서만 성공)
- 이슈에 라벨이 없고 default 레포도 없으면 첫 번째 레포가 선택됨
- 여러 레포에 라벨이 겹치면 첫 번째 매칭이 사용됨

---

#### 5. 기타
- 셀프리뷰 시 `@security-engineer` sub-agent 병렬 실행
- 계획 3개 대안 제시 및 번호 선택 (planning 첫 진입 시)
- 터미널 대시보드 UI (neo-blessed)
- TrackerPoller 전환 및 DispatchReason 개선
- Tracker states 시맨틱 매핑
- PR 피드백 슬랙 수신 (`pr_feedback_source: 'pr' | 'slack' | 'both'`)

---

### 설정 예시

```yaml
trackers:
  - kind: jira
    project_key: KAN
    host: https://your-domain.atlassian.net
    states:
      planning: 아이디어
      plan_review: 검토 중
      in_progress: 진행 중
      in_review: 리뷰 중
      done: 완료

    # 멀티 레포
    repositories:
      - kind: bitbucket
        workspace: myteam
        repo_slug: frontend
        issue_labels: [frontend, web]
      - kind: bitbucket
        workspace: myteam
        repo_slug: backend
        issue_labels: [backend, api]
        default: true

agents:
  # John 전용
  - kind: claude
    claude_auth_dir: /shared/claude-auths/john/.claude
    models: { planning: opus, implementation: sonnet }
    trigger:
      assignees: [john@company.com]

  # Jane 전용
  - kind: claude
    claude_auth_dir: /shared/claude-auths/jane/.claude
    models: { planning: sonnet, implementation: haiku }
    trigger:
      assignees: [jane@company.com]

  # 기본 (trigger 없음 = 모든 이슈)
  - kind: claude
    models: { planning: opus, implementation: sonnet }
```

### 하위호환성

- 기존 `repository` (단수) 설정은 그대로 동작. 내부적으로 `repositories: [repository]`로 정규화
- `trigger`에 `assignees`가 없으면 기존처럼 모든 이슈에 해당 에이전트가 실행
- `claude_auth_dir`이 없으면 기존 호스트 인증 방식 (Keychain 또는 ~/.claude) 사용
- `issue_labels`가 빈 배열이면 레포 매칭에 사용되지 않음

### 변경 파일

| 파일 | 변경 내용 |
|------|-----------|
| `src/types.ts` | `Issue.assigneeEmail` 필드 추가 |
| `src/tracker/jira.ts` | issuelinks 파싱(블로킹), assignee email 추출 |
| `src/tracker/linear.ts` | assignee email GraphQL 쿼리 추가 |
| `src/config/schema.ts` | `trigger.assignees`, `claude_auth_dir`, `repositories`, `issue_labels`, `default` 필드 추가 |
| `src/orchestrator.ts` | `selectAgents` assignee 매칭, `resolveRepository`, 멀티 RepoPoller |
| `src/agent-runner.ts` | `claudeAuthDir` 전달 + 인증 주입 |
| `src/workspace/docker.ts` | `injectClaudeCredentialsFromDir` export 함수 추가 |
| `src/prompt-builder.ts` | `assignee_email` 템플릿 변수 추가 |
