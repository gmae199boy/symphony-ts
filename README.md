# Symphony TS

이슈 트래커(Linear, Jira)와 연동해 코드 작업을 자동화하는 AI 에이전트 오케스트레이터.
이슈를 감지하면 계획을 수립해 Slack으로 승인을 요청하고, 승인 후 구현 → 셀프 리뷰 → PR 생성까지 자동으로 처리한다.

## 빠른 시작

```bash
pnpm install
cp .env.example .env   # 토큰 입력
npm run build
npm start
```

## 문서

- [설정 가이드 (SETUP.md)](docs/SETUP.md) — 환경변수, WORKFLOW.md 설정, Slack 앱 설정
- [아키텍처 (ARCHITECTURE.md)](docs/ARCHITECTURE.md) — 시스템 구조 및 설계
- [전체 설정 예시 (WORKFLOW.example.yml)](WORKFLOW.example.yml)
