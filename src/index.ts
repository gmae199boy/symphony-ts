#!/usr/bin/env node
/**
 * Symphony TypeScript — entry point.
 *
 * Usage:
 *   symphony [--workflow WORKFLOW.md]
 *
 * Reads WORKFLOW.md from:
 *   1. --workflow <path> CLI arg
 *   2. $SYMPHONY_WORKFLOW env var
 *   3. ./WORKFLOW.md (default)
 */

import path from 'node:path';
import process from 'node:process';
import { loadWorkflow } from './config/loader.js';
import { Orchestrator } from './orchestrator.js';
import { logger } from './logger.js';

// ---------------------------------------------------------------------------
// Parse CLI args
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): { workflowPath: string } {
  let workflowPath = process.env['SYMPHONY_WORKFLOW'] ?? 'WORKFLOW.md';

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--workflow' && argv[i + 1]) {
      workflowPath = argv[i + 1];
      i++;
    }
  }

  return { workflowPath };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // Load .env into process.env before anything reads environment variables.
  // Node 22+ built-in — no dotenv package needed.
  // Silently skips if .env doesn't exist (production / CI environments supply
  // vars directly).
  const envPath = process.env['SYMPHONY_ENV_FILE'] ?? '.env';
  try {
    process.loadEnvFile(path.resolve(envPath));
    logger.info(`Loaded env from ${envPath}`);
  } catch {
    // File absent or unreadable — rely on environment variables already set
  }

  const { workflowPath } = parseArgs(process.argv.slice(2));
  const absWorkflowPath = path.resolve(workflowPath);

  logger.info(`Loading workflow config from ${absWorkflowPath}`);

  const { config, promptTemplate } = loadWorkflow(absWorkflowPath);

  const agentKinds = config.agents.map((a) => a.kind).join(', ');
  logger.info(
    `Symphony starting: ${config.trackers.length} tracker(s), agents=[${agentKinds}], workspace_backend=${config.workspace_backend}`,
  );

  // One Orchestrator per tracker
  const orchestrators = config.trackers.map(
    (trackerConfig) => new Orchestrator(config, trackerConfig, promptTemplate),
  );

  // Graceful shutdown
  const shutdown = (signal: string) => {
    logger.info(`Received ${signal}; shutting down`);
    orchestrators.forEach((o) => o.stop());
    // Give running agents time to complete gracefully
    setTimeout(() => process.exit(0), 3_000);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Start all orchestrators
  orchestrators.forEach((o) => {
    o.on('agent:completed', (issue) => {
      logger.info(`✓ Agent completed: ${issue.identifier}`);
    });

    o.on('agent:failed', (issue, err) => {
      logger.error(`✗ Agent failed: ${issue.identifier}`, { error: String(err) });
    });

    o.start();
  });

  logger.info('Symphony is running. Press Ctrl+C to stop.');

  // Keep process alive
  await new Promise<void>(() => {
    // resolved only via signal handlers
  });
}

main().catch((err) => {
  logger.error('Fatal error', { error: String(err) });
  process.exit(1);
});
