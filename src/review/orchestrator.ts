/**
 * ReviewOrchestrator — manages multi-agent, multi-round self-review.
 *
 * Flow:
 *  1. Each agent runs N rounds in series (exclusion list within same agent)
 *  2. All agents run in parallel (no cross-agent exclusion)
 *  3. Validation agent merges, deduplicates, removes false positives
 *  4. Severity threshold filter
 */

import { logger } from '../logger.js';
import { ClaudeReviewBackend } from './claude-review.js';
import { CodexReviewBackend } from './codex-review.js';
import type { ReviewBackend, ReviewFinding } from './types.js';
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
  ): Promise<ReviewFinding[]> {
    logger.info(`Starting self-review: agents=[${reviewConfig.agents.join(', ')}] rounds=${reviewConfig.rounds}`);

    // Phase 1: run all agents in parallel, each with serial rounds
    const perAgentResults = await Promise.all(
      reviewConfig.agents.map((kind) =>
        this.runAgentRounds(kind, diff, reviewConfig.rounds, agentConfigs),
      ),
    );

    const merged = perAgentResults.flat();
    logger.info(`Self-review raw findings: ${merged.length} total`);

    if (merged.length === 0) return [];

    // Phase 2: validation agent merges + dedup + false positive filter
    const validated = await this.validate(diff, merged, reviewConfig.validator, agentConfigs);
    logger.info(`Self-review after validation: ${validated.length} findings`);

    return validated;
  }

  // -------------------------------------------------------------------------
  // Per-agent rounds (serial within agent)
  // -------------------------------------------------------------------------

  private async runAgentRounds(
    kind: string,
    diff: string,
    rounds: number,
    agentConfigs: AgentConfig[],
  ): Promise<ReviewFinding[]> {
    const backend = this.createReviewBackend(kind, agentConfigs);
    if (!backend) {
      logger.warn(`No agent config found for review agent kind="${kind}", skipping`);
      return [];
    }

    const findings: ReviewFinding[] = [];

    for (let round = 1; round <= rounds; round++) {
      logger.info(`Review ${kind} round ${round}/${rounds}`);

      try {
        const roundFindings = await backend.review(diff, {
          previousFindings: findings, // same agent's previous rounds only
          round,
          totalRounds: rounds,
        });

        for (const f of roundFindings) {
          f.agent = kind;
          f.round = round;
        }

        findings.push(...roundFindings);
        logger.info(`Review ${kind} round ${round}: found ${roundFindings.length} issues`);
      } catch (err) {
        logger.warn(`Review ${kind} round ${round} failed`, { error: String(err) });
        // Continue to next round — partial results are better than none
      }
    }

    return findings;
  }

  // -------------------------------------------------------------------------
  // Validation
  // -------------------------------------------------------------------------

  private async validate(
    diff: string,
    allFindings: ReviewFinding[],
    validatorKind: string,
    agentConfigs: AgentConfig[],
  ): Promise<ReviewFinding[]> {
    const backend = this.createReviewBackend(validatorKind, agentConfigs);
    if (!backend) {
      logger.warn(`No agent config for validator kind="${validatorKind}", returning raw findings`);
      return allFindings;
    }

    // ClaudeReviewBackend and CodexReviewBackend both have a validate() method
    if ('validate' in backend && typeof (backend as Record<string, unknown>).validate === 'function') {
      try {
        return await (backend as ClaudeReviewBackend | CodexReviewBackend).validate(diff, allFindings);
      } catch (err) {
        logger.warn('Validation agent failed, returning raw findings', { error: String(err) });
        return allFindings;
      }
    }

    return allFindings;
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
        return new CodexReviewBackend(config as CodexAgentConfig, this.ref.workspace);
      default:
        return null;
    }
  }
}
