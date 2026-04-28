/**
 * SlackBoltReceiver 단위 테스트
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// logger mock
vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// @slack/bolt mock
vi.mock('@slack/bolt', () => {
  const handlers: Record<string, (payload: unknown) => Promise<void>> = {};
  const mockApp = {
    client: {
      auth: { test: vi.fn().mockResolvedValue({ user_id: 'U_BOT' }) },
      chat: { postMessage: vi.fn().mockResolvedValue({ ok: true, ts: '111', channel: 'C1' }) },
    },
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    event: vi.fn((name: string, handler: (p: unknown) => Promise<void>) => {
      handlers[name] = handler;
    }),
    message: vi.fn(),
    _handlers: handlers,
  };
  return {
    App: vi.fn(() => mockApp),
    LogLevel: { INFO: 'info' },
  };
});

// notifier mock
vi.mock('./notifier.js', () => ({
  sendSlackMessage: vi.fn().mockResolvedValue({ ts: '999', channel: 'C1' }),
}));

import { SlackBoltReceiver } from './bolt-app.js';
import type { SlackThreadManager } from './thread-store.js';
import { App } from '@slack/bolt';

function makeThreadManager(override: Partial<SlackThreadManager> = {}): SlackThreadManager {
  return {
    findByThread: vi.fn().mockReturnValue(null),
    getAllThreads: vi.fn().mockReturnValue(new Map()),
    updateLastReadTs: vi.fn(),
    markApprovedByReaction: vi.fn(),
    getThread: vi.fn().mockReturnValue(null),
    watch: vi.fn(),
    unwatch: vi.fn(),
    forgetThread: vi.fn(),
    isWatching: vi.fn().mockReturnValue(false),
    getAllIdentifiers: vi.fn().mockReturnValue([]),
    restore: vi.fn(),
    save: vi.fn(),
    setPendingPlanCount: vi.fn(),
    setApprovalMessageTs: vi.fn(),
    incrementPlanNumber: vi.fn().mockReturnValue(1),
    ...override,
  } as unknown as SlackThreadManager;
}

// Helper to fire mock event handlers
function getHandlers() {
  const instance = (App as ReturnType<typeof vi.fn>).mock.results[
    (App as ReturnType<typeof vi.fn>).mock.results.length - 1
  ].value as { _handlers: Record<string, (p: unknown) => Promise<void>> };
  return instance._handlers;
}

describe('SlackBoltReceiver', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('start()', () => {
    it('user_id 없으면 throw한다', async () => {
      const mockApp = new (App as ReturnType<typeof vi.fn>)();
      mockApp.client.auth.test.mockResolvedValueOnce({});

      const receiver = new SlackBoltReceiver(
        { appToken: 'xapp-', botToken: 'xoxb-' },
        makeThreadManager(),
        vi.fn(),
      );
      await expect(receiver.start()).rejects.toThrow('user_id');
    });
  });

  describe('dedup — message vs reaction 네임스페이스 분리', () => {
    it('동일 event_ts라도 message와 reaction 이벤트를 모두 처리한다', async () => {
      const onEvent = vi.fn();
      const ts = '1700000000.000001';

      const watched = {
        active: true,
        issueIdentifier: 'DEV-1',
        issueId: 'id-1',
        workspaceName: 'ws',
        last_read_ts: '0',
        approvedByReaction: false,
        pendingPlanCount: 1,
        approvalMessageTs: ts,
        threadInfo: { channel: 'C1', thread_ts: 'T1', message_ts: 'T1' },
        planNumber: 1,
      };

      const threadManager = makeThreadManager({
        findByThread: vi.fn().mockReturnValue(watched),
        getAllThreads: vi.fn().mockReturnValue(new Map([['DEV-1', watched]])),
      });

      const receiver = new SlackBoltReceiver(
        { appToken: 'xapp-', botToken: 'xoxb-' },
        threadManager,
        onEvent,
      );
      await receiver.start();

      const handlers = getHandlers();

      // message 이벤트 발화 (event_ts = ts)
      await handlers['message']?.({
        event: {
          event_ts: ts,
          channel: 'C1',
          thread_ts: 'T1',
          ts: ts + '1',
          text: 'hello',
          user: 'U_HUMAN',
        },
      });

      // reaction 이벤트 발화 (동일 event_ts)
      await handlers['reaction_added']?.({
        event: {
          event_ts: ts,
          reaction: 'white_check_mark',
          user: 'U_HUMAN',
          item: { type: 'message', channel: 'C1', ts },
        },
      });

      // 두 이벤트 모두 onEvent로 전달되어야 한다
      expect(onEvent).toHaveBeenCalledTimes(2);
    });

    it('같은 타입의 동일 event_ts는 중복 드롭한다', async () => {
      const onEvent = vi.fn();
      const ts = '1700000000.000002';
      const watched = {
        active: true,
        issueIdentifier: 'DEV-2',
        issueId: 'id-2',
        workspaceName: 'ws',
        last_read_ts: '0',
        approvedByReaction: false,
        pendingPlanCount: 1,
        approvalMessageTs: ts,
        threadInfo: { channel: 'C1', thread_ts: 'T2', message_ts: 'T2' },
        planNumber: 1,
      };
      const threadManager = makeThreadManager({
        findByThread: vi.fn().mockReturnValue(watched),
      });

      const receiver = new SlackBoltReceiver(
        { appToken: 'xapp-', botToken: 'xoxb-' },
        threadManager,
        onEvent,
      );
      await receiver.start();

      const handlers = getHandlers();
      const msgEvent = {
        event: {
          event_ts: ts,
          channel: 'C1',
          thread_ts: 'T2',
          ts: ts + '1',
          text: 'hi',
          user: 'U_HUMAN',
        },
      };

      await handlers['message']?.(msgEvent);
      await handlers['message']?.(msgEvent); // 중복

      expect(onEvent).toHaveBeenCalledTimes(1);
    });
  });

  describe('multi-plan ✅ reaction blocked', () => {
    it('pendingPlanCount > 1이면 ✅ 리액션을 차단하고 안내 메시지를 보낸다', async () => {
      const onEvent = vi.fn();
      const ts = '1700000000.000003';
      const watched = {
        active: true,
        issueIdentifier: 'DEV-3',
        issueId: 'id-3',
        workspaceName: 'ws',
        last_read_ts: '0',
        approvedByReaction: false,
        pendingPlanCount: 3,
        approvalMessageTs: ts,
        threadInfo: { channel: 'C1', thread_ts: 'T3', message_ts: 'T3' },
        planNumber: 1,
      };
      const threadManager = makeThreadManager({
        getAllThreads: vi.fn().mockReturnValue(new Map([['DEV-3', watched]])),
      });

      const receiver = new SlackBoltReceiver(
        { appToken: 'xapp-', botToken: 'xoxb-' },
        threadManager,
        onEvent,
      );
      await receiver.start();

      const handlers = getHandlers();
      await handlers['reaction_added']?.({
        event: {
          event_ts: '111',
          reaction: 'white_check_mark',
          user: 'U_HUMAN',
          item: { type: 'message', channel: 'C1', ts },
        },
      });

      expect(onEvent).not.toHaveBeenCalled();
    });
  });
});
