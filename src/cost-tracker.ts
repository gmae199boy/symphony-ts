/**
 * Cost tracker — accumulates per-issue cost and token usage, persists to disk.
 */

import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { logger } from './logger.js';

const CostEntrySchema = z.object({
  costUsd: z.number(),
  tokens: z.number(),
  turns: z.number(),
  lastUpdated: z.string(),
});

const CostStoreSchema = z.record(CostEntrySchema);

type CostEntry = z.infer<typeof CostEntrySchema>;

export interface CostSummary {
  totalCostUsd: number;
  totalTokens: number;
  totalTurns: number;
  issues: Record<string, CostEntry>;
}

export class CostTracker {
  private readonly filePath: string;
  private data: Record<string, CostEntry>;
  private pendingSave: Promise<void> = Promise.resolve();

  constructor(workspaceRoot: string) {
    this.filePath = path.join(workspaceRoot, 'cost-log.json');
    this.data = this.load();
  }

  record(issueIdentifier: string, costUsd?: number, tokens?: number): void {
    if (costUsd == null && tokens == null) return;

    const existing = this.data[issueIdentifier];
    this.data[issueIdentifier] = {
      costUsd: (existing?.costUsd ?? 0) + (costUsd ?? 0),
      tokens: (existing?.tokens ?? 0) + (tokens ?? 0),
      turns: (existing?.turns ?? 0) + 1,
      lastUpdated: new Date().toISOString(),
    };

    this.save();
  }

  getIssue(identifier: string): { costUsd: number; tokens: number; turns: number } | null {
    return this.data[identifier] ?? null;
  }

  getSummary(): CostSummary {
    let totalCostUsd = 0;
    let totalTokens = 0;
    let totalTurns = 0;

    for (const entry of Object.values(this.data)) {
      totalCostUsd += entry.costUsd;
      totalTokens += entry.tokens;
      totalTurns += entry.turns;
    }

    return { totalCostUsd, totalTokens, totalTurns, issues: { ...this.data } };
  }

  private load(): Record<string, CostEntry> {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = CostStoreSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) {
        logger.warn('Cost tracker: corrupted data, starting fresh');
        return {};
      }
      return parsed.data;
    } catch {
      return {};
    }
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    } catch (err) {
      logger.warn('Cost tracker: failed to create directory', { error: String(err) });
      return;
    }

    const data = JSON.stringify(this.data, null, 2);
    this.pendingSave = this.pendingSave
      .then(async () => {
        const tmpPath = this.filePath + '.tmp';
        await fs.promises.writeFile(tmpPath, data, 'utf8');
        await fs.promises.rename(tmpPath, this.filePath);
      })
      .catch((err) => {
        logger.warn('Cost tracker: failed to save', { error: String(err) });
      });
  }
}
