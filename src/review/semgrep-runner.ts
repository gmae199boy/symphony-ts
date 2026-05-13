/**
 * semgrep 정적 분석 실행 모듈.
 *
 * 오케스트레이터의 셀프리뷰 파이프라인에서 에이전트 리뷰 라운드와 병렬로 실행된다.
 * 결과는 consolidation 프롬프트에 포함되어 메인 에이전트가 에이전트 리뷰 결과와 함께 통합한다.
 */

import { spawnAsync } from '../spawn-async.js';
import { shellEscape } from '../shell-utils.js';
import { logger } from '../logger.js';
import type { WorkspaceRef } from '../types.js';
import type { SemgrepConfig } from '../config/schema.js';

// 락파일·자동 생성 파일은 semgrep 스캔 대상에서 제외 (OOM 방지)
const SEMGREP_EXCLUDED_RE = /(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lock|composer\.lock|Gemfile\.lock|Cargo\.lock|go\.sum|poetry\.lock)$/i;

// ---------------------------------------------------------------------------
// semgrep JSON 출력 타입 (필요한 필드만 정의)
// ---------------------------------------------------------------------------

interface SemgrepFinding {
  check_id: string;
  path: string;
  start: { line: number };
  extra: {
    message: string;
    severity: string; // ERROR | WARNING | INFO
    metadata?: Record<string, unknown>;
  };
}

interface SemgrepOutput {
  results: SemgrepFinding[];
  errors?: Array<{ message: string }>;
}

// ---------------------------------------------------------------------------
// 공개 API
// ---------------------------------------------------------------------------

/**
 * WorkspaceRef의 워크스페이스에서 semgrep을 실행하고 결과를 포맷된 문자열로 반환한다.
 * 설정이 없거나 실행 실패 시 null을 반환한다 (graceful degradation).
 *
 * @param ref - 워크스페이스 참조 (로컬 또는 Docker 컨테이너)
 * @param config - semgrep 설정
 * @param baseBranch - diff 기반 필터링에 사용할 기준 브랜치
 */
export async function runSemgrep(
  ref: WorkspaceRef,
  config: SemgrepConfig,
  baseBranch: string,
): Promise<string | null> {
  try {
    // diff 기반 필터링: 변경된 파일만 스캔하여 노이즈 감소
    const changedFiles = await getChangedFiles(ref, baseBranch);

    if (changedFiles.length === 0) {
      logger.info('[semgrep] 변경된 파일 없음 — 스캔 건너뜀');
      return null;
    }

    // config.paths 기준으로 필터링 — paths=['.']이면 전부 통과
    const filteredFiles = config.paths.includes('.')
      ? changedFiles
      : changedFiles.filter((f) => config.paths.some((p) => f.startsWith(p)));

    if (filteredFiles.length === 0) {
      logger.info('[semgrep] 변경 파일이 config.paths 범위 밖 — 스캔 건너뜀');
      return null;
    }

    const scanTargets = filteredFiles.filter((f) => !SEMGREP_EXCLUDED_RE.test(f));
    if (scanTargets.length === 0) {
      logger.info('[semgrep] 변경 파일 전체가 제외 대상(락파일 등) — 스캔 건너뜀');
      return null;
    }

    logger.info(`[semgrep] ${scanTargets.length}개 대상 스캔 시작`);

    const rawOutput = await spawnSemgrep(ref, config, scanTargets);
    if (rawOutput === null) return null;

    const parsed = parseSemgrepOutput(rawOutput);
    if (parsed === null) return null;

    // 발견 사항이 없으면 null 반환 — consolidation 프롬프트에 불필요한 토큰 낭비 방지
    if (parsed.results.length === 0) {
      logger.info('[semgrep] 발견 사항 없음');
      return null;
    }

    const formatted = formatSemgrepForReview(parsed, config.severity_map);
    return formatted;
  } catch (err) {
    logger.warn('[semgrep] 실행 중 예외 발생', { error: maskToken(String(err), config.app_token) });
    return null;
  }
}

// ---------------------------------------------------------------------------
// 내부 구현
// ---------------------------------------------------------------------------

/** diff 기반으로 변경된 파일 목록을 반환한다. */
async function getChangedFiles(ref: WorkspaceRef, baseBranch: string): Promise<string[]> {
  // spawnAsync에 args 배열로 직접 전달 — 셸을 거치지 않으므로 브랜치명 이스케이프 불필요
  const range = `origin/${baseBranch}...HEAD`;
  const gitArgs = ['diff', '--name-only', range];

  const primary = ref.containerName
    ? await spawnAsync('docker', ['exec', '--workdir', ref.workspace, '--user', 'worker', ref.containerName, 'git', ...gitArgs], { timeoutMs: 30_000 })
    : await spawnAsync('git', gitArgs, { cwd: ref.workspace, timeoutMs: 30_000 });

  if (primary.status === 0 && primary.stdout.trim()) {
    return primary.stdout.split('\n').map((f) => f.trim()).filter(Boolean);
  }

  // 폴백: origin/<branch> 접근 실패 시 HEAD~1 기준
  const fallback = ref.containerName
    ? await spawnAsync('docker', ['exec', '--workdir', ref.workspace, '--user', 'worker', ref.containerName, 'git', 'diff', '--name-only', 'HEAD~1'], { timeoutMs: 30_000 })
    : await spawnAsync('git', ['diff', '--name-only', 'HEAD~1'], { cwd: ref.workspace, timeoutMs: 30_000 });

  return fallback.stdout.split('\n').map((f) => f.trim()).filter(Boolean);
}

/**
 * semgrep 실행에 사용할 cmd/args/env를 반환한다 (순수 함수 — 테스트 가능).
 * app_token이 설정된 경우 SEMGREP_APP_TOKEN을 argv가 아닌 프로세스 환경변수로 전달해 argv 노출을 방지한다.
 * @internal 테스트 전용 export — 외부 모듈에서 직접 사용하지 말 것.
 */
export function buildSemgrepSpawnArgs(
  ref: WorkspaceRef,
  config: SemgrepConfig,
  targets: string[],
): { cmd: string; args: string[]; env?: NodeJS.ProcessEnv } {
  const configArgs = config.config.flatMap((c) => ['--config', c]);
  const semgrepArgs = ['--json', '--no-git-ignore', ...configArgs, '--', ...targets];
  const semgrepCmd = [config.command, ...semgrepArgs].map(shellEscape).join(' ');
  const innerCmd = `cd ${shellEscape(ref.workspace)} && ${semgrepCmd}`;
  const env = config.app_token
    ? { ...process.env, SEMGREP_APP_TOKEN: config.app_token }
    : undefined;

  if (ref.containerName) {
    const dockerArgs = ['exec', '--user', 'worker'];
    if (config.app_token) {
      // --env KEY (값 없음): docker exec가 호스트 env에서 SEMGREP_APP_TOKEN을 상속받아 컨테이너에 전달
      dockerArgs.push('--env', 'SEMGREP_APP_TOKEN');
    }
    dockerArgs.push(ref.containerName, 'bash', '-lc', innerCmd);
    return { cmd: 'docker', args: dockerArgs, env };
  }
  return { cmd: 'bash', args: ['-lc', innerCmd], env };
}

/** 텍스트에 포함된 토큰을 *** 로 마스킹한다. */
function maskToken(text: string, token: string | undefined): string {
  if (!token) return text;
  return text.replaceAll(token, '***');
}

/** semgrep을 실행하고 raw JSON 출력 문자열을 반환한다. */
async function spawnSemgrep(
  ref: WorkspaceRef,
  config: SemgrepConfig,
  targets: string[],
): Promise<string | null> {
  const { cmd, args, env } = buildSemgrepSpawnArgs(ref, config, targets);
  const token = config.app_token;

  // 토큰은 env로 전달되므로 args에 포함되지 않음 — maskToken은 stderr/예외 에코 방어용
  logger.debug('[semgrep] 실행', { cmd, args });

  const result = await spawnAsync(cmd, args, { timeoutMs: config.timeout_ms, killTimeoutMs: 5_000, env });

  if (result.timedOut) {
    logger.warn(`[semgrep] 타임아웃 (${config.timeout_ms}ms) — 결과 없음으로 처리`);
    return null;
  }
  if (result.stderr.trim()) {
    logger.debug(`[semgrep/stderr] ${maskToken(result.stderr.trim(), token)}`);
  }
  if (result.status !== null && result.status >= 2) {
    logger.warn(`[semgrep] 비정상 종료 (exit code: ${result.status}) — 부분 결과일 수 있음`);
  }
  if (!result.stdout.trim()) {
    logger.warn(`[semgrep] 출력 없음 (exit code: ${result.status})`);
    return null;
  }
  return result.stdout;
}

/** semgrep JSON 출력을 파싱한다. 파싱 실패 시 null 반환. */
export function parseSemgrepOutput(rawJson: string): SemgrepOutput | null {
  try {
    const parsed = JSON.parse(rawJson) as SemgrepOutput;
    if (!Array.isArray(parsed.results)) {
      logger.warn('[semgrep] JSON 파싱 결과에 results 필드 없음');
      return null;
    }
    // #14 NIT: 각 항목 최소 구조 검증 — 필수 필드가 없는 항목 제거
    parsed.results = parsed.results.filter(
      (r) =>
        typeof r.check_id === 'string' &&
        typeof r.path === 'string' &&
        typeof r.start?.line === 'number',
    );
    // #4 SUGGESTION: errors 배열 존재 시 경고 로그
    if (parsed.errors && parsed.errors.length > 0) {
      logger.warn(`[semgrep] ${parsed.errors.length}개 파싱 에러 발생`, {
        errors: parsed.errors.map((e) => e.message),
      });
    }
    return parsed;
  } catch (err) {
    logger.warn('[semgrep] JSON 파싱 실패', { error: String(err) });
    return null;
  }
}

/**
 * semgrep 결과를 consolidation 프롬프트에 포함할 텍스트로 변환한다.
 * severity 테이블 형식은 아니며, 에이전트가 최종 통합 시 변환한다.
 */
export function formatSemgrepForReview(
  output: SemgrepOutput,
  severityMap: SemgrepConfig['severity_map'],
): string {
  // #10 NIT: 타입 명시로 타입 안전성 향상
  const counts: Record<'ERROR' | 'WARNING' | 'INFO', number> = { ERROR: 0, WARNING: 0, INFO: 0 };
  const lines: string[] = ['--- semgrep static analysis ---'];

  for (const finding of output.results) {
    // #11 NIT: || 사용으로 빈 문자열("")도 falsy 처리
    const rawSeverity = (finding.extra.severity || 'WARNING').toUpperCase();
    const severity = (['ERROR', 'WARNING', 'INFO'] as const).includes(rawSeverity as 'ERROR' | 'WARNING' | 'INFO')
      ? (rawSeverity as 'ERROR' | 'WARNING' | 'INFO')
      : 'WARNING' as const;
    const reviewSeverity =
      severity === 'ERROR'
        ? severityMap.ERROR
        : severity === 'WARNING'
          ? severityMap.WARNING
          : severityMap.INFO;

    counts[severity] += 1;

    lines.push(
      `[${severity} → ${reviewSeverity}] ${finding.path}:${finding.start.line} — rule: ${finding.check_id}`,
      `  ${finding.extra.message.trim()}`,
      '',
    );
  }

  const total = output.results.length;
  lines.push(
    `총 ${total}개 발견 (ERROR: ${counts.ERROR}, WARNING: ${counts.WARNING}, INFO: ${counts.INFO})`,
  );

  return lines.join('\n');
}

