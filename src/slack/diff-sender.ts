/**
 * DiffSender — PR diff 메시지를 Slack 스레드에 순서대로 전송한다.
 *
 * - 파일별, 청크별 순서 보장
 * - 1초 딜레이 (Slack rate limit 준수)
 * - 실패 시 무한 재시도 + 지수 백오프 (cap 60초) — 같은 청크를 건너뛰지 않음
 * - 매 청크 전송 성공 시 store에 영속화 (재시작 시 이어서 전송)
 */

import { logger } from '../logger.js';
import { sendSlackMessage } from './notifier.js';
import type { DiffQueueStore, DiffQueueRecord } from './diff-queue.js';

const INTER_MESSAGE_DELAY_MS = 1_000;
const MAX_BACKOFF_MS = 60_000;

export class DiffSender {
  constructor(
    private readonly botToken: string,
    private readonly store: DiffQueueStore,
  ) {}

  /**
   * identifier에 해당하는 미전송 diff 메시지를 순서대로 전송한다.
   * 모든 파일 전송 완료 시 approval_sent = true로 마킹.
   */
  async sendPendingDiffs(identifier: string): Promise<void> {
    const record = this.store.get(identifier);
    if (!record || record.approval_sent) return;

    logger.info(`DiffSender: starting diff send for ${identifier}`, {
      totalFiles: record.files.length,
      summarySent: record.summary_sent,
    });

    // 1. 요약 메시지
    if (!record.summary_sent) {
      const summary = this.buildSummary(record);
      await this.sendWithRetry(record.channel, summary, record.thread_ts);
      record.summary_sent = true;
      this.store.save();
      await delay(INTER_MESSAGE_DELAY_MS);
    }

    // 2. 파일별 청크 전송
    for (const file of record.files) {
      const emoji = file.status === 'added' ? '➕' : file.status === 'deleted' ? '🗑️' : '✏️';
      const totalChunks = file.chunks.length;

      for (let i = 0; i < totalChunks; i++) {
        if (file.sent_chunks[i]) continue;

        const header = i === 0
          ? `${emoji} \`${file.path}\` (+${file.additions}/-${file.deletions})${totalChunks > 1 ? ` (1/${totalChunks})` : ''}`
          : `${emoji} \`${file.path}\` (${i + 1}/${totalChunks})`;

        const text = header + '\n' + file.chunks[i];
        await this.sendWithRetry(record.channel, text, record.thread_ts);

        file.sent_chunks[i] = true;
        this.store.save();

        await delay(INTER_MESSAGE_DELAY_MS);
      }
    }

    // 3. 완료 마킹
    record.approval_sent = true;
    this.store.save();

    logger.info(`DiffSender: completed diff send for ${identifier}`, {
      filesCount: record.files.length,
    });
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private buildSummary(record: DiffQueueRecord): string {
    const lines: string[] = [
      `📦 *PR #${record.pr_number}* — 변경 파일 ${record.files.length}개`,
      `${record.pr_url}`,
      '',
    ];

    for (const file of record.files) {
      const emoji = file.status === 'added' ? '➕' : file.status === 'deleted' ? '🗑️' : '✏️';
      const stats = file.status === 'deleted'
        ? `(-${file.deletions})`
        : file.status === 'added'
          ? `(+${file.additions})`
          : `(+${file.additions}/-${file.deletions})`;
      lines.push(`${emoji} \`${file.path}\` ${stats}`);
    }

    return lines.join('\n');
  }

  /**
   * 무한 재시도 + 지수 백오프. 성공할 때까지 반복한다.
   * 같은 청크를 건너뛰지 않음 — Slack 장애 시 복구될 때까지 대기.
   */
  private async sendWithRetry(channel: string, text: string, threadTs: string): Promise<void> {
    let attempt = 0;
    while (true) {
      const result = await sendSlackMessage(this.botToken, channel, text, threadTs);
      if (result) return;

      attempt++;
      const backoff = Math.min(1000 * Math.pow(2, attempt), MAX_BACKOFF_MS);
      logger.warn(`DiffSender: send failed, retrying in ${backoff}ms (attempt ${attempt})`, {
        channel,
        threadTs,
        textLength: text.length,
      });
      await delay(backoff);
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
