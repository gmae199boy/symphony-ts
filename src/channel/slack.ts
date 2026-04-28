/**
 * SlackChannel — HumanChannel implementation using Slack.
 *
 * Receives events via Socket Mode (@slack/bolt SocketModeReceiver).
 * Thread state is managed by SlackThreadManager.
 */

import type { WebClient } from '@slack/web-api';
import { logger } from '../logger.js';
import { SlackBoltReceiver, type SlackResponseEvent } from '../slack/bolt-app.js';
import { SlackThreadManager } from '../slack/thread-store.js';
import { sendSlackMessage, sendSlackMessageChunked } from '../slack/notifier.js';
import type { Issue } from '../types.js';
import type { SlackConfig } from '../config/schema.js';
import type { HumanChannel, ApprovalType, HumanResponseHandler } from './types.js';
import { formatIssueLabel } from '../utils.js';


export class SlackChannel implements HumanChannel {
  private readonly receiver: SlackBoltReceiver;
  private readonly threadManager: SlackThreadManager;
  private readonly config: NonNullable<SlackConfig>;
  private readonly onResponse: HumanResponseHandler;

  constructor(
    config: NonNullable<SlackConfig>,
    workspaceRoot: string,
    onResponse: HumanResponseHandler,
  ) {
    this.config = config;
    this.onResponse = onResponse;
    this.threadManager = new SlackThreadManager(workspaceRoot);

    const handleEvent = (event: SlackResponseEvent) => this.handleSlackEvent(event);

    this.receiver = new SlackBoltReceiver(
      { appToken: config.app_token, botToken: config.bot_token },
      this.threadManager,
      handleEvent,
    );
  }

  async start(): Promise<void> {
    this.threadManager.restore();
    await this.receiver.start();
  }

  async stop(): Promise<void> {
    await this.receiver.stop();
  }

  getWebClient(): WebClient {
    return this.receiver.client;
  }

  async sendForApproval(
    issue: Issue,
    content: string,
    type: ApprovalType,
    workspaceName: string,
  ): Promise<boolean> {
    const client = this.receiver.client;
    const existingThread = this.threadManager.getThread(issue.identifier);
    let threadRegistered = !!existingThread;

    let text: string;
    let result: { ts: string; channel: string } | null;
    let planCount = 1;

    if (type === 'review') {
      let threadForReview = existingThread;
      if (!threadForReview) {
        const header = await sendSlackMessage(
          client,
          this.config.channel,
          `🔍 *[${formatIssueLabel(issue)}]* 셀프리뷰 결과`,
        );
        if (!header) return false;
        this.threadManager.watch(issue.identifier, issue.id, workspaceName, {
          channel: header.channel,
          thread_ts: header.ts,
          message_ts: header.ts,
        });
        threadRegistered = true;
        threadForReview = this.threadManager.getThread(issue.identifier);
      }
      result = await sendSlackMessageChunked(
        client,
        threadForReview?.threadInfo.channel ?? this.config.channel,
        content,
        threadForReview?.threadInfo.thread_ts,
        (ts) => this.threadManager.updateLastReadTs(issue.identifier, ts),
      );
    } else if (type === 'plan') {
      // thread가 없으면 이 plan이 첫 번째(#1)이므로 직접 지정,
      // thread가 있으면 기존 카운터를 증가시켜 다음 번호를 사용한다.
      const planNumber = existingThread
        ? this.incrementPlanNumber(issue.identifier)
        : 1;
      planCount = (content.match(/^#{1,3}\s+Plan\s+\d+/gim) ?? []).length;
      const footer = planCount > 1
        ? `\n\n번호로 계획 선택 (예: "1" 또는 "plan 2"), 피드백: 자유롭게 작성`
        : `\n\n✅ 리액션 = 승인, 피드백: 자유롭게 작성`;
      text = `📋 *[${formatIssueLabel(issue)}]* 계획 #${planNumber}\n\n${content}${footer}`;
      result = await sendSlackMessageChunked(
        client,
        existingThread?.threadInfo.channel ?? this.config.channel,
        text,
        existingThread?.threadInfo.thread_ts,
        (ts) => this.threadManager.updateLastReadTs(issue.identifier, ts),
      );
    } else {
      // question
      text = `❓ *[${formatIssueLabel(issue)}]* 질문\n\n${content}`;
      result = await sendSlackMessageChunked(
        client,
        existingThread?.threadInfo.channel ?? this.config.channel,
        text,
        existingThread?.threadInfo.thread_ts,
        (ts) => this.threadManager.updateLastReadTs(issue.identifier, ts),
      );
    }

    if (!result) return false;

    if (!threadRegistered) {
      this.threadManager.watch(issue.identifier, issue.id, workspaceName, {
        channel: result.channel,
        thread_ts: result.ts,
        message_ts: result.ts,
      });
      // plan을 #1로 보냈으므로 내부 카운터를 1로 동기화한다.
      if (type === 'plan') {
        this.threadManager.incrementPlanNumber(issue.identifier);
      }
    } else {
      this.threadManager.updateLastReadTs(issue.identifier, result.ts);
    }

    if (type === 'plan' || type === 'review') {
      this.threadManager.setApprovalMessageTs(issue.identifier, result.ts);
      this.threadManager.setPendingPlanCount(issue.identifier, type === 'plan' ? planCount : 1);
    }

    return true;
  }

  async sendNotification(issue: Issue, message: string, workspaceName?: string): Promise<void> {
    const client = this.receiver.client;
    const thread = this.threadManager.getThread(issue.identifier);
    const result = await sendSlackMessage(
      client,
      thread?.threadInfo.channel ?? this.config.channel,
      message,
      thread?.threadInfo.thread_ts,
    );
    if (result) {
      if (!thread && workspaceName) {
        this.threadManager.watch(issue.identifier, issue.id, workspaceName, {
          channel: result.channel,
          thread_ts: result.ts,
          message_ts: result.ts,
        });
      } else {
        this.threadManager.updateLastReadTs(issue.identifier, result.ts);
      }
    }
  }

  isWatching(issueIdentifier: string): boolean {
    return this.threadManager.isWatching(issueIdentifier);
  }

  unwatch(issueIdentifier: string): void {
    this.threadManager.unwatch(issueIdentifier);
  }

  getAllWatchedIdentifiers(): string[] {
    return this.threadManager.getAllIdentifiers();
  }

  getThreadInfo(issueIdentifier: string): { channel: string; thread_ts: string } | undefined {
    const thread = this.threadManager.getThread(issueIdentifier);
    if (!thread) return undefined;
    return { channel: thread.threadInfo.channel, thread_ts: thread.threadInfo.thread_ts };
  }

  getPlanNumber(issueIdentifier: string): number {
    return this.threadManager.getThread(issueIdentifier)?.planNumber ?? 0;
  }

  incrementPlanNumber(issueIdentifier: string): number {
    return this.threadManager.incrementPlanNumber(issueIdentifier);
  }

  forgetThread(issueIdentifier: string): void {
    this.threadManager.forgetThread(issueIdentifier);
  }

  private handleSlackEvent(event: SlackResponseEvent): void {
    this.onResponse({
      issueIdentifier: event.issueIdentifier,
      issueId: event.issueId,
      responseText: event.responseText,
      workspaceName: event.workspaceName,
      isApproval: event.isApproval,
      source: 'slack',
    });
  }
}
