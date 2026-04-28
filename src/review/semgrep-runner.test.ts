/**
 * semgrep-runner 순수 함수 단위 테스트
 */

import { describe, it, expect, vi } from 'vitest';
import { parseSemgrepOutput, formatSemgrepForReview, buildSemgrepSpawnArgs } from './semgrep-runner.js';
import { semgrepSchema } from '../config/schema.js';
import type { SemgrepConfig } from '../config/schema.js';

// logger mock — 실제 파일 I/O 없이 테스트
vi.mock('../logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

// ---------------------------------------------------------------------------
// parseSemgrepOutput
// ---------------------------------------------------------------------------

describe('parseSemgrepOutput', () => {
  it('정상 JSON을 파싱한다', () => {
    const input = JSON.stringify({
      results: [
        {
          check_id: 'javascript.lang.security.audit.xss',
          path: 'src/foo.ts',
          start: { line: 42 },
          extra: { message: 'XSS 위험', severity: 'ERROR' },
        },
      ],
      errors: [],
    });
    const result = parseSemgrepOutput(input);
    expect(result).not.toBeNull();
    expect(result!.results).toHaveLength(1);
    expect(result!.results[0].check_id).toBe('javascript.lang.security.audit.xss');
  });

  it('results 필드가 없으면 null을 반환한다', () => {
    const input = JSON.stringify({ errors: [] });
    expect(parseSemgrepOutput(input)).toBeNull();
  });

  it('유효하지 않은 JSON이면 null을 반환한다', () => {
    expect(parseSemgrepOutput('not json')).toBeNull();
  });

  it('필수 필드가 없는 항목을 필터링한다', () => {
    const input = JSON.stringify({
      results: [
        // 유효한 항목
        {
          check_id: 'rule.a',
          path: 'src/a.ts',
          start: { line: 1 },
          extra: { message: 'msg', severity: 'WARNING' },
        },
        // check_id 없음 → 제거
        {
          path: 'src/b.ts',
          start: { line: 2 },
          extra: { message: 'msg', severity: 'INFO' },
        },
        // start.line이 숫자가 아님 → 제거
        {
          check_id: 'rule.c',
          path: 'src/c.ts',
          start: { line: 'bad' },
          extra: { message: 'msg', severity: 'ERROR' },
        },
      ],
    });
    const result = parseSemgrepOutput(input);
    expect(result).not.toBeNull();
    expect(result!.results).toHaveLength(1);
    expect(result!.results[0].check_id).toBe('rule.a');
  });

  it('errors 배열이 있으면 경고를 로그한다', async () => {
    const { logger } = await import('../logger.js');
    const input = JSON.stringify({
      results: [],
      errors: [{ message: '규칙 로드 실패' }],
    });
    parseSemgrepOutput(input);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('1개 파싱 에러'),
      expect.any(Object),
    );
  });
});

// ---------------------------------------------------------------------------
// formatSemgrepForReview
// ---------------------------------------------------------------------------

const defaultSeverityMap = {
  ERROR: 'BLOCKER' as const,
  WARNING: 'SUGGESTION' as const,
  INFO: 'NIT' as const,
};

describe('formatSemgrepForReview', () => {
  it('발견 사항이 없어도 헤더와 집계를 반환한다', () => {
    const output = { results: [] };
    const text = formatSemgrepForReview(output, defaultSeverityMap);
    expect(text).toContain('--- semgrep static analysis ---');
    expect(text).toContain('총 0개 발견');
  });

  it('발견 사항을 severity → review severity 형식으로 포맷한다', () => {
    const output = {
      results: [
        {
          check_id: 'rule.xss',
          path: 'src/foo.ts',
          start: { line: 10 },
          extra: { message: 'XSS 위험', severity: 'ERROR' },
        },
      ],
    };
    const text = formatSemgrepForReview(output, defaultSeverityMap);
    expect(text).toContain('[ERROR → BLOCKER]');
    expect(text).toContain('src/foo.ts:10');
    expect(text).toContain('rule: rule.xss');
    expect(text).toContain('XSS 위험');
  });

  it('severity 매핑을 올바르게 적용한다', () => {
    const output = {
      results: [
        { check_id: 'r1', path: 'a.ts', start: { line: 1 }, extra: { message: 'e', severity: 'ERROR' } },
        { check_id: 'r2', path: 'b.ts', start: { line: 2 }, extra: { message: 'w', severity: 'WARNING' } },
        { check_id: 'r3', path: 'c.ts', start: { line: 3 }, extra: { message: 'i', severity: 'INFO' } },
      ],
    };
    const text = formatSemgrepForReview(output, defaultSeverityMap);
    expect(text).toContain('[ERROR → BLOCKER]');
    expect(text).toContain('[WARNING → SUGGESTION]');
    expect(text).toContain('[INFO → NIT]');
    expect(text).toContain('총 3개 발견 (ERROR: 1, WARNING: 1, INFO: 1)');
  });

  it('severity가 빈 문자열이면 WARNING으로 처리한다', () => {
    const output = {
      results: [
        { check_id: 'r1', path: 'a.ts', start: { line: 1 }, extra: { message: 'msg', severity: '' } },
      ],
    };
    const text = formatSemgrepForReview(output, defaultSeverityMap);
    expect(text).toContain('[WARNING → SUGGESTION]');
  });

  it('알 수 없는 severity는 WARNING으로 폴백한다', () => {
    const output = {
      results: [
        { check_id: 'r1', path: 'a.ts', start: { line: 1 }, extra: { message: 'msg', severity: 'CRITICAL' } },
      ],
    };
    const text = formatSemgrepForReview(output, defaultSeverityMap);
    expect(text).toContain('[WARNING → SUGGESTION]');
  });

  it('--- semgrep static analysis --- 헤더를 포함한다', () => {
    const output = { results: [] };
    expect(formatSemgrepForReview(output, defaultSeverityMap)).toContain('--- semgrep static analysis ---');
  });
});

// ---------------------------------------------------------------------------
// buildSemgrepSpawnArgs — app_token 환경변수 주입
// ---------------------------------------------------------------------------

// S6: semgrepSchema.parse({})로 기본값을 얻어 스키마 회귀에 안전하게 baseConfig 구성
const baseConfig: SemgrepConfig = semgrepSchema.parse({});

describe('buildSemgrepSpawnArgs', () => {
  it('app_token 미설정 시 SEMGREP_APP_TOKEN이 argv에 포함되지 않고 env도 undefined이다', () => {
    const { cmd, args, env } = buildSemgrepSpawnArgs(
      { workspace: '/workspace' },
      baseConfig,
      ['src/foo.ts'],
    );
    expect(cmd).toBe('bash');
    expect(args.join(' ')).not.toContain('SEMGREP_APP_TOKEN');
    expect(env).toBeUndefined();
  });

  it('app_token 설정 시 local 경로에서 SEMGREP_APP_TOKEN이 env로 전달되고 argv에 포함되지 않는다', () => {
    const config: SemgrepConfig = { ...baseConfig, app_token: 'tok-abc123' };
    const { cmd, args, env } = buildSemgrepSpawnArgs(
      { workspace: '/workspace' },
      config,
      ['src/foo.ts'],
    );
    expect(cmd).toBe('bash');
    expect(args.join(' ')).not.toContain('SEMGREP_APP_TOKEN');
    expect(args.join(' ')).not.toContain('tok-abc123');
    expect(env?.SEMGREP_APP_TOKEN).toBe('tok-abc123');
    expect(args[1]).toContain('semgrep');
  });

  it('app_token 설정 시 docker 경로에서 --env SEMGREP_APP_TOKEN 플래그가 추가되고 innerCmd에 토큰이 없다', () => {
    const config: SemgrepConfig = { ...baseConfig, app_token: 'tok-docker' };
    const { cmd, args, env } = buildSemgrepSpawnArgs(
      { workspace: '/workspace', containerName: 'symphony-test' },
      config,
      ['src/bar.ts'],
    );
    expect(cmd).toBe('docker');
    // docker exec에 --env SEMGREP_APP_TOKEN 플래그 (값 없음: 호스트 env 상속)
    const envFlagIdx = args.indexOf('--env');
    expect(envFlagIdx).toBeGreaterThan(-1);
    expect(args[envFlagIdx + 1]).toBe('SEMGREP_APP_TOKEN');
    // innerCmd(마지막 인자)에 토큰이 노출되지 않음
    const innerCmd = args[args.length - 1];
    expect(innerCmd).not.toContain('tok-docker');
    expect(innerCmd).toContain('semgrep');
    expect(env?.SEMGREP_APP_TOKEN).toBe('tok-docker');
  });

  it('app_token에 특수문자가 포함된 경우에도 argv에 노출되지 않고 env에 그대로 전달된다', () => {
    // 개행·세미콜론 등 셸 메타문자 → env 경로라 명령 주입 벡터 없음
    const token = 'tok-val$ue\n; injected';
    const config: SemgrepConfig = { ...baseConfig, app_token: token };
    const { args, env } = buildSemgrepSpawnArgs(
      { workspace: '/workspace' },
      config,
      ['src/foo.ts'],
    );
    expect(args.join(' ')).not.toContain('tok-val');
    expect(env?.SEMGREP_APP_TOKEN).toBe(token);
  });

  // S7: 토큰이 argv에 없으므로 logger.debug에 평문 노출되지 않음을 직접 검증
  it('app_token이 argv에 없어 logger.debug에 토큰이 노출되지 않는다', async () => {
    const { logger } = await import('../logger.js');
    vi.clearAllMocks();

    const config: SemgrepConfig = { ...baseConfig, app_token: 'secret-token-xyz' };
    const { cmd, args } = buildSemgrepSpawnArgs({ workspace: '/workspace' }, config, ['src/foo.ts']);

    // 실제 spawnSemgrep이 기록하는 것과 동일한 형식으로 spy 호출
    logger.debug(`[semgrep] 실행: ${cmd} ${args.join(' ')}`);
    const logged = vi.mocked(logger.debug).mock.calls.map((c) => String(c[0])).join(' ');
    expect(logged).not.toContain('secret-token-xyz');
  });
});

// ---------------------------------------------------------------------------
// semgrepSchema — app_token 스키마 레벨 검증 (S5)
// ---------------------------------------------------------------------------

describe('semgrepSchema — app_token 검증', () => {
  it('app_token이 빈 문자열이면 파싱 오류가 발생한다', () => {
    expect(() => semgrepSchema.parse({ app_token: '' })).toThrow();
  });

  it('app_token이 공백만 있으면 파싱 오류가 발생한다', () => {
    expect(() => semgrepSchema.parse({ app_token: '   ' })).toThrow();
  });

  it('app_token이 undefined이면 정상 파싱된다', () => {
    const result = semgrepSchema.parse({});
    expect(result.app_token).toBeUndefined();
  });

  it('$ENV_VAR 형식의 app_token이 환경변수로 치환된다', () => {
    process.env.TEST_SEMGREP_TOKEN = 'resolved-from-env';
    try {
      const result = semgrepSchema.parse({ app_token: '$TEST_SEMGREP_TOKEN' });
      expect(result.app_token).toBe('resolved-from-env');
    } finally {
      delete process.env.TEST_SEMGREP_TOKEN;
    }
  });
});
