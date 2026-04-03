# =============================================================================
# Symphony — Task Runner
#
# 서버에서 직접 실행: make <target>
# 로컬에서 원격 실행: make remote-<target>
#
# 원격 실행 전 .sync.env 파일을 설정해야 합니다. (.sync.env.example 참고)
# =============================================================================

.PHONY: init startup start stop logs reload status clean \
        remote-upload remote-init remote-startup remote-start \
        remote-stop remote-logs remote-reload remote-status remote-clean

# -----------------------------------------------------------------------------
# 서버에서 직접 실행 (서버에 SSH 접속한 후 사용)
# -----------------------------------------------------------------------------

## pm2, pm2-logrotate 설치 및 빌드.
## 최초 서버 세팅 시 또는 pm2를 새로 설치할 때 실행.
## 시작은 포함되지 않음 — 이후 make start 실행.
init:
	bash scripts/pm2.sh init

## 서버 재부팅 시 pm2 자동 실행 등록 (launchd/systemd).
## 최초 1회만 실행하면 됨. 이미 실행 중인 상태에서 해도 무방.
## pm2 startup 명령이 내부적으로 sudo를 처리하므로 별도 sudo 불필요.
startup:
	bash scripts/pm2.sh startup

## 빌드(tsc) 후 symphony를 시작하거나 재시작.
## 처음 시작할 때와 코드 변경 후 재시작할 때 모두 사용.
start:
	bash scripts/pm2.sh start

## symphony 프로세스 정지.
## pm2가 재시작하지 않음 (autorestart 대상에서 제외).
stop:
	bash scripts/pm2.sh stop

## pm2 실시간 로그 스트리밍 (Ctrl+C로 종료).
## stdout(info/debug)과 stderr(error)를 함께 출력.
logs:
	bash scripts/pm2.sh logs

## 빌드 없이 WORKFLOW.md config만 hot reload (SIGHUP 전송).
## 프로세스를 재시작하지 않고 설정만 다시 읽음.
reload:
	bash scripts/pm2.sh reload

## pm2 프로세스 상태 확인 (uptime, restart 횟수, cpu/mem 등).
status:
	bash scripts/pm2.sh status

## 프로세스 정지 후 워크스페이스, 컨테이너, pm2 등록을 모두 초기화.
## 로그는 유지됨. Docker 이미지는 삭제하지 않음.
clean:
	bash scripts/pm2.sh clean

# -----------------------------------------------------------------------------
# 로컬에서 원격 실행 (.sync.env 설정 필요)
# -----------------------------------------------------------------------------

## 변경된 파일을 EC2에 동기화(rsync)한 후 npm install, 빌드, 재시작까지 수행.
## .env 포함 전송. node_modules, dist, logs, .git, .sync.env는 제외.
## 일반적인 코드 업데이트 시 사용.
remote-upload:
	bash scripts/remote.sh upload

## 최초 서버 세팅. 파일 전송 → pnpm install → make init → make start → make startup 순서로 실행.
## pm2 startup 명령이 내부적으로 sudo를 처리하므로 별도 sudo 불필요.
remote-init:
	bash scripts/remote.sh init

## 원격 서버에서 pm2 startup 등록 (재부팅 자동 실행).
## remote-init에 포함되어 있으므로 별도로 실행할 필요는 없음.
## pm2를 재설치하거나 프로세스 목록이 바뀐 경우에 사용.
remote-startup:
	bash scripts/remote.sh startup

## 원격 서버에서 빌드 후 시작/재시작.
## 파일 전송 없이 이미 올라간 코드로 재시작할 때 사용.
remote-start:
	bash scripts/remote.sh start

## 원격 서버의 symphony 프로세스 정지.
remote-stop:
	bash scripts/remote.sh stop

## 원격 서버의 실시간 로그를 로컬 터미널에 스트리밍 (Ctrl+C로 종료).
remote-logs:
	bash scripts/remote.sh logs

## 원격 서버에서 빌드 없이 WORKFLOW.md config hot reload.
remote-reload:
	bash scripts/remote.sh reload

## 원격 서버의 pm2 프로세스 상태 확인.
remote-status:
	bash scripts/remote.sh status

## 원격 서버의 프로세스, 워크스페이스, 컨테이너 초기화.
remote-clean:
	bash scripts/remote.sh clean
