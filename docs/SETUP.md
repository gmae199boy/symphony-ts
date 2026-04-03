# Symphony TS — 설정 가이드

## 빠른 시작 체크리스트

- [ ] Node.js 24+ 설치
- [ ] 의존성 설치 (`pnpm install`)
- [ ] `.env` 파일 생성
- [ ] `WORKFLOW.md` 설정
- [ ] Slack 앱 설정
- [ ] Docker 워커 이미지 빌드 (`workspace_backend: docker` 사용 시)
- [ ] 빌드 및 실행

**EC2 원격 서버 세팅:**
- [ ] `.sync.env` 설정
- [ ] `make remote-init` — 의존성 자동 설치 + 빌드 + 시작
- [ ] SSH 접속 후 Claude Code 로그인

---

## 1. 사전 요구사항

| 항목 | 버전/조건 | 필수 여부 |
|------|-----------|-----------|
| Node.js | 24+ | 필수 |
| pnpm | 최신 | 필수 |
| Claude Code CLI | 최신 (`~/.claude` 세션) | 필수 |
| Docker | 최신 | `workspace_backend: docker` 시에만 |
| pm2 | 최신 | 프로덕션 운영 시 (`make init`으로 자동 설치) |

> **EC2 원격 서버에 설치 시:** `make remote-init`이 nvm, Node 24, pnpm, Claude Code, make, Docker를 자동으로 설치한다.

**Claude Code CLI 인증:**
- claude를 실행하고 /login 으로 나온 url을 로컬에서 로그인 후 토큰을 해당 claude에 주입

---

## 2. 환경변수 (.env)

`.env.example`을 복사해서 시작:

```bash
cp .env.example .env
```

### 필요한 변수 (사용하는 통합에 따라)

```bash
# Slack (계획 승인 워크플로우 사용 시)
SLACK_BOT_TOKEN=       # xoxb-... — 메시지 전송용
SLACK_APP_TOKEN=       # xapp-... — Socket Mode 연결용
SLACK_CHANNEL_ID=      # 본인 Slack 맴버 ID — DM으로 승인 알림 수신 (프로필 → ⋯ → 맴버 ID 복사)

# Linear (Linear 트래커 사용 시)
LINEAR_API_KEY=        # lin_api_...

# GitHub (GitHub 레포 통합 시)
GITHUB_TOKEN=          # ghp_...

# Jira (Jira 트래커 사용 시)
JIRA_EMAIL=            # Atlassian 계정 이메일 (필수)
JIRA_API_TOKEN=        # Atlassian API 토큰

# Bitbucket (Bitbucket 레포 통합 시)
BITBUCKET_EMAIL=       # Atlassian 계정 이메일 (선택 — 개인 API TOKEN 사용 시 필요, 워크스페이스 토큰은 불필요)
BITBUCKET_API_TOKEN=   # Bitbucket API 토큰

# 로깅
# LOG_LEVEL=debug       # debug | info (기본값: info). 문제 추적 시 debug로 설정
```

### 토큰 발급 방법

**Linear API Key**
→ Linear 앱 → Settings → API → Personal API Keys → Create key

**GitHub Personal Access Token**
→ github.com → Settings → Developer settings → Personal access tokens → Fine-grained tokens
→ 필요 권한: `pull_requests: read/write`, `contents: read`

**Jira API Token**
→ https://id.atlassian.com/manage-profile/security/api-tokens → Create API token

**Bitbucket API Token**

두 가지 방식 중 선택:

| 방식 | 발급 위치 | 댓글 작성자 | BITBUCKET_EMAIL |
|------|-----------|-------------|-----------------|
| 개인 API Token | Personal settings → API tokens | 본인 계정 이름 | 필요 |
| 워크스페이스 토큰 | Workspace settings → Access tokens | 토큰 이름 (봇처럼 표시) | 불필요 |

→ 필요 권한: Repositories(Read), Pull requests(Read/Write)

**Slack 토큰** → [아래 섹션](#4-slack-앱-설정) 참고

---

## 3. WORKFLOW.md 설정

프로젝트 루트의 `WORKFLOW.md` 파일을 수정한다. `---` 사이의 YAML 블록이 설정으로 파싱된다.

전체 예시는 `WORKFLOW.example.yml` 참조.

### 최소 설정 (Linear + GitHub + Claude)

```yaml
---
workspace_backend: local

trackers:
  - kind: linear
    project_slug: "my-project"       # Linear 프로젝트 slug
    api_key: $LINEAR_API_KEY
    assignee: me                     # "me" 또는 Linear user ID
    states:
      planning: Todo                 # 실제 Linear 상태 이름과 일치해야 함
      plan_review: Plan Review
      in_progress: In Progress
      in_review: In Review
      done: Done
      canceled: Canceled
    repository:
      kind: github
      repo: my-org/my-repo
      token: $GITHUB_TOKEN

agents:
  backends:
    - kind: claude
      primary: true
      models:
        planning: opus
        implementation: sonnet
---
```

### 주요 설정 옵션

#### workspace_backend

```yaml
workspace_backend: local    # 이슈별 로컬 디렉토리 생성 (기본값)
workspace_backend: docker   # 이슈별 Docker 컨테이너 생성
workspace:
  root: ./symphony-workspaces
```

#### trackers

**Linear:**
```yaml
trackers:
  - kind: linear
    project_slug: "my-project"
    api_key: $LINEAR_API_KEY
    assignee: me               # 본인 할당 이슈만 처리
    poll_interval_ms: 15000    # 기본값: 30000
    states:
      planning: Todo
      plan_review: Plan Review
      in_progress: In Progress
      in_review: In Review
      done: Done
      canceled: Canceled
```

**Jira:**
```yaml
trackers:
  - kind: jira
    project_key: "PROJ"
    host: https://my-org.atlassian.net   # ← 워크스페이스마다 URL이 다름
    email: $JIRA_EMAIL
    api_token: $JIRA_API_TOKEN
    poll_interval_ms: 60000    # Jira rate limit이 엄격 — 60초 권장
    states:
      planning: 진행 예정
      plan_review: 검토 중
      in_progress: 진행 중
      in_review: 리뷰 중
      done: 완료
      canceled: 취소
```

> **주의**: `states` 값은 실제 Linear/Jira에 설정된 상태 이름과 **정확히** 일치해야 한다. 상태 플로우는 [ARCHITECTURE.md](ARCHITECTURE.md) 참고.

#### repository

```yaml
    repository:
      kind: github
      repo: owner/repo
      token: $GITHUB_TOKEN
      pr_label_filter: symphony      # 이 레이블이 있는 PR만 추적 (기본값: symphony)
      hooks:
        after_create: pnpm install -g typescript  # 컨테이너/디렉토리 생성 직후
        after_clone: npm ci                      # clone 후 실행
        before_run: git fetch origin             # 매 에이전트 실행 전
        after_run: rm -rf node_modules/.cache    # 매 에이전트 실행 후
        before_remove: echo "cleanup"            # 워크스페이스 제거 전
        timeout_ms: 300000       # 훅 타임아웃 (ms, 기본 5분)
```

**Bitbucket:**
```yaml
    repository:
      kind: bitbucket
      workspace: my-workspace
      repo_slug: my-repo
      email: $BITBUCKET_EMAIL        # 개인 API 토큰 사용 시 필요. 워크스페이스 토큰은 불필요
      api_token: $BITBUCKET_API_TOKEN
```

#### 멀티레포 (이슈 라벨로 레포 분기)

하나의 트래커에서 여러 레포로 이슈를 분기할 수 있다. `repository` 대신 `repositories` 배열을 사용한다.

```yaml
    repositories:
      - kind: bitbucket
        workspace: my-org
        repo_slug: frontend
        api_token: $BITBUCKET_API_TOKEN
        issue_labels: [frontend]      # Jira/Linear 이슈에 'frontend' 라벨 → 이 레포

      - kind: bitbucket
        workspace: my-org
        repo_slug: backend
        api_token: $BITBUCKET_API_TOKEN
        issue_labels: [backend]       # 이슈에 'backend' 라벨 → 이 레포
        default: true                 # 매칭 라벨 없으면 이 레포로 폴백
```

라벨은 Jira 이슈 우측 패널 **Labels** 필드, Linear는 이슈의 **Labels** 항목에서 추가한다.

전체 예시는 `WORKFLOW.example.yml` 참조.

#### agents

```yaml
agents:
  max_concurrent: 10           # 동시 실행 에이전트 수 (기본값: 10)
  retry_backoff_ms: 5000       # 재시도 기본 백오프 (ms)
  max_retries: 2               # 에이전트 실패 시 자동 재시도 횟수 (기본값: 2)
  review:
    rounds: 2                  # 에이전트당 리뷰 라운드 수
    kinds:
      - claude                 # backends[].kind 참조
  backends:
    - kind: claude
      primary: true            # 메인 에이전트 (계획/구현/리뷰 병합)
      models:
        planning: opus
        implementation: sonnet
      max_budget_usd: 10.0     # 선택: 턴당 지출 한도 (USD)
      turn_timeout_ms: 3600000 # 기본값: 1시간
      allowed_tools: []        # 비어있으면 모든 툴 허용
      trigger:                 # 선택: 특정 이슈에만 실행
        issue_labels:
          - backend
```

#### slack

```yaml
slack:
  bot_token: $SLACK_BOT_TOKEN   # xoxb-...
  app_token: $SLACK_APP_TOKEN   # xapp-... (Socket Mode용)
  channel: $SLACK_CHANNEL_ID    # 본인 Slack 맴버 ID
```

#### server

내부 HTTP 서버 (헬스체크, webhook 수신 등):

```yaml
server:
  port: 4000      # 기본값
  host: 0.0.0.0   # 기본값
```

#### docker (workspace_backend: docker 시)

```yaml
docker:
  image: symphony-worker:latest
  # auth_mount: ~/.claude        # 선택: 기본 경로(~/.claude) 대신 다른 곳에서 인증 정보를 읽을 때. 보통 불필요 — 자동 주입됨
  memory: 8g
  cpus: "4"
  env:
    NPM_TOKEN: $NPM_TOKEN
```

---

## 4. Slack 앱 설정

Symphony는 **Socket Mode(WebSocket)**로 Slack과 통신한다. 공인 IP나 Request URL이 없어도 동작한다.

### 필요한 것 요약

| 항목 | 값 |
|------|----|
| Bot Token Scopes | `chat:write`, `channels:history`, `groups:history`, `reactions:read` |
| Subscribe to bot events | `message.channels` (또는 `message.groups`), `reaction_added` |
| Event Subscriptions | ON — Request URL 불필요 (Socket Mode가 수신) |
| Socket Mode | ON — App-Level Token (`connections:write` scope) 발급 |

> 봇에게 **DM**으로 승인 알림을 받는다. 채널 초대 없이 본인 맴버 ID만 설정하면 된다.

### 단계별 설정

**1. Slack 앱 생성**

api.slack.com/apps → Create New App → From scratch → 앱 이름 + 워크스페이스 선택

**2. Socket Mode 활성화 + App-Level Token 발급**

좌측 메뉴 → Socket Mode → Enable Socket Mode → ON

App-Level Tokens → Generate → 이름 입력 → scope: `connections:write` → Generate
→ 발급된 `xapp-...` 토큰을 `.env`의 `SLACK_APP_TOKEN`에 저장

**3. OAuth & Permissions — Bot Token Scopes 추가**

좌측 메뉴 → OAuth & Permissions → Scopes → Bot Token Scopes:
- `chat:write`
- `channels:history` — 공개 채널 메시지 수신용
- `groups:history` — 비공개 채널 사용 시 추가
- `reactions:read`

**4. Event Subscriptions 활성화 + bot events 구독**

좌측 메뉴 → Event Subscriptions → Enable Events → ON

> Request URL은 입력하지 않아도 된다 (Socket Mode가 이벤트를 WebSocket으로 전달).

Subscribe to bot events → Add Bot User Event:
- `message.channels` — 공개 채널 스레드 답글 수신
- `message.groups` — 비공개 채널 사용 시 추가
- `reaction_added` — ✅ 리액션 수신

Save Changes

**5. 앱 설치**

좌측 메뉴 → Install App → Install to Workspace → 허용

발급된 `xoxb-...` Bot OAuth Token을 `.env`의 `SLACK_BOT_TOKEN`에 저장

**6. 본인 맴버 ID 확인**

Slack 앱 → 본인 프로필 클릭 → `⋯` (더보기) → **맴버 ID 복사**
→ `.env`의 `SLACK_CHANNEL_ID`에 저장

---

## 5. Docker 워커 이미지 빌드

`workspace_backend: docker` 사용 시 필요. `make init` 및 `make start` 실행 시 자동으로 빌드된다 (Docker 레이어 캐싱으로 변경 없으면 즉시 완료).

수동으로 빌드하려면:
```bash
npm run docker:build
```

---

## 6. 로컬 빌드 및 실행 (개발용)

```bash
# 의존성 설치
pnpm install

# 개발 모드 (빌드 없이 ts 직접 실행)
pnpm run dev
```

---

## 7. 프로덕션 운영 (pm2)

pm2를 사용하면 크래시 시 자동 재시작, 서버 재부팅 시 자동 실행이 가능하다.

### 명령어 실행 방식

명령어는 두 가지 방식으로 실행할 수 있다:

| 방식 | 사용 시점 |
|------|-----------|
| `make <target>` | 서버에 SSH 접속한 후 직접 실행 |
| `make remote-<target>` | 로컬 터미널에서 원격으로 실행 |

### 원격 실행 설정 (.sync.env)

`make remote-*` 명령어를 사용하려면 먼저 접속 정보를 설정한다:

```bash
cp .sync.env.example .sync.env
```

`.sync.env` 파일을 열고 값을 채운다:

```bash
SYNC_HOST=ec2-user@<서버 IP>   # SSH 접속 주소
SYNC_KEY=~/.ssh/my-key.pem     # SSH 키 파일 경로 (선택 — 아래 참고)
SYNC_REMOTE_PATH=~/symphony    # 서버에서 프로젝트를 놓을 경로
```

> `.sync.env`는 `.gitignore`에 포함되어 커밋되지 않는다.

### SSH 키 설정

#### 1단계: 키 생성

로컬에서 키를 생성한다:

```bash
ssh-keygen -t ed25519 -f ~/.ssh/my-key -C "my-ec2"
```

두 파일이 생성된다:
- `~/.ssh/my-key` — 개인키 (로컬에만 보관, 절대 공유하지 않음)
- `~/.ssh/my-key.pub` — 공개키 (서버에 등록)

> AWS에서 `.pem` 파일을 발급받은 경우 생성 단계는 건너뛰고 바로 2단계로 이동한다.

#### 2단계: 공개키를 EC2에 등록

EC2 인스턴스가 이미 실행 중인 경우 AWS 콘솔의 **EC2 Instance Connect**로 브라우저에서 접속해 공개키를 등록한다.

**1. AWS 콘솔 → EC2 → Instances → 인스턴스 선택**

**2. Connect → EC2 Instance Connect → Connect** (브라우저 터미널 열림)

**3. 로컬에서 공개키 내용 확인:**

```bash
# ed25519 키로 생성한 경우
cat ~/.ssh/my-key.pub

# AWS .pem 파일인 경우 공개키 추출
ssh-keygen -y -f ~/.ssh/my-key.pem
```

출력된 `ssh-ed25519 AAAA...` 또는 `ssh-rsa AAAA...` 전체를 복사한다.

**4. 브라우저 터미널에서 붙여넣기:**

```bash
echo "복사한 공개키 전체" >> ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys
```

> 인스턴스 생성 시 키 페어를 지정했다면 2단계는 필요 없다. 해당 `.pem` 파일이 이미 등록된 상태다.

#### 3단계: 로컬 키 권한 설정

```bash
chmod 400 ~/.ssh/my-key        # 또는 my-key.pem
```

권한이 너무 넓으면 SSH가 키 사용을 거부한다.

#### 4단계: ~/.ssh/config 등록

```
Host my-ec2
    HostName <서버 IP>
    User ec2-user
    IdentityFile ~/.ssh/my-key
    IdentitiesOnly yes
```

이후 `ssh my-ec2`로 접속 가능하다.

#### 5단계: .sync.env 설정

**~/.ssh/config 등록한 경우 (권장):**
```bash
SYNC_HOST=my-ec2
SYNC_KEY=              # 비워도 됨
```

**키 파일 직접 지정:**
```bash
SYNC_HOST=ec2-user@<서버 IP>
SYNC_KEY=~/.ssh/my-key
```

둘 다 설정된 경우 `~/.ssh/config`가 우선된다.

**둘 다 없는 경우** `make remote-*` 실행 시 에러가 출력된다:
```
Error: No SSH auth method found.
  Option 1: Set SYNC_KEY in .sync.env
  Option 2: Add a Host entry for 'my-ec2' in ~/.ssh/config
```

### 최초 서버 세팅

**로컬에서 원격으로 (권장):**
```bash
make remote-init
```
다음을 순서대로 자동 수행한다:
1. 원격 의존성 확인/설치 — nvm, Node 24, pnpm, Claude Code, make, Docker
2. 파일 전송 (rsync)
3. `pnpm install`
4. pm2 설치, logrotate 설정, Docker 이미지 빌드, tsc 빌드 (`make init`)
5. 시작 (`make start`)
6. 재부팅 자동 실행 등록 (`make startup`)

완료 후 Claude Code 로그인이 필요하다 → [Claude Code 로그인 (원격 서버)](#claude-code-로그인-원격-서버) 참고

**서버에서 직접:**
```bash
make init       # pm2 설치, logrotate 설정, Docker 이미지 빌드, tsc 빌드
make start      # 시작
make startup    # 재부팅 자동 실행 등록
```

---

### Claude Code 로그인 (원격 서버)

`make remote-init` 완료 후 서버에 SSH로 접속해 로그인한다.

**1. SSH 접속:**
```bash
ssh my-ec2   # 또는 ssh ec2-user@<서버 IP>
```

**2. Claude Code 로그인 실행:**
```bash
claude
```

**3. 출력된 URL을 로컬 브라우저에서 열어 로그인:**
```
To continue, please open the following URL in your browser:
https://claude.ai/oauth/...
```

로그인 완료 시 터미널에 `Logged in` 메시지가 표시된다.

**4. 로그인 확인:**
```bash
claude --version
```

> 로그인 세션은 `~/.claude/.credentials.json`에 저장되며, 이후 컨테이너 실행 시 자동으로 주입된다.

### 코드 업데이트

**로컬에서 원격으로 (권장):**
```bash
make remote-upload
```
변경된 파일 동기화(rsync) → `pnpm install` → Docker 이미지 빌드 → tsc 빌드 → 재시작까지 수행한다. `.env`도 함께 전송된다.

**서버에서 직접:**
```bash
make start  # Docker 이미지 빌드 + tsc 빌드 후 재시작
```

### 전체 명령어

| 서버 직접 | 로컬 원격 | 설명 |
|-----------|-----------|------|
| `make init` | — | pm2 설치, logrotate 설정, Docker/tsc 빌드 |
| `make start` | `make remote-start` | Docker/tsc 빌드 후 시작/재시작 |
| `make stop` | `make remote-stop` | 프로세스 정지 |
| `make logs` | `make remote-logs` | 실시간 로그 스트리밍 |
| `make reload` | `make remote-reload` | config hot reload (SIGHUP, 재시작 없음) |
| `make status` | `make remote-status` | 프로세스 상태 확인 |
| `make startup` | `make remote-startup` | 재부팅 자동 실행 등록 (최초 1회, 내부에서 sudo 처리) |
| — | `make remote-init` | 최초 서버 세팅 (전송+설치+빌드+시작+startup) |
| — | `make remote-upload` | 파일 전송 + 빌드 + 재시작 |

### 로그 파일 위치

| 파일 | 내용 |
|------|------|
| `logs/symphony.log` | 전체 시스템 로그 |
| `logs/<identifier>.log` | 이슈별 에이전트 로그 (예: `logs/KAN-9.log`) |
| `logs/pm2-err.log` | pm2가 캡처한 stderr (error 레벨) |
| `logs/pm2-out.log` | pm2가 캡처한 stdout (info/debug 레벨) |

### 재시작 정책

- 크래시 또는 비정상 종료 시 5초 후 자동 재시작
- 10초 이내에 10회 연속 실패하면 재시작 중단 (`pm2 restart symphony`로 수동 복구)
- 정상 종료(`make stop`)는 재시작하지 않음

---

## 8. 문제 해결

> **디버그 로깅**: 문제 추적 시 `.env`에 `LOG_LEVEL=debug`를 설정하면 상세 로그를 볼 수 있다. 변경 후 `make remote-upload`(원격) 또는 `make start`(서버 직접) 재시작 필요.

**`Slack socket: connected` 로그가 안 뜸**
- `SLACK_APP_TOKEN`이 `xapp-`으로 시작하는지 확인
- Slack 앱에서 Socket Mode가 활성화됐는지 확인
- App-Level Token에 `connections:write` scope가 있는지 확인

**슬랙 메시지에 답장해도 반응 없음**
- Event Subscriptions가 켜져 있는지 확인
- `message.channels` (또는 `message.groups`), `reaction_added` bot event가 구독됐는지 확인
- 봇이 해당 채널에 초대됐는지 확인 (`/invite @봇이름`)
- 앱 재설치 후 재시도

**이슈가 디스패치 안 됨**
- `WORKFLOW.md`의 `states` 값이 실제 Linear/Jira 상태 이름과 정확히 일치하는지 확인
- `assignee: me` 설정 시 해당 이슈가 본인에게 할당됐는지 확인

**Docker 컨테이너에서 Claude 인증 실패**
- `docker.auth_mount`에 `~/.claude` 경로가 정확한지 확인
- 호스트에서 `claude` 명령이 정상 동작하는지 확인

**`make remote-*` 실행 시 SSH 인증 실패**
- `.pem` 파일 권한 확인: `chmod 400 ~/.ssh/my-key.pem`
- `SYNC_HOST`의 유저명이 올바른지 확인 (Amazon Linux: `ec2-user`, Ubuntu: `ubuntu`)
- EC2 보안 그룹에서 포트 22(SSH)가 열려있는지 확인
