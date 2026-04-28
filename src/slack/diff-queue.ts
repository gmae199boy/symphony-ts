/**
 * DiffQueueStore — PR diff 메시지 전송 큐의 영속화.
 *
 * SlackThreadStore/TrackerCommentStore와 동일 패턴:
 * Zod 검증, Map 직렬화, atomic write (tmp → rename).
 */

import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { logger } from '../logger.js';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const DiffFileSchema = z.object({
  path: z.string(),
  status: z.enum(['added', 'modified', 'deleted']),
  additions: z.number(),
  deletions: z.number(),
  /** 원시 unified diff 본문 텍스트 (snippet 업로드용). */
  content: z.string().max(2_000_000),
  /** snippet 업로드 완료 여부. */
  upload_sent: z.boolean(),
});

export type DiffFile = z.infer<typeof DiffFileSchema>;

const DiffQueueRecordSchema = z.object({
  issueIdentifier: z.string(),
  pr_url: z.string(),
  pr_number: z.number(),
  thread_ts: z.string(),
  channel: z.string(),
  summary_sent: z.boolean(),
  files: z.array(DiffFileSchema),
  approval_sent: z.boolean(),
});

export type DiffQueueRecord = z.infer<typeof DiffQueueRecordSchema>;

const DiffQueueStoreSchema = z.array(z.tuple([z.string(), DiffQueueRecordSchema]));

// ---------------------------------------------------------------------------
// Legacy schema migration (chunks[] → content)
// ---------------------------------------------------------------------------

const LegacyDiffFileSchema = z.object({
  path: z.string(),
  status: z.enum(['added', 'modified', 'deleted']),
  additions: z.number(),
  deletions: z.number(),
  chunks: z.array(z.string()),
  sent_chunks: z.array(z.boolean()),
});

const LegacyRecordSchema = z.object({
  issueIdentifier: z.string(),
  pr_url: z.string(),
  pr_number: z.number(),
  thread_ts: z.string(),
  channel: z.string(),
  summary_sent: z.boolean(),
  files: z.array(LegacyDiffFileSchema),
  approval_sent: z.boolean(),
});

const LegacyStoreSchema = z.array(z.tuple([z.string(), LegacyRecordSchema]));

function migrateLegacyRecord(rec: z.infer<typeof LegacyRecordSchema>): DiffQueueRecord {
  return {
    ...rec,
    files: rec.files.map(f => ({
      path: f.path,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      content: f.chunks.join('\n').slice(0, 2_000_000),
      upload_sent: f.sent_chunks.length > 0 && f.sent_chunks.every(Boolean),
    })),
  };
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export class DiffQueueStore {
  private readonly filePath: string;
  private records = new Map<string, DiffQueueRecord>();

  constructor(workspaceRoot: string) {
    this.filePath = path.join(workspaceRoot, 'pending-diff-messages.json');
  }

  load(): void {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const json = JSON.parse(raw);

      const parsed = DiffQueueStoreSchema.safeParse(json);
      if (parsed.success) {
        this.records = new Map(parsed.data);
        return;
      }

      // 구버전 포맷(chunks[]) 마이그레이션 시도
      const legacy = LegacyStoreSchema.safeParse(json);
      if (legacy.success) {
        logger.info('DiffQueueStore: migrating legacy chunk format to content format');
        this.records = new Map(legacy.data.map(([id, rec]) => [id, migrateLegacyRecord(rec)]));
        this.save();
        return;
      }

      // 복구 불가: 기존 파일 백업 후 초기화
      const backupPath = this.filePath + '.bak';
      try {
        fs.copyFileSync(this.filePath, backupPath);
        logger.warn('DiffQueueStore: corrupted data backed up, starting fresh', {
          error: parsed.error.message,
          backupPath,
        });
      } catch {
        logger.warn('DiffQueueStore: corrupted data, starting fresh', { error: parsed.error.message });
      }
      this.records = new Map();
    } catch {
      this.records = new Map();
    }
  }

  get(identifier: string): DiffQueueRecord | undefined {
    return this.records.get(identifier);
  }

  /** 미전송 레코드가 있는 모든 identifier 반환. */
  getPendingIdentifiers(): string[] {
    return [...this.records.entries()]
      .filter(([, r]) => !r.approval_sent)
      .map(([id]) => id);
  }

  set(identifier: string, record: DiffQueueRecord): void {
    this.records.set(identifier, record);
    this.save();
  }

  delete(identifier: string): void {
    this.records.delete(identifier);
    this.save();
  }

  save(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const entries = [...this.records.entries()];
    const json = JSON.stringify(entries, null, 2);
    const tmpPath = this.filePath + '.tmp';
    fs.writeFileSync(tmpPath, json, 'utf8');
    fs.renameSync(tmpPath, this.filePath);
  }
}
