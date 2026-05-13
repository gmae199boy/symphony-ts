/**
 * SlackThreadManager — thread state management for Slack approval workflow.
 *
 * Extracted from SlackPoller so both polling and webhook receivers can share
 * the same state without coupling to the polling mechanism.
 */

import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { logger } from '../logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SlackThreadInfo {
  channel: string;
  thread_ts: string;
  message_ts: string;
}

export interface WatchedThread {
  issueIdentifier: string;
  issueId: string;
  workspaceName: string;
  threadInfo: SlackThreadInfo;
  last_read_ts: string;
  planNumber: number;
  approvalMessageTs: string | null;
  approvedByReaction: boolean;
  /** 현재 승인 대기 중인 계획 수. 1 = 단일, >1 = 복수 선택 필요. */
  pendingPlanCount: number;
  /** false = stop watching, but keep thread routing info */
  active: boolean;
}

// ---------------------------------------------------------------------------
// Zod schemas for disk persistence
// ---------------------------------------------------------------------------

const ThreadRecordSchema = z.object({
  issueIdentifier: z.string(),
  issueId: z.string(),
  workspaceName: z.string(),
  channel: z.string(),
  thread_ts: z.string(),
  last_read_ts: z.string(),
  planNumber: z.number().default(0),
  approvalMessageTs: z.string().nullable().default(null),
  approvedByReaction: z.boolean().default(false),
  pendingPlanCount: z.number().default(1),
  /** false = 폴링 중지, 스레드 라우팅 정보는 유지 */
  active: z.boolean().default(true),
});

const ThreadStoreSchema = z.array(z.tuple([z.string(), ThreadRecordSchema]));

type ThreadRecord = z.infer<typeof ThreadRecordSchema>;

// ---------------------------------------------------------------------------
// SlackDiskStore — JSON file persistence
// ---------------------------------------------------------------------------

class SlackDiskStore {
  private readonly filePath: string;

  constructor(workspaceRoot: string) {
    this.filePath = path.join(workspaceRoot, 'slack-threads.json');
  }

  load(): Map<string, ThreadRecord> {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = ThreadStoreSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) {
        logger.warn('Slack thread store: corrupted data, starting fresh', { error: parsed.error.message });
        return new Map();
      }
      return new Map(parsed.data);
    } catch {
      return new Map();
    }
  }

  save(threads: Map<string, ThreadRecord>): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const entries = [...threads.entries()];
    const json = JSON.stringify(entries, null, 2);
    const tmpPath = this.filePath + '.tmp';
    fs.writeFileSync(tmpPath, json, 'utf8');
    fs.renameSync(tmpPath, this.filePath);
  }
}

// ---------------------------------------------------------------------------
// SlackThreadManager — in-memory state + disk persistence
// ---------------------------------------------------------------------------

export class SlackThreadManager {
  private readonly store: SlackDiskStore;
  private threads = new Map<string, WatchedThread>();

  constructor(workspaceRoot: string) {
    this.store = new SlackDiskStore(workspaceRoot);
  }

  restore(): void {
    const records = this.store.load();
    for (const [identifier, record] of records) {
      this.threads.set(identifier, {
        issueIdentifier: record.issueIdentifier,
        issueId: record.issueId,
        workspaceName: record.workspaceName,
        threadInfo: {
          channel: record.channel,
          thread_ts: record.thread_ts,
          message_ts: record.last_read_ts,
        },
        last_read_ts: record.last_read_ts,
        planNumber: record.planNumber,
        approvalMessageTs: record.approvalMessageTs,
        approvedByReaction: record.approvedByReaction,
        pendingPlanCount: record.pendingPlanCount,
        active: record.active,
      });
    }
    logger.info('Slack thread manager: restored threads', { count: this.threads.size });
  }

  watch(
    issueIdentifier: string,
    issueId: string,
    workspaceName: string,
    threadInfo: SlackThreadInfo,
  ): void {
    logger.info(`Slack thread manager: watching thread for ${issueIdentifier}`, {
      channel: threadInfo.channel,
      thread_ts: threadInfo.thread_ts,
    });

    const existing = this.threads.get(issueIdentifier);
    this.threads.set(issueIdentifier, {
      issueIdentifier,
      issueId,
      workspaceName,
      threadInfo,
      last_read_ts: threadInfo.message_ts,
      planNumber: existing?.planNumber ?? 0,
      approvalMessageTs: null,
      approvedByReaction: false,
      pendingPlanCount: 1,
      active: true,
    });

    this.persist();
  }

  /**
   * 폴링/감시를 중지하되 스레드 라우팅 정보는 유지한다.
   * 이후 sendNotification/sendForApproval이 동일 스레드로 계속 전송된다.
   */
  unwatch(issueIdentifier: string): void {
    const w = this.threads.get(issueIdentifier);
    if (w) {
      w.active = false;
      this.persist();
    }
  }

  /** 비활성화된 스레드를 재활성화한다. approvalMessageTs 등 기존 상태는 유지된다. */
  reactivate(issueIdentifier: string): void {
    const w = this.threads.get(issueIdentifier);
    if (w && !w.active) {
      w.active = true;
      w.approvedByReaction = false;
      this.persist();
      logger.info(`Slack thread manager: reactivated thread for ${issueIdentifier}`);
    }
  }

  /** 스레드 레코드를 완전히 삭제한다. (terminal state, PR 머지 후 정리용) */
  forgetThread(issueIdentifier: string): void {
    this.threads.delete(issueIdentifier);
    this.persist();
  }

  getThread(issueIdentifier: string): WatchedThread | undefined {
    return this.threads.get(issueIdentifier);
  }

  isWatching(issueIdentifier: string): boolean {
    return this.threads.get(issueIdentifier)?.active === true;
  }

  getAllIdentifiers(): string[] {
    return [...this.threads.keys()];
  }

  getActiveThreads(): WatchedThread[] {
    return [...this.threads.values()].filter((w) => w.active);
  }

  getAllThreads(): Map<string, WatchedThread> {
    return this.threads;
  }

  updateLastReadTs(identifier: string, ts: string): void {
    const w = this.threads.get(identifier);
    if (!w) return;
    w.last_read_ts = ts;
    this.persist();
  }

  setApprovalMessageTs(issueIdentifier: string, ts: string): void {
    const w = this.threads.get(issueIdentifier);
    if (!w) return;
    w.approvalMessageTs = ts;
    w.approvedByReaction = false;
    this.persist();
  }

  setPendingPlanCount(issueIdentifier: string, count: number): void {
    const w = this.threads.get(issueIdentifier);
    if (!w) return;
    w.pendingPlanCount = count;
    this.persist();
  }

  markApprovedByReaction(issueIdentifier: string): void {
    const w = this.threads.get(issueIdentifier);
    if (!w) return;
    w.approvedByReaction = true;
    this.persist();
  }

  incrementPlanNumber(issueIdentifier: string): number {
    const w = this.threads.get(issueIdentifier);
    if (!w) return 0;
    w.planNumber++;
    this.persist();
    return w.planNumber;
  }

  /** Find a WatchedThread by Slack channel + thread_ts. Used by webhook receiver. */
  findByThread(channel: string, thread_ts: string): WatchedThread | undefined {
    for (const w of this.threads.values()) {
      if (w.threadInfo.channel === channel && w.threadInfo.thread_ts === thread_ts) {
        return w;
      }
    }
    return undefined;
  }

  private persist(): void {
    const records = new Map<string, ThreadRecord>();
    for (const [identifier, w] of this.threads) {
      records.set(identifier, {
        issueIdentifier: w.issueIdentifier,
        issueId: w.issueId,
        workspaceName: w.workspaceName,
        channel: w.threadInfo.channel,
        thread_ts: w.threadInfo.thread_ts,
        last_read_ts: w.last_read_ts,
        planNumber: w.planNumber,
        approvalMessageTs: w.approvalMessageTs,
        approvedByReaction: w.approvedByReaction,
        pendingPlanCount: w.pendingPlanCount,
        active: w.active,
      });
    }
    this.store.save(records);
  }
}
