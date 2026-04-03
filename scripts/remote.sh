#!/usr/bin/env bash
set -euo pipefail

COMMAND="${1:-}"

# ---------------------------------------------------------------------------
# .sync.env에서 연결 설정 로드
# ---------------------------------------------------------------------------

if [[ ! -f .sync.env ]]; then
  echo "오류: .sync.env 파일이 없습니다. .sync.env.example을 복사하고 값을 채워주세요."
  exit 1
fi

while IFS='=' read -r key value; do
  [[ "$key" =~ ^[[:space:]]*# ]] && continue
  [[ -z "$key" ]] && continue
  declare "$key=$value"
done < .sync.env

: "${SYNC_HOST:?SYNC_HOST가 .sync.env에 설정되지 않았습니다}"
: "${SYNC_REMOTE_PATH:?SYNC_REMOTE_PATH가 .sync.env에 설정되지 않았습니다}"

# ~는 file read 시 확장되지 않으므로 직접 처리
if [[ "${SYNC_KEY:-}" == "~"* ]]; then
  SYNC_KEY="${HOME}${SYNC_KEY:1}"
fi

# ---------------------------------------------------------------------------
# SSH 인증 방식 결정
#
# 우선순위:
#   - SYNC_KEY와 ~/.ssh/config 항목 모두 존재 → SSH config 사용 (키 무시)
#   - SYNC_KEY만 설정됨                        → -i SYNC_KEY 사용
#   - ~/.ssh/config 항목만 존재               → SSH config 사용
#   - 둘 다 없음                               → 오류
# ---------------------------------------------------------------------------

_HOST_ONLY="${SYNC_HOST#*@}"

_has_ssh_config() {
  [[ -f ~/.ssh/config ]] && grep -qE "^[[:space:]]*Host[[:space:]]+${_HOST_ONLY}([[:space:]]|$)" ~/.ssh/config
}

_SSH_OPTS="-o StrictHostKeyChecking=no -o ConnectTimeout=15 -o ServerAliveInterval=10 -o ServerAliveCountMax=3"

if _has_ssh_config && [[ -n "${SYNC_KEY:-}" ]]; then
  echo "==> '${_HOST_ONLY}'에 대한 SSH config 항목이 있습니다 — ~/.ssh/config 사용 (SYNC_KEY 무시)"
  SSH="ssh ${_SSH_OPTS}"
  RSYNC_SSH="ssh ${_SSH_OPTS}"
elif [[ -n "${SYNC_KEY:-}" ]]; then
  SSH="ssh -i ${SYNC_KEY} ${_SSH_OPTS}"
  RSYNC_SSH="ssh -i ${SYNC_KEY} ${_SSH_OPTS}"
elif _has_ssh_config; then
  SSH="ssh ${_SSH_OPTS}"
  RSYNC_SSH="ssh ${_SSH_OPTS}"
else
  echo "오류: SSH 인증 방식을 찾을 수 없습니다."
  echo "  방법 1: .sync.env에 SYNC_KEY 설정 (예: SYNC_KEY=~/.ssh/my-key.pem)"
  echo "  방법 2: ~/.ssh/config에 '${_HOST_ONLY}'에 대한 Host 항목 추가"
  exit 1
fi

# ---------------------------------------------------------------------------
# rsync 설치 여부 확인 (로컬 및 원격)
# ---------------------------------------------------------------------------

# SYNC_KEY의 ~는 file read 시 확장되지 않으므로 직접 처리
if [[ "${SYNC_KEY:-}" == "~"* ]]; then
  SYNC_KEY="${HOME}${SYNC_KEY:1}"
fi

ensure_brew_local() {
  if command -v brew &>/dev/null; then
    return
  fi
  if [[ "$(uname)" == "Darwin" ]]; then
    echo "==> Homebrew가 없습니다. 설치 중..."
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  fi
}

ensure_rsync_local() {
  if command -v rsync &>/dev/null; then
    return
  fi
  echo "==> 로컬에 rsync가 없습니다. 설치 중..."
  if [[ "$(uname)" == "Darwin" ]]; then
    ensure_brew_local
    brew install rsync
  elif command -v apt-get &>/dev/null; then
    sudo apt-get install -y rsync
  elif command -v yum &>/dev/null; then
    sudo yum install -y rsync
  else
    echo "오류: rsync를 로컬에 설치할 수 없습니다. 수동으로 설치해주세요."
    exit 1
  fi
}

ensure_rsync_remote() {
  if ${SSH} "${SYNC_HOST}" "command -v rsync" &>/dev/null; then
    return
  fi
  echo "==> 원격 서버에 rsync가 없습니다. 설치 중..."
  ${SSH} "${SYNC_HOST}" "
    if command -v apt-get &>/dev/null; then
      sudo apt-get install -y rsync
    elif command -v yum &>/dev/null; then
      sudo yum install -y rsync
    elif command -v brew &>/dev/null; then
      brew install rsync
    else
      echo '오류: 원격 서버에 rsync를 설치할 수 없습니다. 수동으로 설치해주세요.' && exit 1
    fi
  "
}

ensure_rsync() {
  ensure_rsync_local
  ensure_rsync_remote
}

ensure_remote_deps() {
  echo "==> 원격 서버 의존성 확인 중 (nvm, Node 24, pnpm, make, Docker)..."
  ${SSH} "${SYNC_HOST}" 'bash -lc '"'"'
    set -euo pipefail

    # --- nvm ---
    export NVM_DIR="${HOME}/.nvm"
    if [[ ! -s "${NVM_DIR}/nvm.sh" ]]; then
      echo "==> nvm이 없습니다. 설치 중..."
      curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
    fi
    source "${NVM_DIR}/nvm.sh"

    # --- Node 24 ---
    if ! nvm ls 24 | grep -q "v24"; then
      echo "==> Node 24가 없습니다. 설치 중..."
      nvm install 24
    fi

    # --- Node 24가 활성화되지 않은 경우 전환 ---
    CURRENT=$(node --version 2>/dev/null || echo "none")
    if [[ "${CURRENT}" != v24* ]]; then
      echo "==> Node 24로 전환 중..."
      nvm use 24
    fi
    nvm alias default 24

    # --- pnpm ---
    if ! command -v pnpm &>/dev/null; then
      echo "==> pnpm이 없습니다. 설치 중..."
      npm install -g pnpm
    fi

    # --- make ---
    if ! command -v make &>/dev/null; then
      echo "==> make가 없습니다. 설치 중..."
      if command -v yum &>/dev/null; then
        sudo yum install -y make
      elif command -v apt-get &>/dev/null; then
        sudo apt-get install -y make
      else
        echo "오류: make를 설치할 수 없습니다. 수동으로 설치해주세요." && exit 1
      fi
    fi

    # --- Claude Code ---
    if ! command -v claude &>/dev/null; then
      echo "==> Claude Code가 없습니다. 설치 중..."
      npm install -g @anthropic-ai/claude-code
    fi

    # --- Docker ---
    if ! command -v docker &>/dev/null; then
      echo "==> Docker가 없습니다. 설치 중..."
      if command -v yum &>/dev/null; then
        sudo yum install -y docker
        sudo systemctl enable docker
        sudo systemctl start docker
        sudo usermod -aG docker "${USER}"
        echo "==> Docker 설치 완료. 그룹 변경 적용을 위해 재로그인이 필요합니다."
      elif command -v apt-get &>/dev/null; then
        sudo apt-get update -y
        sudo apt-get install -y docker.io
        sudo systemctl enable docker
        sudo systemctl start docker
        sudo usermod -aG docker "${USER}"
        echo "==> Docker 설치 완료. 그룹 변경 적용을 위해 재로그인이 필요합니다."
      else
        echo "오류: Docker를 설치할 수 없습니다. 수동으로 설치해주세요." && exit 1
      fi
    fi

    echo "==> 원격 의존성 확인 완료 — $(node --version), pnpm $(pnpm --version), claude $(claude --version 2>/dev/null || echo '미설치'), make $(make --version | head -1), docker $(docker --version)"
  '"'"
}

# ---------------------------------------------------------------------------
# 커맨드
# ---------------------------------------------------------------------------

case "$COMMAND" in
  upload)
    ensure_rsync
    echo "==> ${SYNC_HOST}:${SYNC_REMOTE_PATH}으로 파일 동기화 중..."
    rsync -avz --delete \
      --exclude node_modules/ \
      --exclude dist/ \
      --exclude logs/ \
      --exclude .git/ \
      --exclude .sync.env \
      -e "${RSYNC_SSH}" \
      ./ "${SYNC_HOST}:${SYNC_REMOTE_PATH}/"

    echo "==> 원격 서버에서 의존성 설치 중..."
    ${SSH} "${SYNC_HOST}" "bash -lc 'cd ${SYNC_REMOTE_PATH} && pnpm install'"

    echo "==> 원격 서버에서 빌드 및 시작 중..."
    ${SSH} "${SYNC_HOST}" "bash -lc 'cd ${SYNC_REMOTE_PATH} && make start'"
    ;;

  init)
    ensure_rsync
    ensure_remote_deps
    echo "==> ${SYNC_HOST}:${SYNC_REMOTE_PATH}으로 파일 동기화 중..."
    rsync -avz --delete \
      --exclude node_modules/ \
      --exclude dist/ \
      --exclude logs/ \
      --exclude .git/ \
      --exclude .sync.env \
      -e "${RSYNC_SSH}" \
      ./ "${SYNC_HOST}:${SYNC_REMOTE_PATH}/"

    echo "==> 원격 서버에서 init + start + startup 실행 중..."
    ${SSH} "${SYNC_HOST}" "bash -lc 'cd ${SYNC_REMOTE_PATH} && pnpm install && make init && make start && make startup'"
    ;;

  startup)
    echo "==> 원격 서버에 pm2 startup 훅 등록 중..."
    ${SSH} "${SYNC_HOST}" "cd ${SYNC_REMOTE_PATH} && make startup"
    ;;

  start)
    echo "==> 원격 서버에서 빌드 및 시작 중..."
    ${SSH} "${SYNC_HOST}" "cd ${SYNC_REMOTE_PATH} && make start"
    ;;

  stop)
    echo "==> 원격 서버 프로세스 정지 중..."
    ${SSH} "${SYNC_HOST}" "cd ${SYNC_REMOTE_PATH} && make stop"
    ;;

  logs)
    echo "==> 원격 서버 로그 스트리밍 중 (Ctrl+C로 종료)..."
    ${SSH} -t "${SYNC_HOST}" "cd ${SYNC_REMOTE_PATH} && make logs"
    ;;

  reload)
    echo "==> 원격 서버에 SIGHUP 전송 (hot reload)..."
    ${SSH} "${SYNC_HOST}" "cd ${SYNC_REMOTE_PATH} && make reload"
    ;;

  status)
    echo "==> 원격 서버 상태 확인 중..."
    ${SSH} "${SYNC_HOST}" "cd ${SYNC_REMOTE_PATH} && make status"
    ;;

  clean)
    echo "==> 원격 서버 초기화 중..."
    ${SSH} "${SYNC_HOST}" "bash -lc 'cd ${SYNC_REMOTE_PATH} && make clean'"
    ;;

  *)
    echo "사용법: $0 {upload|init|startup|start|stop|logs|reload|status|clean}"
    exit 1
    ;;
esac
