#!/usr/bin/env node
/**
 * Symphony TypeScript — 진입점.
 *
 * 사용법:
 *   symphony [--workflow WORKFLOW.md]
 *
 * WORKFLOW.md 로드 순서:
 *   1. --workflow <path> CLI 인자
 *   2. $SYMPHONY_WORKFLOW 환경 변수
 *   3. ./WORKFLOW.md (기본값)
 */

import path from 'node:path';
import process from 'node:process';
import { loadWorkflow, reloadConfig } from './config/loader.js';
import { Orchestrator, type TransferableState } from './orchestrator.js';
import { ConcurrencyLimiter } from './concurrency-limiter.js';
import { logger } from './logger.js';
import type { AgentMessage } from './types.js';

// ---------------------------------------------------------------------------
// CLI 인자 파싱
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): { workflowPath: string } {
  let workflowPath = process.env['SYMPHONY_WORKFLOW'] ?? 'WORKFLOW.md';

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--workflow' && argv[i + 1]) {
      workflowPath = argv[i + 1];
      i++;
    }
  }

  return { workflowPath };
}

// ---------------------------------------------------------------------------
// 메인
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // 환경 변수를 읽기 전에 .env를 process.env에 로드.
  // Node 22+ 내장 기능 — dotenv 패키지 불필요.
  // .env가 없으면 조용히 건너뜀 (프로덕션/CI 환경은
  // 환경 변수를 직접 제공).
  const envPath = process.env['SYMPHONY_ENV_FILE'] ?? '.env';
  try {
    process.loadEnvFile(path.resolve(envPath));
    logger.info(`Loaded env from ${envPath}`);
  } catch {
    // 파일 없음 또는 읽기 불가 — 이미 설정된 환경 변수 사용
  }

  const { workflowPath } = parseArgs(process.argv.slice(2));
  const absWorkflowPath = path.resolve(workflowPath);

  logger.info(`Loading workflow config from ${absWorkflowPath}`);

  const { config, promptTemplate } = loadWorkflow(absWorkflowPath);

  const agentKinds = config.agents.backends.map((a) => a.kind).join(', ');
  logger.info(
    `Symphony starting: ${config.trackers.length} tracker(s), agents=[${agentKinds}], workspace_backend=${config.workspace_backend}`,
  );

  // 전역 동시성 제한기 — 모든 오케스트레이터가 공유
  const limiter = new ConcurrencyLimiter(config.agents.max_concurrent);

  // 트래커당 오케스트레이터 하나씩 생성
  let orchestrators = config.trackers.map(
    (trackerConfig) => new Orchestrator(config, trackerConfig, promptTemplate, limiter),
  );

  // 정상 종료 처리
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.info(`Received ${signal}; shutting down gracefully`);

    // 정상 종료가 멈출 경우를 대비한 강제 종료 폴백
    const hardTimeout = setTimeout(() => {
      logger.warn('Hard shutdown timeout reached; forcing exit');
      process.exit(1);
    }, 35_000);
    hardTimeout.unref();

    await Promise.allSettled(orchestrators.map((o) => o.stopAndWait(30_000)));
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  // 모든 오케스트레이터 시작

  /** 오케스트레이터에 로깅 이벤트 리스너를 등록. */
  function registerOrchestratorEvents(o: Orchestrator): void {
    o.on('agent:completed', (issue) => {
      logger.info(`✓ Agent completed: ${issue.identifier}`);
    });

    o.on('agent:failed', (issue, err) => {
      logger.error(`✗ Agent failed: ${issue.identifier}`, { error: String(err) });
    });

    o.on('agent:message', (_issueId: string, _msg: AgentMessage) => {
      // raw JSON 로깅 비활성화 — 파싱된 semantic 로그는 claude.ts에서 출력됨
    });
  }

  orchestrators.forEach((o) => {
    registerOrchestratorEvents(o);
    o.start();
  });

  // SIGHUP — 프로세스를 종료하지 않고 설정 핫 리로드
  let reloading = false;
  process.on('SIGHUP', () => {
    if (reloading) { logger.warn('Reload already in progress, ignoring SIGHUP'); return; }
    if (shuttingDown) { logger.warn('Shutdown in progress, ignoring SIGHUP'); return; }
    void handleReload();
  });

  async function handleReload(): Promise<void> {
    reloading = true;
    logger.info('SIGHUP received — reloading config...');

    try {
      // 1. .env 재로드
      try { process.loadEnvFile(path.resolve(envPath)); } catch { /* absent is ok */ }

      // 2. config 재로드
      const { config: newConfig, promptTemplate: newTemplate } = reloadConfig(absWorkflowPath);

      // 3. 기존 orchestrator drain + 상태 추출
      const states = await Promise.all(
        orchestrators.map((o) => o.drainForSwap()),
      );

      // 4. 상태 병합
      const merged = mergeTransferableStates(states);

      // 5. 새 limiter + orchestrator 생성
      const newLimiter = new ConcurrencyLimiter(newConfig.agents.max_concurrent);
      const newOrchestrators = newConfig.trackers.map((tc) => {
        const o = new Orchestrator(newConfig, tc, newTemplate, newLimiter);
        o.injectState(merged);
        return o;
      });

      // 6. 기존 orchestrator 리스너 정리 후 재등록 + 시작
      orchestrators.forEach((o) => o.removeAllListeners());
      newOrchestrators.forEach((o) => {
        registerOrchestratorEvents(o);
        o.start();
      });

      orchestrators = newOrchestrators;
      logger.info('Config reloaded successfully');
    } catch (err) {
      logger.error('Config reload failed — keeping current config', { error: String(err) });
    } finally {
      reloading = false;
    }
  }

  logger.info('Symphony is running. Press Ctrl+C to stop.');

  // 프로세스 유지
  await new Promise<void>(() => {
    // 시그널 핸들러를 통해서만 resolve됨
  });
}

// ---------------------------------------------------------------------------
// 헬퍼 함수
// ---------------------------------------------------------------------------

/** 여러 TransferableState 객체를 하나로 병합 (키 충돌 시 나중 항목이 우선). */
function mergeTransferableStates(states: TransferableState[]): TransferableState {
  const merged: TransferableState = {
    issuePhases: new Map(),
    pendingDispatch: new Set(),
    watchedIssues: new Map(),
    queuedComments: new Map(),
    recentlyMerged: new Map(),
    completedCount: 0,
    failedCount: 0,
  };

  for (const s of states) {
    for (const [k, v] of s.issuePhases) merged.issuePhases.set(k, v);
    for (const v of s.pendingDispatch) merged.pendingDispatch.add(v);
    for (const [k, v] of s.watchedIssues) merged.watchedIssues.set(k, v);
    for (const [k, v] of s.queuedComments) merged.queuedComments.set(k, v);
    for (const [k, v] of s.recentlyMerged) merged.recentlyMerged.set(k, v);
    merged.completedCount += s.completedCount;
    merged.failedCount += s.failedCount;
  }

  return merged;
}

main().catch((err) => {
  logger.error('Fatal error', { error: String(err) });
  process.exit(1);
});
