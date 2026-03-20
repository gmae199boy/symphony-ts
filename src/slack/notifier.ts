/**
 * Slack notifier — sends messages to Slack channels/threads.
 */

import { z } from 'zod';
import { logger } from '../logger.js';
import { fetchWithRetry } from '../fetch-retry.js';

const SlackPostMessageResponseSchema = z.object({
  ok: z.boolean(),
  ts: z.string().optional(),
  channel: z.string().optional(),
  error: z.string().optional(),
});

export async function sendSlackMessage(
  botToken: string,
  channel: string,
  text: string,
  threadTs?: string,
): Promise<{ ts: string; channel: string } | null> {
  try {
    const body: Record<string, string> = { channel, text };
    if (threadTs) body.thread_ts = threadTs;

    const resp = await fetchWithRetry('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${botToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    const parsed = SlackPostMessageResponseSchema.safeParse(await resp.json());
    if (!parsed.success) {
      logger.warn('Slack postMessage: unexpected response shape', { error: parsed.error.message });
      return null;
    }
    const data = parsed.data;
    if (!data.ok) {
      logger.warn('Slack postMessage failed', { error: data.error, channel, threadTs });
      return null;
    }
    if (!data.ts) {
      logger.warn('Slack postMessage: ok but no ts', { channel });
      return null;
    }
    return { ts: data.ts, channel: data.channel ?? channel };
  } catch (err) {
    logger.warn('Failed to send Slack message', { error: String(err) });
    return null;
  }
}

/**
 * Send a long message, splitting by '---' section boundaries if it exceeds
 * Slack's ~40 000 character limit.  Each chunk is sent as a thread reply.
 *
 * @param onMessageSent - called after each chunk is sent so the caller can
 *        update last_read_ts to prevent the Slack poller from picking up
 *        bot-sent chunks as user messages.
 */
export async function sendSlackMessageChunked(
  botToken: string,
  channel: string,
  text: string,
  threadTs?: string,
  onMessageSent?: (ts: string) => void,
): Promise<{ ts: string; channel: string } | null> {
  const MAX_LENGTH = 39_000; // leave headroom below Slack's 40 000 limit

  if (text.length <= MAX_LENGTH) {
    const result = await sendSlackMessage(botToken, channel, text, threadTs);
    if (result) onMessageSent?.(result.ts);
    return result;
  }

  // Split on finding boundaries (--- separator)
  const sections = text.split('\n---\n');
  const chunks: string[] = [];
  let current = '';

  for (const section of sections) {
    if (current.length + section.length + 5 > MAX_LENGTH && current) {
      chunks.push(current);
      current = section;
    } else {
      current += (current ? '\n---\n' : '') + section;
    }
  }
  if (current) chunks.push(current);

  let lastResult: { ts: string; channel: string } | null = null;

  for (let i = 0; i < chunks.length; i++) {
    const prefix = chunks.length > 1 ? `(${i + 1}/${chunks.length})\n\n` : '';
    const result = await sendSlackMessage(botToken, channel, prefix + chunks[i], threadTs);
    if (result) {
      onMessageSent?.(result.ts);
      lastResult = result;
    }
  }

  return lastResult;
}
