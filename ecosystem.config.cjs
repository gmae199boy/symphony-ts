// PM2 ecosystem 설정
// 사용법:
//   pm2 start ecosystem.config.cjs       # 시작
//   pm2 restart symphony                 # 재시작
//   pm2 stop symphony                    # 중지
//   pm2 logs symphony                    # 실시간 로그
//   pm2 sendSignal SIGHUP symphony       # 설정 핫 리로드 (SIGHUP)

module.exports = {
  apps: [
    {
      name: 'symphony',
      script: 'dist/index.js',
      cwd: __dirname,

      // 단일 인스턴스
      instances: 1,
      exec_mode: 'fork',

      // 여기에 --env-file을 전달하지 말 것.
      // 앱 내부에서 try-catch와 함께 process.loadEnvFile()을 사용함.
      // --env-file을 전달하면 .env가 없을 때 Node가 오류로 종료되어
      // 무한 재시작 루프가 발생함.
      node_args: '',

      // 크래시 또는 예기치 않은 종료 시 자동 재시작
      autorestart: true,
      max_restarts: 10,     // 10회 연속 실패 후 재시도 중단
      min_uptime: '10s',    // 10초 이내 종료는 재시작 실패로 간주
      restart_delay: 5000,  // 재시작 사이 5초 대기

      // 그레이스풀 셧다운:
      // 앱 내부: 30초 드레인 + 35초 하드 타임아웃 → pm2가 SIGKILL 전 40초 대기
      kill_timeout: 40000,

      // 로그 파일 (앱 자체 이슈 로그와 함께 logs/ 디렉토리에 저장)
      error_file: './logs/pm2-err.log',
      out_file: './logs/pm2-out.log',
      log_date_format: '',   // pm2 타임스탬프 접두어 비활성화 (앱이 자체적으로 기록)
      merge_logs: true,

      // 프로덕션에서는 파일 감시 비활성화
      watch: false,

      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
