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
import { ensureDockerImage } from './workspace/docker.js';
import { ConcurrencyLimiter } from './concurrency-limiter.js';
import { logger } from './logger.js';
import { spawnAsync } from './spawn-async.js';
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
// Git 업데이트 체크
// ---------------------------------------------------------------------------

async function checkForUpdates(): Promise<void> {
  const fetch = await spawnAsync('git', ['fetch', '--quiet'], { timeoutMs: 10_000 });
  if (fetch.status !== 0) return; // git 없음 또는 remote 없음 — 조용히 스킵

  const behind = await spawnAsync('git', ['rev-list', 'HEAD..@{u}', '--count'], { timeoutMs: 5_000 });
  if (behind.status !== 0) return; // upstream 미설정 — 스킵

  const count = parseInt(behind.stdout.trim(), 10);
  if (count > 0) {
    logger.notice(`업데이트 ${count}개 있음 — 'git pull' 후 재시작하세요`);
  }
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

  await checkForUpdates();

  const agentKinds = config.agents.backends.map((a) => a.kind).join(', ');
  logger.info(
    `Symphony starting: ${config.trackers.length} tracker(s), agents=[${agentKinds}], workspace_backend=${config.workspace_backend}`,
  );

  if (config.workspace_backend === 'docker') {
    await ensureDockerImage(config);
  }

  // 전역 컨테이너 admission 집합 — 모든 오케스트레이터가 공유
  const limiter = new ConcurrencyLimiter(config.agents.max_containers);

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

      // 2. config 재로드 — 실패하면 drain 없이 기존 오케스트레이터 유지
      let newConfig: typeof config;
      let newTemplate: string;
      try {
        ({ config: newConfig, promptTemplate: newTemplate } = reloadConfig(absWorkflowPath));
      } catch (err) {
        logger.error('Config reload failed — keeping current config', { error: String(err) });
        return;
      }

      // 3. 기존 orchestrator drain + 인덱스별 상태 추출
      // Promise.allSettled: 일부 drain 실패 시에도 나머지 오케스트레이터는 정상 처리
      const drainResults = await Promise.allSettled(
        orchestrators.map((o) => o.drainForSwap()),
      );

      // 빈 상태 팩토리 (새 트래커가 추가된 경우 또는 drain 실패 시 fallback)
      const emptyState = (): TransferableState => ({
        issuePhases: new Map(),
        pendingDispatch: new Set(),
        watchedIssues: new Map(),
        queuedComments: new Map(),
        recentlyMerged: new Map(),
        recentlyTerminated: new Map(),
        missingTickCounts: new Map(),
        completedCount: 0,
        failedCount: 0,
        admittedIdentifiers: [],
      });

      // drain 결과 처리: 실패한 오케스트레이터는 stop() 후 빈 상태로 대체
      const states: TransferableState[] = drainResults.map((result, i) => {
        if (result.status === 'fulfilled') return result.value;
        logger.error(
          `Orchestrator[${i}] drain failed — state lost for this tracker, using empty state`,
          { error: String(result.reason) },
        );
        // drain 실패한 구 오케스트레이터 정리 (best-effort)
        void orchestrators[i]?.stop().catch(() => undefined);
        return emptyState();
      });

      const drainFailCount = drainResults.filter((r) => r.status === 'rejected').length;
      if (drainFailCount > 0) {
        logger.warn(`${drainFailCount}개 오케스트레이터 drain 실패 — 해당 트래커 상태가 초기화됩니다.`);
      }

      // 4. 전역 admitted 병합 (공유 limiter 시딩용)
      const globalAdmitted = mergeTransferableStates(states).admittedIdentifiers;

      // 5. 새 limiter + orchestrator 생성 (인덱스별 상태 라우팅, start 전)
      const newLimiter = new ConcurrencyLimiter(newConfig.agents.max_containers);
      const newOrchestrators = newConfig.trackers.map((tc, i) => {
        const o = new Orchestrator(newConfig, tc, newTemplate, newLimiter);
        // 동일 인덱스 old orchestrator의 상태를 주입; admittedIdentifiers는 전역 병합 사용
        const perState = states[i] ?? emptyState();
        o.injectState({ ...perState, admittedIdentifiers: globalAdmitted });
        return o;
      });

      // 6. start() 시도 — HumanChannel 초기화 실패 등의 경우 rollback
      try {
        orchestrators.forEach((o) => o.removeAllListeners());
        newOrchestrators.forEach((o) => {
          registerOrchestratorEvents(o);
          o.start();
        });
      } catch (startErr) {
        logger.error('New orchestrator start failed — rolling back to old config', { error: String(startErr) });
        for (const o of newOrchestrators) {
          try { await o.stop(); } catch { /* best-effort */ }
        }
        // 기존 오케스트레이터는 drain으로 이미 stopped → 기존 config로 재생성
        const rollbackLimiter = new ConcurrencyLimiter(config.agents.max_containers);
        const rollbackOrchestrators = config.trackers.map((tc, i) => {
          const o = new Orchestrator(config, tc, promptTemplate, rollbackLimiter);
          const perState = states[i] ?? emptyState();
          o.injectState({ ...perState, admittedIdentifiers: globalAdmitted });
          return o;
        });
        try {
          rollbackOrchestrators.forEach((o) => {
            registerOrchestratorEvents(o);
            o.start();
          });
        } catch (rollbackErr) {
          logger.error('CRITICAL: rollback orchestrator start also failed — exiting', { error: String(rollbackErr) });
          process.exit(1);
        }
        orchestrators = rollbackOrchestrators;
        return;
      }

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
    recentlyTerminated: new Map(),
    missingTickCounts: new Map(),
    canceledPendingMap: new Map(),
    completedCount: 0,
    failedCount: 0,
    admittedIdentifiers: [],
  };

  const admittedSet = new Set<string>();
  for (const s of states) {
    for (const [k, v] of s.issuePhases) merged.issuePhases.set(k, v);
    for (const v of s.pendingDispatch) merged.pendingDispatch.add(v);
    for (const [k, v] of s.watchedIssues) merged.watchedIssues.set(k, v);
    for (const [k, v] of s.queuedComments) merged.queuedComments.set(k, v);
    for (const [k, v] of s.recentlyMerged) merged.recentlyMerged.set(k, v);
    for (const [k, v] of (s.recentlyTerminated ?? [])) merged.recentlyTerminated.set(k, v);
    for (const [k, v] of (s.missingTickCounts ?? [])) merged.missingTickCounts.set(k, v);
    for (const [k, v] of (s.canceledPendingMap ?? [])) merged.canceledPendingMap!.set(k, v);
    merged.completedCount += s.completedCount;
    merged.failedCount += s.failedCount;
    for (const id of s.admittedIdentifiers ?? []) admittedSet.add(id);
  }
  merged.admittedIdentifiers = [...admittedSet];

  return merged;
}

main().catch((err) => {
  logger.error('Fatal error', { error: String(err) });
  process.exit(1);
});
