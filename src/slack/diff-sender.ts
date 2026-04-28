/**
 * DiffSender — PR diff를 Slack snippet으로 스레드에 순서대로 전송한다.
 *
 * - 파일별 files.uploadV2 호출 (filetype: 'diff', snippet_type: 'diff' → 초록/빨강 색상 렌더링)
 * - 1초 딜레이 (Slack rate limit 준수)
 * - 실패 시 무한 재시도 + 지수 백오프 (cap 60초) — 같은 파일을 건너뛰지 않음
 * - rate-limit 에러 시 Retry-After 헤더 값 준수
 * - 매 파일 전송 성공 시 store에 영속화 (재시작 시 이어서 전송)
 */

import type { WebClient } from '@slack/web-api';
import { logger } from '../logger.js';
import type { DiffQueueStore, DiffQueueRecord, DiffFile } from './diff-queue.js';

const INTER_FILE_DELAY_MS = 1_000;
const MAX_BACKOFF_MS = 60_000;

// 재시도해도 해결되지 않는 Slack 영구 에러 코드.
const PERMANENT_ERRORS = new Set([
  'invalid_auth',
  'account_inactive',
  'token_revoked',
  'channel_not_found',
  'not_in_channel',
  'is_archived',
  'not_allowed_token_type',
  'missing_scope',
  'file_too_large',
  'no_file_data',
  'invalid_file_type',
  'ekm_access_denied',
  'org_login_required',
  'file_uploads_disabled',
  'team_access_not_granted',
  'invalid_arguments',
]);

/** Slack mrkdwn 특수문자(&, <, >) 이스케이프. */
function escapeMrkdwn(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** 업로드용 파일명 생성: 안전하지 않은 문자 치환, 중복 확장자 방지, 200자 절단. */
function buildFilename(filePath: string): string {
  // 양방향/제로폭 유니코드 문자 제거 후 경로 구분자 및 비안전 문자를 _로 치환
  const sanitized = filePath
    .replace(/[\u200B-\u200F\u202A-\u202E\uFEFF]/g, '')
    .replace(/[/\\]/g, '_')
    .replace(/[^\w.\-() ]/g, '_');
  const withExt = /\.(diff|patch)$/i.test(sanitized) ? sanitized : `${sanitized}.diff`;
  return withExt.slice(0, 200);
}

function fileBadge(file: DiffFile): { emoji: string; stats: string } {
  const emoji = file.status === 'added' ? '➕' : file.status === 'deleted' ? '🗑️' : '✏️';
  const stats =
    file.status === 'deleted'
      ? `(-${file.deletions})`
      : file.status === 'added'
        ? `(+${file.additions})`
        : `(+${file.additions}/-${file.deletions})`;
  return { emoji, stats };
}

// try 블록 내부에서 throw한 영구 에러를 catch 블록에서 식별하기 위한 sentinel.
class PermanentSlackError extends Error {
  constructor(code: string) {
    super(`Permanent Slack error: ${code}`);
    this.name = 'PermanentSlackError';
  }
}

export class DiffSender {
  private readonly interFileDelayMs: number;
  /** identifier별 진행 중인 전송 Promise — 중복 동시 호출 방지. */
  private readonly inFlight = new Map<string, Promise<void>>();

  constructor(
    private readonly client: WebClient,
    private readonly store: DiffQueueStore,
    { interFileDelayMs = INTER_FILE_DELAY_MS }: { interFileDelayMs?: number } = {},
  ) {
    this.interFileDelayMs = interFileDelayMs;
  }

  /**
   * identifier에 해당하는 미전송 diff snippet을 순서대로 전송한다.
   * 동일 identifier에 대한 중복 호출은 기존 Promise를 재사용한다.
   */
  sendPendingDiffs(identifier: string): Promise<void> {
    const existing = this.inFlight.get(identifier);
    if (existing) return existing;

    const promise = this._sendDiffsInner(identifier).finally(() => {
      this.inFlight.delete(identifier);
    });
    this.inFlight.set(identifier, promise);
    return promise;
  }

  private async _sendDiffsInner(identifier: string): Promise<void> {
    const record = this.store.get(identifier);
    if (!record || record.approval_sent) return;

    if (!record.thread_ts) {
      throw new Error(`DiffSender: thread_ts is empty for ${identifier}`);
    }

    logger.info(`DiffSender: starting diff send for ${identifier}`, {
      totalFiles: record.files.length,
      summarySent: record.summary_sent,
    });

    // 1. 요약 메시지 (chat.postMessage)
    if (!record.summary_sent) {
      const summary = this.buildSummary(record);
      try {
        await this.sendSummaryWithRetry(record.channel, summary, record.thread_ts);
      } catch (err) {
        // sendSummaryWithRetry는 영구 에러에서만 throw — 큐에서 제거 후 re-throw
        this.store.delete(identifier);
        throw err;
      }
      record.summary_sent = true;
      this.store.save();
      await delay(this.interFileDelayMs);
    }

    // 2. 파일별 snippet 업로드
    for (const file of record.files) {
      if (file.upload_sent) continue;

      await this.uploadFileWithRetry(identifier, record, file);

      file.upload_sent = true;
      this.store.save();

      await delay(this.interFileDelayMs);
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
      `<${record.pr_url}|PR #${record.pr_number}>`,
      '',
    ];

    for (const file of record.files) {
      const { emoji, stats } = fileBadge(file);
      lines.push(`${emoji} \`${escapeMrkdwn(file.path)}\` ${stats}`);
    }

    return lines.join('\n');
  }

  private buildFileTitle(file: DiffFile): string {
    const { emoji, stats } = fileBadge(file);
    return `${emoji} ${escapeMrkdwn(file.path)} ${stats}`.slice(0, 200);
  }

  /**
   * 파일 diff를 Slack snippet(filetype=diff, snippet_type=diff)으로 업로드한다.
   * rate-limit 에러는 retryAfter 준수, 영구 에러는 큐에서 삭제 후 throw.
   */
  private async uploadFileWithRetry(identifier: string, record: DiffQueueRecord, file: DiffFile): Promise<void> {
    const filename = buildFilename(file.path);
    const title = this.buildFileTitle(file);

    let attempt = 0;
    while (true) {
      try {
        const result = await this.client.files.uploadV2({
          channel_id: record.channel,
          thread_ts: record.thread_ts,
          filename,
          filetype: 'diff',
          snippet_type: 'diff',
          title,
          content: file.content,
        });

        if (result.ok) return;

        const errorCode = result.error ?? '';
        if (PERMANENT_ERRORS.has(errorCode)) {
          logger.error(`DiffSender: permanent Slack error '${errorCode}', removing from queue`, { file: file.path });
          this.store.delete(identifier);
          throw new PermanentSlackError(errorCode);
        }

        logger.warn(`DiffSender: uploadV2 returned ok=false`, { file: file.path, error: errorCode });
      } catch (err: unknown) {
        if (err instanceof PermanentSlackError) throw err;

        const slackCode = (err as { code?: string }).code ?? '';

        // rate-limit: Retry-After 준수
        if (slackCode === 'slack_webapi_rate_limited_error') {
          const retryAfter = ((err as { retryAfter?: number }).retryAfter ?? 60) * 1_000;
          logger.warn(`DiffSender: rate limited, retrying after ${retryAfter}ms`, { file: file.path });
          await delay(retryAfter);
          continue;
        }

        const dataError = (err as { data?: { error?: string } }).data?.error ?? '';
        const code = dataError || slackCode;
        if (PERMANENT_ERRORS.has(code)) {
          logger.error(`DiffSender: permanent Slack error '${code}', removing from queue`, { file: file.path });
          this.store.delete(identifier);
          throw err;
        }
        logger.warn(`DiffSender: upload threw error`, {
          file: file.path,
          code,
          err: (err as Error)?.message ?? String(err),
        });
      }

      attempt++;
      const backoff = Math.min(1_000 * Math.pow(2, attempt), MAX_BACKOFF_MS);
      logger.warn(`DiffSender: upload failed, retrying in ${backoff}ms (attempt ${attempt})`, { file: file.path });
      await delay(backoff);
    }
  }

  /**
   * 요약 메시지 전송 (chat.postMessage). 영구 에러 즉시 throw, 일시 에러는 지수 백오프 재시도.
   */
  private async sendSummaryWithRetry(channel: string, text: string, threadTs: string): Promise<void> {
    let attempt = 0;
    while (true) {
      try {
        const result = await this.client.chat.postMessage({
          channel,
          text,
          thread_ts: threadTs,
          unfurl_links: false,
          unfurl_media: false,
        });

        if (result.ok) return;

        const errorCode = result.error ?? '';
        if (PERMANENT_ERRORS.has(errorCode)) {
          logger.error(`DiffSender: permanent Slack error '${errorCode}' in summary`, { channel });
          throw new PermanentSlackError(errorCode);
        }

        logger.warn(`DiffSender: postMessage returned ok=false`, { channel, error: errorCode });
      } catch (err: unknown) {
        if (err instanceof PermanentSlackError) throw err;

        const slackCode = (err as { code?: string }).code ?? '';

        // rate-limit: Retry-After 준수
        if (slackCode === 'slack_webapi_rate_limited_error') {
          const retryAfter = ((err as { retryAfter?: number }).retryAfter ?? 60) * 1_000;
          logger.warn(`DiffSender: rate limited on summary, retrying after ${retryAfter}ms`, { channel });
          await delay(retryAfter);
          continue;
        }

        const dataError = (err as { data?: { error?: string } }).data?.error ?? '';
        if (PERMANENT_ERRORS.has(dataError)) {
          logger.error(`DiffSender: permanent Slack error '${dataError}' in summary`, { channel });
          throw err;
        }
        logger.warn(`DiffSender: summary threw error`, {
          channel,
          err: (err as Error)?.message ?? String(err),
        });
      }

      attempt++;
      const backoff = Math.min(1_000 * Math.pow(2, attempt), MAX_BACKOFF_MS);
      logger.warn(`DiffSender: summary send failed, retrying in ${backoff}ms (attempt ${attempt})`, { channel });
      await delay(backoff);
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
