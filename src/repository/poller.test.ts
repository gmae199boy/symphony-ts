import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RepoClientApi } from './factory.js';
import type { RepositoryConfig } from '../config/schema.js';
import type { PullRequest } from '../types.js';

vi.mock('./factory.js', () => ({
  createRepoClient: vi.fn(),
}));

import { createRepoClient } from './factory.js';
import { RepoPoller } from './poller.js';

// 내부 상태와 doPoll()에 직접 접근하기 위한 테스트 전용 서브클래스
class TestRepoPoller extends RepoPoller {
  async runDoPoll(): Promise<void> {
    return this.doPoll();
  }

  getSeenKeys(): number[] {
    return [...getState(this).seen.keys()];
  }

  getFirstPoll(): boolean {
    return getState(this).firstPoll;
  }
}

function getState(poller: TestRepoPoller): { seen: Map<number, unknown>; firstPoll: boolean } {
  return (poller as unknown as { state: { seen: Map<number, unknown>; firstPoll: boolean } }).state;
}

const makeConfig = (): RepositoryConfig =>
  ({
    kind: 'github',
    repo: 'test/repo',
    token: null,
    poll_interval_ms: 99_999,
    pr_label_filter: 'symphony',
    event_source: 'polling',
    webhook_secret: null,
    hooks: { timeout_ms: 300_000 },
    issue_labels: [],
    branch_strategy: {
      production: 'main',
      development: 'main',
      hotfix_labels: ['hotfix'],
      protect_production: true,
    },
  }) as unknown as RepositoryConfig;

const makePR = (number: number): PullRequest => ({
  number,
  title: `PR #${number}`,
  url: `https://github.com/test/repo/pull/${number}`,
  branchName: `feature-${number}`,
  labels: ['symphony'],
  issueIdentifier: null,
  state: 'open',
});

let tmpDir: string;
let mockClient: RepoClientApi;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'repopoller-test-'));
  mockClient = {
    fetchOpenPRs: vi.fn().mockResolvedValue([]),
    fetchPR: vi.fn().mockResolvedValue(null),
    fetchPRComments: vi.fn().mockResolvedValue([]),
    deleteBranch: vi.fn().mockResolvedValue(true),
    fetchPRReviews: vi.fn().mockResolvedValue([]),
  };
  vi.mocked(createRepoClient).mockReturnValue(mockClient);
});

afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch (err) {
    console.warn('afterEach: failed to clean up tmpDir', err);
  }
  vi.clearAllMocks();
});

describe('cleanupOrphanedSeen', () => {
  it('재시작 후 첫 폴링에서 fetchPR 확인 후 stale seen 엔트리를 정리한다', async () => {
    // 재시작 시나리오: seen 파일에 PR 5, 12, 31이 있고 현재는 31만 open
    const stateFile = path.join(tmpDir, 'repo-poller-test-repo-seen.json');
    fs.writeFileSync(stateFile, JSON.stringify({ '5': [], '12': ['c-1'], '31': ['c-2'] }));

    const onEvent = vi.fn();
    const poller = new TestRepoPoller(makeConfig(), onEvent, tmpDir);

    vi.mocked(mockClient.fetchOpenPRs).mockResolvedValue([makePR(31)]);
    vi.mocked(mockClient.fetchPRComments).mockResolvedValue([]);
    // fetchPR returns null by default → orphans (5, 12) will be deleted

    poller.start();
    poller.stop(); // 타이머 즉시 취소
    await poller.runDoPoll();

    // PR 5, 12는 제거되고 31만 남아야 함
    expect(poller.getSeenKeys().sort()).toEqual([31]);

    // cleanup이 fetchPR로 각 orphan 상태 확인
    expect(mockClient.fetchPR).toHaveBeenCalledWith(5);
    expect(mockClient.fetchPR).toHaveBeenCalledWith(12);
    expect(mockClient.fetchPR).not.toHaveBeenCalledWith(31); // open PR은 호출 안 함

    // 이벤트 없음 (null 상태는 merged 아님)
    expect(onEvent).not.toHaveBeenCalled();

    // 디스크 파일에서도 제거됐는지 확인
    const persisted = JSON.parse(fs.readFileSync(stateFile, 'utf8')) as Record<string, unknown>;
    expect(Object.keys(persisted).sort()).toEqual(['31']);
  });

  it('부분 재시작: seen 일부가 현재 open에 없으면 fetchPR 확인 후 해당 항목만 정리한다', async () => {
    const stateFile = path.join(tmpDir, 'repo-poller-test-repo-seen.json');
    fs.writeFileSync(stateFile, JSON.stringify({ '1': [], '2': ['c-a'], '3': ['c-b'] }));

    const onEvent = vi.fn();
    const poller = new TestRepoPoller(makeConfig(), onEvent, tmpDir);

    vi.mocked(mockClient.fetchOpenPRs).mockResolvedValue([makePR(2)]);
    vi.mocked(mockClient.fetchPRComments).mockResolvedValue([]);

    poller.start();
    poller.stop();
    await poller.runDoPoll();

    expect(poller.getSeenKeys().sort()).toEqual([2]);
    expect(mockClient.fetchPR).toHaveBeenCalledWith(1);
    expect(mockClient.fetchPR).toHaveBeenCalledWith(3);
    expect(mockClient.fetchPR).not.toHaveBeenCalledWith(2);
    expect(onEvent).not.toHaveBeenCalled();
  });

  it('fetchPR이 open을 반환하면 seen을 삭제하지 않는다 (라벨 일시 제거 보호)', async () => {
    const stateFile = path.join(tmpDir, 'repo-poller-test-repo-seen.json');
    fs.writeFileSync(stateFile, JSON.stringify({ '5': ['c-1'] }));

    const onEvent = vi.fn();
    const poller = new TestRepoPoller(makeConfig(), onEvent, tmpDir);

    // PR#5가 fetchOpenPRs에서 빠졌지만 (라벨 일시 제거) fetchPR로 확인하면 open
    vi.mocked(mockClient.fetchOpenPRs).mockResolvedValue([]);
    vi.mocked(mockClient.fetchPR).mockResolvedValue({ ...makePR(5), state: 'open' });
    vi.mocked(mockClient.fetchPRComments).mockResolvedValue([]);

    poller.start();
    poller.stop();
    await poller.runDoPoll();

    // seen 엔트리가 보존되어야 함
    expect(poller.getSeenKeys()).toContain(5);
    expect(mockClient.fetchPR).toHaveBeenCalledWith(5);
    expect(onEvent).not.toHaveBeenCalled();
  });

  it('fetchOpenPRs가 실패하면 cleanup이 실행되지 않아 seen이 보존된다', async () => {
    const stateFile = path.join(tmpDir, 'repo-poller-test-repo-seen.json');
    fs.writeFileSync(stateFile, JSON.stringify({ '5': ['c-1'], '12': ['c-2'] }));

    const poller = new TestRepoPoller(makeConfig(), vi.fn(), tmpDir);
    vi.mocked(mockClient.fetchOpenPRs).mockRejectedValue(new Error('network error'));

    poller.start();
    poller.stop();
    await poller.runDoPoll();

    // doPoll early return → cleanup 미실행 → seen 보존
    expect(poller.getSeenKeys().sort((a, b) => a - b)).toEqual([5, 12]);
    expect(mockClient.fetchPR).not.toHaveBeenCalled();
  });

  it('전체 doPoll 사이클당 persistState가 정확히 1회 호출된다 (cleanup은 추가 호출 없음)', async () => {
    const stateFile = path.join(tmpDir, 'repo-poller-test-repo-seen.json');
    fs.writeFileSync(stateFile, JSON.stringify({ '7': ['c-1'] }));

    const poller = new TestRepoPoller(makeConfig(), vi.fn(), tmpDir);

    vi.mocked(mockClient.fetchOpenPRs).mockResolvedValue([makePR(7)]);
    vi.mocked(mockClient.fetchPRComments).mockResolvedValue([]);

    const persistSpy = vi.spyOn(
      poller as unknown as { persistState: () => void },
      'persistState',
    );

    poller.start();
    poller.stop();
    await poller.runDoPoll();

    // doPoll 종료 시 단 1회 persist — cleanup이나 checkPR이 별도 호출을 트리거하지 않음
    expect(persistSpy).toHaveBeenCalledTimes(1);
    expect(poller.getSeenKeys()).toContain(7);
    expect(mockClient.fetchPR).not.toHaveBeenCalled();
    void stateFile;
  });
});

describe('detectMergedPRs — 정상 운영 회귀 방지', () => {
  it('정상 폴링 중 PR이 merged 상태로 사라지면 pr_merged 이벤트를 emit하고 seen을 정리한다', async () => {
    const onEvent = vi.fn();
    const poller = new TestRepoPoller(makeConfig(), onEvent, tmpDir);

    // state 파일 없음 → firstPoll=true, 첫 폴링으로 knownOpenPRs에 PR#1 등록
    expect(poller.getFirstPoll()).toBe(true);
    vi.mocked(mockClient.fetchOpenPRs).mockResolvedValue([makePR(1)]);
    vi.mocked(mockClient.fetchPRComments).mockResolvedValue([]);
    poller.start();
    poller.stop();
    await poller.runDoPoll();

    // 두 번째 폴링: PR#1이 사라짐 → merged 감지
    vi.mocked(mockClient.fetchOpenPRs).mockResolvedValue([]);
    vi.mocked(mockClient.fetchPR).mockResolvedValue({ ...makePR(1), state: 'merged' });

    await poller.runDoPoll();

    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'pr_merged', pr: expect.objectContaining({ number: 1 }) }),
    );
    expect(poller.getSeenKeys()).not.toContain(1);
  });

  it('PR이 merged가 아닌 상태로 사라지면 이벤트 없이 seen만 정리한다', async () => {
    const onEvent = vi.fn();
    const poller = new TestRepoPoller(makeConfig(), onEvent, tmpDir);

    vi.mocked(mockClient.fetchOpenPRs).mockResolvedValue([makePR(2)]);
    vi.mocked(mockClient.fetchPRComments).mockResolvedValue([]);
    poller.start();
    poller.stop();
    await poller.runDoPoll();

    vi.mocked(mockClient.fetchOpenPRs).mockResolvedValue([]);
    vi.mocked(mockClient.fetchPR).mockResolvedValue({ ...makePR(2), state: 'closed' });

    await poller.runDoPoll();

    expect(onEvent).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'pr_merged' }));
    expect(poller.getSeenKeys()).not.toContain(2);
  });
});

describe('detectMergedPRs와 cleanupOrphanedSeen 역할 분담', () => {
  it('knownOpenPRs에 있는 PR은 detectMergedPRs가, orphan은 cleanupOrphanedSeen이 각각 처리한다', async () => {
    const stateFile = path.join(tmpDir, 'repo-poller-test-repo-seen.json');
    // PR 31은 첫 폴링 후 knownOpenPRs에 등록되어 detectMergedPRs가 처리, PR 99는 orphan
    fs.writeFileSync(stateFile, JSON.stringify({ '31': ['c-1'], '99': ['c-2'] }));

    const onEvent = vi.fn();
    const poller = new TestRepoPoller(makeConfig(), onEvent, tmpDir);

    // 첫 폴링으로 knownOpenPRs에 PR#31 등록; PR#99는 orphan으로 cleanup (fetchPR: null)
    vi.mocked(mockClient.fetchOpenPRs).mockResolvedValue([makePR(31)]);
    vi.mocked(mockClient.fetchPRComments).mockResolvedValue([]);
    poller.start();
    poller.stop();
    await poller.runDoPoll();

    // 두 번째 폴링: PR#31도 사라짐 → detectMergedPRs가 처리
    vi.mocked(mockClient.fetchOpenPRs).mockResolvedValue([]);
    vi.mocked(mockClient.fetchPR).mockResolvedValue({ ...makePR(31), state: 'merged' });

    await poller.runDoPoll();

    // 첫 폴링: cleanupOrphanedSeen → fetchPR(99)
    // 두 번째 폴링: detectMergedPRs → fetchPR(31)
    expect(mockClient.fetchPR).toHaveBeenCalledTimes(2);
    expect(mockClient.fetchPR).toHaveBeenCalledWith(99); // cleanupOrphanedSeen
    expect(mockClient.fetchPR).toHaveBeenCalledWith(31); // detectMergedPRs

    // 두 항목 모두 seen에서 제거됨
    expect(poller.getSeenKeys()).not.toContain(31);
    expect(poller.getSeenKeys()).not.toContain(99);

    void stateFile;
  });
});
