/**
 * SlackBoltReceiver — @slack/bolt 기반 Socket Mode 이벤트 수신기.
 *
 * HumanChannel 어댑터: 이벤트 수신(Socket Mode)과 REST 전송(WebClient)을
 * Bolt SDK에 위임하고 SlackResponseEvent를 상위 레이어로 전달한다.
 */

import { App, LogLevel, type Logger as BoltLogger } from '@slack/bolt';
import type { WebClient } from '@slack/web-api';
import { logger } from '../logger.js';
import { sendSlackMessage } from './notifier.js';
import type { SlackThreadManager } from './thread-store.js';

// ---------------------------------------------------------------------------
// 공개 타입 (channel/slack.ts에서 import)
// ---------------------------------------------------------------------------

export interface SlackResponseEvent {
  issueIdentifier: string;
  issueId: string;
  responseText: string;
  workspaceName: string;
  isApproval: boolean;
}

// ---------------------------------------------------------------------------
// Bolt logger 어댑터 — 기존 logger 포맷으로 통합
// ---------------------------------------------------------------------------

function serializeMsg(item: unknown): string {
  if (item instanceof Error) return item.stack ?? item.message;
  if (typeof item === 'object' && item !== null) {
    try { return JSON.stringify(item); } catch { return String(item); }
  }
  return String(item);
}

const boltLogger: BoltLogger = {
  debug: () => {},
  info:  (...msgs) => logger.info('[Bolt] '  + msgs.map(serializeMsg).join(' ')),
  warn:  () => {},
  error: (...msgs) => logger.error('[Bolt] ' + msgs.map(serializeMsg).join(' ')),
  setLevel: () => {},
  getLevel: () => LogLevel.INFO,
  setName: () => {},
};

// ---------------------------------------------------------------------------
// event_ts 기반 dedup
// 핸들러별 타입 접두사(message: / reaction:)로 네임스페이스를 분리해
// 두 핸들러가 맵을 공유해도 동일 ts 값이 서로 다른 이벤트를 드롭하지 않도록 한다.
// ---------------------------------------------------------------------------

const DEDUP_TTL_MS = 5 * 60 * 1_000;
const MAX_DEDUP_SIZE = 1_000;

// ---------------------------------------------------------------------------
// SlackBoltReceiver
// ---------------------------------------------------------------------------

export class SlackBoltReceiver {
  private readonly app: App;
  private botUserId: string | null = null;
  private readonly seenIds = new Map<string, number>();

  constructor(
    config: { appToken: string; botToken: string },
    private readonly threadManager: SlackThreadManager,
    private readonly onEvent: (event: SlackResponseEvent) => void,
  ) {
    this.app = new App({
      token: config.botToken,
      appToken: config.appToken,
      socketMode: true,
      logger: boltLogger,
      logLevel: LogLevel.INFO,
      // bot_id 조건과 이중 방어하기 위해 수동 필터를 사용한다.
      // botUserId 확보 실패 시에도 bot_id 체크가 2차 방어선으로 동작한다.
      ignoreSelf: false,
    });

    this.registerHandlers();
  }

  async start(): Promise<void> {
    const result = await this.app.client.auth.test();
    const uid = result.user_id as string | undefined;
    if (!uid) {
      throw new Error('Slack auth.test: user_id가 반환되지 않았습니다. 봇 토큰을 확인하세요.');
    }
    this.botUserId = uid;
    logger.info('Slack bolt: resolved bot user ID', { botUserId: this.botUserId });
    await this.app.start();
    logger.info('Slack bolt: connected');
  }

  async stop(): Promise<void> {
    await this.app.stop();
    logger.info('Slack bolt receiver stopped');
  }

  get client(): WebClient {
    return this.app.client;
  }

  // ---------------------------------------------------------------------------
  // 핸들러 등록
  // ---------------------------------------------------------------------------

  private registerHandlers(): void {
    // app.event('message', …)를 사용해 Bolt의 기본 subtype 드롭 미들웨어를 우회한다.
    // message_changed / thread_broadcast 포함 모든 message 계열 이벤트를 수신한 뒤
    // handleMessageEvent 내부 필터로 세분화한다.
    this.app.event('message', async ({ event }) => {
      try {
        const msg = event as unknown as Record<string, unknown>;
        const now = Date.now();
        this.pruneSeenIds(now);
        const dedupKey = 'message:' + (msg.event_ts as string | undefined ?? '');
        if (dedupKey !== 'message:') {
          if (this.seenIds.has(dedupKey)) return;
          this.seenIds.set(dedupKey, now);
        }
        this.handleMessageEvent(msg);
      } catch (err) {
        logger.error('Slack bolt: message handler error', { error: String(err) });
      }
    });

    // reaction_added 이벤트
    this.app.event('reaction_added', async ({ event }) => {
      try {
        const now = Date.now();
        this.pruneSeenIds(now);
        const dedupKey = 'reaction:' + (event.event_ts as string | undefined ?? '');
        if (dedupKey !== 'reaction:') {
          if (this.seenIds.has(dedupKey)) return;
          this.seenIds.set(dedupKey, now);
        }
        this.handleReactionEvent(event as unknown as Record<string, unknown>);
      } catch (err) {
        logger.error('Slack bolt: reaction_added handler error', { error: String(err) });
      }
    });
  }

  // ---------------------------------------------------------------------------
  // 이벤트 처리
  // ---------------------------------------------------------------------------

  private handleMessageEvent(event: Record<string, unknown>): void {
    // bot_id: 봇 전송 메시지, bot_message: 봇 subtype, message_deleted: 삭제 이벤트 제외
    // message_changed / thread_broadcast 는 통과시켜 사용자의 편집·채널공유 답글도 수신한다.
    const subtype = event.subtype as string | undefined;
    if (event.bot_id || subtype === 'bot_message' || subtype === 'message_deleted') return;
    if (event.user === this.botUserId) return;

    const channel = event.channel as string | undefined;
    const thread_ts = event.thread_ts as string | undefined;
    const ts = event.ts as string | undefined;
    const responseText = (event.text as string | undefined) ?? '';

    if (!channel || !thread_ts || !ts) return;
    if (thread_ts === ts) return; // 최상위 메시지는 무시

    const watched = this.threadManager.findByThread(channel, thread_ts);
    if (!watched || !watched.active) return;
    if (ts <= watched.last_read_ts) return;

    logger.info(`Slack bolt: human message for ${watched.issueIdentifier}`, {
      text: responseText.slice(0, 100),
    });

    this.threadManager.updateLastReadTs(watched.issueIdentifier, ts);

    try {
      this.onEvent({
        issueIdentifier: watched.issueIdentifier,
        issueId: watched.issueId,
        responseText,
        workspaceName: watched.workspaceName,
        isApproval: false,
      });
    } catch (err) {
      logger.error('Slack bolt: onEvent handler threw', { error: String(err) });
    }
  }

  private handleReactionEvent(event: Record<string, unknown>): void {
    if (event.reaction !== 'white_check_mark') return;

    const item = event.item as Record<string, unknown> | undefined;
    if (item?.type !== 'message') return;
    if (event.user === this.botUserId) return;

    const channel = item?.channel as string | undefined;
    const reactionTs = item?.ts as string | undefined;
    if (!channel || !reactionTs) return;

    for (const watched of this.threadManager.getAllThreads().values()) {
      if (!watched.active) continue;
      if (watched.approvedByReaction) continue;
      if (watched.threadInfo.channel !== channel) continue;
      if (watched.approvalMessageTs !== reactionTs) continue;

      if (watched.pendingPlanCount > 1) {
        logger.info(`Slack bolt: ✅ reaction blocked — multi-plan for ${watched.issueIdentifier}`);
        void sendSlackMessage(
          this.app.client,
          channel,
          '계획 번호를 입력하거나 피드백을 주세요 (예: 1, 2, 3)',
          watched.threadInfo.thread_ts,
        );
        return;
      }

      logger.info(`Slack bolt: ✅ reaction for ${watched.issueIdentifier}`);
      this.threadManager.markApprovedByReaction(watched.issueIdentifier);

      try {
        this.onEvent({
          issueIdentifier: watched.issueIdentifier,
          issueId: watched.issueId,
          responseText: '승인',
          workspaceName: watched.workspaceName,
          isApproval: true,
        });
      } catch (err) {
        logger.error('Slack bolt: onEvent handler threw', { error: String(err) });
      }
      return;
    }
  }

  private pruneSeenIds(now: number): void {
    for (const [id, ts] of this.seenIds) {
      if (now - ts > DEDUP_TTL_MS) this.seenIds.delete(id);
    }
    // 크기 상한 초과 시 가장 오래된 엔트리부터 제거
    if (this.seenIds.size > MAX_DEDUP_SIZE) {
      const oldest = [...this.seenIds.entries()].sort((a, b) => a[1] - b[1]);
      for (const [id] of oldest.slice(0, this.seenIds.size - MAX_DEDUP_SIZE)) {
        this.seenIds.delete(id);
      }
    }
  }
}
