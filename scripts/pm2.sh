#!/usr/bin/env bash
set -euo pipefail

# nvm 환경 로드 (비로그인 쉘에서도 node/npm/pm2 PATH 확보)
export NVM_DIR="${HOME}/.nvm"
[[ -s "${NVM_DIR}/nvm.sh" ]] && source "${NVM_DIR}/nvm.sh"

COMMAND="${1:-}"

build() {
  echo "==> Building..."
  npm run build
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
    npm run docker:build

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
    npm run docker:build
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

  *)
    echo "Usage: $0 {init|startup|start|stop|logs|reload|status}"
    exit 1
    ;;
esac
