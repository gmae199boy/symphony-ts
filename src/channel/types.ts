/**
 * HumanChannel — abstraction for all human interactions (plan approval, questions, review, notifications).
 *
 * Implementation: SlackChannel.
 */

import type { WebClient } from '@slack/web-api';
import type { Issue, FeedbackResponseEvent } from '../types.js';

export type ApprovalType = 'plan' | 'review' | 'question';
export type HumanResponseHandler = (event: FeedbackResponseEvent) => void;

export interface HumanChannel {
  /** Start the channel (begin polling, etc). */
  start(): Promise<void>;
  /** Stop the channel and await clean shutdown. */
  stop(): Promise<void>;

  /**
   * Send content to a human for approval or feedback.
   * The response is delivered asynchronously via the handler passed at construction time.
   * @returns true if the message was sent successfully
   */
  sendForApproval(
    issue: Issue,
    content: string,
    type: ApprovalType,
    workspaceName: string,
  ): Promise<boolean>;

  /**
   * Send an informational notification (no response expected).
   * @param workspaceName  When provided and no thread exists yet, registers the created thread
   *                       so subsequent messages (plan, question, review) land in the same thread.
   */
  sendNotification(issue: Issue, message: string, workspaceName?: string): Promise<void>;

  /** Whether the channel is currently watching for a response from the given issue. */
  isWatching(issueIdentifier: string): boolean;

  /**
   * 응답 감시 중지. 스레드 라우팅 정보는 유지한다.
   * (이후 sendNotification/sendForApproval이 동일 스레드로 계속 전송됨)
   */
  unwatch(issueIdentifier: string): void;

  /**
   * 비활성화된 스레드를 재활성화한다. approvalMessageTs 등 기존 상태는 그대로 유지된다.
   * clearPhase 실패로 phase.json이 WAITING_PHASE를 유지했지만 active=false인 경우 복구에 사용.
   */
  reactivateThread(issueIdentifier: string): void;

  /**
   * 스레드/감시 레코드를 완전히 삭제한다.
   * terminal state 도달, PR 머지 등 이슈가 종료될 때 호출한다.
   */
  forgetThread(issueIdentifier: string): void;

  /** Return all tracked issue identifiers (active + inactive). Used for stale thread cleanup. */
  getAllWatchedIdentifiers(): string[];

  /** Return Slack thread info for routing (channel, thread_ts). undefined if no thread exists. */
  getThreadInfo(issueIdentifier: string): { channel: string; thread_ts: string } | undefined;

  /** Get the current plan revision number for the given issue. */
  getPlanNumber(issueIdentifier: string): number;

  /** Increment and return the plan revision number for the given issue. */
  incrementPlanNumber(issueIdentifier: string): number;

  /** Expose the underlying WebClient for components that need direct REST access (e.g. DiffSender). */
  getWebClient(): WebClient;
}
