/**
 * Slack thread poller — watches Slack threads for human responses
 * to agent plan approval requests.
 *
 * Follows the RepoPoller pattern (src/repository/poller.ts).
 */

import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { logger } from '../logger.js';
import { fetchWithRetry } from '../fetch-retry.js';
import type { SlackConfig } from '../config/schema.js';

const SlackAuthTestResponseSchema = z.object({
  ok: z.boolean(),
  user_id: z.string().optional(),
  error: z.string().optional(),
});

const SlackRepliesResponseSchema = z.object({
  ok: z.boolean(),
  messages: z.array(z.object({
    ts: z.string(),
    text: z.string().optional(),
    bot_id: z.string().optional(),
    subtype: z.string().optional(),
    user: z.string().optional(),
  })).optional(),
  error: z.string().optional(),
});

const SlackReactionsResponseSchema = z.object({
  ok: z.boolean(),
  message: z.object({
    reactions: z.array(z.object({
      name: z.string(),
      users: z.array(z.string()).optional(),
    })).optional(),
  }).optional(),
  error: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SlackThreadInfo {
  channel: string;
  thread_ts: string;
  message_ts: string;
}

export interface SlackResponseEvent {
  issueIdentifier: string;
  issueId: string;
  responseText: string;
  workspaceName: string;
  /** true when triggered by ✅ reaction on the plan message */
  isApproval: boolean;
}

const ThreadRecordSchema = z.object({
  issueIdentifier: z.string(),
  issueId: z.string(),
  workspaceName: z.string(),
  channel: z.string(),
  thread_ts: z.string(),
  last_read_ts: z.string(),
  planNumber: z.number().default(0),
  planMessageTs: z.string().nullable().default(null),
  approvedByReaction: z.boolean().default(false),
});

const ThreadStoreSchema = z.array(z.tuple([z.string(), ThreadRecordSchema]));

type ThreadRecord = z.infer<typeof ThreadRecordSchema>;

export interface WatchedThread {
  issueIdentifier: string;
  issueId: string;
  workspaceName: string;
  threadInfo: SlackThreadInfo;
  last_read_ts: string;
  planNumber: number;
  planMessageTs: string | null;
  approvedByReaction: boolean;
}

// ---------------------------------------------------------------------------
// SlackThreadStore — persists watched threads to disk
// ---------------------------------------------------------------------------

class SlackThreadStore {
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
    // Atomic write: write to temp then rename
    const tmpPath = this.filePath + '.tmp';
    fs.writeFileSync(tmpPath, json, 'utf8');
    fs.renameSync(tmpPath, this.filePath);
  }
}

// ---------------------------------------------------------------------------
// SlackPoller
// ---------------------------------------------------------------------------

export class SlackPoller {
  private readonly botToken: string;
  private readonly pollIntervalMs: number;
  private readonly onEvent: (event: SlackResponseEvent) => void;
  private readonly store: SlackThreadStore;

  private watched = new Map<string, WatchedThread>(); // issueIdentifier → thread
  private timer: NodeJS.Timeout | null = null;
  private botUserId: string | null = null;

  constructor(
    config: NonNullable<SlackConfig>,
    workspaceRoot: string,
    onEvent: (event: SlackResponseEvent) => void,
  ) {
    this.botToken = config.bot_token;
    this.pollIntervalMs = config.poll_interval_ms;
    this.onEvent = onEvent;
    this.store = new SlackThreadStore(workspaceRoot);
  }

  async start(): Promise<void> {
    if (this.timer) return;

    await this.fetchBotUserId();
    this.restoreFromStore();

    logger.info('Slack poller starting', {
      restoredThreads: this.watched.size,
    });
    this.scheduleNext(0);
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  watch(
    issueIdentifier: string,
    issueId: string,
    workspaceName: string,
    threadInfo: SlackThreadInfo,
  ): void {
    logger.info(`Slack poller: watching thread for ${issueIdentifier}`, {
      channel: threadInfo.channel,
      thread_ts: threadInfo.thread_ts,
    });

    this.watched.set(issueIdentifier, {
      issueIdentifier,
      issueId,
      workspaceName,
      threadInfo,
      last_read_ts: threadInfo.message_ts,
      planNumber: 0,
      planMessageTs: null,
      approvedByReaction: false,
    });

    this.persistToStore();
  }

  unwatch(issueIdentifier: string): void {
    this.watched.delete(issueIdentifier);
    this.persistToStore();
  }

  updateLastReadTs(identifier: string, ts: string): void {
    const w = this.watched.get(identifier);
    if (!w) return;
    w.last_read_ts = ts;
    this.persistToStore();
  }

  isWatching(issueIdentifier: string): boolean {
    return this.watched.has(issueIdentifier);
  }

  /**
   * Look up the thread record for a given issue identifier.
   * Used by Orchestrator to find thread info for completion notices.
   */
  getThread(issueIdentifier: string): WatchedThread | undefined {
    return this.watched.get(issueIdentifier);
  }

  /** Increment and persist the plan counter; returns the new number. */
  incrementPlanNumber(issueIdentifier: string): number {
    const w = this.watched.get(issueIdentifier);
    if (!w) return 0;
    w.planNumber++;
    this.persistToStore();
    return w.planNumber;
  }

  /** Set the plan message ts to watch for ✅ reactions. */
  setPlanMessageTs(issueIdentifier: string, ts: string): void {
    const w = this.watched.get(issueIdentifier);
    if (!w) return;
    w.planMessageTs = ts;
    w.approvedByReaction = false;
    this.persistToStore();
  }

  // ---------------------------------------------------------------------------
  // Bot user ID
  // ---------------------------------------------------------------------------

  private async fetchBotUserId(): Promise<void> {
    try {
      const resp = await fetchWithRetry('https://slack.com/api/auth.test', {
        headers: { Authorization: `Bearer ${this.botToken}` },
      });
      const parsed = SlackAuthTestResponseSchema.safeParse(await resp.json());
      if (!parsed.success) {
        logger.warn('Slack auth.test: unexpected response shape', { error: parsed.error.message });
        return;
      }
      const data = parsed.data;
      if (data.ok && data.user_id) {
        this.botUserId = data.user_id;
        logger.info('Slack poller: resolved bot user ID', { botUserId: this.botUserId });
      } else {
        logger.warn('Slack poller: auth.test failed', { error: data.error });
      }
    } catch (err) {
      logger.warn('Slack poller: failed to fetch bot user ID', { error: String(err) });
    }
  }

  // ---------------------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------------------

  private restoreFromStore(): void {
    const records = this.store.load();
    for (const [identifier, record] of records) {
      this.watched.set(identifier, {
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
        planMessageTs: record.planMessageTs,
        approvedByReaction: record.approvedByReaction,
      });
    }
  }

  private persistToStore(): void {
    const records = new Map<string, ThreadRecord>();
    for (const [identifier, w] of this.watched) {
      records.set(identifier, {
        issueIdentifier: w.issueIdentifier,
        issueId: w.issueId,
        workspaceName: w.workspaceName,
        channel: w.threadInfo.channel,
        thread_ts: w.threadInfo.thread_ts,
        last_read_ts: w.last_read_ts,
        planNumber: w.planNumber,
        planMessageTs: w.planMessageTs,
        approvedByReaction: w.approvedByReaction,
      });
    }
    this.store.save(records);
  }

  // ---------------------------------------------------------------------------
  // Scheduling
  // ---------------------------------------------------------------------------

  private scheduleNext(delayMs: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.poll(), delayMs);
  }

  private async poll(): Promise<void> {
    try {
      await this.doPoll();
    } catch (err) {
      logger.warn('Slack poller: poll failed', { error: String(err) });
    } finally {
      this.scheduleNext(this.pollIntervalMs);
    }
  }

  // ---------------------------------------------------------------------------
  // Core poll logic
  // ---------------------------------------------------------------------------

  private async doPoll(): Promise<void> {
    for (const [identifier, watched] of this.watched) {
      try {
        await this.checkThread(watched);
      } catch (err) {
        logger.warn(`Slack poller: failed to check thread for ${identifier}`, {
          error: String(err),
        });
      }
    }
  }

  private async checkThread(watched: WatchedThread): Promise<void> {
    const { channel, thread_ts } = watched.threadInfo;

    const url = new URL('https://slack.com/api/conversations.replies');
    url.searchParams.set('channel', channel);
    url.searchParams.set('ts', thread_ts);
    url.searchParams.set('oldest', watched.last_read_ts);

    const resp = await fetchWithRetry(url.toString(), {
      headers: { Authorization: `Bearer ${this.botToken}` },
    });

    if (!resp.ok) {
      logger.warn(`Slack API HTTP error: ${resp.status}`);
      return;
    }

    const parsed = SlackRepliesResponseSchema.safeParse(await resp.json());
    if (!parsed.success) {
      logger.warn('Slack conversations.replies: unexpected response shape', { error: parsed.error.message });
      return;
    }
    const data = parsed.data;

    if (!data.ok) {
      logger.warn(`Slack API error: ${data.error}`);
      return;
    }

    const messages = data.messages ?? [];

    for (const msg of messages) {
      // Skip the message at exactly last_read_ts (already processed)
      if (msg.ts === watched.last_read_ts) continue;

      // Skip bot messages and own messages
      if (msg.bot_id || msg.subtype || msg.user === this.botUserId) continue;

      // Human message found — emit event
      const responseText = msg.text ?? '';
      logger.info(
        `Slack poller: human response detected for ${watched.issueIdentifier}`,
        { user: msg.user, text: responseText.slice(0, 100) },
      );

      // Update last_read_ts and persist
      watched.last_read_ts = msg.ts;
      this.persistToStore();

      try {
        this.onEvent({
          issueIdentifier: watched.issueIdentifier,
          issueId: watched.issueId,
          responseText,
          workspaceName: watched.workspaceName,
          isApproval: false,
        });
      } catch (err) {
        logger.error('Slack poller: onEvent handler threw', { error: String(err) });
      }

      // Only process the first new human message per poll cycle
      return;
    }

    // Check for ✅ reaction on the plan message
    await this.checkPlanReaction(watched);
  }

  private async checkPlanReaction(watched: WatchedThread): Promise<void> {
    if (!watched.planMessageTs || watched.approvedByReaction) return;

    const url = new URL('https://slack.com/api/reactions.get');
    url.searchParams.set('channel', watched.threadInfo.channel);
    url.searchParams.set('timestamp', watched.planMessageTs);

    const resp = await fetchWithRetry(url.toString(), {
      headers: { Authorization: `Bearer ${this.botToken}` },
    });

    if (!resp.ok) return;

    const parsed = SlackReactionsResponseSchema.safeParse(await resp.json());
    if (!parsed.success || !parsed.data.ok) return;

    const reactions = parsed.data.message?.reactions ?? [];
    const hasApproval = reactions.some((r) =>
      r.name === 'white_check_mark' &&
      r.users?.some((u) => u !== this.botUserId),
    );

    if (!hasApproval) return;

    logger.info(`Slack poller: ✅ reaction detected for ${watched.issueIdentifier}`);

    watched.approvedByReaction = true;
    this.persistToStore();

    try {
      this.onEvent({
        issueIdentifier: watched.issueIdentifier,
        issueId: watched.issueId,
        responseText: '승인',
        workspaceName: watched.workspaceName,
        isApproval: true,
      });
    } catch (err) {
      logger.error('Slack poller: onEvent handler threw', { error: String(err) });
    }
  }
}
