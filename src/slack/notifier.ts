/**
 * Slack notifier — @slack/web-api WebClient로 메시지를 전송한다.
 */

import type { WebClient } from '@slack/web-api';
import { logger } from '../logger.js';

export async function sendSlackMessage(
  client: WebClient,
  channel: string,
  text: string,
  threadTs?: string,
): Promise<{ ts: string; channel: string } | null> {
  try {
    const result = await client.chat.postMessage({
      channel,
      text,
      ...(threadTs ? { thread_ts: threadTs } : {}),
    });

    if (!result.ok) {
      logger.warn('Slack postMessage failed', { error: result.error, channel, threadTs });
      return null;
    }
    if (!result.ts) {
      logger.warn('Slack postMessage: ok but no ts', { channel });
      return null;
    }
    return { ts: result.ts, channel: (result.channel as string | undefined) ?? channel };
  } catch (err) {
    logger.warn('Failed to send Slack message', { error: String(err) });
    return null;
  }
}

/**
 * 긴 메시지를 '---' 섹션 경계로 분할하여 순차적으로 전송한다.
 * 각 청크는 스레드 답글로 전송된다.
 */
export async function sendSlackMessageChunked(
  client: WebClient,
  channel: string,
  text: string,
  threadTs?: string,
  onMessageSent?: (ts: string) => void,
): Promise<{ ts: string; channel: string } | null> {
  const MAX_LENGTH = 39_000;

  if (text.length <= MAX_LENGTH) {
    const result = await sendSlackMessage(client, channel, text, threadTs);
    if (result) onMessageSent?.(result.ts);
    return result;
  }

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
    const result = await sendSlackMessage(client, channel, prefix + chunks[i], threadTs);
    if (result) {
      onMessageSent?.(result.ts);
      lastResult = result;
    }
  }

  return lastResult;
}
