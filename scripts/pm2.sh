#!/usr/bin/env bash
set -euo pipefail

# nvm 환경 로드 (비로그인 쉘에서도 node/npm/pm2 PATH 확보)
export NVM_DIR="${HOME}/.nvm"
[[ -s "${NVM_DIR}/nvm.sh" ]] && source "${NVM_DIR}/nvm.sh"

COMMAND="${1:-}"

build() {
  echo "==> Building..."
  pnpm run build
}

case "$COMMAND" in
  init)
    echo "==> Installing pm2 globally..."
    npm install -g pm2  # pm2는 글로벌 설치라 npm 사용

    echo "==> Installing pm2-logrotate..."
    pm2 install pm2-logrotate
    pm2 set pm2-logrotate:max_size 50M
    pm2 set pm2-logrotate:retain 7
    pm2 set pm2-logrotate:compress true

    build

    echo "==> Building Docker worker image (symphony-worker:latest)..."
    pnpm run docker:build

    echo "==> Done. Run 'make start' to start symphony."
    ;;

  startup)
    echo "==> Registering pm2 startup hook..."
    eval "$(pm2 startup | grep -E '^sudo')"
    echo "==> Saving pm2 process list..."
    pm2 save
    echo "==> Done."
    ;;

  start)
    build
    echo "==> Building Docker worker image (symphony-worker:latest)..."
    pnpm run docker:build
    pm2 startOrRestart ecosystem.config.cjs
    ;;

  stop)
    pm2 stop symphony
    ;;

  logs)
    pm2 logs symphony
    ;;

  reload)
    pm2 sendSignal SIGHUP symphony
    ;;

  status)
    pm2 status
    ;;

  clean)
    echo "==> 프로세스 정지 중..."
    pm2 delete symphony 2>/dev/null || true
    pm2 save 2>/dev/null || true

    echo "==> 워크스페이스 삭제 중..."
    rm -rf symphony-workspaces/

    echo "==> symphony 컨테이너 제거 중..."
    if command -v docker &>/dev/null; then
      CONTAINERS=$(timeout 10 docker ps -a --filter "name=symphony-" -q 2>/dev/null || true)
      if [[ -n "$CONTAINERS" ]]; then
        echo "$CONTAINERS" | xargs timeout 30 docker rm -f || true
      fi
      echo "==> 컨테이너 정리 완료."
    else
      echo "==> Docker가 설치되어 있지 않습니다. 컨테이너 정리를 건너뜁니다."
    fi

    echo "==> 빌드 산출물 삭제 중..."
    rm -rf dist/

    echo "==> 초기화 완료. 로그(logs/)와 Docker 이미지는 유지됩니다."
    ;;

  *)
    echo "Usage: $0 {init|startup|start|stop|logs|reload|status|clean}"
    exit 1
    ;;
esac
