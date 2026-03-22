/**
 * ReviewOrchestrator — manages multi-agent, multi-round self-review.
 *
 * Flow:
 *  1. Each agent runs N rounds in series (exclusion via previous results)
 *  2. All agents run in parallel (no cross-agent exclusion)
 *  3. Validation agent merges, deduplicates, removes false positives
 *  4. Returns consolidated review text for Slack
 */

import { logger } from '../logger.js';
import { ClaudeReviewBackend } from './claude-review.js';
import { CodexReviewBackend } from './codex-review.js';
import type { ReviewBackend } from './types.js';
import type { WorkspaceRef } from '../types.js';
import type { ReviewConfig, AgentConfig, ClaudeAgentConfig, CodexAgentConfig } from '../config/schema.js';

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export class ReviewOrchestrator {
  private readonly ref: WorkspaceRef;

  constructor(ref: WorkspaceRef) {
    this.ref = ref;
  }

  async run(
    diff: string,
    reviewConfig: ReviewConfig,
    agentConfigs: AgentConfig[],
  ): Promise<string> {
    logger.info(`Starting self-review: agents=[${reviewConfig.agents.join(', ')}] rounds=${reviewConfig.rounds}`);

    // Phase 1: run all agents in parallel, each with serial rounds
    const perAgentResults = await Promise.all(
      reviewConfig.agents.map((kind) =>
        this.runAgentRounds(kind, diff, reviewConfig.rounds, agentConfigs),
      ),
    );

    const allResults = perAgentResults.flat();
    logger.info(`Self-review raw results: ${allResults.length} round(s)`);

    if (allResults.length === 0) {
      return '리뷰 결과 문제가 발견되지 않았습니다.\n\n✅ 리액션이나 피드백을 주세요.';
    }

    // Phase 2: validation agent merges + dedup + false positive filter
    const consolidated = await this.validate(diff, allResults, reviewConfig.validator, agentConfigs);
    logger.info(`Self-review validation complete`);

    return consolidated;
  }

  // -------------------------------------------------------------------------
  // Per-agent rounds (serial within agent)
  // -------------------------------------------------------------------------

  private async runAgentRounds(
    kind: string,
    diff: string,
    rounds: number,
    agentConfigs: AgentConfig[],
  ): Promise<string[]> {
    const backend = this.createReviewBackend(kind, agentConfigs);
    if (!backend) {
      logger.warn(`No agent config found for review agent kind="${kind}", skipping`);
      return [];
    }

    const results: string[] = [];

    for (let round = 1; round <= rounds; round++) {
      logger.info(`Review ${kind} round ${round}/${rounds}`);

      try {
        const result = await backend.review(diff, {
          previousResults: results,
          round,
          totalRounds: rounds,
        });

        results.push(result);
        logger.info(`Review ${kind} round ${round}: complete`);
      } catch (err) {
        logger.warn(`Review ${kind} round ${round} failed`, { error: String(err) });
      }
    }

    return results;
  }

  // -------------------------------------------------------------------------
  // Validation
  // -------------------------------------------------------------------------

  private async validate(
    diff: string,
    allResults: string[],
    validatorKind: string,
    agentConfigs: AgentConfig[],
  ): Promise<string> {
    const backend = this.createReviewBackend(validatorKind, agentConfigs);
    if (!backend) {
      logger.warn(`No agent config for validator kind="${validatorKind}", returning concatenated results`);
      return allResults.join('\n---\n');
    }

    if (backend.validate) {
      try {
        return await backend.validate(diff, allResults);
      } catch (err) {
        logger.warn('Validation agent failed, returning concatenated results', { error: String(err) });
        return allResults.join('\n---\n');
      }
    }

    return allResults.join('\n---\n');
  }

  // -------------------------------------------------------------------------
  // Factory
  // -------------------------------------------------------------------------

  private createReviewBackend(kind: string, agentConfigs: AgentConfig[]): ReviewBackend | null {
    const config = agentConfigs.find((c) => c.kind === kind);
    if (!config) return null;

    switch (config.kind) {
      case 'claude':
        return new ClaudeReviewBackend(config as ClaudeAgentConfig, this.ref);
      case 'codex':
        return new CodexReviewBackend(config as CodexAgentConfig, this.ref);
      default:
        return null;
    }
  }
}
