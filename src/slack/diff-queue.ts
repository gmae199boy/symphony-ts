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
  /** 사전 분할된 Slack 메시지 청크 (코드블록 포함). */
  chunks: z.array(z.string()),
  /** 청크별 전송 완료 여부. */
  sent_chunks: z.array(z.boolean()),
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
      const parsed = DiffQueueStoreSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) {
        logger.warn('DiffQueueStore: corrupted data, starting fresh', { error: parsed.error.message });
        this.records = new Map();
        return;
      }
      this.records = new Map(parsed.data);
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
