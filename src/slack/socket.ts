/**
 * SlackSocketReceiver — receives Slack events via Socket Mode (WebSocket).
 *
 * Handles:
 *  - message events (thread replies from humans)
 *  - reaction_added events (✅ on plan messages)
 *
 * Features:
 *  - Automatic reconnect with exponential backoff
 *  - event_id deduplication (5-minute TTL)
 *  - Agent concurrency guard: ignores events when agent is running (active=false)
 *
 * Requires Node.js 22+ (native global WebSocket).
 */

import { z } from 'zod';
import { logger } from '../logger.js';
import { fetchWithRetry } from '../fetch-retry.js';
import type { SlackThreadManager } from './thread-store.js';

// ---------------------------------------------------------------------------
// Event type (shared with channel/slack.ts)
// ---------------------------------------------------------------------------

export interface SlackResponseEvent {
  issueIdentifier: string;
  issueId: string;
  responseText: string;
  workspaceName: string;
  isApproval: boolean;
}

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const AuthTestResponseSchema = z.object({
  ok: z.boolean(),
  user_id: z.string().optional(),
  error: z.string().optional(),
});

const ConnectionsOpenResponseSchema = z.object({
  ok: z.boolean(),
  url: z.string().optional(),
  error: z.string().optional(),
});

const SocketEnvelopeSchema = z.object({
  envelope_id: z.string().optional(),
  type: z.string(),
  payload: z.unknown().optional(),
});

const EventCallbackPayloadSchema = z.object({
  event: z.object({
    type: z.string(),
    // message fields
    text: z.string().optional(),
    user: z.string().optional(),
    bot_id: z.string().optional(),
    subtype: z.string().optional(),
    ts: z.string().optional(),
    thread_ts: z.string().optional(),
    channel: z.string().optional(),
    // reaction_added fields
    reaction: z.string().optional(),
    item: z.object({
      type: z.string().optional(),
      channel: z.string().optional(),
      ts: z.string().optional(),
    }).optional(),
    item_user: z.string().optional(),
  }),
});

// ---------------------------------------------------------------------------
// SlackSocketReceiver
// ---------------------------------------------------------------------------

const BACKOFF_INITIAL_MS = 1_000;
const BACKOFF_MAX_MS = 60_000;
const DEDUP_TTL_MS = 5 * 60 * 1_000;

export class SlackSocketReceiver {
  private readonly botToken: string;
  private readonly appToken: string;
  private readonly threadManager: SlackThreadManager;
  private readonly onEvent: (event: SlackResponseEvent) => void;

  private ws: WebSocket | null = null;
  private botUserId: string | null = null;
  private stopped = false;
  private backoffMs = BACKOFF_INITIAL_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  // event_id dedup: envelope_id → received timestamp
  private readonly seenEnvelopeIds = new Map<string, number>();

  constructor(
    config: { appToken: string; botToken: string },
    threadManager: SlackThreadManager,
    onEvent: (event: SlackResponseEvent) => void,
  ) {
    this.appToken = config.appToken;
    this.botToken = config.botToken;
    this.threadManager = threadManager;
    this.onEvent = onEvent;
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.botUserId = await this.fetchBotUserId();
    logger.info('Slack socket: resolved bot user ID', { botUserId: this.botUserId });
    await this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    logger.info('Slack socket receiver stopped');
  }

  // ---------------------------------------------------------------------------
  // Connection
  // ---------------------------------------------------------------------------

  private async connect(): Promise<void> {
    if (this.stopped) return;

    const wsUrl = await this.openConnection();
    if (!wsUrl) {
      this.scheduleReconnect();
      return;
    }

    const ws = new WebSocket(wsUrl);
    this.ws = ws;

    ws.onmessage = (ev: MessageEvent) => {
      try {
        this.handleRawMessage(typeof ev.data === 'string' ? ev.data : String(ev.data));
      } catch (err) {
        logger.error('Slack socket: message handler error', { error: String(err) });
      }
    };

    ws.onclose = (ev: Event & { code?: number; reason?: string }) => {
      if (this.stopped) return;
      logger.warn('Slack socket: connection closed', { code: ev.code, reason: ev.reason });
      this.ws = null;
      this.scheduleReconnect();
    };

    ws.onerror = (ev: Event) => {
      if (this.stopped) return;
      logger.warn('Slack socket: connection error', { error: String(ev) });
      // onclose will fire after onerror, so no need to reconnect here
    };
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    logger.info(`Slack socket: reconnecting in ${this.backoffMs}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, this.backoffMs);
    this.backoffMs = Math.min(this.backoffMs * 2, BACKOFF_MAX_MS);
  }

  private resetBackoff(): void {
    this.backoffMs = BACKOFF_INITIAL_MS;
  }

  // ---------------------------------------------------------------------------
  // Slack API calls
  // ---------------------------------------------------------------------------

  private async fetchBotUserId(): Promise<string> {
    const resp = await fetchWithRetry('https://slack.com/api/auth.test', {
      headers: { Authorization: `Bearer ${this.botToken}` },
    });
    const parsed = AuthTestResponseSchema.safeParse(await resp.json());
    if (!parsed.success || !parsed.data.ok || !parsed.data.user_id) {
      throw new Error(`Slack auth.test failed: ${parsed.success ? (parsed.data.error ?? 'unknown') : parsed.error.message}`);
    }
    return parsed.data.user_id;
  }

  private async openConnection(): Promise<string | null> {
    try {
      const resp = await fetchWithRetry('https://slack.com/api/apps.connections.open', {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.appToken}` },
      });
      const parsed = ConnectionsOpenResponseSchema.safeParse(await resp.json());
      if (!parsed.success || !parsed.data.ok || !parsed.data.url) {
        logger.error('Slack socket: apps.connections.open failed', {
          error: parsed.success ? (parsed.data.error ?? 'unknown') : parsed.error.message,
        });
        return null;
      }
      return parsed.data.url;
    } catch (err) {
      logger.error('Slack socket: failed to open connection', { error: String(err) });
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Message handling
  // ---------------------------------------------------------------------------

  private handleRawMessage(raw: string): void {
    const envelope = SocketEnvelopeSchema.safeParse(JSON.parse(raw));
    if (!envelope.success) return;

    const { type, envelope_id, payload } = envelope.data;

    // ACK first (Slack retries if no ACK within 3s)
    if (envelope_id) {
      this.ws?.send(JSON.stringify({ envelope_id }));

      // Dedup
      const now = Date.now();
      this.pruneSeenIds(now);
      if (this.seenEnvelopeIds.has(envelope_id)) return;
      this.seenEnvelopeIds.set(envelope_id, now);
    }

    if (type === 'hello') {
      logger.info('Slack socket: connected');
      this.resetBackoff();
      return;
    }

    if (type === 'disconnect') {
      logger.info('Slack socket: disconnect requested by Slack, reconnecting');
      this.ws?.close();
      this.ws = null;
      void this.connect();
      return;
    }

    if (type === 'events_api') {
      const payloadParsed = EventCallbackPayloadSchema.safeParse(payload);
      if (!payloadParsed.success) return;
      const { event } = payloadParsed.data;

      if (event.type === 'message') {
        this.handleMessageEvent(event);
      } else if (event.type === 'reaction_added') {
        this.handleReactionEvent(event);
      }
    }
  }

  private pruneSeenIds(now: number): void {
    for (const [id, ts] of this.seenEnvelopeIds) {
      if (now - ts > DEDUP_TTL_MS) this.seenEnvelopeIds.delete(id);
    }
  }

  // ---------------------------------------------------------------------------
  // Event handlers
  // ---------------------------------------------------------------------------

  private handleMessageEvent(event: z.infer<typeof EventCallbackPayloadSchema>['event']): void {
    if (event.bot_id || event.subtype || event.user === this.botUserId) return;

    const { channel, thread_ts, ts } = event;
    const responseText = event.text ?? '';

    if (!channel || !thread_ts || !ts) return;
    if (thread_ts === ts) return; // top-level message, not a thread reply

    const watched = this.threadManager.findByThread(channel, thread_ts);
    if (!watched || !watched.active) return;

    if (ts <= watched.last_read_ts) return;

    logger.info(`Slack socket: human message for ${watched.issueIdentifier}`, {
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
      logger.error('Slack socket: onEvent handler threw', { error: String(err) });
    }
  }

  private handleReactionEvent(event: z.infer<typeof EventCallbackPayloadSchema>['event']): void {
    if (event.reaction !== 'white_check_mark') return;
    if (event.item?.type !== 'message') return;
    if (event.user === this.botUserId) return; // 봇 자신이 단 리액션 무시

    const channel = event.item?.channel;
    const reactionTs = event.item?.ts;
    if (!channel || !reactionTs) return;

    for (const watched of this.threadManager.getAllThreads().values()) {
      if (!watched.active) continue;
      if (watched.approvedByReaction) continue;
      if (watched.threadInfo.channel !== channel) continue;
      if (watched.approvalMessageTs !== reactionTs) continue;

      logger.info(`Slack socket: ✅ reaction for ${watched.issueIdentifier}`);
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
        logger.error('Slack socket: onEvent handler threw', { error: String(err) });
      }
      return;
    }
  }
}
